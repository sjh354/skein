import { describe, expect, it, vi } from "vitest";
import { SharedWebviewHub } from "../../src/extension/services/SharedWebviewHub";
const peer = () => ({ postMessage: vi.fn(async (_message: unknown) => true) });
describe("shared panel/editor session", () => {
  it("broadcasts one analysis result to both surfaces and removes disposed peers", async () => {
    const hub = new SharedWebviewHub(); const panel = peer(); const editor = peer();
    hub.add(panel); const remove = hub.add(editor);
    const result = { command: "updateGraph", data: { nodes: ["a"] } };
    expect(await hub.post(result)).toBe(true);
    expect(panel.postMessage).toHaveBeenCalledWith(result); expect(editor.postMessage).toHaveBeenCalledWith(result);
    remove(); editor.postMessage.mockClear(); await hub.post(result);
    expect(editor.postMessage).not.toHaveBeenCalled();
  });
  it("mirrors human state without echoing to its sender and restores it to new surfaces", async () => {
    const hub = new SharedWebviewHub(); const panel = peer(); const editor = peer();
    hub.add(panel); hub.add(editor);
    const state = { command: "surfaceSync", mode: "file", selection: { nodeId: "a" } };
    await hub.mirror(panel, state);
    expect(panel.postMessage).not.toHaveBeenCalled(); expect(editor.postMessage).toHaveBeenCalledWith(state);
    const reopened = peer(); await hub.restore(reopened);
    expect(reopened.postMessage).toHaveBeenCalledWith(state);
  });
  it("restores the latest layout for the same callgraph root, and the latest mode last", async () => {
    const hub = new SharedWebviewHub(); const panel = peer(); hub.add(panel);
    await hub.post({ command: "switchViewMode", mode: "file" });
    await hub.post({ type: "showCallGraph", rootSymbolId: "r", nodes: [] });
    await hub.post({ command: "switchViewMode", mode: "callgraph" });
    const layout = { rootSymbolId: "r", positions: { a: { x: 20, y: 30 } }, zoom: 2 };
    await hub.mirror(panel, { type: "callGraphSyncLayout", layout });
    const reopened = peer(); await hub.restore(reopened);
    expect(reopened.postMessage).toHaveBeenCalledWith({ type: "showCallGraph", rootSymbolId: "r", nodes: [], layout });
    expect(reopened.postMessage.mock.calls.at(-1)?.[0]).toEqual({ command: "switchViewMode", mode: "callgraph" });
  });
  it("sends the call graph again to a surface that mounted after the replay", async () => {
    const hub = new SharedWebviewHub(); const panel = peer(); hub.add(panel);
    const graph = { type: "showCallGraph", rootSymbolId: "r", nodes: [] };
    const select = { type: "callGraphSelectNode", nodeId: "a" };
    await hub.post(graph); await hub.mirror(panel, select);
    const editor = peer(); await hub.restoreCallGraph(editor);
    expect(editor.postMessage.mock.calls.map(([message]) => message)).toEqual([graph, select]);
  });
  it("does not let one closed surface prevent delivery to the remaining one", async () => {
    const hub = new SharedWebviewHub(); const live = peer(); hub.add(live);
    hub.add({ postMessage: vi.fn(async () => { throw new Error("closed"); }) });
    expect(await hub.post({ command: "updateGraph" })).toBe(true);
  });
});
