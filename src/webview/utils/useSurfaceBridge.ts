import { useEffect, useRef, useState } from "react";
import type { SurfaceCommandMessage, SurfaceSyncMessage, WebviewToExtensionMessage } from "../../shared/messages";
import type { SkeinSelection, SkeinSurfaceState, SkeinViewAction, SkeinViewMode } from "../../shared/viewState";

/** Acknowledge commands from the mounted renderer, and publish bounded view state. */
export function useSurfaceBridge(options: {
  mode: SkeinViewMode;
  nodes: Array<{ id: string; label?: string }>;
  getNodes?: () => Array<{ id: string; label?: string }>;
  state: Omit<SkeinSurfaceState, "nodeIds">;
  post?: (message: WebviewToExtensionMessage) => void;
  clearSelection?: () => void;
  syncExpanded?: (nodeIds: string[]) => void;
  apply: (action: SkeinViewAction) => string | void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [commandVersion, setCommandVersion] = useState(0);
  const userPending = useRef(false);
  const lastLocalActionAt = useRef(0);
  const syncTarget = useRef<SurfaceSyncMessage | undefined>(undefined);
  const pending = useRef<Array<{ id: string; reason?: string }>>([]);
  const [selection, setSelection] = useState<SkeinSelection>();
  const [search, setSearch] = useState<SkeinSurfaceState["search"]>();
  const current = useRef({ selection, search });
  current.current = { selection, search };
  const report = (userInitiated = false) => {
    const o = latest.current;
    const nodeIds = (o.getNodes?.() ?? o.nodes).map(node => node.id);
    o.post?.({ command: "surfaceState", mode: o.mode, updatedAt: Date.now(),
      state: { ...o.state, nodeIds: nodeIds.slice(0, 10000), ...(nodeIds.length > 10000 ? { nodeIdsTruncated: true } : {}), search: current.current.search },
      selection: current.current.selection, userInitiated });
  };
  useEffect(() => {
    report(userPending.current);
    userPending.current = false;
    for (const result of pending.current.splice(0)) latest.current.post?.({ command: "surfaceResult", ...result });
  }, [options.mode, JSON.stringify(options.nodes), JSON.stringify(options.state), selection, search, commandVersion]);
  useEffect(() => {
    const target = syncTarget.current;
    if (!target) return;
    const o = latest.current;
    const remote = target.state.architecture;
    const local = o.state.architecture;
    if (remote && local) {
      const controls = { action: "set_architecture" as const, view: remote.view as "graph" | "matrix" | undefined, minImports: remote.minImports };
      if (remote.unit !== local.unit) { o.apply({ ...controls, unit: remote.unit ?? "" }); return; }
      if (remote.folder !== local.folder) { o.apply({ ...controls, folder: remote.folder ?? "" }); return; }
      if (remote.view !== local.view || remote.minImports !== local.minImports) { o.apply(controls); return; }
    }
    if (target.selection?.nodeId !== current.current.selection?.nodeId) {
      if (target.selection && o.apply({ action: "select", nodeId: target.selection.nodeId })) return;
      if (!target.selection) o.clearSelection?.();
      current.current.selection = target.selection;
      setSelection(target.selection);
    }
    if (JSON.stringify(target.state.search) !== JSON.stringify(current.current.search)) {
      current.current.search = target.state.search; setSearch(target.state.search);
    }
    const expanded = new Set(target.state.expandedNodeIds);
    if (expanded.size !== o.state.expandedNodeIds.length || o.state.expandedNodeIds.some(id => !expanded.has(id))) {
      if (o.syncExpanded) o.syncExpanded([...expanded]);
      else for (const nodeId of new Set([...o.state.expandedNodeIds, ...expanded])) {
        if (o.state.expandedNodeIds.includes(nodeId) !== expanded.has(nodeId)) o.apply({ action: "set_expanded", nodeId, expanded: expanded.has(nodeId) });
      }
    }
    syncTarget.current = undefined;
  }, [options.mode, JSON.stringify(options.nodes), JSON.stringify(options.state), commandVersion]);
  useEffect(() => {
    const receive = (event: MessageEvent<SurfaceCommandMessage | SurfaceSyncMessage>) => {
      const message = event.data;
      if (!message || message.mode !== latest.current.mode) return;
      if (message.command === "surfaceSync") {
        if (lastLocalActionAt.current > 0 && (message.updatedAt ?? 0) <= lastLocalActionAt.current) return;
        syncTarget.current = message;
        setCommandVersion(version => version + 1);
        return;
      }
      if (message.command !== "surfaceCommand") return;
      syncTarget.current = undefined;
      lastLocalActionAt.current = Date.now();
      const o = latest.current;
      const action = message.action;
      const nodes = o.getNodes?.() ?? o.nodes;
      let reason: string | undefined;
      if (action.action === "search") {
        const query = action.query.toLocaleLowerCase();
        const matches = query ? nodes.filter(node => `${node.id} ${node.label ?? ""}`.toLocaleLowerCase().includes(query)).map(node => node.id) : [];
        current.current.search = { query: action.query, matches: matches.slice(0, 100), total: matches.length };
        setSearch(current.current.search);
        if (matches[0]) {
          reason = o.apply({ action: "focus", nodeId: matches[0] }) || undefined;
          if (!reason) { current.current.selection = { nodeId: matches[0] }; setSelection(current.current.selection); }
        }
      } else {
        const id = "nodeId" in action ? action.nodeId : undefined;
        if (id && !nodes.some(node => node.id === id)) reason = "node-not-found";
        else reason = o.apply(action) || undefined;
        if (!reason && (action.action === "select" || action.action === "focus")) {
          current.current.selection = { nodeId: action.nodeId }; setSelection(current.current.selection);
        }
      }
      pending.current.push({ id: message.id, reason });
      setCommandVersion(version => version + 1);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return { markUserAction: () => { lastLocalActionAt.current = Date.now(); syncTarget.current = undefined; userPending.current = true; }, selectedId: selection?.nodeId, select: (nodeId?: string, path?: string) => {
    lastLocalActionAt.current = Date.now();
    syncTarget.current = undefined;
    current.current.selection = nodeId ? { nodeId, path } : undefined;
    setSelection(current.current.selection); report(true);
  } };
}
