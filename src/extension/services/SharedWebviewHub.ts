/** One analysis session, rendered in the panel and editor without a second analyzer. */
export class SharedWebviewHub {
  private readonly peers = new Set<{ postMessage(message: unknown): Thenable<boolean> }>();
  private readonly replay = new Map<string, unknown>();

  add(peer: { postMessage(message: unknown): Thenable<boolean> }): () => void {
    this.peers.add(peer);
    return () => { this.peers.delete(peer); };
  }

  async post(message: unknown): Promise<boolean> {
    if (typeof message === "object" && message !== null) {
      const m = message as { command?: string; type?: string };
      const key = m.type ?? m.command;
      if (key && ["updateGraph", "symbolGraph", "showCallGraph", "architectureSummary", "switchViewMode", "callGraphSelectNode", "callGraphSetFilter"].includes(key)) {
        this.replay.delete(key);
        this.replay.set(key, message);
      }
    }
    const results = await Promise.allSettled([...this.peers].map(peer => peer.postMessage(message)));
    return results.some(result => result.status === "fulfilled" && result.value);
  }

  async restore(peer: { postMessage(message: unknown): Thenable<boolean> }): Promise<void> {
    for (const message of this.replay.values()) {
      // eslint-disable-next-line no-await-in-loop -- retain analysis/mode message order
      await peer.postMessage(message);
    }
  }

  /** The call graph renders only once it mounts, so a surface that just mounted gets its messages again. */
  async restoreCallGraph(peer: { postMessage(message: unknown): Thenable<boolean> }): Promise<void> {
    for (const key of ["showCallGraph", "callGraphSelectNode", "callGraphSetFilter"]) {
      const message = this.replay.get(key);
      // eslint-disable-next-line no-await-in-loop -- the graph must arrive before its selection and filters
      if (message !== undefined) await peer.postMessage(message);
    }
  }

  async mirror(source: { postMessage(message: unknown): Thenable<boolean> }, message: unknown): Promise<void> {
    if (typeof message === "object" && message !== null) {
      const m = message as { command?: string; type?: string; mode?: string; layout?: { rootSymbolId?: string } };
      if (m.command === "surfaceSync") this.replay.set(`surface:${m.mode}`, message);
      if (m.type === "callGraphSelectNode") this.replay.set(m.type, message);
      if (m.type === "callGraphSyncLayout") {
        const graph = this.replay.get("showCallGraph") as { rootSymbolId?: string } | undefined;
        if (graph && (!m.layout?.rootSymbolId || graph.rootSymbolId === m.layout.rootSymbolId)) this.replay.set("showCallGraph", { ...graph, layout: m.layout });
      }
    }
    await Promise.allSettled([...this.peers].filter(peer => peer !== source).map(peer => peer.postMessage(message)));
  }
}
