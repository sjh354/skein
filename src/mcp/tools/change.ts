/**
 * MCP surface for the common change path (DESIGN 8, 9, 10).
 *
 * Plans and history are read from the files the extension published. Mutations
 * go through `.skein/commands/`, so the extension remains the only writer and
 * the same checks apply to a human and an agent. Without a live extension the
 * tools fail instead of editing files behind the screen.
 */

import { z } from "zod/v4";
import { isPathWithinRoot } from "../../shared/pathSecurity";
import {
  COMMAND_RESULT_POLL_MS,
  deleteCommandFiles,
  readViewState,
} from "../../shared/viewState";
import {
  canRedo,
  canUndo,
  createChangeId,
  findRedoCandidate,
  findUndoCandidate,
  readChangeHistory,
  readChangeResult,
  readChangeTask,
  summarizeHistoryEntry,
  writeChangeRequest,
  CHANGE_RESULT_TIMEOUT_MS,
  type ChangeConflict,
  type ChangeHistorySummary,
  type ChangePlanSummary,
  type SkeinChangeAction,
  type SkeinChangeCommandStatus,
  type SkeinChangeRequest,
  type SkeinChangeResult,
} from "../../shared/change";
import { planDiff, summarizeTask } from "../../analyzer/change/changePlan";

const MAX_DIFF_CHARS = 12_000;

const TimeoutSchema = z
  .number()
  .int()
  .min(100)
  .max(10_000)
  .optional()
  .describe(`How long to wait for the extension (default ${CHANGE_RESULT_TIMEOUT_MS} ms).`);

export const PlanChangeSchema = z.object({
  kind: z
    .enum(["rename", "move", "extract", "inline"])
    .describe("Change kind: rename, move, extract or inline."),
  nodeId: z
    .string()
    .min(1)
    .optional()
    .describe("Call graph node id from get_view_state, in the form <path>:<symbol>:<startLine>."),
  path: z.string().min(1).optional().describe("Absolute file path when nodeId is not available."),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Current symbol name, or the new function name for extract."),
  line: z.number().int().min(0).optional().describe("0-based declaration line, with path and name."),
  newName: z.string().min(1).optional().describe("New symbol name (rename)."),
  newPath: z.string().min(1).optional().describe("Destination file path (move)."),
  startLine: z.number().int().min(0).optional().describe("Selection start line (extract)."),
  startCharacter: z.number().int().min(0).optional().describe("Selection start character (extract)."),
  endLine: z.number().int().min(0).optional().describe("Selection end line (extract)."),
  endCharacter: z.number().int().min(0).optional().describe("Selection end character (extract)."),
  callLine: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Call site line to inline; omit to inline every call site."),
  callCharacter: z.number().int().min(0).optional().describe("Call site character with callLine."),
  timeoutMs: TimeoutSchema,
});

export type PlanChangeParams = z.infer<typeof PlanChangeSchema>;

export const ApplyChangeSchema = z.object({
  planId: z.string().min(1).describe("planId returned by skein_plan_change."),
  timeoutMs: TimeoutSchema,
});

export type ApplyChangeParams = z.infer<typeof ApplyChangeSchema>;

export const GetChangePlanSchema = z.object({
  planId: z.string().min(1).describe("planId returned by skein_plan_change."),
});

export type GetChangePlanParams = z.infer<typeof GetChangePlanSchema>;

export const ListChangeHistorySchema = z.object({
  limit: z.number().int().min(1).max(200).optional().describe("Newest entries to return (default 20)."),
});

export type ListChangeHistoryParams = z.infer<typeof ListChangeHistorySchema>;

export const UndoChangeSchema = z.object({
  historyId: z
    .string()
    .min(1)
    .optional()
    .describe("History entry to undo; defaults to the newest undoable entry."),
  timeoutMs: TimeoutSchema,
});

export type UndoChangeParams = z.infer<typeof UndoChangeSchema>;

export const RedoChangeSchema = z.object({
  historyId: z
    .string()
    .min(1)
    .optional()
    .describe("Undo entry to re-apply; defaults to the newest one that has not been redone."),
  timeoutMs: TimeoutSchema,
});

export type RedoChangeParams = z.infer<typeof RedoChangeSchema>;

export interface ChangeToolResult {
  applied: boolean;
  status: SkeinChangeCommandStatus;
  reason?: string;
  plan?: ChangePlanSummary;
  history?: ChangeHistorySummary;
  diff?: string;
  conflicts?: ChangeConflict[];
}

export interface GetChangePlanResult {
  available: boolean;
  reason?: "plan-not-found";
  plan?: ChangePlanSummary;
  diff?: string;
}

export interface ListChangeHistoryResult {
  entries: ChangeHistorySummary[];
  total: number;
  /** Entry that a bare skein_undo_change would undo. */
  undoable?: string;
  /** Entry that a bare skein_redo_change would re-apply. */
  redoable?: string;
}

async function queueChange(
  rootDir: string,
  action: SkeinChangeAction,
  timeoutMs = CHANGE_RESULT_TIMEOUT_MS,
): Promise<SkeinChangeResult> {
  const state = await readViewState(rootDir);
  const request: SkeinChangeRequest = {
    id: createChangeId(),
    kind: "change",
    createdAt: Date.now(),
    command: action,
  };
  if (state?.activeWindowId) request.targetWindowId = state.activeWindowId;
  await writeChangeRequest(rootDir, request);

  const deadline = Date.now() + timeoutMs;
  try {
    /* eslint-disable no-await-in-loop -- the result is polled until it appears */
    for (;;) {
      const result = await readChangeResult(rootDir, request.id);
      if (result) return result;
      if (Date.now() >= deadline) {
        return {
          id: request.id,
          status: "error",
          reason: "extension-not-responding",
          completedAt: Date.now(),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, COMMAND_RESULT_POLL_MS));
    }
    /* eslint-enable no-await-in-loop */
  } finally {
    await deleteCommandFiles(rootDir, request.id);
  }
}

function trimDiff(diff: string): string {
  return diff.length > MAX_DIFF_CHARS
    ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]`
    : diff;
}

function toToolResult(result: SkeinChangeResult): ChangeToolResult {
  const toolResult: ChangeToolResult = {
    applied: result.status === "applied",
    status: result.status,
  };
  if (result.reason) toolResult.reason = result.reason;
  if (result.task) {
    toolResult.plan = summarizeTask(result.task);
    const diff = planDiff(result.task);
    if (diff) toolResult.diff = trimDiff(diff);
  }
  if (result.history) toolResult.history = summarizeHistoryEntry(result.history);
  if (result.conflicts) toolResult.conflicts = result.conflicts;
  return toolResult;
}

export async function executePlanChange(
  rootDir: string | undefined,
  params: PlanChangeParams,
): Promise<ChangeToolResult> {
  if (!rootDir) return { applied: false, status: "error", reason: "workspace-not-configured" };

  if (params.kind === "extract") {
    if (
      !params.path ||
      !params.name ||
      params.startLine === undefined ||
      params.startCharacter === undefined ||
      params.endLine === undefined ||
      params.endCharacter === undefined
    ) {
      return {
        applied: false,
        status: "error",
        reason: "extract requires path, name and the selection range",
      };
    }
    if (!isPathWithinRoot(params.path, rootDir)) {
      return { applied: false, status: "error", reason: "path-outside-workspace" };
    }
    const action: SkeinChangeAction = {
      action: "change_plan",
      kind: "extract",
      path: params.path,
      name: params.name,
      selection: {
        startLine: params.startLine,
        startCharacter: params.startCharacter,
        endLine: params.endLine,
        endCharacter: params.endCharacter,
      },
    };
    return toToolResult(await queueChange(rootDir, action, params.timeoutMs));
  }

  if (!params.nodeId) {
    if (!params.path || !params.name || params.line === undefined) {
      return {
        applied: false,
        status: "error",
        reason: "plan_change requires nodeId, or path with name and line",
      };
    }
    if (!isPathWithinRoot(params.path, rootDir)) {
      return { applied: false, status: "error", reason: "path-outside-workspace" };
    }
  }
  if (params.kind === "rename" && !params.newName) {
    return { applied: false, status: "error", reason: "rename requires newName" };
  }
  if (params.kind === "move") {
    if (!params.newPath) {
      return { applied: false, status: "error", reason: "move requires newPath" };
    }
    if (!isPathWithinRoot(params.newPath, rootDir)) {
      return { applied: false, status: "error", reason: "path-outside-workspace" };
    }
  }

  const action: SkeinChangeAction = {
    action: "change_plan",
    kind: params.kind,
  };
  if (params.nodeId) action.nodeId = params.nodeId;
  if (params.path) action.path = params.path;
  if (params.name) action.name = params.name;
  if (params.line !== undefined) action.line = params.line;
  if (params.newName) action.newName = params.newName;
  if (params.newPath) action.newPath = params.newPath;
  if (params.callLine !== undefined) action.callLine = params.callLine;
  if (params.callCharacter !== undefined) action.callCharacter = params.callCharacter;
  const result = await queueChange(rootDir, action, params.timeoutMs);
  return toToolResult(result);
}

export async function executeApplyChange(
  rootDir: string | undefined,
  params: ApplyChangeParams,
): Promise<ChangeToolResult> {
  if (!rootDir) return { applied: false, status: "error", reason: "workspace-not-configured" };
  const result = await queueChange(
    rootDir,
    { action: "change_apply", planId: params.planId },
    params.timeoutMs,
  );
  return toToolResult(result);
}

export async function executeGetChangePlan(
  rootDir: string | undefined,
  params: GetChangePlanParams,
): Promise<GetChangePlanResult> {
  if (!rootDir) return { available: false, reason: "plan-not-found" };
  const task = await readChangeTask(rootDir, params.planId);
  if (!task) return { available: false, reason: "plan-not-found" };
  const result: GetChangePlanResult = { available: true, plan: summarizeTask(task) };
  const diff = planDiff(task);
  if (diff) result.diff = trimDiff(diff);
  return result;
}

export async function executeListChangeHistory(
  rootDir: string | undefined,
  params: ListChangeHistoryParams,
): Promise<ListChangeHistoryResult> {
  if (!rootDir) return { entries: [], total: 0 };
  const index = await readChangeHistory(rootDir);
  const limit = params.limit ?? 20;
  const entries = [...index.entries]
    .reverse()
    .slice(0, limit)
    .map((entry) => summarizeHistoryEntry(entry));
  const result: ListChangeHistoryResult = { entries, total: index.entries.length };
  const undo = findUndoCandidate(index);
  const redo = findRedoCandidate(index);
  if (undo) result.undoable = undo.id;
  if (redo) result.redoable = redo.id;
  return result;
}

export async function executeUndoChange(
  rootDir: string | undefined,
  params: UndoChangeParams,
): Promise<ChangeToolResult> {
  if (!rootDir) return { applied: false, status: "error", reason: "workspace-not-configured" };
  if (params.historyId) {
    const index = await readChangeHistory(rootDir);
    const entry = index.entries.find((item) => item.id === params.historyId);
    if (!entry || !canUndo(entry, index)) {
      return { applied: false, status: "rejected", reason: "not-undoable" };
    }
  }
  const action: SkeinChangeAction = { action: "change_undo" };
  if (params.historyId) action.historyId = params.historyId;
  return toToolResult(await queueChange(rootDir, action, params.timeoutMs));
}

export async function executeRedoChange(
  rootDir: string | undefined,
  params: RedoChangeParams,
): Promise<ChangeToolResult> {
  if (!rootDir) return { applied: false, status: "error", reason: "workspace-not-configured" };
  if (params.historyId) {
    const index = await readChangeHistory(rootDir);
    const entry = index.entries.find((item) => item.id === params.historyId);
    if (!entry || !canRedo(entry, index)) {
      return { applied: false, status: "rejected", reason: "not-redoable" };
    }
  }
  const action: SkeinChangeAction = { action: "change_redo" };
  if (params.historyId) action.historyId = params.historyId;
  return toToolResult(await queueChange(rootDir, action, params.timeoutMs));
}
