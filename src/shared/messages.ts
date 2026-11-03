/**
 * Extension ↔ webview message protocol types.
 * Contains all message interfaces and union types for communication
 * between the VS Code extension host and the webview React app.
 */

import type {
  ArchitectureExtensionMessage,
  ArchitectureWebviewCommand,
} from "./architecture-types";
import type {
  CallGraphCopyReferenceCommand,
  CallGraphDepthChangedCommand,
  CallGraphFilterChangedCommand,
  CallGraphIndexingMessage,
  CallGraphMountedCommand,
  CallGraphOpenFileCommand,
  CallGraphReadyCommand,
  CallGraphSelectionChangedCommand,
  CallGraphLayoutChangedCommand,
  CallGraphSymbolFocusCommand,
  ShowCallGraphMessage,
} from "./callgraph-types";
import type { CommunityMode, GraphData } from "./graph-types";
import type {
    BreadcrumbPath,
    IntraFileGraph,
    SymbolDependency,
    SymbolInfo,
} from "./symbol-types";

export interface ShowGraphMessage {
  command: "updateGraph";
  filePath: string;
  data: GraphData;
  expandAll?: boolean;
  isRefresh?: boolean;
  refreshReason?:
    | "manual"
    | "indexing"
    | "fileSaved"
    | "navigation"
    | "fileChange"
    | "usage-analysis"
    | "unknown";
  unusedDependencyMode?: "none" | "hide" | "dim";
  filterUnused?: boolean;
  showCommunities?: boolean;
  /** How nodeMetadata communities were computed, so the legend can say so. */
  communityMode?: CommunityMode;
}

export interface OpenFileMessage {
  command: "openFile";
  path: string;
  line?: number;
}

export interface ExpandNodeMessage {
  command: "expandNode";
  nodeId: string;
  knownNodes: string[];
}

export interface SetExpandAllMessage {
  command: "setExpandAll";
  expandAll: boolean;
}

export interface CancelExpandNodeMessage {
  command: "cancelExpandNode";
  nodeId?: string;
}

export interface UpdateFilterMessage {
  command: "updateFilter";
  filterUnused: boolean;
  unusedDependencyMode: "none" | "hide" | "dim";
}

export interface RefreshingMessage {
  command: "refreshing";
}

export interface RefreshGraphMessage {
  command: "refreshGraph";
}

export interface EnableUnusedFilterMessage {
  command: "enableUnusedFilter";
}

export interface DisableUnusedFilterMessage {
  command: "disableUnusedFilter";
}

export interface SelectSymbolMessage {
  command: "selectSymbol";
  symbolId: string | undefined;
}

export interface ExpandedGraphMessage {
  command: "expandedGraph";
  nodeId: string;
  data: GraphData;
}

export interface FindReferencingFilesMessage {
  command: "findReferencingFiles";
  nodeId: string;
  knownNodes?: string[];
}

export interface ReferencingFilesMessage {
  command: "referencingFiles";
  nodeId: string;
  data: GraphData;
}

export interface ClearReverseDependenciesMessage {
  command: "clearReverseDependencies";
}

export interface ExpansionProgressMessage {
  command: "expansionProgress";
  nodeId: string;
  status: "started" | "in-progress" | "completed" | "cancelled" | "error";
  processed?: number;
  total?: number;
  message?: string;
}

export interface IndexingProgressMessage {
  command: "indexingProgress";
  processed: number;
  total: number;
  status: "starting" | "indexing" | "complete" | "error" | "validating";
  message?: string;
}

export interface DrillDownMessage {
  command: "drillDown";
  filePath: string;
}

export interface ReadyMessage {
  command: "ready";
}

export interface SwitchModeMessage {
  command: "switchMode";
  mode: "file" | "symbol";
}

export interface SwitchViewModeMessage {
  command: "switchViewMode";
  mode: "file" | "list" | "symbol" | "architecture" | "callgraph";
}

export interface WebviewLogMessage {
  command: "webviewLog";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  args?: unknown[];
}

export interface EmptyStateMessage {
  command: "emptyState";
  reason: "no-file-open" | "no-workspace";
  message?: string;
}

export interface SymbolGraphMessage {
  command: "symbolGraph";
  filePath: string;
  isRefresh?: boolean;
  targetViewMode?: "symbol" | "list";
  graph: IntraFileGraph;
  breadcrumb: BreadcrumbPath;
  data?: {
    nodes: string[];
    edges: Array<{ source: string; target: string }>;
    symbolData?: { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };
    incomingDependencies?: SymbolDependency[];
    referencingFiles?: string[];
    parentCounts?: Record<string, number>;
  };
}

export interface SymbolEmptyStateMessage {
  command: "symbolEmptyState";
  filePath: string;
  reason:
    | "lsp-unavailable"
    | "unsupported-file-type"
    | "empty-file"
    | "analysis-error";
  message: string;
}

export interface NavigateToSymbolMessage {
  command: "navigateToSymbol";
  filePath: string;
  line: number;
  symbolId?: string;
}

export interface LayoutChangeMessage {
  type: "layoutChange";
  layout: "hierarchical" | "force" | "radial";
}

export interface ShowSymbolListMessage {
  type: "showSymbolList";
}

export interface SurfaceCommandMessage {
  command: "surfaceCommand";
  mode: import("./viewState").SkeinViewMode;
  id: string;
  action: import("./viewState").SkeinViewAction;
}
export interface SurfaceStateMessage {
  command: "surfaceState";
  mode: import("./viewState").SkeinViewMode;
  state: import("./viewState").SkeinSurfaceState;
  selection?: import("./viewState").SkeinSelection;
  userInitiated?: boolean;
}
export interface SurfaceResultMessage {
  command: "surfaceResult";
  id: string;
  reason?: string;
}

export type ExtensionToWebviewMessage =
  | SurfaceCommandMessage
  | ShowGraphMessage
  | ExpandedGraphMessage
  | ReferencingFilesMessage
  | ClearReverseDependenciesMessage
  | IndexingProgressMessage
  | SymbolGraphMessage
  | SymbolEmptyStateMessage
  | EmptyStateMessage
  | SetExpandAllMessage
  | ExpansionProgressMessage
  | UpdateFilterMessage
  | RefreshingMessage
  | LayoutChangeMessage
  | ShowSymbolListMessage
  | SwitchViewModeMessage
  | ShowCallGraphMessage
  | CallGraphIndexingMessage
  | ArchitectureExtensionMessage;

export type WebviewToExtensionMessage =
  | SurfaceStateMessage
  | SurfaceResultMessage
  | OpenFileMessage
  | ExpandNodeMessage
  | SetExpandAllMessage
  | RefreshGraphMessage
  | FindReferencingFilesMessage
  | DrillDownMessage
  | NavigateToSymbolMessage
  | ReadyMessage
  | SwitchModeMessage
  | SwitchViewModeMessage
  | WebviewLogMessage
  | CancelExpandNodeMessage
  | EnableUnusedFilterMessage
  | DisableUnusedFilterMessage
  | SelectSymbolMessage
  | CallGraphOpenFileCommand
  | CallGraphCopyReferenceCommand
  | CallGraphReadyCommand
  | CallGraphDepthChangedCommand
  | CallGraphFilterChangedCommand
  | CallGraphSymbolFocusCommand
  | CallGraphMountedCommand
  | CallGraphSelectionChangedCommand
  | CallGraphLayoutChangedCommand
  | ArchitectureWebviewCommand;
