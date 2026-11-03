import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executeApplyChange,
  executeGetChangePlan,
  executeListChangeHistory,
  executePlanChange,
  executeRedoChange,
  executeUndoChange,
} from "@/mcp/tools/change";
import {
  SKEIN_CHANGE_SCHEMA_VERSION,
  hashContent,
  parseChangeRequest,
  writeChangeHistory,
  writeChangeTask,
  type ChangeHistoryEntry,
  type ChangeTask,
} from "@/shared/change";
import { applyTextEdits } from "@/shared/change";

const FILE = "src/app.ts";

function task(planId: string): ChangeTask {
  return {
    schemaVersion: SKEIN_CHANGE_SCHEMA_VERSION,
    status: "preview-ready",
    createdAt: 1,
    updatedAt: 1,
    plan: {
      id: planId,
      kind: "rename",
      createdAt: 1,
      workspaceRoot: "/workspace",
      graphVersion: 1,
      source: "mcp",
      target: { name: "alpha", newName: "beta", path: "/workspace/src/app.ts", line: 0 },
      files: [
        {
          path: "/workspace/src/app.ts",
          beforeContent: "alpha\n",
          edits: [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5, newText: "beta" }],
        },
      ],
      fingerprint: {
        files: [{ path: "/workspace/src/app.ts", exists: true, sha256: hashContent("alpha\n") }],
        graphVersion: 1,
      },
    },
  };
}

function historyEntry(): ChangeHistoryEntry {
  return {
    id: "history-1",
    planId: "plan-1",
    kind: "rename",
    source: "mcp",
    createdAt: 1,
    status: "succeeded",
    files: [{ path: "/workspace/src/app.ts", change: "modified", beforeHash: "a", afterHash: "b" }],
    beforeCommit: "before",
    afterCommit: "after",
    target: { name: "alpha", newName: "beta", path: "/workspace/src/app.ts", line: 0 },
  };
}

describe("MCP change tools", () => {
  let root: string;
  let stop: (() => void) | null = null;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skein-mcp-change-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, FILE), "alpha\n", "utf8");
  });

  afterEach(async () => {
    stop?.();
    stop = null;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  /** Stands in for the extension: answers queued requests with canned results. */
  function respondWith(answer: (request: ReturnType<typeof parseChangeRequest>) => unknown): void {
    let disposed = false;
    stop = () => {
      disposed = true;
    };
    const loop = async (): Promise<void> => {
      while (!disposed) {
        const directory = path.join(root, ".skein", "commands");
        let names: string[] = [];
        try {
          names = await fs.readdir(directory);
        } catch {
          // not created yet
        }
        for (const name of names) {
          if (!name.endsWith(".request.json")) continue;
          const file = path.join(directory, name);
          const request = parseChangeRequest(await fs.readFile(file, "utf8"));
          if (!request) continue;
          const result = answer(request);
          await fs.writeFile(
            path.join(directory, `${request.id}.result.json`),
            JSON.stringify(result),
            "utf8",
          );
          await fs.rm(file, { force: true });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    void loop();
  }

  it("plans a rename through the queue and summarizes the task", async () => {
    respondWith((request) => ({
      id: request!.id,
      status: "applied",
      completedAt: Date.now(),
      task: task("plan-1"),
    }));
    const result = await executePlanChange(root, {
      kind: "rename",
      path: path.join(root, FILE),
      name: "alpha",
      line: 0,
      newName: "beta",
    });
    expect(result.applied).toBe(true);
    expect(result.plan?.planId).toBe("plan-1");
    expect(result.diff).toContain("+beta");
    expect(await fs.stat(path.join(root, ".skein", "commands", "x.result.json")).catch(() => null)).toBeNull();
  });

  it("rejects a plan for a path outside the workspace", async () => {
    const result = await executePlanChange(root, {
      kind: "rename",
      path: "/elsewhere/app.ts",
      name: "alpha",
      line: 0,
      newName: "beta",
    });
    expect(result).toMatchObject({ applied: false, reason: "path-outside-workspace" });
  });

  it("fails explicitly when the extension does not answer", async () => {
    const result = await executePlanChange(root, {
      kind: "rename",
      nodeId: "/workspace/src/app.ts:alpha:0",
      newName: "beta",
      timeoutMs: 150,
    });
    expect(result.status).toBe("error");
    expect(result.reason).toBe("extension-not-responding");
    const files = await fs.readdir(path.join(root, ".skein", "commands"));
    expect(files.filter((name) => name.endsWith(".request.json"))).toEqual([]);
  });

  it("queues move, extract and inline plans with their parameters", async () => {
    const seen: Array<Record<string, unknown>> = [];
    respondWith((request) => {
      seen.push(request!.command as unknown as Record<string, unknown>);
      return {
        id: request!.id,
        status: "applied",
        completedAt: Date.now(),
        task: task("plan-1"),
      };
    });
    await executePlanChange(root, {
      kind: "move",
      path: path.join(root, FILE),
      name: "alpha",
      line: 0,
      newPath: path.join(root, "src/moved.ts"),
    });
    await executePlanChange(root, {
      kind: "extract",
      path: path.join(root, FILE),
      name: "extracted",
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: 5,
    });
    await executePlanChange(root, {
      kind: "inline",
      path: path.join(root, FILE),
      name: "alpha",
      line: 0,
      callLine: 2,
      callCharacter: 10,
    });
    expect(seen[0]).toMatchObject({
      kind: "move",
      newPath: path.join(root, "src/moved.ts"),
    });
    expect(seen[1]).toMatchObject({
      kind: "extract",
      selection: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 },
    });
    expect(seen[2]).toMatchObject({ kind: "inline", callLine: 2, callCharacter: 10 });
  });

  it("rejects a move destination outside the workspace", async () => {
    const result = await executePlanChange(root, {
      kind: "move",
      path: path.join(root, FILE),
      name: "alpha",
      line: 0,
      newPath: "/elsewhere/moved.ts",
    });
    expect(result).toMatchObject({ applied: false, reason: "path-outside-workspace" });
  });

  it("applies, undoes and redoes through the queue", async () => {
    const entry = historyEntry();
    respondWith((request) => ({
      id: request!.id,
      status: "applied",
      completedAt: Date.now(),
      task: task("plan-2"),
      history: entry,
    }));
    const applied = await executeApplyChange(root, { planId: "plan-1" });
    expect(applied.applied).toBe(true);
    expect(applied.history?.id).toBe("history-1");
    await writeChangeHistory(root, {
      schemaVersion: SKEIN_CHANGE_SCHEMA_VERSION,
      entries: [entry],
    });

    const undone = await executeUndoChange(root, { historyId: "history-1" });
    expect(undone.status).toBe("applied");
    const redone = await executeRedoChange(root, {});
    expect(redone.status).toBe("applied");
  });

  it("rejects undo for an entry that is not undoable", async () => {
    const index = {
      schemaVersion: SKEIN_CHANGE_SCHEMA_VERSION,
      entries: [
        historyEntry(),
        { ...historyEntry(), id: "history-2", kind: "undo" as const, undoTargetId: "history-1" },
      ],
    };
    await writeChangeHistory(root, index);
    const result = await executeUndoChange(root, { historyId: "history-1" });
    expect(result).toMatchObject({ applied: false, reason: "not-undoable" });
  });

  it("reads a stored plan and history directly", async () => {
    await writeChangeTask(root, task("plan-1"));
    const plan = await executeGetChangePlan(root, { planId: "plan-1" });
    expect(plan.available).toBe(true);
    expect(plan.plan?.files[0].path).toBe("/workspace/src/app.ts");
    expect(applyTextEdits("alpha\n", task("plan-1").plan.files[0].edits)).toBe("beta\n");

    await writeChangeHistory(root, {
      schemaVersion: SKEIN_CHANGE_SCHEMA_VERSION,
      entries: [historyEntry()],
    });
    const history = await executeListChangeHistory(root, { limit: 10 });
    expect(history.total).toBe(1);
    expect(history.undoable).toBe("history-1");
    expect(history.entries[0].status).toBe("succeeded");
  });

  it("reports a missing plan", async () => {
    expect(await executeGetChangePlan(root, { planId: "nope" })).toEqual({
      available: false,
      reason: "plan-not-found",
    });
    expect(await executeApplyChange(undefined, { planId: "nope" })).toMatchObject({
      reason: "workspace-not-configured",
    });
  });
});
