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
  ChangeArchitectureSnapshot,
  ChangeHistoryEntry,
  ChangePlan,
  ChangeConflict,
  ChangeRequestSource,
  ChangeSelectionRange,
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
import {
  buildExtractRefactor,
  buildInlineRefactor,
  buildMoveRefactor,
  languageForPath,
  type RefactorIo,
  type RefactorSymbol,
} from "@/analyzer/change/refactor";
import { mergeThreeWay } from "@/analyzer/change/threeWayMerge";
import { architectureAfterChange } from "@/analyzer/diagnostics/changeArchitecture";
import { inspectTaskState, recoverInterruptedTasks, withChangeLock } from "@/analyzer/change/taskStore";
import type { ChangeEditorHost } from "./changeHost";

/** Confirmed architecture findings around a change; implemented with the workspace analyzer. */
export interface ChangeArchitectureGuard {
  check(files: readonly string[]): Promise<ChangeArchitectureSnapshot>;
}

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
  /** Declared architecture rules, when the workspace has them; absent disables the gate. */
  architectureGuard?: ChangeArchitectureGuard;
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

export interface PlanMoveInput {
  nodeId?: string;
  path?: string;
  name?: string;
  line?: number;
  newPath: string;
  source: ChangeRequestSource;
  graphVersion: number;
}

export interface PlanExtractInput {
  path: string;
  selection: ChangeSelectionRange;
  name: string;
  source: ChangeRequestSource;
  graphVersion: number;
}

export interface PlanInlineInput {
  nodeId?: string;
  path?: string;
  name?: string;
  line?: number;
  callLine?: number;
  callCharacter?: number;
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
  "target-not-found": "The symbol to change is no longer in the graph.",
  "symbol-not-found": "The language service could not find the symbol declaration.",
  "ambiguous-symbol": "More than one symbol in this file has that name.",
  "symbol-lookup-failed": "The editor could not read this file's symbols.",
  "reference-provider-unavailable": "No reference provider is installed for this language.",
  "unsupported-language": "This change is not supported for the file's language yet.",
  "unsupported-symbol-kind": "This symbol kind cannot be moved.",
  "nested-symbol": "Move a top-level symbol, not a member of another declaration.",
  "entry-point": "Framework entry points cannot be moved automatically.",
  "access-restricted": "The symbol is private to its library and would lose access after the move.",
  "name-collision": "The destination already declares a symbol with this name.",
  "unresolved-import": "A referencing file's import could not be updated confidently.",
  "circular-import": "The move would create a circular import between the two files.",
  "bundle-too-large": "The move bundle grew beyond the safe limit.",
  "same-file": "The destination is the current file.",
  "empty-selection": "Select code to extract first.",
  "invalid-name": "The new function name is not a valid identifier.",
  "extract-params-unsupported": "The enclosing function has parameters this tool cannot read.",
  "extract-uses-this": "Extracting code that uses this is not supported yet.",
  "extract-await-in-sync": "The selection awaits inside a synchronous function.",
  "extract-declaration-used-after": "The selection declares a name that is used after it, so it cannot be extracted as is.",
  "inline-exported-unsupported": "Exported functions cannot be inlined because other modules import them.",
  "inline-unsupported-symbol": "Only top-level functions can be inlined.",
  "inline-async-unsupported": "Async or generator functions cannot be inlined yet.",
  "inline-multiple-returns": "A function with more than one return cannot be inlined.",
  "inline-params-unsupported": "The parameter list uses patterns this tool cannot substitute.",
  "inline-unsupported-declaration": "The function body is not a single expression.",
  "inline-statement-body-unsupported": "A statement body cannot be inlined as an expression.",
  "inline-recursive": "A recursive function cannot be inlined.",
  "inline-no-call-sites": "No call sites were found for this function.",
  "inline-external-references": "The function is used outside its file.",
  "inline-call-not-found": "The selected call site could not be read.",
  "inline-arity-mismatch": "A call passes a different number of arguments.",
  "inline-overlapping-calls": "Two selected calls overlap.",
  "rename-provider-unavailable": "No rename provider is installed for this language.",
  "rename-failed": "The language service refused the rename.",
  "unsupported-uri": "The rename touches a file outside the workspace.",
  "unsaved-changes": "Save the changed files before applying a change.",
  "architecture-blocked": "The change would introduce or worsen a confirmed architecture violation. Fix it or record an exception first.",
  "architecture-config-error": "skein.architecture.json could not be checked, so the change was not applied.",
  "architecture-violation": "The change introduced or worsened a confirmed architecture violation.",
  "architecture-unavailable": "The architecture check could not run; the change is not reported as verified.",
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

  /** Creates a move plan; files are only read. */
  async planMove(input: PlanMoveInput): Promise<ChangeResult> {
    const resolved = await this.resolveRefactorTarget(input);
    if ("error" in resolved) return { ok: false, reason: resolved.error };
    const sourcePath = normalizePath(resolved.path);
    const destinationPath = normalizePath(input.newPath);
    const targetLanguage = languageForPath(sourcePath);
    if (targetLanguage === "unknown" || languageForPath(destinationPath) !== targetLanguage) {
      return { ok: false, reason: "unsupported-language" };
    }
    if ((await this.options.host.exists(destinationPath)) &&
        (await this.options.host.readSavedContent(destinationPath)) === null) {
      return { ok: false, reason: "file-not-readable", files: [destinationPath] };
    }
    const io = this.refactorIo();
    const result = await buildMoveRefactor({
      sourcePath,
      destinationPath,
      symbol: resolved.symbol,
      io,
    });
    if (!result.ok) return { ok: false, reason: result.reason, files: result.files };
    const dirty = result.build.touchedFiles.filter((file) => this.options.host.isDirty(file));
    if (dirty.length > 0) return { ok: false, reason: "unsaved-changes", files: dirty };
    const built = buildChangePlan({
      id: this.createPlanId(),
      kind: "move",
      root: this.root,
      graphVersion: input.graphVersion,
      source: input.source,
      contents: result.build.contents,
      files: result.build.files,
      target: result.build.target,
      analysis: result.build.analysis,
      now: this.now(),
    });
    if (!built.ok) return { ok: false, reason: built.reason };
    return this.storePlan(built.plan);
  }

  /** Creates a function-extraction plan for an editor selection. */
  async planExtract(input: PlanExtractInput): Promise<ChangeResult> {
    const sourcePath = normalizePath(input.path);
    if (this.options.host.isDirty(sourcePath)) {
      return { ok: false, reason: "unsaved-changes", files: [sourcePath] };
    }
    const content = await this.options.host.readSavedContent(sourcePath);
    if (content === null) return { ok: false, reason: "file-not-readable", files: [sourcePath] };
    const symbols = await this.options.host.listSymbols(sourcePath);
    if ("error" in symbols) return { ok: false, reason: symbols.error, files: [sourcePath] };
    const result = buildExtractRefactor({
      sourcePath,
      content,
      symbols: symbols.symbols,
      selection: input.selection,
      name: input.name,
    });
    if (!result.ok) return { ok: false, reason: result.reason, files: result.files };
    const built = buildChangePlan({
      id: this.createPlanId(),
      kind: "extract",
      root: this.root,
      graphVersion: input.graphVersion,
      source: input.source,
      contents: result.build.contents,
      files: result.build.files,
      target: result.build.target,
      analysis: result.build.analysis,
      now: this.now(),
    });
    if (!built.ok) return { ok: false, reason: built.reason };
    return this.storePlan(built.plan);
  }

  /** Creates an inline plan for one call site or every call site. */
  async planInline(input: PlanInlineInput): Promise<ChangeResult> {
    const resolved = await this.resolveRefactorTarget(input);
    if ("error" in resolved) return { ok: false, reason: resolved.error };
    const sourcePath = normalizePath(resolved.path);
    if (this.options.host.isDirty(sourcePath)) {
      return { ok: false, reason: "unsaved-changes", files: [sourcePath] };
    }
    const content = await this.options.host.readSavedContent(sourcePath);
    if (content === null) return { ok: false, reason: "file-not-readable", files: [sourcePath] };
    const references = await this.options.host.findReferences(sourcePath, resolved.symbol);
    if ("error" in references) return { ok: false, reason: references.error, files: [sourcePath] };
    const result = buildInlineRefactor({
      sourcePath,
      content,
      symbol: resolved.symbol,
      references: references.references,
      ...(input.callLine !== undefined ? { callLine: input.callLine } : {}),
      ...(input.callCharacter !== undefined ? { callCharacter: input.callCharacter } : {}),
    });
    if (!result.ok) return { ok: false, reason: result.reason, files: result.files };
    const built = buildChangePlan({
      id: this.createPlanId(),
      kind: "inline",
      root: this.root,
      graphVersion: input.graphVersion,
      source: input.source,
      contents: result.build.contents,
      files: result.build.files,
      target: result.build.target,
      analysis: result.build.analysis,
      now: this.now(),
    });
    if (!built.ok) return { ok: false, reason: built.reason };
    return this.storePlan(built.plan);
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
          switch (action.kind) {
            case "rename":
              result = await this.planRename({
                nodeId: action.nodeId,
                path: action.path,
                name: action.name,
                line: action.line,
                newName: action.newName ?? "",
                source: "mcp",
                graphVersion: request.graphVersion ?? 0,
              });
              break;
            case "move":
              result = await this.planMove({
                nodeId: action.nodeId,
                path: action.path,
                name: action.name,
                line: action.line,
                newPath: action.newPath ?? "",
                source: "mcp",
                graphVersion: request.graphVersion ?? 0,
              });
              break;
            case "extract":
              result = await this.planExtract({
                path: action.path ?? "",
                selection: action.selection!,
                name: action.name ?? "",
                source: "mcp",
                graphVersion: request.graphVersion ?? 0,
              });
              break;
            case "inline":
              result = await this.planInline({
                nodeId: action.nodeId,
                path: action.path,
                name: action.name,
                line: action.line,
                callLine: action.callLine,
                callCharacter: action.callCharacter,
                source: "mcp",
                graphVersion: request.graphVersion ?? 0,
              });
              break;
          }
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

  private async resolveRefactorTarget(input: {
    nodeId?: string;
    path?: string;
    name?: string;
    line?: number;
  }): Promise<{ path: string; symbol: RefactorSymbol } | { error: string }> {
    const target = this.resolveTarget({
      ...input,
      newName: "",
      source: "ui",
      graphVersion: 0,
    });
    if (!target) return { error: "target-not-found" };
    const sourcePath = normalizePath(target.path);
    const lookup = await this.options.host.listSymbols(sourcePath);
    if ("error" in lookup) return { error: lookup.error };
    const matching = lookup.symbols.filter(
      (symbol) =>
        symbol.name === target.name &&
        (symbol.startLine === target.line ||
          (symbol.startLine <= target.line && symbol.endLine >= target.line)),
    );
    if (matching.length === 0) {
      const byName = lookup.symbols.filter((symbol) => symbol.name === target.name);
      if (byName.length === 1) matching.push(byName[0]);
      else if (byName.length > 1) return { error: "ambiguous-symbol" };
    }
    if (matching.length === 0) return { error: "symbol-not-found" };
    matching.sort((left, right) => {
      const leftSpan = left.endLine - left.startLine;
      const rightSpan = right.endLine - right.startLine;
      return leftSpan - rightSpan;
    });
    return { path: sourcePath, symbol: matching[0] };
  }

  private refactorIo(): RefactorIo {
    return {
      listSymbols: async (filePath) => {
        const lookup = await this.options.host.listSymbols(filePath);
        return "error" in lookup ? lookup : lookup.symbols;
      },
      findReferences: (symbol, filePath) => this.options.host.findReferences(filePath, symbol),
      readFile: (filePath) => this.options.host.readSavedContent(filePath),
    };
  }

  private async storePlan(plan: ChangePlan): Promise<ChangeResult> {
    const task = this.newTask(plan);
    try {
      await withChangeLock(this.root, () => writeChangeTask(this.root, task));
    } catch (err) {
      return { ok: false, reason: this.errorReason(err, "plan-store-failed") };
    }
    return { ok: true, task };
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
    let architectureBefore: ChangeArchitectureSnapshot | undefined;
    if (this.options.architectureGuard !== undefined) {
      architectureBefore = await this.checkArchitecture(paths);
      if (architectureBefore.status === "blocked") {
        task.reason = "architecture-blocked";
        await this.saveTask(task);
        return { ok: false, reason: "architecture-blocked", files: paths, task };
      }
      if (architectureBefore.status === "config-error") {
        task.reason = "architecture-config-error";
        await this.saveTask(task);
        return { ok: false, reason: "architecture-config-error", files: paths, task };
      }
    }
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
      if (current !== expected) mismatch.push(file.path);
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

    const verification = await this.verify(task, baseline, architectureBefore);
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
    architectureBefore: ChangeArchitectureSnapshot | undefined,
  ): Promise<ChangeVerification> {
    const paths = task.plan.files.map((file) => file.path);
    const checkedAt = this.now();
    const notRun = { status: "not-run" as const, reason: "step-5" };
    const architecture = await this.verifyArchitecture(paths, architectureBefore, checkedAt);
    const architectureFailed = architecture.status === "failed";
    const architectureIncomplete = architecture.status === "unavailable";
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
        status: newErrors.length > 0 || architectureFailed
          ? "failed"
          : architectureIncomplete
            ? "incomplete"
            : "passed",
        checkedAt,
        files,
        tests: notRun,
        architecture,
      };
      if (newErrors.length > 0) verification.reason = "new-errors";
      else if (architectureFailed) verification.reason = "architecture-violation";
      else if (architectureIncomplete) verification.reason = "architecture-unavailable";
      return verification;
    } catch {
      return {
        status: "incomplete",
        checkedAt,
        reason: "diagnostics-unavailable",
        files: [],
        tests: notRun,
        architecture,
      };
    }
  }

  /** Runs the architecture guard again after apply and compares it with the pre-apply snapshot. */
  private async verifyArchitecture(
    files: readonly string[],
    before: ChangeArchitectureSnapshot | undefined,
    checkedAt: number,
  ): Promise<ChangeVerification["architecture"]> {
    if (this.options.architectureGuard === undefined) return { status: "not-run", reason: "step-7" };
    if (before === undefined) return { status: "unavailable", checkedAt, findings: [], message: "no architecture check ran before apply" };
    try {
      const after = await this.options.architectureGuard.check(files);
      return { ...architectureAfterChange(before, after), checkedAt };
    } catch (error) {
      return {
        status: "unavailable",
        checkedAt,
        findings: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** The pre-apply snapshot: a throw is reported as unavailable, never as a pass. */
  private async checkArchitecture(files: readonly string[]): Promise<ChangeArchitectureSnapshot> {
    try {
      return await this.options.architectureGuard!.check(files);
    } catch (error) {
      return {
        status: "unavailable",
        checkedAt: this.now(),
        findings: [],
        message: error instanceof Error ? error.message : String(error),
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
          change: file.delete ? "deleted" : fingerprint?.exists === false ? "created" : "modified",
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
      const baseText = await this.historyRepo.readText(entry.afterCommit, filePath);
      const targetText = await this.historyRepo.readText(entry.beforeCommit, filePath);
      if (baseText === null && targetText === null) continue;
      if (current === null) {
        if (targetText === null) continue;
        if (baseText !== null) {
          conflicts.push({ path: filePath, conflicts: 1, hunk: "" });
          continue;
        }
        files.push({
          path: filePath,
          edits: [replaceWholeFileEdit("", targetText)],
          create: true,
        });
        continue;
      }
      if (targetText === null) {
        if (baseText !== null && current !== normalizeEol(baseText)) {
          conflicts.push({ path: filePath, conflicts: 1, hunk: "" });
          continue;
        }
        contents.set(filePath, current);
        files.push({ path: filePath, edits: [], delete: true });
        continue;
      }
      if (baseText === null) {
        conflicts.push({ path: filePath, conflicts: 1, hunk: "" });
        continue;
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
