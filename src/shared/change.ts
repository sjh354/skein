/**
 * Shared change protocol (DESIGN 8, 9, 10).
 *
 * A change is one explicit user/agent action (a rename in step 5) that is
 * planned against an exact code fingerprint, recorded in the internal Git
 * history, applied, verified and then undoable. This module holds the
 * serializable shape only: the VS Code adapter collects edits and diagnostics,
 * `src/analyzer/change/**` performs the Git and merge work, and the extension
 * is the only process that writes plans, tasks and the history index.
 *
 * MCP reads the published task/index files directly and queues mutations in
 * `.skein/commands/` — the same bridge as the view state (DESIGN 5.2).
 *
 * NO vscode imports.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { normalizePath } from "./path";
import { isPathWithinRoot } from "./pathSecurity";
import { ensureSkeinWorkspace, writeJsonAtomic } from "./viewState";

export const SKEIN_CHANGE_SCHEMA_VERSION = 1;
/** A language service may still be loading its project on the first request. */
export const CHANGE_RESULT_TIMEOUT_MS = 10_000;
export const SKEIN_HISTORY_DIR = "history";
export const SKEIN_CHANGE_INDEX_FILE = "index.json";
export const SKEIN_CHANGE_TASKS_DIR = "tasks";

/** One text edit in a file, 0-based like the VS Code API. */
export interface ChangeTextEdit {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  newText: string;
}

/** Edits planned for one file, with the exact content they were computed against. */
export interface ChangeFileEdit {
  /** Absolute path, normalized with forward slashes. */
  path: string;
  /** Full saved content the edits were computed against. */
  beforeContent: string;
  edits: ChangeTextEdit[];
}

export type ChangeKind = "rename" | "undo" | "redo";
export type ChangeRequestSource = "ui" | "mcp";

export interface ChangeTarget {
  nodeId?: string;
  name: string;
  newName: string;
  path: string;
  /** 0-based line of the declaration. */
  line: number;
  character?: number;
}

export type ChangeTaskStatus =
  | "planning"
  | "preview-ready"
  | "applying"
  | "verifying"
  | "succeeded"
  | "apply-failed"
  | "verification-failed"
  | "incomplete"
  | "conflict"
  | "recovery"
  | "cancelled";

export interface ChangeFileState {
  path: string;
  exists: boolean;
  /** SHA-256 of the saved content, or null when the file does not exist. */
  sha256: string | null;
}

/** What the plan was computed against; applying re-checks it. */
export interface ChangeFingerprint {
  files: ChangeFileState[];
  graphVersion: number;
}

export interface ChangeDiagnosticSample {
  errors: number;
  warnings: number;
  messages: string[];
}

export interface ChangeFileVerification {
  path: string;
  before: ChangeDiagnosticSample;
  after: ChangeDiagnosticSample;
}

export interface ChangeVerification {
  status: "passed" | "failed" | "incomplete" | "not-run";
  checkedAt: number;
  reason?: string;
  files: ChangeFileVerification[];
  /** Project test execution is not wired in step 5 (DESIGN 8.4). */
  tests: { status: "not-run"; reason: string };
  architecture: { status: "not-run"; reason: string };
}

export interface ChangePlan {
  id: string;
  kind: ChangeKind;
  createdAt: number;
  workspaceRoot: string;
  graphVersion: number;
  source: ChangeRequestSource;
  target?: ChangeTarget;
  /** Links an undo/redo plan to the history entry it reverses/reapplies. */
  historyTargetId?: string;
  files: ChangeFileEdit[];
  fingerprint: ChangeFingerprint;
}

export interface ChangeTask {
  schemaVersion: number;
  plan: ChangePlan;
  status: ChangeTaskStatus;
  createdAt: number;
  updatedAt: number;
  reason?: string;
  verification?: ChangeVerification;
  /** History entry this task produced. */
  historyId?: string;
}

export type ChangeFileChange = "modified" | "created" | "deleted";

export interface ChangeHistoryFile {
  path: string;
  change: ChangeFileChange;
  beforeHash: string | null;
  afterHash: string | null;
}

export type ChangeHistoryStatus =
  | "succeeded"
  | "verification-failed"
  | "incomplete"
  | "apply-failed";

export interface ChangeHistoryEntry {
  id: string;
  planId: string;
  kind: ChangeKind;
  source: ChangeRequestSource;
  createdAt: number;
  status: ChangeHistoryStatus;
  files: ChangeHistoryFile[];
  /** Internal Git commits holding the before/after snapshots. */
  beforeCommit: string;
  afterCommit: string;
  target?: ChangeTarget;
  verification?: ChangeVerification;
  /** For undo entries: the entry this one reverts. */
  undoTargetId?: string;
  /** For redo entries: the undo entry this one re-applies. */
  redoOfId?: string;
}

export interface ChangeHistoryIndex {
  schemaVersion: number;
  entries: ChangeHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function historyDirPath(root: string): string {
  return path.join(root, ".skein", SKEIN_HISTORY_DIR);
}

export function historyRepoPath(root: string): string {
  return path.join(historyDirPath(root), "repo.git");
}

export function changeIndexPath(root: string): string {
  return path.join(historyDirPath(root), SKEIN_CHANGE_INDEX_FILE);
}

export function changeTaskDir(root: string): string {
  return path.join(historyDirPath(root), SKEIN_CHANGE_TASKS_DIR);
}

export function changeTaskPath(root: string, planId: string): string {
  return path.join(changeTaskDir(root), `${planId}.json`);
}

export function changeLockPath(root: string): string {
  return path.join(historyDirPath(root), "lock");
}

/** Paths a change may never touch, relative to the workspace root. */
export function isProtectedChangePath(filePath: string, root: string): boolean {
  if (!isPathWithinRoot(filePath, root)) return true;
  const relative = normalizePath(path.relative(root, filePath)).toLowerCase();
  return (
    relative === ".git" ||
    relative.startsWith(".git/") ||
    relative === ".skein" ||
    relative.startsWith(".skein/")
  );
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/** Line endings never make a fingerprint or a merge disagree across platforms. */
export function normalizeEol(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

export function hashContent(content: string): string {
  return createHash("sha256").update(normalizeEol(content), "utf8").digest("hex");
}

export function createChangeId(): string {
  return randomUUID();
}

/** Converts 0-based line/character positions to a string offset. */
export function positionToOffset(content: string, line: number, character: number): number {
  if (line < 0 || character < 0) return -1;
  let offset = 0;
  for (let current = 0; current < line; current += 1) {
    const newline = content.indexOf("\n", offset);
    if (newline === -1) return -1;
    offset = newline + 1;
  }
  const offsetAfterLine = offset + character;
  const lineEnd = content.indexOf("\n", offset);
  const maxOffset = lineEnd === -1 ? content.length : lineEnd;
  return offsetAfterLine <= maxOffset ? offsetAfterLine : -1;
}

/** Applies non-overlapping edits; returns null when a range is invalid or overlaps. */
export function applyTextEdits(content: string, edits: ChangeTextEdit[]): string | null {
  const resolved: Array<{ start: number; end: number; newText: string }> = [];
  for (const edit of edits) {
    const start = positionToOffset(content, edit.startLine, edit.startCharacter);
    const end = positionToOffset(content, edit.endLine, edit.endCharacter);
    if (start < 0 || end < 0 || end < start) return null;
    resolved.push({ start, end, newText: edit.newText });
  }
  resolved.sort((left, right) => right.start - left.start || right.end - left.end);
  let result = content;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const edit of resolved) {
    if (edit.end > lastStart) return null;
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
    lastStart = edit.start;
  }
  return result;
}

/** Full-file replacement edit (used by three-way undo/redo). */
export function replaceWholeFileEdit(content: string, replacement: string): ChangeTextEdit {
  return {
    startLine: 0,
    startCharacter: 0,
    endLine: numberOfLines(content) - 1,
    endCharacter: lastLineLength(content),
    newText: replacement,
  };
}

export function numberOfLines(content: string): number {
  return content.split("\n").length;
}

function lastLineLength(content: string): number {
  const index = content.lastIndexOf("\n");
  return index === -1 ? content.length : content.length - index - 1;
}

// ---------------------------------------------------------------------------
// Task/index validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const TASK_STATUSES: ReadonlySet<string> = new Set<ChangeTaskStatus>([
  "planning",
  "preview-ready",
  "applying",
  "verifying",
  "succeeded",
  "apply-failed",
  "verification-failed",
  "incomplete",
  "conflict",
  "recovery",
  "cancelled",
]);

const KINDS: ReadonlySet<string> = new Set<ChangeKind>(["rename", "undo", "redo"]);

function parseTextEdit(value: unknown): ChangeTextEdit | null {
  if (!isRecord(value)) return null;
  if (
    !isFiniteNumber(value.startLine) ||
    !isFiniteNumber(value.startCharacter) ||
    !isFiniteNumber(value.endLine) ||
    !isFiniteNumber(value.endCharacter) ||
    typeof value.newText !== "string"
  ) {
    return null;
  }
  return {
    startLine: value.startLine,
    startCharacter: value.startCharacter,
    endLine: value.endLine,
    endCharacter: value.endCharacter,
    newText: value.newText,
  };
}

function parseFileEdit(value: unknown): ChangeFileEdit | null {
  if (!isRecord(value) || typeof value.path !== "string") return null;
  if (typeof value.beforeContent !== "string" || !Array.isArray(value.edits)) return null;
  const edits: ChangeTextEdit[] = [];
  for (const item of value.edits) {
    const edit = parseTextEdit(item);
    if (!edit) return null;
    edits.push(edit);
  }
  return { path: normalizePath(value.path), beforeContent: value.beforeContent, edits };
}

function parseFileState(value: unknown): ChangeFileState | null {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.exists !== "boolean") {
    return null;
  }
  if (value.sha256 !== null && typeof value.sha256 !== "string") return null;
  return { path: normalizePath(value.path), exists: value.exists, sha256: value.sha256 };
}

function parseTarget(value: unknown): ChangeTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.name !== "string" || typeof value.newName !== "string") return undefined;
  if (typeof value.path !== "string" || !isFiniteNumber(value.line)) return undefined;
  const target: ChangeTarget = {
    name: value.name,
    newName: value.newName,
    path: normalizePath(value.path),
    line: value.line,
  };
  if (typeof value.nodeId === "string") target.nodeId = value.nodeId;
  if (isFiniteNumber(value.character)) target.character = value.character;
  return target;
}

function parseFingerprint(value: unknown): ChangeFingerprint | null {
  if (!isRecord(value) || !Array.isArray(value.files) || !isFiniteNumber(value.graphVersion)) {
    return null;
  }
  const files: ChangeFileState[] = [];
  for (const item of value.files) {
    const state = parseFileState(item);
    if (!state) return null;
    files.push(state);
  }
  return { files, graphVersion: value.graphVersion };
}

function parseDiagnosticSample(value: unknown): ChangeDiagnosticSample | null {
  if (!isRecord(value) || !isFiniteNumber(value.errors) || !isFiniteNumber(value.warnings)) {
    return null;
  }
  const messages = Array.isArray(value.messages)
    ? value.messages.filter((item): item is string => typeof item === "string")
    : [];
  return { errors: value.errors, warnings: value.warnings, messages };
}

function parseVerification(value: unknown): ChangeVerification | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.status;
  if (
    status !== "passed" &&
    status !== "failed" &&
    status !== "incomplete" &&
    status !== "not-run"
  ) {
    return undefined;
  }
  if (!isFiniteNumber(value.checkedAt)) return undefined;
  const files: ChangeFileVerification[] = [];
  if (Array.isArray(value.files)) {
    for (const item of value.files) {
      if (!isRecord(item) || typeof item.path !== "string") continue;
      const before = parseDiagnosticSample(item.before);
      const after = parseDiagnosticSample(item.after);
      if (!before || !after) continue;
      files.push({ path: normalizePath(item.path), before, after });
    }
  }
  const verification: ChangeVerification = {
    status,
    checkedAt: value.checkedAt,
    files,
    tests: { status: "not-run", reason: "step-5" },
    architecture: { status: "not-run", reason: "step-5" },
  };
  if (typeof value.reason === "string") verification.reason = value.reason;
  return verification;
}

export function parseChangeTask(raw: string): ChangeTask | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.plan)) return null;
  if (typeof parsed.status !== "string" || !TASK_STATUSES.has(parsed.status)) return null;
  const plan = parsed.plan;
  if (typeof plan.id !== "string" || typeof plan.kind !== "string" || !KINDS.has(plan.kind)) {
    return null;
  }
  if (typeof plan.workspaceRoot !== "string" || !isFiniteNumber(plan.graphVersion)) return null;
  if (!Array.isArray(plan.files)) return null;
  const files: ChangeFileEdit[] = [];
  for (const item of plan.files) {
    const file = parseFileEdit(item);
    if (!file) return null;
    files.push(file);
  }
  const fingerprint = parseFingerprint(plan.fingerprint);
  if (!fingerprint) return null;
  const changePlan: ChangePlan = {
    id: plan.id,
    kind: plan.kind as ChangeKind,
    createdAt: isFiniteNumber(plan.createdAt) ? plan.createdAt : 0,
    workspaceRoot: plan.workspaceRoot,
    graphVersion: plan.graphVersion,
    source: plan.source === "mcp" ? "mcp" : "ui",
    files,
    fingerprint,
  };
  const target = parseTarget(plan.target);
  if (target) changePlan.target = target;
  if (typeof plan.historyTargetId === "string") changePlan.historyTargetId = plan.historyTargetId;

  const task: ChangeTask = {
    schemaVersion: isFiniteNumber(parsed.schemaVersion)
      ? parsed.schemaVersion
      : SKEIN_CHANGE_SCHEMA_VERSION,
    plan: changePlan,
    status: parsed.status as ChangeTaskStatus,
    createdAt: isFiniteNumber(parsed.createdAt) ? parsed.createdAt : changePlan.createdAt,
    updatedAt: isFiniteNumber(parsed.updatedAt) ? parsed.updatedAt : changePlan.createdAt,
  };
  if (typeof parsed.reason === "string") task.reason = parsed.reason;
  if (typeof parsed.historyId === "string") task.historyId = parsed.historyId;
  const verification = parseVerification(parsed.verification);
  if (verification) task.verification = verification;
  return task;
}

function parseHistoryFile(value: unknown): ChangeHistoryFile | null {
  if (!isRecord(value) || typeof value.path !== "string") return null;
  const change = value.change;
  if (change !== "modified" && change !== "created" && change !== "deleted") return null;
  if (value.beforeHash !== null && typeof value.beforeHash !== "string") return null;
  if (value.afterHash !== null && typeof value.afterHash !== "string") return null;
  return {
    path: normalizePath(value.path),
    change,
    beforeHash: value.beforeHash,
    afterHash: value.afterHash,
  };
}

export function parseChangeHistoryEntry(value: unknown): ChangeHistoryEntry | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.planId !== "string") {
    return null;
  }
  if (typeof value.kind !== "string" || !KINDS.has(value.kind)) return null;
  if (typeof value.beforeCommit !== "string" || typeof value.afterCommit !== "string") {
    return null;
  }
  const status = value.status;
  if (
    status !== "succeeded" &&
    status !== "verification-failed" &&
    status !== "incomplete" &&
    status !== "apply-failed"
  ) {
    return null;
  }
  if (!Array.isArray(value.files)) return null;
  const files: ChangeHistoryFile[] = [];
  for (const item of value.files) {
    const file = parseHistoryFile(item);
    if (!file) return null;
    files.push(file);
  }
  const entry: ChangeHistoryEntry = {
    id: value.id,
    planId: value.planId,
    kind: value.kind as ChangeKind,
    source: value.source === "mcp" ? "mcp" : "ui",
    createdAt: isFiniteNumber(value.createdAt) ? value.createdAt : 0,
    status,
    files,
    beforeCommit: value.beforeCommit,
    afterCommit: value.afterCommit,
  };
  const target = parseTarget(value.target);
  if (target) entry.target = target;
  const verification = parseVerification(value.verification);
  if (verification) entry.verification = verification;
  if (typeof value.undoTargetId === "string") entry.undoTargetId = value.undoTargetId;
  if (typeof value.redoOfId === "string") entry.redoOfId = value.redoOfId;
  return entry;
}

export function parseChangeHistory(raw: string): ChangeHistoryIndex | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return null;
  const entries: ChangeHistoryEntry[] = [];
  for (const item of parsed.entries) {
    const entry = parseChangeHistoryEntry(item);
    if (entry) entries.push(entry);
  }
  return { schemaVersion: SKEIN_CHANGE_SCHEMA_VERSION, entries };
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

export async function readChangeTask(root: string, planId: string): Promise<ChangeTask | null> {
  try {
    return parseChangeTask(await fs.readFile(changeTaskPath(root, planId), "utf8"));
  } catch {
    return null;
  }
}

export async function writeChangeTask(root: string, task: ChangeTask): Promise<void> {
  await writeJsonAtomic(changeTaskPath(root, task.plan.id), task);
}

export async function listChangeTasks(root: string): Promise<ChangeTask[]> {
  let names: string[];
  try {
    names = await fs.readdir(changeTaskDir(root));
  } catch {
    return [];
  }
  const tasks: ChangeTask[] = [];
  /* eslint-disable no-await-in-loop -- one small file per plan */
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const task = parseChangeTask(await fs.readFile(path.join(changeTaskDir(root), name), "utf8"));
      if (task) tasks.push(task);
    } catch {
      // Removed between readdir and read — ignore.
    }
  }
  /* eslint-enable no-await-in-loop */
  return tasks.sort((left, right) => left.createdAt - right.createdAt);
}

export async function readChangeHistory(root: string): Promise<ChangeHistoryIndex> {
  try {
    const index = parseChangeHistory(await fs.readFile(changeIndexPath(root), "utf8"));
    if (index) return index;
  } catch {
    // Missing or malformed history starts empty; a corrupt file is reported by
    // the writer flow instead of being silently overwritten here.
  }
  return { schemaVersion: SKEIN_CHANGE_SCHEMA_VERSION, entries: [] };
}

export async function writeChangeHistory(
  root: string,
  index: ChangeHistoryIndex,
): Promise<void> {
  await writeJsonAtomic(changeIndexPath(root), {
    schemaVersion: SKEIN_CHANGE_SCHEMA_VERSION,
    entries: index.entries,
  });
}

export async function appendChangeHistoryEntry(
  root: string,
  entry: ChangeHistoryEntry,
): Promise<ChangeHistoryIndex> {
  const index = await readChangeHistory(root);
  const entries = index.entries.filter((item) => item.id !== entry.id);
  entries.push(entry);
  const next: ChangeHistoryIndex = { schemaVersion: SKEIN_CHANGE_SCHEMA_VERSION, entries };
  await writeChangeHistory(root, next);
  return next;
}

/**
 * The history is linear: the newest entry describes the current tool state.
 * Undo reverses it when it is an applied rename/redo; redo re-applies the
 * newest undo. Older entries cannot be undone out of order.
 */
export function findUndoCandidate(
  index: ChangeHistoryIndex,
  historyId?: string,
): ChangeHistoryEntry | undefined {
  const entry = historyId
    ? index.entries.find((item) => item.id === historyId)
    : index.entries[index.entries.length - 1];
  return entry && canUndo(entry, index) ? entry : undefined;
}

export function canUndo(entry: ChangeHistoryEntry, index: ChangeHistoryIndex): boolean {
  if (index.entries[index.entries.length - 1]?.id !== entry.id) return false;
  if (entry.status === "apply-failed") return false;
  return entry.kind === "rename" || entry.kind === "redo";
}

/** The newest entry can be redone when it is an applied undo. */
export function findRedoCandidate(
  index: ChangeHistoryIndex,
  historyId?: string,
): ChangeHistoryEntry | undefined {
  const entry = historyId
    ? index.entries.find((item) => item.id === historyId)
    : index.entries[index.entries.length - 1];
  return entry && canRedo(entry, index) ? entry : undefined;
}

export function canRedo(entry: ChangeHistoryEntry, index: ChangeHistoryIndex): boolean {
  if (index.entries[index.entries.length - 1]?.id !== entry.id) return false;
  if (entry.status === "apply-failed") return false;
  return entry.kind === "undo";
}

// ---------------------------------------------------------------------------
// Command queue (same directory as the view-state commands, different `kind`)
// ---------------------------------------------------------------------------

export type SkeinChangeAction =
  | {
      action: "change_plan";
      kind: "rename";
      nodeId?: string;
      path?: string;
      name?: string;
      line?: number;
      newName: string;
    }
  | { action: "change_apply"; planId: string }
  | { action: "change_undo"; historyId?: string }
  | { action: "change_redo"; historyId?: string };

export interface SkeinChangeRequest {
  id: string;
  kind: "change";
  createdAt: number;
  graphVersion?: number;
  targetWindowId?: string;
  command: SkeinChangeAction;
}

export type SkeinChangeCommandStatus = "applied" | "rejected" | "error";

export interface ChangeConflict {
  path: string;
  conflicts: number;
  /** First conflicting hunk with diff3 markers, for display. */
  hunk: string;
}

export interface SkeinChangeResult {
  id: string;
  status: SkeinChangeCommandStatus;
  reason?: string;
  completedAt: number;
  task?: ChangeTask;
  history?: ChangeHistoryEntry;
  conflicts?: ChangeConflict[];
}

function commandDir(root: string): string {
  return path.join(root, ".skein", "commands");
}

function changeRequestPath(root: string, id: string): string {
  return path.join(commandDir(root), `${id}.request.json`);
}

function changeResultPath(root: string, id: string): string {
  return path.join(commandDir(root), `${id}.result.json`);
}

function parseChangeAction(value: unknown): SkeinChangeAction | null {
  if (!isRecord(value) || typeof value.action !== "string") return null;
  switch (value.action) {
    case "change_plan": {
      if (value.kind !== "rename") return null;
      if (typeof value.newName !== "string" || value.newName.length === 0) return null;
      const action: SkeinChangeAction = { action: "change_plan", kind: "rename", newName: value.newName };
      if (typeof value.nodeId === "string" && value.nodeId.length > 0) action.nodeId = value.nodeId;
      if (typeof value.path === "string" && value.path.length > 0) action.path = value.path;
      if (typeof value.name === "string" && value.name.length > 0) action.name = value.name;
      if (isFiniteNumber(value.line)) action.line = value.line;
      if (!action.nodeId && (!action.path || !action.name || action.line === undefined)) return null;
      return action;
    }
    case "change_apply":
      return typeof value.planId === "string" && value.planId.length > 0
        ? { action: "change_apply", planId: value.planId }
        : null;
    case "change_undo": {
      const action: SkeinChangeAction = { action: "change_undo" };
      if (typeof value.historyId === "string") action.historyId = value.historyId;
      return action;
    }
    case "change_redo": {
      const action: SkeinChangeAction = { action: "change_redo" };
      if (typeof value.historyId === "string") action.historyId = value.historyId;
      return action;
    }
    default:
      return null;
  }
}

export function parseChangeRequest(raw: string): SkeinChangeRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.kind !== "change") return null;
  if (typeof parsed.id !== "string" || parsed.id.length === 0) return null;
  if (!isFiniteNumber(parsed.createdAt)) return null;
  const command = parseChangeAction(parsed.command);
  if (!command) return null;
  const request: SkeinChangeRequest = {
    id: parsed.id,
    kind: "change",
    createdAt: parsed.createdAt,
    command,
  };
  if (isFiniteNumber(parsed.graphVersion)) request.graphVersion = parsed.graphVersion;
  if (typeof parsed.targetWindowId === "string" && parsed.targetWindowId.length > 0) {
    request.targetWindowId = parsed.targetWindowId;
  }
  return request;
}

export async function writeChangeRequest(
  root: string,
  request: SkeinChangeRequest,
): Promise<void> {
  await ensureSkeinWorkspace(root);
  await writeJsonAtomic(changeRequestPath(root, request.id), request);
}

/** Change requests queued by MCP, oldest first. Other request kinds are ignored. */
export async function listChangeRequests(root: string): Promise<SkeinChangeRequest[]> {
  let names: string[];
  try {
    names = await fs.readdir(commandDir(root));
  } catch {
    return [];
  }
  const requests: SkeinChangeRequest[] = [];
  /* eslint-disable no-await-in-loop -- one small file per queued command */
  for (const name of names) {
    if (!name.endsWith(".request.json")) continue;
    try {
      const request = parseChangeRequest(await fs.readFile(path.join(commandDir(root), name), "utf8"));
      if (request) requests.push(request);
    } catch {
      // Removed between readdir and read — ignore.
    }
  }
  /* eslint-enable no-await-in-loop */
  return requests.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export async function readChangeResult(
  root: string,
  id: string,
): Promise<SkeinChangeResult | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(changeResultPath(root, id), "utf8"));
    if (!isRecord(parsed) || typeof parsed.id !== "string") return null;
    if (!isFiniteNumber(parsed.completedAt)) return null;
    if (parsed.status !== "applied" && parsed.status !== "rejected" && parsed.status !== "error") {
      return null;
    }
    const result: SkeinChangeResult = {
      id: parsed.id,
      status: parsed.status,
      completedAt: parsed.completedAt,
    };
    if (typeof parsed.reason === "string") result.reason = parsed.reason;
    if (isRecord(parsed.task) && isRecord(parsed.task.plan)) {
      const task = parseChangeTask(JSON.stringify(parsed.task));
      if (task) result.task = task;
    }
    const history = parseChangeHistoryEntry(parsed.history);
    if (history) result.history = history;
    if (Array.isArray(parsed.conflicts)) {
      const conflicts: ChangeConflict[] = [];
      for (const item of parsed.conflicts) {
        if (!isRecord(item) || typeof item.path !== "string") continue;
        if (!isFiniteNumber(item.conflicts) || typeof item.hunk !== "string") continue;
        conflicts.push({ path: item.path, conflicts: item.conflicts, hunk: item.hunk });
      }
      if (conflicts.length > 0) result.conflicts = conflicts;
    }
    return result;
  } catch {
    return null;
  }
}

export async function writeChangeResult(
  root: string,
  result: SkeinChangeResult,
): Promise<void> {
  await writeJsonAtomic(changeResultPath(root, result.id), result);
}

export async function deleteChangeRequest(root: string, id: string): Promise<void> {
  await fs.rm(changeRequestPath(root, id), { force: true });
}

// ---------------------------------------------------------------------------
// Summaries for MCP responses (avoid returning full file contents)
// ---------------------------------------------------------------------------

export interface ChangePlanSummary {
  planId: string;
  kind: ChangeKind;
  status: ChangeTaskStatus;
  createdAt: number;
  graphVersion: number;
  target?: ChangeTarget;
  files: Array<{ path: string; edits: number; added: number; removed: number }>;
  reason?: string;
  historyId?: string;
}

export interface ChangeHistorySummary {
  id: string;
  planId: string;
  kind: ChangeKind;
  status: ChangeHistoryStatus;
  createdAt: number;
  target?: ChangeTarget;
  files: Array<{ path: string; change: ChangeFileChange }>;
  undoTargetId?: string;
  redoOfId?: string;
  verification?: ChangeVerification["status"];
}

export function summarizeHistoryEntry(entry: ChangeHistoryEntry): ChangeHistorySummary {
  const summary: ChangeHistorySummary = {
    id: entry.id,
    planId: entry.planId,
    kind: entry.kind,
    status: entry.status,
    createdAt: entry.createdAt,
    files: entry.files.map((file) => ({ path: file.path, change: file.change })),
  };
  if (entry.target) summary.target = entry.target;
  if (entry.undoTargetId) summary.undoTargetId = entry.undoTargetId;
  if (entry.redoOfId) summary.redoOfId = entry.redoOfId;
  if (entry.verification) summary.verification = entry.verification.status;
  return summary;
}
