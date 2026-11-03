import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandBridgeService } from "@/extension/services/CommandBridgeService";
import {
  createCommandId,
  readCommandResult,
  writeCommandRequest,
} from "@/shared/viewState";
import {
  createChangeId,
  readChangeResult,
  writeChangeRequest,
} from "@/shared/change";

vi.mock("vscode", () => ({}));

const logger = { warn: vi.fn() };

async function waitFor<T>(read: () => Promise<T | null | undefined>, message: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${message}`);
}

describe("CommandBridgeService", () => {
  let root: string;
  let view: { handleCommand: ReturnType<typeof vi.fn> };
  let change: { handleRequest: ReturnType<typeof vi.fn> };
  let bridge: CommandBridgeService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "skein-bridge-"));
    view = {
      handleCommand: vi.fn(async (request) => ({
        id: request.id,
        status: "applied",
        completedAt: Date.now(),
      })),
    };
    change = {
      handleRequest: vi.fn(async (request) => ({
        id: request.id,
        status: "applied",
        completedAt: Date.now(),
      })),
    };
    bridge = new CommandBridgeService({
      root,
      logger,
      windowId: () => "window-1",
      view: view as never,
      change: change as never,
      pollIntervalMs: 10,
    });
    await bridge.start();
  });

  afterEach(async () => {
    bridge.dispose();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("routes view and change requests to their handlers", async () => {
    const viewRequest = {
      id: createCommandId(),
      createdAt: Date.now(),
      command: { action: "select" as const, nodeId: "n1" },
    };
    await writeCommandRequest(root, viewRequest);
    const changeRequest = {
      id: createChangeId(),
      kind: "change" as const,
      createdAt: Date.now(),
      command: { action: "change_apply" as const, planId: "plan-1" },
    };
    await writeChangeRequest(root, changeRequest);

    const viewResult = await waitFor(() => readCommandResult(root, viewRequest.id), "view result");
    const changeResult = await waitFor(
      () => readChangeResult(root, changeRequest.id),
      "change result",
    );
    expect(viewResult.status).toBe("applied");
    expect(changeResult.status).toBe("applied");
    expect(view.handleCommand).toHaveBeenCalledTimes(1);
    expect(change.handleRequest).toHaveBeenCalledTimes(1);
    await expect(
      stat(path.join(root, ".skein", "commands", `${viewRequest.id}.request.json`)),
    ).rejects.toThrow();
    await expect(
      stat(path.join(root, ".skein", "commands", `${changeRequest.id}.request.json`)),
    ).rejects.toThrow();
  });

  it("leaves a request for another window in place", async () => {
    const request = {
      id: createChangeId(),
      kind: "change" as const,
      createdAt: Date.now(),
      targetWindowId: "window-2",
      command: { action: "change_undo" as const },
    };
    await writeChangeRequest(root, request);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(change.handleRequest).not.toHaveBeenCalled();
    expect(await readChangeResult(root, request.id)).toBeNull();
    expect(
      await readFile(path.join(root, ".skein", "commands", `${request.id}.request.json`), "utf8"),
    ).toContain("window-2");
  });

  it("ignores malformed and unknown request files", async () => {
    const directory = path.join(root, ".skein", "commands");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "broken.request.json"), "{", "utf8");
    await writeFile(
      path.join(directory, "unknown.request.json"),
      JSON.stringify({ id: "x", createdAt: 1, command: { action: "nope" } }),
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(view.handleCommand).not.toHaveBeenCalled();
    expect(change.handleRequest).not.toHaveBeenCalled();
  });

  it("keeps polling after a handler failure", async () => {
    view.handleCommand.mockRejectedValueOnce(new Error("boom"));
    const failing = {
      id: createCommandId(),
      createdAt: Date.now(),
      command: { action: "select" as const, nodeId: "n1" },
    };
    await writeCommandRequest(root, failing);
    await new Promise((resolve) => setTimeout(resolve, 60));

    const next = {
      id: createCommandId(),
      createdAt: Date.now() + 1,
      command: { action: "select" as const, nodeId: "n2" },
    };
    await writeCommandRequest(root, next);
    const result = await waitFor(() => readCommandResult(root, next.id), "second result");
    expect(result.status).toBe("applied");
    expect(logger.warn).toHaveBeenCalled();
  });
});
