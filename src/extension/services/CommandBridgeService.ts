/**
 * One poller for every command the MCP server queues in `.skein/commands/`.
 *
 * View commands go to `ViewStateService`, change commands to `ChangeService`.
 * Keeping a single reader avoids two services racing over the same directory,
 * and the `targetWindowId` rule stays in one place (DESIGN 10.2).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import {
  deleteCommandRequest,
  parseCommandRequest,
  pruneCommandFiles,
  readCommandResult,
  writeCommandResult,
  type SkeinCommandRequest,
  type SkeinCommandResult,
} from "@/shared/viewState";
import {
  deleteChangeRequest,
  parseChangeRequest,
  readChangeResult,
  writeChangeResult,
  type SkeinChangeRequest,
  type SkeinChangeResult,
} from "@/shared/change";

/** Commands and results a crashed run left behind are dropped after a day. */
const STALE_COMMAND_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CommandBridgeOptions {
  root: string;
  logger: { warn(message: string, ...args: unknown[]): void };
  /** Window id of this extension host, for `targetWindowId`. */
  windowId: () => string;
  view: { handleCommand(request: SkeinCommandRequest): Promise<SkeinCommandResult> };
  change: { handleRequest(request: SkeinChangeRequest): Promise<SkeinChangeResult> };
  pollIntervalMs?: number;
}

type QueuedCommand =
  | { id: string; createdAt: number; targetWindowId?: string; file: string; kind: "view"; view: SkeinCommandRequest }
  | { id: string; createdAt: number; targetWindowId?: string; file: string; kind: "change"; change: SkeinChangeRequest };

export class CommandBridgeService implements vscode.Disposable {
  private root: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private disposed = false;

  constructor(private readonly options: CommandBridgeOptions) {
    this.root = options.root;
  }

  async start(): Promise<void> {
    await this.prune();
    this.timer = setInterval(
      () => void this.tick(),
      this.options.pollIntervalMs ?? 500,
    );
    this.timer.unref?.();
  }

  async setRoot(root: string): Promise<void> {
    if (root === this.root) return;
    this.root = root;
    await this.prune();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async prune(): Promise<void> {
    try {
      await pruneCommandFiles(this.root, STALE_COMMAND_MAX_AGE_MS);
    } catch (err) {
      this.options.logger.warn("[CommandBridge] prune failed:", err);
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    try {
      const commands = await this.listQueued();
      /* eslint-disable no-await-in-loop -- commands are applied in queue order */
      for (const command of commands) {
        if (this.disposed) return;
        if (
          command.targetWindowId &&
          command.targetWindowId !== this.options.windowId()
        ) {
          continue;
        }
        await this.execute(command);
      }
      /* eslint-enable no-await-in-loop */
    } catch (err) {
      this.options.logger.warn("[CommandBridge] poll failed:", err);
    } finally {
      this.busy = false;
    }
  }

  private async execute(command: QueuedCommand): Promise<void> {
    // The MCP side deletes its request when it stops waiting. A request listed
    // before that must not run after it: the caller already saw a failure.
    try {
      await fs.access(command.file);
    } catch {
      return;
    }
    // A result file means an earlier attempt already ran the command and only
    // the request cleanup failed; re-running undo/redo would apply it twice.
    if (command.kind === "change") {
      if (!(await readChangeResult(this.root, command.id))) {
        const result = await this.options.change.handleRequest(command.change);
        await writeChangeResult(this.root, result);
      }
      await deleteChangeRequest(this.root, command.id);
      return;
    }
    if (!(await readCommandResult(this.root, command.id))) {
      const result = await this.options.view.handleCommand(command.view);
      await writeCommandResult(this.root, result);
    }
    await deleteCommandRequest(this.root, command.id);
  }

  /** Both request kinds, oldest first; malformed files are pruned by age. */
  private async listQueued(): Promise<QueuedCommand[]> {
    const directory = path.join(this.root, ".skein", "commands");
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch {
      return [];
    }
    const commands: QueuedCommand[] = [];
    /* eslint-disable no-await-in-loop -- one small file per queued command */
    for (const name of names) {
      if (!name.endsWith(".request.json")) continue;
      const file = path.join(directory, name);
      let raw: string;
      try {
        raw = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const change = parseChangeRequest(raw);
      if (change) {
        commands.push({
          id: change.id,
          createdAt: change.createdAt,
          ...(change.targetWindowId ? { targetWindowId: change.targetWindowId } : {}),
          file,
          kind: "change",
          change,
        });
        continue;
      }
      const view = parseCommandRequest(raw);
      if (view) {
        commands.push({
          id: view.id,
          createdAt: view.createdAt,
          ...(view.targetWindowId ? { targetWindowId: view.targetWindowId } : {}),
          file,
          kind: "view",
          view,
        });
      }
    }
    /* eslint-enable no-await-in-loop */
    return commands.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }
}
