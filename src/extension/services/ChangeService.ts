/**
 * Common change path: plan → history → apply → verify → undo (DESIGN 8, 9).
 *
 * One change runs at a time. The plan is computed against saved content, the
 * before/after state is recorded in the internal Git repository before the
 * workspace is touched, and verification compares diagnostics that already
 * existed with the ones after the edit. A failure never triggers an automatic
 * rollback: the task keeps its before/after commits and the recovery state so
 * the user can inspect the diff and choose undo.
 *
 * The VS Code surface is behind `ChangeEditorHost`; this class has no `vscode`
 * import so the whole flow is unit-testable.
 */

import type {
  ChangeHistoryEntry,
  ChangePlan,
  ChangeConflict,
  ChangeRequestSource,
  ChangeTask,
  ChangeVerification,
  SkeinChangeRequest,
  SkeinChangeResult,
} from "@/shared/change";
import {
  SKEIN_CHANGE_SCHEMA_VERSION,
  appendChangeHistoryEntry,
  findRedoCandidate,
  findUndoCandidate,
  hashContent,
  normalizeEol,
  readChangeHistory,
  readChangeTask,
  replaceWholeFileEdit,
  writeChangeTask,
} from "@/shared/change";
import { normalizePath } from "@/shared/path";
import {
  buildChangePlan,
  fileAfterContent,
  materializePreview,
  type ChangePreviewFile,
  type RawFileEdit,
} from "@/analyzer/change/changePlan";
import { compareFingerprint } from "@/analyzer/change/fingerprint";
import { HistoryRepo } from "@/analyzer/change/historyRepo";
import { mergeThreeWay } from "@/analyzer/change/threeWayMerge";
import { inspectTaskState, recoverInterruptedTasks, withChangeLock } from "@/analyzer/change/taskStore";
import type { ChangeEditorHost } from "./changeHost";

export interface ChangeServiceOptions {
  root: string;
  logger: {
    debug(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
  };
  host: ChangeEditorHost;
  history?: HistoryRepo;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Extra diagnostic polls while a just-applied edit is still settling. */
  verificationRetries?: number;
}

export interface ChangeResult {
  ok: boolean;
  reason?: string;
  task?: ChangeTask;
  history?: ChangeHistoryEntry;
  files?: string[];
  conflicts?: ChangeConflict[];
}

export interface PlanRenameInput {
  nodeId?: string;
  path?: string;
  name?: string;
  line?: number;
  newName: string;
  source: ChangeRequestSource;
  graphVersion: number;
}

interface Target {
  nodeId?: string;
  path: string;
  name: string;
  line: number;
}

const REASON_MESSAGES: Record<string, string> = {
  "target-not-found": "The symbol to rename is no longer in the graph.",
  "symbol-not-found": "The language service could not find the symbol declaration.",
  "rename-provider-unavailable": "No rename provider is installed for this language.",
  "rename-failed": "The language service refused the rename.",
  "unsupported-uri": "The rename touches a file outside the workspace.",
  "unsaved-changes": "Save the changed files before applying a change.",
  "stale-plan": "The code changed after the plan was created; create a new plan.",
  "plan-not-found": "The change plan no longer exists.",
  "plan-not-ready": "This plan has already been applied or cancelled.",
  "history-unavailable": "The internal history could not record the change, so nothing was applied.",
  "history-record-failed": "The change was applied but could not be recorded; recovery is required.",
  "history-incomplete": "The recorded before/after state is incomplete.",
  "apply-failed": "The edit was not applied.",
  "save-failed": "VS Code could not save the edited files.",
  "partial-apply": "Only some files were changed; recovery is required.",
  "merge-unavailable": "The merge tool is unavailable.",
  "merge-failed": "The three-way merge failed.",
  conflict: "Your later edits conflict with this change; nothing was overwritten.",
  "nothing-to-undo": "There is no applied change to undo.",
  "nothing-to-redo": "There is no undone change to re-apply.",
  "no-changes": "The change would not modify any file.",
  "file-not-readable": "A planned file can no longer be read.",
  "invalid-edit": "The language service returned an edit this tool cannot apply.",
};

export function describeReason(reason: string): string {
  return REASON_MESSAGES[reason] ?? reason;
}

function targetFromNodeId(nodeId: string): Target | undefined {
  const parts = nodeId.split(":");
  if (parts.length < 3) return undefined;
  const line = Number(parts.pop());
  const name = parts.pop();
  const filePath = parts.join(":");
  if (!name || !Number.isFinite(line) || line < 0 || filePath.length === 0) return undefined;
  return { nodeId, path: filePath, name, line };
}

/** First conflicting hunk, so the caller can show where the merge stopped. */
function conflictHunk(content: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.startsWith("<<<<<<<"));
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && line.startsWith(">>>>>>>"));
  return lines.slice(start, end === -1 ? start + 20 : end + 1).join("\n");
}

export class ChangeService {
  private root: string;
  private historyRepo: HistoryRepo;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ChangeServiceOptions) {
    this.root = options.root;
    this.historyRepo = options.history ?? new HistoryRepo(options.root);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  getRoot(): string {
    return this.root;
  }

  /** Applies to the active workspace area (multi-root). */
  async setRoot(root: string): Promise<void> {
    if (normalizePath(root) === normalizePath(this.root)) return;
    this.root = root;
    this.historyRepo = new HistoryRepo(root);
    await this.start();
  }

  async start(): Promise<void> {
    try {
      const reports = await recoverInterruptedTasks(this.root);
      for (const report of reports) {
        this.options.logger.warn(
          `[Change] Recovered interrupted plan ${report.planId}: ${report.state}` +
            (report.files.length > 0 ? ` (${report.files.join(", ")})` : ""),
        );
      }
    } catch (err) {
      this.options.logger.warn("[Change] Recovery scan failed:", err);
    }
  }

  /** Creates a rename plan; no file is modified. */
  async planRename(input: PlanRenameInput): Promise<ChangeResult> {
    const target = this.resolveTarget(input);
    if (!target) return { ok: false, reason: "target-not-found" };

    const resolution = await this.options.host.resolveRename({
      path: target.path,
      name: target.name,
      line: target.line,
      newName: input.newName,
    });
    if ("error" in resolution) {
      return { ok: false, reason: resolution.error };
    }

    const contents = new Map<string, string>();
    /* eslint-disable no-await-in-loop -- read each edited file once */
    for (const file of resolution.files) {
      const filePath = normalizePath(file.path);
      if (this.options.host.isDirty(filePath)) {
        return { ok: false, reason: "unsaved-changes", files: [filePath] };
      }
      const content = await this.options.host.readSavedContent(filePath);
      if (content === null) return { ok: false, reason: "file-not-readable", files: [filePath] };
      contents.set(filePath, content);
    }
    /* eslint-enable no-await-in-loop */

    const built = buildChangePlan({
      id: this.createPlanId(),
      kind: "rename",
      root: this.root,
      graphVersion: input.graphVersion,
      source: input.source,
      contents,
      files: resolution.files.map((file) => ({ path: normalizePath(file.path), edits: file.edits })),
      target: {
        nodeId: target.nodeId,
        name: target.name,
        newName: input.newName,
        path: normalizePath(target.path),
        line: target.line,
      },
      now: this.now(),
    });
    if (!built.ok) return { ok: false, reason: built.reason };

    const task = this.newTask(built.plan);
    try {
      await withChangeLock(this.root, () => writeChangeTask(this.root, task));
    } catch (err) {
      return { ok: false, reason: this.errorReason(err, "plan-store-failed") };
    }
    return { ok: true, task };
  }

  preview(task: ChangeTask): ChangePreviewFile[] {
    return materializePreview(task);
  }

  /** Applies a plan that is still `preview-ready`. */
  async apply(planId: string): Promise<ChangeResult> {
    return withChangeLock(this.root, async () => {
      const task = await readChangeTask(this.root, planId);
      if (!task) return { ok: false, reason: "plan-not-found" };
      return this.applyTaskLocked(task);
    });
  }

  async undo(historyId?: string): Promise<ChangeResult> {
    return withChangeLock(this.root, async () => {
      const index = await readChangeHistory(this.root);
      const entry = findUndoCandidate(index, historyId);
      if (!entry) return { ok: false, reason: "nothing-to-undo" };
      return this.reverseAndApplyLocked(entry, "undo");
    });
  }

  async redo(historyId?: string): Promise<ChangeResult> {
    return withChangeLock(this.root, async () => {
      const index = await readChangeHistory(this.root);
      const entry = findRedoCandidate(index, historyId);
      if (!entry) return { ok: false, reason: "nothing-to-redo" };
      return this.reverseAndApplyLocked(entry, "redo");
    });
  }

  /** Entry point used by the command bridge for MCP-queued changes. */
  async handleRequest(request: SkeinChangeRequest): Promise<SkeinChangeResult> {
    const base = { id: request.id, completedAt: this.now() };
    try {
      const action = request.command;
      let result: ChangeResult;
      switch (action.action) {
        case "change_plan":
          result = await this.planRename({
            nodeId: action.nodeId,
            path: action.path,
            name: action.name,
            line: action.line,
            newName: action.newName,
            source: "mcp",
            graphVersion: request.graphVersion ?? 0,
          });
          break;
        case "change_apply":
          result = await this.apply(action.planId);
          break;
        case "change_undo":
          result = await this.undo(action.historyId);
          break;
        case "change_redo":
          result = await this.redo(action.historyId);
          break;
      }
      return {
        ...base,
        status: result.ok ? "applied" : "rejected",
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.task ? { task: result.task } : {}),
        ...(result.history ? { history: result.history } : {}),
        ...(result.conflicts ? { conflicts: result.conflicts } : {}),
      };
    } catch (err) {
      this.options.logger.warn("[Change] request failed:", err);
      return {
        ...base,
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private resolveTarget(input: PlanRenameInput): Target | undefined {
    if (input.path && input.name && input.line !== undefined) {
      return { nodeId: input.nodeId, path: normalizePath(input.path), name: input.name, line: input.line };
    }
    if (!input.nodeId) return undefined;
    return targetFromNodeId(input.nodeId);
  }

  private newTask(plan: ChangePlan, status: ChangeTask["status"] = "preview-ready"): ChangeTask {
    const now = this.now();
    return {
      schemaVersion: SKEIN_CHANGE_SCHEMA_VERSION,
      plan,
      status,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async saveTask(task: ChangeTask): Promise<void> {
    task.updatedAt = this.now();
    await writeChangeTask(this.root, task);
  }

  private async applyTaskLocked(task: ChangeTask): Promise<ChangeResult> {
    if (task.status !== "preview-ready") return { ok: false, reason: "plan-not-ready", task };
    const fingerprintCheck = await compareFingerprint(task.plan.fingerprint);
    if (!fingerprintCheck.ok) {
      task.reason = fingerprintCheck.reason ?? "stale-plan";
      await this.saveTask(task);
      return { ok: false, reason: "stale-plan", files: fingerprintCheck.changed, task };
    }
    const dirty = task.plan.files.map((file) => file.path).filter((file) => this.options.host.isDirty(file));
    if (dirty.length > 0) return { ok: false, reason: "unsaved-changes", files: dirty, task };

    const paths = task.plan.files.map((file) => file.path);
    const baseline = new Map(paths.map((file) => [file, this.options.host.diagnostics(file)]));

    let beforeCommit: string;
    try {
      beforeCommit = await this.historyRepo.snapshot(`before ${task.plan.kind} ${task.plan.id}`, paths);
    } catch (err) {
      task.status = "apply-failed";
      task.reason = "history-unavailable";
      await this.saveTask(task);
      return { ok: false, reason: this.errorReason(err, "history-unavailable"), task };
    }

    task.status = "applying";
    await this.saveTask(task);

    const applied = await this.options.host.applyEdits(task.plan.files);
    if (!applied.ok) {
      const report = await inspectTaskState(task);
      task.status = report.state === "partial" ? "recovery" : "apply-failed";
      task.reason = applied.reason;
      await this.saveTask(task);
      return { ok: false, reason: applied.reason, files: report.files, task };
    }

    const mismatch: string[] = [];
    /* eslint-disable no-await-in-loop -- confirm each edited file after apply */
    for (const file of task.plan.files) {
      const expected = fileAfterContent(file);
      const current = await this.options.host.readSavedContent(file.path);
      if (expected === null || current !== expected) mismatch.push(file.path);
    }
    /* eslint-enable no-await-in-loop */
    if (mismatch.length > 0) {
      const report = await inspectTaskState(task);
      task.status = report.state === "partial" ? "recovery" : "apply-failed";
      task.reason = "partial-apply";
      await this.saveTask(task);
      return { ok: false, reason: "partial-apply", files: mismatch, task };
    }

    let afterCommit: string;
    try {
      afterCommit = await this.historyRepo.snapshot(`after ${task.plan.kind} ${task.plan.id}`, paths);
    } catch (err) {
      task.status = "incomplete";
      task.reason = "history-record-failed";
      await this.saveTask(task);
      return { ok: false, reason: this.errorReason(err, "history-record-failed"), task };
    }

    task.status = "verifying";
    await this.saveTask(task);

    const verification = await this.verify(task, baseline);
    task.verification = verification;
    task.status =
      verification.status === "passed"
        ? "succeeded"
        : verification.status === "failed"
          ? "verification-failed"
          : "incomplete";

    const entry = this.buildHistoryEntry(task, beforeCommit, afterCommit, verification);
    try {
      await appendChangeHistoryEntry(this.root, entry);
    } catch (err) {
      task.status = "incomplete";
      task.reason = "history-record-failed";
      await this.saveTask(task);
      return { ok: false, reason: this.errorReason(err, "history-record-failed"), task };
    }
    task.historyId = entry.id;
    await this.saveTask(task);
    return { ok: true, task, history: entry };
  }

  private async verify(
    task: ChangeTask,
    baseline: Map<string, ReturnType<ChangeEditorHost["diagnostics"]>>,
  ): Promise<ChangeVerification> {
    const paths = task.plan.files.map((file) => file.path);
    const checkedAt = this.now();
    const notRun = { status: "not-run" as const, reason: "step-5" };
    try {
      await this.options.host.waitForDiagnostics(paths);
      const retries = this.options.verificationRetries ?? 3;
      let samples = new Map(paths.map((file) => [file, this.options.host.diagnostics(file)]));
      /* eslint-disable no-await-in-loop -- wait for diagnostics to settle */
      for (let attempt = 0; attempt < retries; attempt += 1) {
        const newErrors = paths.some(
          (file) => samples.get(file)!.errors > (baseline.get(file)?.errors ?? 0),
        );
        if (!newErrors) break;
        if (attempt === retries - 1) break;
        await this.sleep(500);
        samples = new Map(paths.map((file) => [file, this.options.host.diagnostics(file)]));
      }
      /* eslint-enable no-await-in-loop */
      const newErrors = paths.filter(
        (file) => samples.get(file)!.errors > (baseline.get(file)?.errors ?? 0),
      );
      const files = paths.map((file) => ({
        path: file,
        before: baseline.get(file) ?? { errors: 0, warnings: 0, messages: [] },
        after: samples.get(file)!,
      }));
      const verification: ChangeVerification = {
        status: newErrors.length > 0 ? "failed" : "passed",
        checkedAt,
        files,
        tests: notRun,
        architecture: notRun,
      };
      if (newErrors.length > 0) verification.reason = "new-errors";
      return verification;
    } catch {
      return {
        status: "incomplete",
        checkedAt,
        reason: "diagnostics-unavailable",
        files: [],
        tests: notRun,
        architecture: notRun,
      };
    }
  }

  private buildHistoryEntry(
    task: ChangeTask,
    beforeCommit: string,
    afterCommit: string,
    verification: ChangeVerification,
  ): ChangeHistoryEntry {
    const entry: ChangeHistoryEntry = {
      id: `history-${task.plan.id}`,
      planId: task.plan.id,
      kind: task.plan.kind,
      source: task.plan.source,
      createdAt: this.now(),
      status:
        verification.status === "passed"
          ? "succeeded"
          : verification.status === "failed"
            ? "verification-failed"
            : "incomplete",
      files: task.plan.files.map((file) => {
        const fingerprint = task.plan.fingerprint.files.find((item) => item.path === file.path);
        const afterContent = fileAfterContent(file);
        return {
          path: file.path,
          change: fingerprint?.exists === false ? "created" : "modified",
          beforeHash: fingerprint?.sha256 ?? null,
          afterHash: afterContent === null ? null : hashContent(afterContent),
        };
      }),
      beforeCommit,
      afterCommit,
      verification,
    };
    if (task.plan.target) entry.target = task.plan.target;
    if (task.plan.kind === "undo" && task.plan.historyTargetId) {
      entry.undoTargetId = task.plan.historyTargetId;
    }
    if (task.plan.kind === "redo" && task.plan.historyTargetId) {
      entry.redoOfId = task.plan.historyTargetId;
    }
    return entry;
  }

  private async reverseAndApplyLocked(
    entry: ChangeHistoryEntry,
    kind: "undo" | "redo",
  ): Promise<ChangeResult> {
    const files: RawFileEdit[] = [];
    const contents = new Map<string, string>();
    const conflicts: ChangeConflict[] = [];

    /* eslint-disable no-await-in-loop -- merge each file in order */
    for (const file of entry.files) {
      const filePath = normalizePath(file.path);
      const current = await this.options.host.readSavedContent(filePath);
      if (current === null) return { ok: false, reason: "file-not-readable", files: [filePath] };
      const baseText = await this.historyRepo.readText(entry.afterCommit, filePath);
      const targetText = await this.historyRepo.readText(entry.beforeCommit, filePath);
      if (baseText === null || targetText === null) {
        return { ok: false, reason: "history-incomplete", files: [filePath] };
      }
      const base = normalizeEol(baseText);
      const target = normalizeEol(targetText);
      let replacement = target;
      if (current !== base) {
        const merge = await mergeThreeWay(current, base, target);
        if ("error" in merge) return { ok: false, reason: merge.error };
        if (!merge.clean) {
          conflicts.push({ path: filePath, conflicts: merge.conflicts, hunk: conflictHunk(merge.content) });
          continue;
        }
        replacement = normalizeEol(merge.content);
      }
      if (replacement === current) continue;
      contents.set(filePath, current);
      files.push({ path: filePath, edits: [replaceWholeFileEdit(current, replacement)] });
    }
    /* eslint-enable no-await-in-loop */

    if (conflicts.length > 0) return { ok: false, reason: "conflict", conflicts };
    if (files.length === 0) return { ok: false, reason: "no-changes" };

    const built = buildChangePlan({
      id: this.createPlanId(),
      kind,
      root: this.root,
      graphVersion: 0,
      source: entry.source,
      contents,
      files,
      historyTargetId: entry.id,
      now: this.now(),
      ...(entry.target ? { target: entry.target } : {}),
    });
    if (!built.ok) return { ok: false, reason: built.reason };

    const task = this.newTask(built.plan);
    await this.saveTask(task);
    return this.applyTaskLocked(task);
  }

  private createPlanId(): string {
    return `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private errorReason(err: unknown, fallback: string): string {
    if (err instanceof Error && "reason" in err && typeof err.reason === "string") {
      return err.reason;
    }
    this.options.logger.warn(`[Change] ${fallback}:`, err);
    return fallback;
  }
}
