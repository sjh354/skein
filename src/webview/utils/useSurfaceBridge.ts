import { useEffect, useRef, useState } from "react";
import type { SurfaceCommandMessage, WebviewToExtensionMessage } from "../../shared/messages";
import type { SkeinSelection, SkeinSurfaceState, SkeinViewAction, SkeinViewMode } from "../../shared/viewState";

/** Acknowledge commands from the mounted renderer, and publish bounded view state. */
export function useSurfaceBridge(options: {
  mode: SkeinViewMode;
  nodes: Array<{ id: string; label?: string }>;
  getNodes?: () => Array<{ id: string; label?: string }>;
  state: Omit<SkeinSurfaceState, "nodeIds">;
  post?: (message: WebviewToExtensionMessage) => void;
  apply: (action: SkeinViewAction) => string | void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [commandVersion, setCommandVersion] = useState(0);
  const pending = useRef<Array<{ id: string; reason?: string }>>([]);
  const [selection, setSelection] = useState<SkeinSelection>();
  const [search, setSearch] = useState<SkeinSurfaceState["search"]>();
  const current = useRef({ selection, search });
  current.current = { selection, search };
  const report = (userInitiated = false) => {
    const o = latest.current;
    const nodeIds = (o.getNodes?.() ?? o.nodes).map(node => node.id);
    o.post?.({ command: "surfaceState", mode: o.mode,
      state: { ...o.state, nodeIds: nodeIds.slice(0, 10000), ...(nodeIds.length > 10000 ? { nodeIdsTruncated: true } : {}), search: current.current.search },
      selection: current.current.selection, userInitiated });
  };
  useEffect(() => {
    report();
    for (const result of pending.current.splice(0)) latest.current.post?.({ command: "surfaceResult", ...result });
  }, [options.mode, JSON.stringify(options.nodes), JSON.stringify(options.state), selection, search, commandVersion]);
  useEffect(() => {
    const receive = (event: MessageEvent<SurfaceCommandMessage>) => {
      const message = event.data;
      if (message?.command !== "surfaceCommand" || message.mode !== latest.current.mode) return;
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
  return { selectedId: selection?.nodeId, select: (nodeId?: string, path?: string) => {
    current.current.selection = nodeId ? { nodeId, path } : undefined;
    setSelection(current.current.selection); report(true);
  } };
}
