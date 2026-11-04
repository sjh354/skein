/**
 * Extension ↔ Webview message protocol for the Live Call Graph feature.
 *
 * SPEC REFERENCE: specs/001-live-call-graph/spec.md — FR-001, FR-013
 * DATA MODEL: specs/001-live-call-graph/data-model.md
 * CONTRACT: specs/001-live-call-graph/contracts/messages.ts
 *
 * Convention matches existing message types in src/shared/messages.ts:
 *   - extension → webview: discriminated union on `type`
 *   - webview → extension: discriminated union on `command`
 */

import type { SkeinLayout } from "./viewState";

// ---------------------------------------------------------------------------
// Shared primitive types
// ---------------------------------------------------------------------------

/** Symbol types recognized by the GraphExtractor */
export type SymbolType =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "variable";

/** Relation types extracted by Tree-sitter queries */
export type RelationType = "CALLS" | "INHERITS" | "IMPLEMENTS" | "USES";

/** Language keys aligned with LANGUAGE_COLORS in src/shared/constants.ts */
export type SupportedLang = "typescript" | "javascript" | "python" | "rust" | "csharp" | "go" | "java" | "graphql" | "dart";

// ---------------------------------------------------------------------------
// Serialized graph payload (sent in showCallGraph message)
// ---------------------------------------------------------------------------

export interface SerializedCallNode {
  /** Stable ID: normalizedFilePath:symbolName:startLine */
  id: string;
  /** Symbol's bare display name */
  name: string;
  type: SymbolType;
  lang: SupportedLang;
  /** Normalized absolute path */
  path: string;
  /** Workspace-relative folder path (determines compound node parent) */
  folder: string;
  /** 0-based start line */
  startLine: number;
  /** 0-based end line */
  endLine: number;
  /** 0-based start column */
  startCol: number;
  isExported: boolean;
  /** True when this node is the symbol the user triggered the graph from */
  isRoot: boolean;
}

export interface SerializedCallEdge {
  sourceId: string;
  targetId: string;
  typeRelation: RelationType;
  /** True when this edge is part of a detected cycle */
  isCyclic: boolean;
  /** Line in source file where the reference occurs */
  sourceLine: number;
  /** Direction relative to the query root node */
  direction: "outgoing" | "incoming" | "lateral";
}

export interface SerializedCompoundNode {
  /** Workspace-relative folder path (folder) or absolute file path (file) */
  id: string;
  /** Display label, e.g. "services" or "utils.ts" */
  label: string;
  type: "compound";
  /** Two-level hierarchy: top-level folder groups contain file groups */
  compoundLevel: "folder" | "file";
  /** For file-level compounds: the parent folder compound id */
  parent?: string;
}

// ---------------------------------------------------------------------------
// Extension → Webview messages
// ---------------------------------------------------------------------------

/**
 * Sent when the extension has resolved the neighbourhood graph for a symbol.
 * The webview initialises or refreshes the Cytoscape instance with this data.
 */

export interface ShowCallGraphMessage {
  type: "showCallGraph";
  /** The ID of the root symbol (as defined in SerializedCallNode.id) */
  rootSymbolId: string;
  nodes: SerializedCallNode[];
  edges: SerializedCallEdge[];
  compounds: SerializedCompoundNode[];
  /** Traversal depth used to build this neighbourhood */
  depth: number;
  /** Reachable symbols omitted to keep the layout responsive (absent = none) */
  hiddenNodeCount?: number;
  /** Workspace folder name, shown in the detail panel's reference copy */
  projectName?: string;
  /** Saved node positions and viewport for this root (restored after a restart). */
  layout?: SkeinLayout;
  /** Unix ms — webview discards messages older than the last received */
  timestamp: number;
}

/**
 * Sent during indexation to inform the webview of progress.
 */
export interface CallGraphIndexingMessage {
  type: "callGraphIndexing";
  status: "started" | "progress" | "complete" | "error";
  message?: string;
  /** 0-100 */
  percent?: number;
}

/**
 * Asks the webview to select a node (MCP-driven). The webview reports the
 * result back with `callGraphSelectionChanged` and `userInitiated: false`.
 */
export interface CallGraphSelectNodeMessage {
  type: "callGraphSelectNode";
  nodeId: string;
}

/** Asks the webview to hide or show a node type or folder (MCP-driven). */
export interface CallGraphSetFilterMessage {
  type: "callGraphSetFilter";
  filterType: "nodeType" | "folder" | "edgeType";
  value: string;
  visible: boolean;
  /** Present when the extension waits for this renderer to confirm the change. */
  requestId?: string;
}

/** Synchronises the depth slider without re-querying (the extension owns the query). */
export interface CallGraphSetDepthMessage {
  type: "callGraphSetDepth";
  depth: number;
}

/** Discriminated union of all extension → webview messages for this feature */
export interface CallGraphSyncLayoutMessage {
  type: "callGraphSyncLayout";
  layout: import("./viewState").SkeinLayout;
}

export type CallGraphExtensionMessage =
  | CallGraphSyncLayoutMessage
  | ShowCallGraphMessage
  | CallGraphIndexingMessage
  | CallGraphSelectNodeMessage
  | CallGraphSetFilterMessage
  | CallGraphSetDepthMessage;

// ---------------------------------------------------------------------------
// Webview → Extension messages
// ---------------------------------------------------------------------------

/**
 * Sent when the user clicks on a node in the Cytoscape graph.
 * The extension opens the corresponding file at the symbol's location.
 */
export interface CallGraphOpenFileCommand {
  command: "callGraphOpenFile";
  /** Absolute file URI scheme path */
  uri: string;
  /** 0-based line number to reveal */
  line: number;
  /** 0-based column number to reveal */
  character: number;
}

/**
 * Sent when the user asks to centre the graph on a symbol (detail panel action).
 * A plain click only selects: it neither navigates nor re-centres.
 */
export interface CallGraphSymbolFocusCommand {
  command: "callGraphSymbolFocus";
  /** Full node ID (e.g. "/abs/path/file.ts:symbolName:line") used as new graph root */
  nodeId: string;
  /** Absolute file path for VS Code navigation */
  path: string;
  /** 0-based line number */
  startLine: number;
  /** 0-based column number */
  startCol: number;
}

/**
 * Sent once by the webview immediately after the window `message` listener is
 * registered (inside the empty-deps useEffect). This signals to the extension
 * that it can safely (re-)send any buffered `showCallGraph` data that may have
 * been posted before the listener was ready.
 */
export interface CallGraphMountedCommand {
  command: "callGraphMounted";
}

/**
 * Sent when the Cytoscape graph has finished rendering (used for E2E test
 * instrumentation / metrics only — NOT used to trigger replay).
 */
export interface CallGraphReadyCommand {
  command: "callGraphReady";
  /** Number of nodes rendered */
  nodeCount: number;
  /** Number of edges rendered */
  edgeCount: number;
}

/**
 * Sent when the user toggles a filter in the legend
 * (show/hide a node type or folder).
 * The extension may use this to persist filter state;
 * the webview applies filters locally.
 */
export interface CallGraphFilterChangedCommand {
  command: "callGraphFilterChanged";
  /** What was toggled */
  filterType: "nodeType" | "folder" | "edgeType";
  /** The value being toggled (SymbolType string, folder path, or edge filter key) */
  value: string;
  /** New visibility state */
  visible: boolean;
}

/**
 * Confirms that a renderer applied (or rejected) a filter requested by the
 * extension. The extension only reports `set_filter` as applied after this.
 */
export interface CallGraphFilterAppliedCommand {
  command: "callGraphFilterApplied";
  requestId: string;
  /** Present when the filter could not be applied to the rendered graph. */
  reason?: string;
}

/**
 * Sent when the user adjusts the depth slider in the call graph legend.
 * The extension re-queries the neighbourhood at the new depth and pushes
 * an updated `ShowCallGraphMessage` to the webview.
 */
export interface CallGraphDepthChangedCommand {
  command: "callGraphDepthChanged";
  /** Requested traversal depth (1 = direct callers/callees only, max 5) */
  depth: number;
}

/**
 * Sent when the user copies the selected symbol's reference (project, node id,
 * path, symbol, position, analysis version) from the detail panel.
 * The extension owns the clipboard so the webview needs no clipboard permission.
 */
export interface CallGraphCopyReferenceCommand {
  command: "callGraphCopyReference";
  text: string;
}

/**
 * Sent when the graph selection changes, including selections requested by the
 * extension on behalf of an agent. `userInitiated` separates human actions
 * (which take priority over queued agent commands) from agent-driven changes.
 */
export interface CallGraphSelectionChangedCommand {
  command: "callGraphSelectionChanged";
  nodeId?: string;
  path?: string;
  name?: string;
  startLine?: number;
  userInitiated: boolean;
}

/**
 * Sent when the user (or a restore) changes node positions or the viewport.
 * The extension persists it in `.skein/state.json` so a restart can restore it.
 */
export interface CallGraphLayoutChangedCommand {
  command: "callGraphLayoutChanged";
  layout: SkeinLayout;
  userInitiated: boolean;
}

/**
 * Sent while the user is panning, zooming or dragging nodes. The extension
 * rejects commands that arrive during an interaction instead of moving the
 * screen under the user (DESIGN 10.2). `active` turns false once the
 * interaction has been idle for a moment.
 */
export interface CallGraphUserInteractionCommand {
  command: "callGraphUserInteraction";
  active: boolean;
}

/** Discriminated union of all webview → extension messages for this feature */
export type CallGraphWebviewCommand =
  | CallGraphMountedCommand
  | CallGraphOpenFileCommand
  | CallGraphSymbolFocusCommand
  | CallGraphCopyReferenceCommand
  | CallGraphReadyCommand
  | CallGraphFilterChangedCommand
  | CallGraphFilterAppliedCommand
  | CallGraphDepthChangedCommand
  | CallGraphSelectionChangedCommand
  | CallGraphLayoutChangedCommand
  | CallGraphUserInteractionCommand;
