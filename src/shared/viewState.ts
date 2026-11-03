/**
 * Shared view state and command protocol for the VS Code graph and the MCP server.
 *
 * The extension is the only writer of `.skein/state.json`. The MCP server reads
 * that file and drops command requests into `.skein/commands/`; the extension
 * applies them and writes the result next to the request. Unique command ids,
 * per-window sections and atomic renames keep two processes from overwriting
 * each other's files.
 *
 * Schema 2 keeps one snapshot per extension window (`windows`) so two VS Code
 * windows on the same folder no longer erase each other, and adds the call-graph
 * layout (node positions + viewport) so a restart can restore the screen.
 *
 * NO vscode imports — this module is used by the extension, the MCP server and
 * their unit tests.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "./lock";
import { normalizePath } from "./path";

export const SKEIN_DIR_NAME = ".skein";
export const SKEIN_STATE_FILE = "state.json";
export const SKEIN_COMMANDS_DIR = "commands";
export const SKEIN_STATE_SCHEMA_VERSION = 2;

/** Timeout the MCP side waits for the extension to answer a command. */
export const COMMAND_RESULT_TIMEOUT_MS = 3_000;
/** Poll interval while waiting for a command result. */
export const COMMAND_RESULT_POLL_MS = 50;
/** A window snapshot untouched for this long is dropped on the next write. */
export const WINDOW_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Upper bound on stored node positions, so a broken webview cannot bloat the file. */
const MAX_LAYOUT_POSITIONS = 10_000;

export type SkeinViewMode = "file" | "list" | "symbol" | "callgraph" | "architecture";
export type SkeinFilterType = "nodeType" | "folder" | "edgeType";

export interface SkeinSelection {
  /** Call graph node id: `<path>:<symbol>:<startLine>` */
  nodeId: string;
  path?: string;
  name?: string;
  startLine?: number;
}

export interface SkeinFilter {
  filterType: SkeinFilterType;
  value: string;
}

export interface SkeinPoint {
  x: number;
  y: number;
}

/** Where the user left the call graph: node positions and the viewport. */
export interface SkeinLayout {
  positions: Record<string, SkeinPoint>;
  zoom?: number;
  pan?: SkeinPoint;
  /** Root the positions belong to; a different root builds a fresh layout. */
  rootSymbolId?: string;
  /** Graph version the positions belong to. */
  graphVersion?: number;
}

/** Selection for the other views that share the same identifiers. */
export interface SkeinViewSelections {
  file?: SkeinSelection;
  list?: SkeinSelection;
  symbol?: SkeinSelection;
  architecture?: SkeinSelection;
}

/** Bounded state of the rendered surface; detailed analysis stays in query tools. */
export interface SkeinSurfaceState {
  nodeIds: string[];
  nodeIdsTruncated?: boolean;
  expandedNodeIds: string[];
  search?: { query: string; matches: string[]; total: number };
  architecture?: { revision?: string; unit?: string; folder?: string; view?: string; minImports?: number };
  analysis?: { revision?: string; nodes: number; edges: number; stale: boolean };
  diagnostics?: { total: number; truncated: boolean; items: Array<{ id: string; kind: string; status: string }> };
}

export interface SkeinViewSnapshot {
  mode: SkeinViewMode;
  /** File the graph view is showing (absolute path). */
  filePath?: string;
  selection?: SkeinSelection;
  callGraph?: {
    rootSymbolId?: string;
    depth?: number;
  };
  /** Filters the user has hidden (node types, folders). */
  hiddenFilters: SkeinFilter[];
  expandAll: boolean;
  layout?: SkeinLayout;
  views?: SkeinViewSelections;
  surface?: SkeinSurfaceState;
}

/** One extension window's snapshot. */
export interface SkeinWindowView extends SkeinViewSnapshot {
  windowId: string;
  /** Unix ms of that window's last write. */
  updatedAt: number;
  /** Unix ms of the last human interaction in that window. */
  lastUserActionAt: number;
  /** Bumped whenever the analysis behind the view is replaced. */
  graphVersion: number;
}

export interface SkeinViewState extends SkeinWindowView {
  schemaVersion: number;
  workspaceRoot: string;
  /** Window the top-level fields mirror (the most recent writer). */
  activeWindowId: string;
  windows: Record<string, SkeinWindowView>;
}

/** Compact window list for MCP responses (no snapshots or layouts). */
export interface SkeinWindowSummary {
  windowId: string;
  updatedAt: number;
  lastUserActionAt: number;
  mode: SkeinViewMode;
  graphVersion: number;
}

export function summarizeWindows(state: SkeinViewState): SkeinWindowSummary[] {
  return Object.values(state.windows)
    .map((window) => ({
      windowId: window.windowId,
      updatedAt: window.updatedAt,
      lastUserActionAt: window.lastUserActionAt,
      mode: window.mode,
      graphVersion: window.graphVersion,
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export const EMPTY_VIEW_SNAPSHOT: SkeinViewSnapshot = {
  mode: "file",
  hiddenFilters: [],
  expandAll: false,
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type SkeinViewAction =
  | { action: "search"; query: string }
  | { action: "set_expanded"; nodeId: string; expanded: boolean }
  | { action: "set_architecture"; view?: "graph" | "matrix"; unit?: string; folder?: string; minImports?: number }
  | { action: "select"; nodeId: string }
  | { action: "focus"; nodeId: string }
  | { action: "set_depth"; depth: number }
  | { action: "open_file"; path: string; line?: number; character?: number }
  | { action: "set_filter"; filterType: SkeinFilterType; value: string; visible: boolean }
  | { action: "set_expand_all"; expandAll: boolean };

export interface SkeinCommandRequest {
  id: string;
  createdAt: number;
  /** When set, the extension rejects the command if its graph has moved on. */
  graphVersion?: number;
  /** When set, only the matching extension window applies the command. */
  targetWindowId?: string;
  command: SkeinViewAction;
}

export type SkeinCommandStatus = "applied" | "rejected" | "error";

export interface SkeinCommandResult {
  id: string;
  status: SkeinCommandStatus;
  reason?: string;
  completedAt: number;
  /** View state right after the command (applied only). */
  state?: SkeinViewState;
}

const ACTION_NAMES: ReadonlySet<string> = new Set<SkeinViewAction["action"]>([
  "search",
  "set_expanded",
  "set_architecture",
  "select",
  "focus",
  "set_depth",
  "open_file",
  "set_filter",
  "set_expand_all",
]);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function skeinDir(root: string): string {
  return path.join(root, SKEIN_DIR_NAME);
}

export function viewStatePath(root: string): string {
  return path.join(skeinDir(root), SKEIN_STATE_FILE);
}

export function commandDir(root: string): string {
  return path.join(skeinDir(root), SKEIN_COMMANDS_DIR);
}

/** Canonical key for a workspace area (state file root). */
export function normalizeAreaKey(root: string): string {
  return normalizePath(root);
}

function stateLockPath(root: string): string {
  return path.join(skeinDir(root), "state.lock");
}

function commandRequestPath(root: string, id: string): string {
  return path.join(commandDir(root), `${id}.request.json`);
}

function commandResultPath(root: string, id: string): string {
  return path.join(commandDir(root), `${id}.result.json`);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isViewMode(value: unknown): value is SkeinViewMode {
  return (
    value === "file" ||
    value === "list" ||
    value === "symbol" ||
    value === "callgraph" ||
    value === "architecture"
  );
}

function isFilterType(value: unknown): value is SkeinFilterType {
  return value === "nodeType" || value === "folder" || value === "edgeType";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseSelection(value: unknown): SkeinSelection | undefined {
  if (!isRecord(value) || typeof value.nodeId !== "string" || value.nodeId.length === 0) {
    return undefined;
  }
  const selection: SkeinSelection = { nodeId: value.nodeId };
  if (typeof value.path === "string") selection.path = value.path;
  if (typeof value.name === "string") selection.name = value.name;
  if (typeof value.startLine === "number") selection.startLine = value.startLine;
  return selection;
}

function parseFilters(value: unknown): SkeinFilter[] {
  if (!Array.isArray(value)) return [];
  const filters: SkeinFilter[] = [];
  for (const item of value) {
    if (isRecord(item) && isFilterType(item.filterType) && typeof item.value === "string") {
      filters.push({ filterType: item.filterType, value: item.value });
    }
  }
  return filters;
}

function parseLayout(value: unknown): SkeinLayout | undefined {
  if (!isRecord(value) || !isRecord(value.positions)) return undefined;
  const positions: Record<string, SkeinPoint> = {};
  let count = 0;
  for (const [nodeId, point] of Object.entries(value.positions)) {
    if (count >= MAX_LAYOUT_POSITIONS) break;
    if (typeof nodeId !== "string" || !isRecord(point)) continue;
    if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) continue;
    positions[nodeId] = { x: point.x, y: point.y };
    count += 1;
  }
  if (count === 0) return undefined;
  const layout: SkeinLayout = { positions };
  if (isFiniteNumber(value.zoom)) layout.zoom = value.zoom;
  if (isRecord(value.pan) && isFiniteNumber(value.pan.x) && isFiniteNumber(value.pan.y)) {
    layout.pan = { x: value.pan.x, y: value.pan.y };
  }
  if (typeof value.rootSymbolId === "string") layout.rootSymbolId = value.rootSymbolId;
  if (isFiniteNumber(value.graphVersion)) layout.graphVersion = value.graphVersion;
  return layout;
}

function parseViewSelections(value: unknown): SkeinViewSelections | undefined {
  if (!isRecord(value)) return undefined;
  const views: SkeinViewSelections = {};
  const file = parseSelection(value.file);
  if (file) views.file = file;
  const list = parseSelection(value.list);
  if (list) views.list = list;
  const symbol = parseSelection(value.symbol);
  if (symbol) views.symbol = symbol;
  const architecture = parseSelection(value.architecture);
  if (architecture) views.architecture = architecture;
  return Object.keys(views).length > 0 ? views : undefined;
}

function parseSnapshot(value: Record<string, unknown>): SkeinViewSnapshot | null {
  if (!isViewMode(value.mode)) return null;
  const snapshot: SkeinViewSnapshot = {
    mode: value.mode,
    hiddenFilters: parseFilters(value.hiddenFilters),
    expandAll: value.expandAll === true,
  };
  if (typeof value.filePath === "string") snapshot.filePath = value.filePath;
  const selection = parseSelection(value.selection);
  if (selection) snapshot.selection = selection;
  if (isRecord(value.callGraph)) {
    const callGraph: NonNullable<SkeinViewSnapshot["callGraph"]> = {};
    if (typeof value.callGraph.rootSymbolId === "string") {
      callGraph.rootSymbolId = value.callGraph.rootSymbolId;
    }
    if (typeof value.callGraph.depth === "number") callGraph.depth = value.callGraph.depth;
    snapshot.callGraph = callGraph;
  }
  const layout = parseLayout(value.layout);
  if (layout) snapshot.layout = layout;
  const views = parseViewSelections(value.views);
  if (views) snapshot.views = views;
  if (isRecord(value.surface)) {
    const surface = value.surface;
    const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 10000) : [];
    snapshot.surface = { nodeIds: strings(surface.nodeIds), expandedNodeIds: strings(surface.expandedNodeIds) };
    if (surface.nodeIdsTruncated === true) snapshot.surface.nodeIdsTruncated = true;
    if (isRecord(surface.search) && typeof surface.search.query === "string" && typeof surface.search.total === "number") {
      snapshot.surface.search = { query: surface.search.query.slice(0, 256), matches: strings(surface.search.matches).slice(0, 100), total: surface.search.total };
    }
    if (isRecord(surface.architecture)) {
      const a = surface.architecture;
      snapshot.surface.architecture = {};
      for (const key of ["revision", "unit", "folder", "view"] as const) {
        if (typeof a[key] === "string") snapshot.surface.architecture[key] = a[key];
      }
      if (typeof a.minImports === "number") snapshot.surface.architecture.minImports = a.minImports;
    }
    if (isRecord(surface.analysis) && typeof surface.analysis.nodes === "number" && typeof surface.analysis.edges === "number") {
      snapshot.surface.analysis = { nodes: surface.analysis.nodes, edges: surface.analysis.edges, stale: surface.analysis.stale === true,
        ...(typeof surface.analysis.revision === "string" ? { revision: surface.analysis.revision } : {}) };
    }
    if (isRecord(surface.diagnostics) && Array.isArray(surface.diagnostics.items) && typeof surface.diagnostics.total === "number") {
      const items = surface.diagnostics.items.filter(isRecord).filter(item => typeof item.id === "string" && typeof item.kind === "string" && typeof item.status === "string")
        .slice(0, 100).map(item => ({ id: String(item.id), kind: String(item.kind), status: String(item.status) }));
      snapshot.surface.diagnostics = { total: surface.diagnostics.total, truncated: surface.diagnostics.truncated === true, items };
    }
  }
  return snapshot;
}

function parseWindowView(
  value: Record<string, unknown>,
  fallbackWindowId: string,
): SkeinWindowView | null {
  const snapshot = parseSnapshot(value);
  if (!snapshot) return null;
  const windowId =
    typeof value.windowId === "string" && value.windowId.length > 0
      ? value.windowId
      : fallbackWindowId;
  return {
    ...snapshot,
    windowId,
    updatedAt: isFiniteNumber(value.updatedAt) ? value.updatedAt : 0,
    lastUserActionAt: isFiniteNumber(value.lastUserActionAt) ? value.lastUserActionAt : 0,
    graphVersion: isFiniteNumber(value.graphVersion) ? value.graphVersion : 0,
  };
}

function latestWindowId(windows: Record<string, SkeinWindowView>): string | undefined {
  let latest: SkeinWindowView | undefined;
  for (const window of Object.values(windows)) {
    if (!latest || window.updatedAt > latest.updatedAt) latest = window;
  }
  return latest?.windowId;
}

function migrateLegacyViewState(
  parsed: Record<string, unknown>,
  workspaceRoot: string,
): SkeinViewState | null {
  const window = parseWindowView(parsed, "legacy");
  if (!window) return null;
  return {
    ...window,
    schemaVersion: SKEIN_STATE_SCHEMA_VERSION,
    workspaceRoot,
    activeWindowId: window.windowId,
    windows: { [window.windowId]: window },
  };
}

/** Returns the parsed state, or null when the value is missing or malformed. */
export function parseViewStateValue(parsed: unknown): SkeinViewState | null {
  if (!isRecord(parsed)) return null;
  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== SKEIN_STATE_SCHEMA_VERSION) return null;
  if (typeof parsed.workspaceRoot !== "string" || parsed.workspaceRoot.length === 0) return null;
  const workspaceRoot = parsed.workspaceRoot;

  if (schemaVersion === 1) return migrateLegacyViewState(parsed, workspaceRoot);

  const windows: Record<string, SkeinWindowView> = {};
  if (isRecord(parsed.windows)) {
    for (const [key, value] of Object.entries(parsed.windows)) {
      if (!isRecord(value)) continue;
      const window = parseWindowView(value, key);
      if (window) windows[window.windowId] = window;
    }
  }

  if (Object.keys(windows).length === 0) {
    const legacy = parseWindowView(parsed, typeof parsed.windowId === "string" ? parsed.windowId : "legacy");
    if (!legacy) return null;
    windows[legacy.windowId] = legacy;
  }

  const requestedActive =
    typeof parsed.activeWindowId === "string" ? parsed.activeWindowId : undefined;
  const activeWindowId =
    requestedActive && windows[requestedActive]
      ? requestedActive
      : (latestWindowId(windows) ?? Object.keys(windows)[0]);
  const active = windows[activeWindowId];
  if (!active) return null;

  return {
    ...active,
    schemaVersion: SKEIN_STATE_SCHEMA_VERSION,
    workspaceRoot,
    activeWindowId,
    windows,
    updatedAt: Math.max(active.updatedAt, isFiniteNumber(parsed.updatedAt) ? parsed.updatedAt : 0),
  };
}

/** Returns the parsed state, or null when the JSON is malformed. */
export function parseViewState(raw: string): SkeinViewState | null {
  try {
    return parseViewStateValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseAction(value: unknown): SkeinViewAction | null {
  if (!isRecord(value) || typeof value.action !== "string") return null;
  if (!ACTION_NAMES.has(value.action)) return null;
  switch (value.action) {
    case "search":
      return typeof value.query === "string" && value.query.length <= 256 ? { action: "search", query: value.query } : null;
    case "set_expanded":
      return typeof value.nodeId === "string" && typeof value.expanded === "boolean" ? { action: "set_expanded", nodeId: value.nodeId, expanded: value.expanded } : null;
    case "set_architecture": {
      if (value.view !== undefined && value.view !== "graph" && value.view !== "matrix") return null;
      if (value.unit !== undefined && typeof value.unit !== "string") return null;
      if (value.folder !== undefined && typeof value.folder !== "string") return null;
      if (value.minImports !== undefined && (!Number.isSafeInteger(value.minImports) || Number(value.minImports) < 1)) return null;
      return { action: "set_architecture", view: value.view as "graph" | "matrix" | undefined, unit: value.unit as string | undefined, folder: value.folder as string | undefined, minImports: value.minImports as number | undefined };
    }
    case "select":
    case "focus":
      return typeof value.nodeId === "string" && value.nodeId.length > 0
        ? { action: value.action, nodeId: value.nodeId }
        : null;
    case "set_depth":
      return typeof value.depth === "number" ? { action: "set_depth", depth: value.depth } : null;
    case "open_file": {
      if (typeof value.path !== "string" || value.path.length === 0) return null;
      const action: SkeinViewAction = { action: "open_file", path: value.path };
      if (typeof value.line === "number") action.line = value.line;
      if (typeof value.character === "number") action.character = value.character;
      return action;
    }
    case "set_filter":
      return isFilterType(value.filterType) &&
        typeof value.value === "string" &&
        typeof value.visible === "boolean"
        ? {
            action: "set_filter",
            filterType: value.filterType,
            value: value.value,
            visible: value.visible,
          }
        : null;
    case "set_expand_all":
      return typeof value.expandAll === "boolean"
        ? { action: "set_expand_all", expandAll: value.expandAll }
        : null;
    default:
      return null;
  }
}

export function parseCommandRequest(raw: string): SkeinCommandRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.id !== "string" || parsed.id.length === 0) return null;
  if (typeof parsed.createdAt !== "number") return null;
  const command = parseAction(parsed.command);
  if (!command) return null;
  const request: SkeinCommandRequest = { id: parsed.id, createdAt: parsed.createdAt, command };
  if (typeof parsed.graphVersion === "number") request.graphVersion = parsed.graphVersion;
  if (typeof parsed.targetWindowId === "string" && parsed.targetWindowId.length > 0) {
    request.targetWindowId = parsed.targetWindowId;
  }
  return request;
}

export function parseCommandResult(raw: string): SkeinCommandResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.id !== "string" || typeof parsed.completedAt !== "number") return null;
  const status = parsed.status;
  if (status !== "applied" && status !== "rejected" && status !== "error") return null;
  const result: SkeinCommandResult = {
    id: parsed.id,
    status,
    completedAt: parsed.completedAt,
  };
  if (typeof parsed.reason === "string") result.reason = parsed.reason;
  const state = parseViewStateValue(parsed.state);
  if (state) result.state = state;
  return result;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

let temporaryFileCounter = 0;

/** Writes through a temporary file in the same directory, then renames. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${++temporaryFileCounter}.tmp`,
  );
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (err) {
    await fs.rm(temporaryPath, { force: true });
    throw err;
  }
}

/**
 * Creates `.skein/` with a local `.gitignore` (`*`) so the folder never shows up
 * in the user's repository without touching a shared exclude file.
 */
export async function ensureSkeinWorkspace(root: string): Promise<void> {
  const dir = skeinDir(root);
  await fs.mkdir(commandDir(root), { recursive: true });
  const gitignore = path.join(dir, ".gitignore");
  try {
    await fs.access(gitignore);
  } catch {
    await fs.writeFile(gitignore, "*\n", "utf8");
  }
}

/**
 * Serializes read-modify-write cycles across extension windows.
 * A crashed writer leaves a lock behind; it is treated as stale after 5 s.
 */
export async function withStateLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await ensureSkeinWorkspace(root);
  return withFileLock(stateLockPath(root), action);
}

export async function readViewState(root: string): Promise<SkeinViewState | null> {
  try {
    return parseViewState(await fs.readFile(viewStatePath(root), "utf8"));
  } catch {
    return null;
  }
}

/** Direct write. Prefer `mergeViewState` in the extension. */
export async function writeViewState(root: string, state: SkeinViewState): Promise<void> {
  await writeJsonAtomic(viewStatePath(root), state);
}

export interface WindowStateWrite {
  workspaceRoot: string;
  windowId: string;
  snapshot: SkeinViewSnapshot;
  graphVersion: number;
  lastUserActionAt: number;
  updatedAt?: number;
}

function pruneWindowSnapshots(
  windows: Record<string, SkeinWindowView>,
  keepWindowId: string,
  now: number,
): Record<string, SkeinWindowView> {
  const pruned: Record<string, SkeinWindowView> = {};
  for (const [id, window] of Object.entries(windows)) {
    if (id === keepWindowId || now - window.updatedAt <= WINDOW_SNAPSHOT_MAX_AGE_MS) {
      pruned[id] = window;
    }
  }
  return pruned;
}

/**
 * Merges this window's snapshot into the shared file under a lock, then makes
 * the newest window the top-level view (what an MCP client reads).
 */
export async function mergeViewState(
  root: string,
  write: WindowStateWrite,
): Promise<SkeinViewState> {
  const now = write.updatedAt ?? Date.now();
  return withStateLock(root, async () => {
    const existing = await readViewState(root);
    const windows: Record<string, SkeinWindowView> = existing ? { ...existing.windows } : {};
    windows[write.windowId] = {
      ...write.snapshot,
      windowId: write.windowId,
      updatedAt: now,
      lastUserActionAt: write.lastUserActionAt,
      graphVersion: write.graphVersion,
    };
    const pruned = pruneWindowSnapshots(windows, write.windowId, now);
    const merged: SkeinViewState = {
      ...pruned[write.windowId],
      schemaVersion: SKEIN_STATE_SCHEMA_VERSION,
      workspaceRoot: normalizePath(write.workspaceRoot),
      activeWindowId: write.windowId,
      windows: pruned,
      updatedAt: now,
    };
    await writeJsonAtomic(viewStatePath(root), merged);
    return merged;
  });
}

/** Drops snapshots older than `maxAgeMs` without changing the active one. */
export async function pruneWindowSnapshotsInFile(
  root: string,
  maxAgeMs = WINDOW_SNAPSHOT_MAX_AGE_MS,
): Promise<void> {
  await withStateLock(root, async () => {
    const existing = await readViewState(root);
    if (!existing) return;
    const now = Date.now();
    const windows: Record<string, SkeinWindowView> = {};
    for (const [id, window] of Object.entries(existing.windows)) {
      if (id === existing.activeWindowId || now - window.updatedAt <= maxAgeMs) {
        windows[id] = window;
      }
    }
    if (Object.keys(windows).length === Object.keys(existing.windows).length) return;
    const active = windows[existing.activeWindowId] ?? Object.values(windows)[0];
    if (!active) return;
    await writeJsonAtomic(viewStatePath(root), {
      ...active,
      schemaVersion: SKEIN_STATE_SCHEMA_VERSION,
      workspaceRoot: existing.workspaceRoot,
      activeWindowId: active.windowId,
      windows,
    });
  });
}

// ---------------------------------------------------------------------------
// Command queue
// ---------------------------------------------------------------------------

export function createCommandId(): string {
  return randomUUID();
}

export async function writeCommandRequest(
  root: string,
  request: SkeinCommandRequest,
): Promise<void> {
  await writeJsonAtomic(commandRequestPath(root, request.id), request);
}

/** Requests written by the MCP server, oldest first. Malformed files are ignored. */
export async function listCommandRequests(root: string): Promise<SkeinCommandRequest[]> {
  let names: string[];
  try {
    names = await fs.readdir(commandDir(root));
  } catch {
    return [];
  }
  const requests: SkeinCommandRequest[] = [];
  /* eslint-disable no-await-in-loop -- one small file per queued command */
  for (const name of names) {
    if (!name.endsWith(".request.json")) continue;
    try {
      const request = parseCommandRequest(
        await fs.readFile(path.join(commandDir(root), name), "utf8"),
      );
      if (request) requests.push(request);
    } catch {
      // Removed between readdir and read — ignore.
    }
  }
  /* eslint-enable no-await-in-loop */
  return requests.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export async function readCommandResult(
  root: string,
  id: string,
): Promise<SkeinCommandResult | null> {
  try {
    return parseCommandResult(await fs.readFile(commandResultPath(root, id), "utf8"));
  } catch {
    return null;
  }
}

export async function writeCommandResult(root: string, result: SkeinCommandResult): Promise<void> {
  await writeJsonAtomic(commandResultPath(root, result.id), result);
}

export async function deleteCommandFiles(root: string, id: string): Promise<void> {
  await Promise.all(
    [commandRequestPath(root, id), commandResultPath(root, id)].map((file) =>
      fs.rm(file, { force: true }),
    ),
  );
}

export async function deleteCommandRequest(root: string, id: string): Promise<void> {
  await fs.rm(commandRequestPath(root, id), { force: true });
}

/** Drops request/result files older than `maxAgeMs` (crashed runs). */
export async function pruneCommandFiles(root: string, maxAgeMs: number): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(commandDir(root));
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    names
      .filter((name) => name.endsWith(".request.json") || name.endsWith(".result.json"))
      .map(async (name) => {
        const file = path.join(commandDir(root), name);
        try {
          const stat = await fs.stat(file);
          if (stat.mtimeMs < cutoff) await fs.rm(file, { force: true });
        } catch {
          // Already gone.
        }
      }),
  );
}

/**
 * A human interacted with the view after the command was queued, so applying it
 * would move the screen under them (DESIGN 10.2).
 */
export function isCommandSupersededByUser(
  request: SkeinCommandRequest,
  state: Pick<SkeinViewState, "lastUserActionAt"> | null,
): boolean {
  return state !== null && state.lastUserActionAt > request.createdAt;
}

/** The command was queued against an older analysis result. */
export function isCommandStale(
  request: SkeinCommandRequest,
  state: Pick<SkeinViewState, "graphVersion"> | null,
): boolean {
  return (
    request.graphVersion !== undefined &&
    state !== null &&
    state.graphVersion !== request.graphVersion
  );
}
