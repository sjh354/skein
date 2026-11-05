/**
 * CytoscapeGraph — React component rendering the live call graph.
 *
 * Responsibilities:
 * - Initialize a Cytoscape.js instance inside a div ref on mount
 * - Register cytoscape-fcose layout extension (once, at module load)
 * - Listen to `window.message` for `showCallGraph` (render graph) and
 *   `callGraphIndexing` (show loading state) messages from the extension
 * - Post `callGraphReady` back to extension after layout completes
 * - Destroy Cytoscape instance on unmount (FR-016)
 *
 * NO @/ path aliases — webview uses relative imports.
 * SPEC: specs/001-live-call-graph/spec.md — FR-001..FR-016
 */

import cytoscape from "cytoscape";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  CallGraphCopyReferenceCommand,
  CallGraphDepthChangedCommand,
  CallGraphExtensionMessage,
  CallGraphLayoutChangedCommand,
  CallGraphMountedCommand,
  CallGraphOpenFileCommand,
  CallGraphReadyCommand,
  CallGraphSelectionChangedCommand,
  CallGraphSymbolFocusCommand,
  SerializedCallEdge,
  SerializedCallNode,
  SerializedCompoundNode,
  ShowCallGraphMessage,
  SymbolType,
} from "../../../shared/callgraph-types";
import type { SkeinFilter, SkeinFilterType } from "../../../shared/viewState";
import { CallGraphDetail } from "./CallGraphDetail";
import { aliasKey, type Point, planPositions } from "./CytoscapeLayout";
import { buildCallGraphStylesheet } from "./CytoscapeTheme";
import { GraphLegend } from "./GraphLegend";
import { registerViewportReporting, focusZoomFor } from "./viewportReporting";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fcose = require("cytoscape-fcose") as cytoscape.Ext;

// ---------------------------------------------------------------------------
// Register fcose layout ONCE at module level (idempotent in Cytoscape)
// ---------------------------------------------------------------------------

cytoscape.use(fcose);

// ---------------------------------------------------------------------------
// VS Code webview API (available as window.acquireVsCodeApi in webviews)
// ---------------------------------------------------------------------------

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Lazily acquired so tests can load this module without the API.
// When CytoscapeGraph is rendered inside the main webview bundle (App.tsx),
// acquireVsCodeApi() was already called. In that case the caller passes its
// postMessage function as a prop; the local fallback is only for the
// standalone callgraph/index.tsx entry point.
let vsCodeApi: VsCodeApi | null = null;
function getVsCodeApi(): VsCodeApi | null {
  if (vsCodeApi) return vsCodeApi;
  try {
    if (typeof acquireVsCodeApi === "function") {
      vsCodeApi = acquireVsCodeApi();
    }
  } catch {
    // Already acquired — ignore
  }
  return vsCodeApi;
}

// ---------------------------------------------------------------------------
// Helper: compute call order for CALLS edges per source node
// ---------------------------------------------------------------------------

/**
 * For each source node, sort its outgoing CALLS edges by `sourceLine` and
 * assign a 1-based order index.  This reflects the sequence in which a
 * function calls its callees as written in source code.
 *
 * @returns Map from edge key (`sourceId→targetId→typeRelation`) to order number.
 */
function computeCallOrder(edges: SerializedCallEdge[]): Map<string, number> {
  const orderMap = new Map<string, number>();
  const edgesBySource = new Map<string, SerializedCallEdge[]>();

  for (const e of edges) {
    if (e.typeRelation !== "CALLS") continue;
    let list = edgesBySource.get(e.sourceId);
    if (!list) {
      list = [];
      edgesBySource.set(e.sourceId, list);
    }
    list.push(e);
  }

  for (const [, group] of edgesBySource) {
    group.sort((a, b) => a.sourceLine - b.sourceLine);
    for (let i = 0; i < group.length; i++) {
      orderMap.set(`${group[i].sourceId}→${group[i].targetId}→${group[i].typeRelation}`, i + 1);
    }
  }

  return orderMap;
}

// ---------------------------------------------------------------------------
// Helper: build Cytoscape elements from graph data
// ---------------------------------------------------------------------------

/**
 * Build Cytoscape node/compound elements. Edges are returned separately so they can
 * be added to the graph AFTER the batch that adds nodes — this ensures Cytoscape
 * renders edges above compound backgrounds regardless of z-index settings.
 */
function buildElements(
  nodes: SerializedCallNode[],
  edges: SerializedCallEdge[],
  compounds: SerializedCompoundNode[],
): { nodeElements: cytoscape.ElementDefinition[]; edgeElements: cytoscape.ElementDefinition[] } {
  const nodeElements: cytoscape.ElementDefinition[] = [];
  const edgeElements: cytoscape.ElementDefinition[] = [];

  // Build lookup sets for fast parent-existence checks
  const compoundIds = new Set(compounds.map((c) => c.id));

  // Folder compounds first, then file compounds (Cytoscape requires parents before children)
  const folderCompounds = compounds.filter((c) => c.compoundLevel === "folder");
  const fileCompounds = compounds.filter((c) => c.compoundLevel === "file");

  for (const c of [...folderCompounds, ...fileCompounds]) {
    nodeElements.push({
      group: "nodes",
      data: {
        id: c.id,
        label: c.label,
        type: "compound",
        compoundLevel: c.compoundLevel,
        parent: c.parent && compoundIds.has(c.parent) ? c.parent : undefined,
      },
    });
  }

  // Symbol nodes — parent is the file-level compound (n.path)
  for (const n of nodes) {
    nodeElements.push({
      group: "nodes",
      data: {
        id: n.id,
        label: n.name,
        name: n.name,
        type: n.type,
        lang: n.lang,
        path: n.path,
        startLine: n.startLine,
        startCol: n.startCol,
        // Use numeric 1/0 so Cytoscape [?isRoot] truthy selector works correctly
        // (the string "false" is truthy, which would style all nodes as roots)
        isRoot: n.isRoot ? 1 : 0,
        parent: compoundIds.has(n.path) ? n.path : undefined,
      },
    });
  }

  // Compute call order: for each source, sort CALLS edges by sourceLine
  const callOrderMap = computeCallOrder(edges);

  // Edges — carry direction for colour styling + call order
  for (const e of edges) {
    const edgeKey = `${e.sourceId}→${e.targetId}→${e.typeRelation}`;
    const order = callOrderMap.get(edgeKey);
    edgeElements.push({
      group: "edges",
      data: {
        id: edgeKey,
        source: e.sourceId,
        target: e.targetId,
        typeRelation: e.typeRelation,
        // Use numeric 1/0 so Cytoscape [?isCyclic] truthy selector works correctly
        // (the string "false" is truthy, which styled every edge as cyclic/red)
        isCyclic: e.isCyclic ? 1 : 0,
        direction: e.direction,
        // Line in the source file the relation occurs on (double-click opens it)
        sourceLine: e.sourceLine,
        // Call order label (1-based) — only set for CALLS edges
        ...(order !== undefined && { callOrder: order }),
      },
    });
  }

  return { nodeElements, edgeElements };
}

// ---------------------------------------------------------------------------
// Helper: force Cytoscape to fully repaint after a layout
// ---------------------------------------------------------------------------

/**
 * A zero-delta pan is the lightest operation that triggers Cytoscape's full
 * canvas repaint path (same code path as a real user pan).  This ensures
 * edges rendered with z-index-compare:manual appear above compound fills
 * on the very first frame after a layout completes.
 */
function triggerCanvasRepaint(cy: cytoscape.Core): void {
  requestAnimationFrame(() => {
    cy.panBy({ x: 0, y: 0 });
    cy.forceRender();
  });
}

// ---------------------------------------------------------------------------
// Selection — relations are emphasised by dimming what is unrelated, which
// keeps every symbol in place and never hides the user's context.
// ---------------------------------------------------------------------------

function clearSelection(cy: cytoscape.Core): void {
  cy.elements().unselect();
  cy.elements().removeClass("dimmed");
}

/** Keep the selected symbol, its one-hop relations and the root readable. */
function dimUnrelated(cy: cytoscape.Core, keepNodeIds: Set<string>): void {
  const rootIds = cy.nodes("[?isRoot]").map((node) => node.id());
  for (const id of rootIds) keepNodeIds.add(id);
  cy.nodes("[type != 'compound']").forEach((node) => {
    if (!keepNodeIds.has(node.id())) node.addClass("dimmed");
  });
}

function selectNode(cy: cytoscape.Core, nodeId: string): void {
  clearSelection(cy);
  const node = cy.getElementById(nodeId);
  if (node.empty() || !node.isNode()) return;
  node.select();

  const keep = new Set<string>([nodeId]);
  const incident = node.connectedEdges();
  incident.forEach((edge) => {
    keep.add(edge.source().id());
    keep.add(edge.target().id());
  });
  dimUnrelated(cy, keep);
  cy.edges().forEach((edge) => {
    if (!incident.contains(edge)) edge.addClass("dimmed");
  });
}

function selectEdge(cy: cytoscape.Core, edgeId: string): void {
  clearSelection(cy);
  const edge = cy.getElementById(edgeId);
  if (edge.empty() || !edge.isEdge()) return;
  edge.select();
  dimUnrelated(cy, new Set([edge.source().id(), edge.target().id()]));
  cy.edges().forEach((candidate) => {
    if (candidate.id() !== edgeId) candidate.addClass("dimmed");
  });
}

// ---------------------------------------------------------------------------
// Theme detection — VS Code adds class to <body>: vscode-dark, vscode-light,
// vscode-high-contrast, vscode-high-contrast-light
// ---------------------------------------------------------------------------

function detectIsDarkTheme(): boolean {
  return !document.body.classList.contains("vscode-light") &&
         !document.body.classList.contains("vscode-high-contrast-light");
}

const EDGE_FILTER_KEYS = new Set([
  "outgoing", "incoming", "lateral", "inherits", "implements", "uses", "cycle",
]);

/** Rejects filters the current graph cannot apply instead of reporting success. */
function isKnownFilter(
  filterType: SkeinFilterType,
  value: string,
  nodeTypes: SymbolType[],
  folders: string[],
): boolean {
  if (filterType === "nodeType") return nodeTypes.includes(value as SymbolType);
  if (filterType === "folder") return folders.includes(value);
  return EDGE_FILTER_KEYS.has(value);
}

/** Converts legend keys (`type:value`) to the published filter shape. */
function filtersFromKeys(keys: Set<string>): SkeinFilter[] {
  const filters: SkeinFilter[] = [];
  for (const key of keys) {
    const colon = key.indexOf(":");
    if (colon <= 0) continue;
    filters.push({ filterType: key.slice(0, colon) as SkeinFilterType, value: key.slice(colon + 1) });
  }
  return filters;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CytoscapeGraphProps {
  /** Called when Cytoscape has finished rendering the first layout */
  onReady?: (nodeCount: number, edgeCount: number) => void;
  /** Post a message to the VS Code extension.
   *  When embedded in the main webview (App.tsx), pass `vscode.postMessage`.
   *  When used standalone (callgraph/index.tsx) this falls back to the local API. */
  postMessage?: (message: unknown) => void;
}

/**
 * Full-height Cytoscape graph container for the live call graph webview.
 */
import { useSurfaceBridge } from "../../utils/useSurfaceBridge";

export function CytoscapeGraph({ onReady, postMessage }: Readonly<CytoscapeGraphProps>): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  // Resolved postMessage function: prefer the prop, fall back to local acquireVsCodeApi
  const postMessageFn = useCallback(
    (msg: unknown): void => {
      if (postMessage) {
        postMessage(msg);
      } else {
        getVsCodeApi()?.postMessage(msg);
      }
    },
    [postMessage],
  );

  // Keep latest postMessageFn in a ref so event-handler closures use the current version
  const postMessageRef = useRef(postMessageFn);
  postMessageRef.current = postMessageFn;

  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Analyzing…");
  const [isEmpty, setIsEmpty] = useState(false);
  const [hiddenNodeCount, setHiddenNodeCount] = useState(0);

  // T027 — filter legend state
  const [hiddenFilters, setHiddenFilters] = useState<Set<string>>(new Set());
  const [graphNodeTypes, setGraphNodeTypes] = useState<SymbolType[]>([]);
  const [graphFolders, setGraphFolders] = useState<string[]>([]);
  const hiddenFiltersRef = useRef<Set<string>>(new Set());
  const graphNodeTypesRef = useRef<SymbolType[]>([]);
  const graphFoldersRef = useRef<string[]>([]);
  graphNodeTypesRef.current = graphNodeTypes;
  graphFoldersRef.current = graphFolders;

  // Depth slider state — synchronised with extension on each showCallGraph message
  const [currentDepth, setCurrentDepth] = useState(1);

  // Detail panel: what is selected, and the data it reads (DESIGN 3.2).
  const [graphNodes, setGraphNodes] = useState<SerializedCallNode[]>([]);
  const [graphEdges, setGraphEdges] = useState<SerializedCallEdge[]>([]);
  const [rootSymbolId, setRootSymbolId] = useState("");
  const [projectName, setProjectName] = useState<string | undefined>(undefined);
  const [generatedAt, setGeneratedAt] = useState<number | undefined>(undefined);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | undefined>(undefined);

  // Positions survive save-driven refreshes and depth changes; a new root or an
  // explicit re-layout rebuilds them (DESIGN 3.2).
  // True while the app moves the viewport on the user's behalf, so a remote
  // focus or a resize re-centre is not recorded as a user action.
  const viewportProgrammaticRef = useRef(false);
  useSurfaceBridge({
    mode: "callgraph", nodes: graphNodes.map(node => ({ id: node.id, label: node.name })), post: postMessageFn,
    state: {
      expandedNodeIds: [], hiddenFilters: filtersFromKeys(hiddenFilters),
      filters: {
        nodeTypes: graphNodeTypes,
        folders: graphFolders,
        edgeTypes: ["outgoing", "incoming", "lateral", "inherits", "implements", "uses", "cycle"],
      },
      analysis: { nodes: graphNodes.length, edges: graphEdges.length, stale: isLoading },
    },
    apply: action => {
      if (action.action === "set_filter") {
        if (!isKnownFilter(action.filterType, action.value, graphNodeTypes, graphFolders)) return "filter-not-found";
        handleFilterToggle(action.filterType, action.value, action.visible);
        return undefined;
      }
      if (action.action !== "select" && action.action !== "focus") return "unsupported-view-action";
      const cy = cyRef.current;
      if (!cy || cy.getElementById(action.nodeId).empty()) return "node-not-found";
      selectNode(cy, action.nodeId);
      setSelectedNodeId(action.nodeId); setSelectedEdgeId(undefined);
      reportSelection(action.nodeId, false);
      if (action.action === "focus") {
        const node = cy.getElementById(action.nodeId);
        viewportProgrammaticRef.current = true;
        try {
          cy.fit(node, 60);
          const zoom = focusZoomFor(cy.zoom());
          if (zoom !== cy.zoom()) {
            cy.zoom(zoom);
            cy.center(node);
          }
        } finally {
          viewportProgrammaticRef.current = false;
        }
      }
      return undefined;
    },
  });
  const positionsRef = useRef<Map<string, Point>>(new Map());
  const viewportRef = useRef<{ zoom: number; pan: Point } | null>(null);
  const lastRootRef = useRef<string | null>(null);
  const nodesRef = useRef<SerializedCallNode[]>([]);
  nodesRef.current = graphNodes;

  // Layout reporting: debounce drags/zooms into one state-file write.
  const layoutReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressLayoutReportRef = useRef(false);

  /** Tell the extension what is selected so agents see the same view. */
  const reportSelection = useCallback((nodeId: string | undefined, userInitiated: boolean): void => {
    const node = nodeId ? nodesRef.current.find((candidate) => candidate.id === nodeId) : undefined;
    const command: CallGraphSelectionChangedCommand = {
      command: "callGraphSelectionChanged",
      nodeId,
      path: node?.path,
      name: node?.name,
      startLine: node?.startLine,
      userInitiated,
    };
    try {
      postMessageRef.current(command);
    } catch {
      // postMessage not available outside webview (e.g., unit tests)
    }
  }, []);

  // Keep latest onReady in a ref to avoid stale closure in the effect
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Track the pending layout setTimeout so it can be cancelled when a new
  // showCallGraph arrives before the previous one has run layout.run().
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track the post-layout resize timer so teardown can cancel it.
  const postLayoutResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Safety timeout ref: clears isLoading if layoutstop never fires (e.g. on
  // certain Cytoscape edge cases or rapid component teardown).
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // Initialize / destroy Cytoscape instance
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: buildCallGraphStylesheet(detectIsDarkTheme()),
      layout: { name: "preset" },
      wheelSensitivity: 0.3,
      minZoom: 0.05,
      maxZoom: 5,
    });

    cyRef.current = cy;

    // T036: ensure nodes are always draggable (compound graphs can unset this)
    cy.autoungrabify(false);
    cy.autounselectify(false);

    // A click selects and opens the detail panel. Code navigation and
    // re-centring are explicit actions (double-click and the panel buttons),
    // so dragging a symbol never moves the editor (DESIGN 3.2).
    let grabStart: { id: string; x: number; y: number } | null = null;
    cy.on("grab", "node", (event) => {
      const node = event.target as cytoscape.NodeSingular;
      grabStart = { id: node.id(), x: node.position().x, y: node.position().y };
    });

    const draggedSinceGrab = (node: cytoscape.NodeSingular): boolean => {
      const start = grabStart;
      grabStart = null;
      if (!start || start.id !== node.id()) return false;
      const now = node.position();
      return Math.abs(now.x - start.x) > 1 || Math.abs(now.y - start.y) > 1;
    };

    cy.on("tap", "node[type != 'compound']", (event) => {
      const node = event.target as cytoscape.NodeSingular;
      if (draggedSinceGrab(node)) return;
      const nodeId = node.id();
      selectNode(cy, nodeId);
      setSelectedNodeId(nodeId);
      setSelectedEdgeId(undefined);
      reportSelection(nodeId, true);
    });

    cy.on("dbltap", "node[type != 'compound']", (event) => {
      const node = event.target as cytoscape.NodeSingular;
      const open: CallGraphOpenFileCommand = {
        command: "callGraphOpenFile",
        uri: node.data("path") as string,
        line: node.data("startLine") as number,
        character: node.data("startCol") as number,
      };
      try {
        postMessageRef.current(open);
      } catch {
        // postMessage not available outside webview (e.g., unit tests)
      }
    });

    cy.on("tap", "edge", (event) => {
      const edge = event.target as cytoscape.EdgeSingular;
      selectEdge(cy, edge.id());
      setSelectedEdgeId(edge.id());
      setSelectedNodeId(undefined);
      reportSelection(undefined, true);
    });

    cy.on("dbltap", "edge", (event) => {
      const edge = event.target as cytoscape.EdgeSingular;
      const open: CallGraphOpenFileCommand = {
        command: "callGraphOpenFile",
        uri: edge.source().data("path") as string,
        line: edge.data("sourceLine") as number,
        character: 0,
      };
      try {
        postMessageRef.current(open);
      } catch {
        // postMessage not available outside webview (e.g., unit tests)
      }
    });

    cy.on("tap", (event) => {
      if (event.target !== cy) return; // nodes and edges have their own handlers
      clearSelection(cy);
      setSelectedNodeId(undefined);
      setSelectedEdgeId(undefined);
      reportSelection(undefined, true);
    });

    // File-compound click → open file (no graph recenter)
    cy.on("tap", "node[compoundLevel = 'file']", (event) => {
      const node = event.target as cytoscape.NodeSingular;
      const filePath = node.id();
      try {
        postMessageRef.current({ command: "callGraphOpenFile", uri: filePath, line: 0, character: 0 });
      } catch {
        // postMessage not available outside webview (e.g., unit tests)
      }
    });

    // Persist the user's node placement and viewport (DESIGN 3.2, 5.2).
    const stopViewportReporting = registerViewportReporting(cy, {
      onChange: scheduleLayoutReport,
      isProgrammatic: () => viewportProgrammaticRef.current,
      onInteraction: (active) => {
        try {
          postMessageRef.current({ command: "callGraphUserInteraction", active });
        } catch {
          // postMessage not available outside webview (e.g., unit tests)
        }
      },
    });

    // Auto-resize when the webview panel is resized. Opening the detail panel
    // narrows the canvas; re-fitting there would shrink the whole graph on the
    // first click, so keep the zoom and only re-centre the same content.
    // Debounced at 120 ms so we don't thrash during a live drag-resize.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = (): void => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const current = cyRef.current;
        resizeTimer = null;
        if (!current) return;

        const zoom = current.zoom();
        const pan = current.pan();
        const hadSize = current.width() > 0 && current.height() > 0;
        // The model point at the centre of the old viewport.
        const centre = hadSize
          ? {
              x: (current.width() / 2 - pan.x) / zoom,
              y: (current.height() / 2 - pan.y) / zoom,
            }
          : null;

        current.resize();

        if (centre && current.width() > 0 && current.height() > 0) {
          // Keep the same content centred: the app moved the viewport, not the user.
          viewportProgrammaticRef.current = true;
          try {
            current.pan({
              x: current.width() / 2 - centre.x * zoom,
              y: current.height() / 2 - centre.y * zoom,
            });
          } finally {
            viewportProgrammaticRef.current = false;
          }
        }
        triggerCanvasRepaint(current);
      }, 120);
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(handleResize);

    if (resizeObserver && containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    // Fallback for environments where ResizeObserver is unavailable
    window.addEventListener("resize", handleResize);

    // Theme change detection — VS Code mutates body.className when the user
    // switches color themes.  Re-apply the Cytoscape stylesheet so text/edge
    // colors adapt to the new theme without a full reload.
    let lastIsDark = detectIsDarkTheme();
    const themeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            const nowDark = detectIsDarkTheme();
            if (nowDark !== lastIsDark) {
              lastIsDark = nowDark;
              if (cyRef.current) {
                cyRef.current
                  .style()
                  .fromJson(buildCallGraphStylesheet(nowDark))
                  .update();
                triggerCanvasRepaint(cyRef.current);
              }
            }
          });
    themeObserver?.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      stopViewportReporting();
      if (layoutTimerRef.current !== null) {
        clearTimeout(layoutTimerRef.current);
        layoutTimerRef.current = null;
      }
      if (postLayoutResizeTimerRef.current !== null) {
        clearTimeout(postLayoutResizeTimerRef.current);
        postLayoutResizeTimerRef.current = null;
      }
      if (safetyTimerRef.current !== null) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
      if (layoutReportTimerRef.current !== null) {
        clearTimeout(layoutReportTimerRef.current);
        layoutReportTimerRef.current = null;
      }
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      window.removeEventListener("resize", handleResize);
      cy.destroy();
      cyRef.current = null;
    };
    // Intentionally empty deps — run once on mount/unmount
  }, []);

  // ---------------------------------------------------------------------------
  // Listen for messages from the extension
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function handleMessage(event: MessageEvent<CallGraphExtensionMessage>): void {
      // VS Code extension messages arrive from the webview's own vscode-webview://
      // origin. Reject messages from any other origin to satisfy the SonarQube
      // S2819 rule while remaining functional in the webview sandbox.
      if (event.origin && !event.origin.startsWith("vscode-webview://") && event.origin !== "null") {
        return;
      }
      const msg = event.data;
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;

      if (msg.type === "callGraphIndexing") {
        if (msg.status === "started" || msg.status === "progress") {
          setIsLoading(true);
          setIsEmpty(false);
          setLoadingMessage(msg.message ?? "Analyzing…");
        } else if (msg.status === "complete" || msg.status === "error") {
          setIsLoading(false);
          if (msg.status === "error") {
            setLoadingMessage(msg.message ?? "Error occurred");
          }
        }
        return;
      }

      if (msg.type === "showCallGraph") {
        handleShowCallGraph(msg);
        return;
      }

      if (msg.type === "callGraphSyncLayout") {
        const cy = cyRef.current;
        if (!cy || (msg.layout.rootSymbolId && msg.layout.rootSymbolId !== lastRootRef.current)) return;
        if (layoutReportTimerRef.current !== null) clearTimeout(layoutReportTimerRef.current);
        if (postLayoutResizeTimerRef.current !== null) clearTimeout(postLayoutResizeTimerRef.current);
        suppressLayoutReportRef.current = true;
        try {
          cy.batch(() => {
            // Only node placement is shared: each surface keeps its own zoom and pan
            // (its canvas can have another size), so a drag here never moves the other view.
            for (const [id, point] of Object.entries(msg.layout.positions)) cy.getElementById(id).position(point);
          });
          rememberLayout(cy);
        } finally { suppressLayoutReportRef.current = false; }
        return;
      }

      if (msg.type === "callGraphSelectNode") {
        const cy = cyRef.current;
        if (!cy) return;
        if (!msg.nodeId) {
          clearSelection(cy); setSelectedNodeId(undefined); setSelectedEdgeId(undefined); reportSelection(undefined, false); return;
        }
        const node = cy.getElementById(msg.nodeId);
        if (node.empty() || !node.isNode()) return;
        selectNode(cy, msg.nodeId);
        setSelectedNodeId(msg.nodeId);
        setSelectedEdgeId(undefined);
        reportSelection(msg.nodeId, false);
        return;
      }

      if (msg.type === "callGraphSetFilter") {
        if (!msg.requestId) {
          // Replayed/mirrored state: apply as-is, the extension already owns it.
          applyRemoteFilter(msg.filterType, msg.value, msg.visible);
          return;
        }
        const reason = isKnownFilter(msg.filterType, msg.value, graphNodeTypesRef.current, graphFoldersRef.current)
          ? undefined
          : "filter-not-found";
        if (!reason) applyRemoteFilter(msg.filterType, msg.value, msg.visible);
        postMessageRef.current({
          command: "callGraphFilterApplied",
          requestId: msg.requestId,
          ...(reason ? { reason } : {}),
        });
        return;
      }

      if (msg.type === "callGraphSetDepth") {
        setCurrentDepth(msg.depth);
      }
    }

    window.addEventListener("message", handleMessage);

    // Signal to the extension that the message listener is now active.
    // The extension may have already posted showCallGraph data before this listener
    // was registered (race on first open). Sending callGraphMounted lets the extension
    // replay any buffered pendingGraph data so nothing is lost.
    const mountedCmd: CallGraphMountedCommand = { command: "callGraphMounted" };
    try {
      postMessageRef.current(mountedCmd);
    } catch {
      // postMessage not available outside webview (e.g., unit tests)
    }

    return () => window.removeEventListener("message", handleMessage);
  }, []);

  /** A render moves the viewport on the app's behalf: that is not a user interaction and must not supersede agent commands. */
  function moveViewportProgrammatically(move: () => void): void {
    viewportProgrammaticRef.current = true;
    try {
      move();
    } finally {
      viewportProgrammaticRef.current = false;
    }
  }

  /** Remember where the user left every node and the current viewport. */
  function rememberLayout(cy: cytoscape.Core): void {
    cy.nodes().forEach((node) => {
      const position = { x: node.position().x, y: node.position().y };
      positionsRef.current.set(node.id(), position);
      const path = node.data("path");
      const name = node.data("name");
      if (typeof path === "string" && typeof name === "string") {
        positionsRef.current.set(aliasKey(path, name), position);
      }
    });
    viewportRef.current = { zoom: cy.zoom(), pan: { ...cy.pan() } };
  }

  function reportRendered(cy: cytoscape.Core): void {
    const nodeCount = cy.nodes().not("[type='compound']").length;
    const edgeCount = cy.edges().length;
    onReadyRef.current?.(nodeCount, edgeCount);
    const readyCmd: CallGraphReadyCommand = { command: "callGraphReady", nodeCount, edgeCount };
    try {
      postMessageFn(readyCmd);
    } catch {
      // postMessage not available outside webview (e.g., unit tests)
    }
  }

  function scheduleLayoutReport(userInitiated: boolean): void {
    if (suppressLayoutReportRef.current) return;
    if (layoutReportTimerRef.current !== null) clearTimeout(layoutReportTimerRef.current);
    layoutReportTimerRef.current = setTimeout(() => {
      layoutReportTimerRef.current = null;
      const cy = cyRef.current;
      if (!cy || suppressLayoutReportRef.current) return;
      rememberLayout(cy);
      const positions: Record<string, Point> = {};
      for (const [nodeId, point] of positionsRef.current) positions[nodeId] = point;
      if (Object.keys(positions).length === 0) return;
      const command: CallGraphLayoutChangedCommand = {
        command: "callGraphLayoutChanged",
        layout: {
          positions,
          zoom: cy.zoom(),
          pan: { ...cy.pan() },
          ...(lastRootRef.current ? { rootSymbolId: lastRootRef.current } : {}),
        },
        userInitiated,
      };
      try {
        postMessageRef.current(command);
      } catch {
        // postMessage not available outside webview (e.g., unit tests)
      }
    }, 400);
  }

  /** fcose rebuild: a new root, an explicit re-layout or the first render. */
  function runFullLayout(cy: cytoscape.Core, userInitiated = false): void {
    if (layoutTimerRef.current !== null) {
      clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = null;
    }
    if (safetyTimerRef.current !== null) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }

    // fcose is synchronous and blocks the whole thread on large graphs, so the
    // overlay is painted first and layout.run() is deferred one frame.
    suppressLayoutReportRef.current = true;
    setIsLoading(true);
    setLoadingMessage("Calculating layout…");

    const layout = cy.layout({
      name: "fcose",
      animate: false,
      randomize: true,
      quality: "default",
      nodeSeparation: 220,
      idealEdgeLength: 220,
      edgeElasticity: () => 0.45,
      gravity: 0.15,
      gravityCompound: 1.5,
      gravityRange: 3.8,
      numIter: 2500,
      packComponents: true,
      tilingPaddingVertical: 60,
      tilingPaddingHorizontal: 60,
    } as cytoscape.LayoutOptions);

    safetyTimerRef.current = setTimeout(() => {
      safetyTimerRef.current = null;
      setIsLoading(false);
    }, 15000);

    layout.on("layoutstop", () => {
      if (safetyTimerRef.current !== null) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }

      moveViewportProgrammatically(() => cy.fit(undefined, 60));
      cy.style().update();
      triggerCanvasRepaint(cy);
      setIsLoading(false);
      rememberLayout(cy);
      suppressLayoutReportRef.current = false;
      scheduleLayoutReport(userInitiated);

      // Safety retry: the container may still have been sizing during the run.
      if (postLayoutResizeTimerRef.current !== null) {
        clearTimeout(postLayoutResizeTimerRef.current);
      }
      postLayoutResizeTimerRef.current = setTimeout(() => {
        postLayoutResizeTimerRef.current = null;
        if (!cyRef.current) return;
        suppressLayoutReportRef.current = true;
        cyRef.current.resize();
        const retryCy = cyRef.current;
        moveViewportProgrammatically(() => retryCy.fit(undefined, 60));
        triggerCanvasRepaint(cyRef.current);
        suppressLayoutReportRef.current = false;
      }, 500);

      reportRendered(cy);
    });

    layoutTimerRef.current = setTimeout(() => {
      layoutTimerRef.current = null;
      layout.run();
    }, 20);
  }

  function handleShowCallGraph(msg: ShowCallGraphMessage): void {
    const cy = cyRef.current;
    if (!cy) return;

    setHiddenNodeCount(msg.hiddenNodeCount ?? 0);

    if (msg.nodes.length === 0) {
      setIsLoading(false);
      setIsEmpty(true);
      cy.elements().remove();
      setGraphNodeTypes([]);
      setGraphFolders([]);
      setGraphNodes([]);
      setGraphEdges([]);
      setSelectedNodeId(undefined);
      setSelectedEdgeId(undefined);
      positionsRef.current.clear();
      lastRootRef.current = null;
      return;
    }

    setIsEmpty(false);

    // Sync depth from extension
    if (msg.depth !== undefined) {
      setCurrentDepth(msg.depth);
    }

    // A new root is a new graph: rebuild the layout. Anything else (save,
    // depth slider, filter) keeps the user's positions (DESIGN 3.2).
    // A saved layout from `.skein/state.json` replaces the fcose run so the
    // restart restores the screen the user left.
    const savedLayout = msg.layout;
    const savedLayoutMatches =
      savedLayout !== undefined &&
      Object.keys(savedLayout.positions).length > 0 &&
      (savedLayout.rootSymbolId === undefined || savedLayout.rootSymbolId === msg.rootSymbolId);
    if (savedLayoutMatches) {
      positionsRef.current = new Map(Object.entries(savedLayout.positions));
      viewportRef.current =
        savedLayout.zoom !== undefined && savedLayout.pan
          ? { zoom: savedLayout.zoom, pan: { ...savedLayout.pan } }
          : null;
    }

    const previousRoot = lastRootRef.current;
    const rootChanged = previousRoot !== msg.rootSymbolId;
    if (!rootChanged) {
      rememberLayout(cy);
    } else if (!savedLayoutMatches) {
      positionsRef.current.clear();
      viewportRef.current = null;
    }

    // A pending layout from the previous message must not run on this data.
    if (layoutTimerRef.current !== null) {
      clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = null;
    }
    if (safetyTimerRef.current !== null) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
    if (postLayoutResizeTimerRef.current !== null) {
      clearTimeout(postLayoutResizeTimerRef.current);
      postLayoutResizeTimerRef.current = null;
    }

    setGraphNodes(msg.nodes);
    setGraphEdges(msg.edges);
    setRootSymbolId(msg.rootSymbolId);
    setProjectName(msg.projectName);
    setGeneratedAt(msg.timestamp);
    setSelectedNodeId(undefined);
    setSelectedEdgeId(undefined);

    // Add nodes/compounds first (batch), then edges outside the batch so they
    // render on top of compound backgrounds (fixes invisible-edges-on-first-open).
    const { nodeElements, edgeElements } = buildElements(msg.nodes, msg.edges, msg.compounds);
    cy.batch(() => {
      cy.elements().remove();
      cy.add(nodeElements);
    });
    cy.add(edgeElements);

    // Do NOT call ungrabify() on compound nodes — cy.autoungrabify(false) (set
    // at init) ensures all nodes including compounds are grabifiable so users
    // can freely move both individual symbols and entire file/folder groups.
    cy.resize();

    // Extract unique nodeTypes and folders for legend (T027)
    const types = [...new Set(msg.nodes.map((n) => n.type))];
    const folders = msg.compounds
      .filter((c) => c.compoundLevel === "folder")
      .map((c) => c.id);
    setGraphNodeTypes(types);
    setGraphFolders(folders);
    // Filters belong to the view, not to one graph payload. Keep them across
    // refreshes and apply them to the newly added elements.
    applyFilterSet(new Set(hiddenFiltersRef.current));

    lastRootRef.current = msg.rootSymbolId;

    if (rootChanged && !savedLayoutMatches) {
      runFullLayout(cy);
      return;
    }

    // Same root, or a saved layout: keep every known position, place newly
    // reachable symbols beside their neighbours, and restore the viewport
    // instead of re-fitting.
    const planned = planPositions(
      positionsRef.current,
      msg.nodes,
      msg.edges.map((edge) => ({ sourceId: edge.sourceId, targetId: edge.targetId })),
    );
    suppressLayoutReportRef.current = true;
    cy.batch(() => {
      for (const [id, position] of positionsRef.current) {
        const element = cy.getElementById(id);
        if (element.nonempty()) element.position(position);
      }
      for (const [id, position] of planned) {
        const element = cy.getElementById(id);
        if (element.nonempty()) element.position(position);
      }
    });
    cy.layout({ name: "preset", fit: false } as cytoscape.LayoutOptions).run();
    moveViewportProgrammatically(() => {
      if (viewportRef.current) cy.viewport(viewportRef.current);
      else cy.fit(undefined, 60);
    });
    setIsLoading(false);
    cy.style().update();
    triggerCanvasRepaint(cy);
    rememberLayout(cy);
    suppressLayoutReportRef.current = false;
    scheduleLayoutReport(false);
    reportRendered(cy);
  }

  /** Explicit "Re-layout": the only action that discards the saved positions. */
  function handleRelayout(): void {
    const cy = cyRef.current;
    if (!cy) return;
    positionsRef.current.clear();
    setSelectedNodeId(undefined);
    setSelectedEdgeId(undefined);
    clearSelection(cy);
    runFullLayout(cy, true);
  }

  function handleSelectEdge(edgeId: string): void {
    const cy = cyRef.current;
    if (!cy) return;
    selectEdge(cy, edgeId);
    setSelectedEdgeId(edgeId);
    setSelectedNodeId(undefined);
  }

  function handleCloseDetail(): void {
    const cy = cyRef.current;
    if (cy) clearSelection(cy);
    setSelectedNodeId(undefined);
    setSelectedEdgeId(undefined);
  }

  // ---------------------------------------------------------------------------
  // T027 — filter toggle handler (local legend + remote MCP commands)
  // ---------------------------------------------------------------------------

  const applyFilterSet = useCallback((next: Set<string>): void => {
    hiddenFiltersRef.current = next;
    setHiddenFilters(new Set(next)); // trigger re-render

    // Apply visibility to Cytoscape elements (no layout recalculation — FR-014)
    const cy = cyRef.current;
    if (!cy) return;

    // Restore all elements first, then re-hide filtered ones
    cy.elements().removeStyle("display");
    for (const filterKey of next) {
      const colonIdx = filterKey.indexOf(":");
      const filterType = filterKey.slice(0, colonIdx);
      const filterValue = filterKey.slice(colonIdx + 1);
      if (filterType === "nodeType") {
        cy.nodes(`[type="${filterValue}"]`).style("display", "none");
      } else if (filterType === "folder") {
        const folderNode = cy.getElementById(filterValue);
        // Hide the folder compound and ALL nested elements (file compounds + symbol nodes)
        folderNode.style("display", "none");
        folderNode.descendants().style("display", "none");
      } else if (filterType === "edgeType") {
        // Map edge filter keys to Cytoscape selectors
        const edgeSelectors: Record<string, string> = {
          outgoing: 'edge[typeRelation="CALLS"][direction="outgoing"]',
          incoming: 'edge[typeRelation="CALLS"][direction="incoming"]',
          lateral: 'edge[direction="lateral"]',
          inherits: 'edge[typeRelation="INHERITS"]',
          implements: 'edge[typeRelation="IMPLEMENTS"]',
          uses: 'edge[typeRelation="USES"]',
          cycle: "edge[isCyclic=1]",
        };
        const selector = edgeSelectors[filterValue];
        if (selector) {
          cy.elements(selector).style("display", "none");
        }
      }
    }
  }, []);

  const handleFilterToggle = useCallback(
    (filterType: "nodeType" | "folder" | "edgeType", value: string, visible: boolean): void => {
      const key = `${filterType}:${value}`;
      const next = new Set(hiddenFiltersRef.current);
      if (visible) {
        next.delete(key);
      } else {
        next.add(key);
      }
      applyFilterSet(next);
    },
    [applyFilterSet],
  );

  /** Applies a filter sent by the extension for an MCP command (no echo back). */
  const applyRemoteFilter = useCallback(
    (filterType: "nodeType" | "folder" | "edgeType", value: string, visible: boolean): void => {
      const key = `${filterType}:${value}`;
      const next = new Set(hiddenFiltersRef.current);
      if (visible) {
        next.delete(key);
      } else {
        next.add(key);
      }
      applyFilterSet(next);
    },
    [applyFilterSet],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const hasGraph = !isLoading && !isEmpty && graphNodes.length > 0;

  return (
    <div style={{ display: "flex", width: "100%", height: "100%" }}>
      <div style={{ position: "relative", flex: "1 1 auto", minWidth: 0, height: "100%" }}>
      {/* Cytoscape container */}
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%" }}
        data-testid="cytoscape-container"
      />

      {/* Explicit re-layout: the only control that discards saved positions */}
      {hasGraph && (
        <button
          type="button"
          onClick={handleRelayout}
          title="Re-run the layout from scratch"
          style={{
            position: "absolute",
            top: "12px",
            right: "12px",
            zIndex: 20,
            background: "var(--vscode-button-secondaryBackground, rgba(60,60,60,0.85))",
            color: "var(--vscode-button-secondaryForeground, #fff)",
            border: "none",
            borderRadius: 6,
            padding: "5px 10px",
            fontSize: 11,
            cursor: "pointer",
          }}
          data-testid="call-graph-relayout"
        >
          Re-layout
        </button>
      )}

      {/* Depth slider */}
      {!isLoading && !isEmpty && (
        <div
          style={{
            position: "absolute",
            top: "12px",
            left: "12px",
            background: "var(--vscode-sideBar-background, rgba(30,30,30,0.85))",
            border: "1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))",
            borderRadius: "6px",
            padding: "6px 10px",
            fontSize: "11px",
            color: "var(--vscode-foreground, #ccc)",
            zIndex: 20,
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            userSelect: "none" as const,
          }}
          data-testid="depth-slider"
        >
          <label
            htmlFor="depth-range"
            style={{
              fontWeight: 600,
              fontSize: "10px",
              textTransform: "uppercase" as const,
              letterSpacing: "0.06em",
              color: "var(--vscode-descriptionForeground, #888)",
              whiteSpace: "nowrap" as const,
            }}
          >
            Depth
          </label>
          <input
            id="depth-range"
            type="range"
            min={1}
            max={5}
            value={currentDepth}
            onChange={(e) => {
              const d = Number(e.target.value);
              setCurrentDepth(d);
              const cmd: CallGraphDepthChangedCommand = { command: "callGraphDepthChanged", depth: d };
              try { postMessageRef.current(cmd); } catch { /* no-op */ }
            }}
            style={{ width: "80px", cursor: "pointer" }}
            aria-label="Traversal depth"
          />
          <span style={{ minWidth: "12px", textAlign: "center" }}>{currentDepth}</span>
        </div>
      )}

      {/* T027: Filter legend */}
      {!isLoading && !isEmpty && (
        <GraphLegend
          nodeTypes={graphNodeTypes}
          folders={graphFolders}
          hiddenFilters={hiddenFilters}
          onToggle={handleFilterToggle}
          postMessage={postMessageFn}
        />
      )}

      {/* Truncation notice — the extension caps large neighbourhoods (#326) */}
      {!isLoading && !isEmpty && hiddenNodeCount > 0 && (
        <output
          style={{
            position: "absolute",
            bottom: "12px",
            left: "12px",
            background: "var(--vscode-sideBar-background, rgba(30,30,30,0.85))",
            border: "1px solid var(--vscode-panel-border, rgba(128,128,128,0.3))",
            borderRadius: "6px",
            padding: "4px 8px",
            fontSize: "11px",
            color: "var(--vscode-descriptionForeground, #888)",
            zIndex: 20,
          }}
          data-testid="truncation-notice"
        >
          {hiddenNodeCount.toLocaleString()} more symbols not shown — open a narrower symbol to explore them
        </output>
      )}

      {/* Loading overlay */}
      {isLoading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.45)",
            color: "var(--vscode-foreground, #ccc)",
            fontSize: "14px",
            zIndex: 10,
          }}
          data-testid="loading-overlay"
        >
          <style>{"@keyframes skein-spin{to{transform:rotate(360deg)}}"}</style>
          <span
            aria-hidden="true"
            style={{
              width: 16,
              height: 16,
              marginRight: 10,
              border: "2px solid currentColor",
              borderTopColor: "transparent",
              borderRadius: "50%",
              animation: "skein-spin 0.8s linear infinite",
            }}
          />
          <span>{loadingMessage}</span>
        </div>
      )}

      {/* Empty state */}
      {isEmpty && !isLoading && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--vscode-descriptionForeground, #888)",
            fontSize: "13px",
          }}
          data-testid="empty-state"
        >
          <span>No relationships found for this symbol.</span>
        </div>
      )}
      </div>

      <CallGraphDetail
        nodes={graphNodes}
        edges={graphEdges}
        selectedNodeId={selectedNodeId}
        selectedEdgeId={selectedEdgeId}
        rootSymbolId={rootSymbolId}
        projectName={projectName}
        generatedAt={generatedAt}
        onOpenFile={(path, line, column) => {
          const open: CallGraphOpenFileCommand = {
            command: "callGraphOpenFile",
            uri: path,
            line,
            character: column,
          };
          try {
            postMessageRef.current(open);
          } catch {
            // postMessage not available outside webview (e.g., unit tests)
          }
        }}
        onFocusNode={(nodeId) => {
          const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
          if (!node) return;
          const focus: CallGraphSymbolFocusCommand = {
            command: "callGraphSymbolFocus",
            nodeId: node.id,
            path: node.path,
            startLine: node.startLine,
            startCol: node.startCol,
          };
          try {
            postMessageRef.current(focus);
          } catch {
            // postMessage not available outside webview (e.g., unit tests)
          }
        }}
        onSelectEdge={handleSelectEdge}
        onCopy={(text) => {
          const copy: CallGraphCopyReferenceCommand = { command: "callGraphCopyReference", text };
          try {
            postMessageRef.current(copy);
          } catch {
            // postMessage not available outside webview (e.g., unit tests)
          }
        }}
        onClose={handleCloseDetail}
      />
    </div>
  );
}
