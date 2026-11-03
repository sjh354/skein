// @vitest-environment happy-dom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSurfaceBridge } from "../../src/webview/utils/useSurfaceBridge";
import type { SkeinViewAction, SkeinViewMode } from "../../src/shared/viewState";

const nodes = [{ id: "file:alpha", label: "Alpha" }, { id: "file:beta", label: "Beta" }];
function Harness({ post, apply, mode = "file" }: { post: ReturnType<typeof vi.fn>; apply: ReturnType<typeof vi.fn>; mode?: SkeinViewMode }) {
  const surface = useSurfaceBridge({ mode, nodes, state: { expandedNodeIds: [] }, post, apply });
  return <button onClick={() => surface.select(nodes[1].id)}>select</button>;
}
const send = (action: SkeinViewAction, mode = "file") => act(() => window.dispatchEvent(new MessageEvent("message", { data: { command: "surfaceCommand", id: "request", mode, action } })));
afterEach(cleanup);
describe("rendered surface bridge", () => {
  it("searches current nodes, focuses the match and publishes exact IDs before acknowledging", () => {
    const post = vi.fn(); const apply = vi.fn();
    render(<Harness post={post} apply={apply} />);
    send({ action: "search", query: "BETA" });
    expect(apply).toHaveBeenCalledWith({ action: "focus", nodeId: "file:beta" });
    const messages = post.mock.calls.map(([m]) => m);
    const state = messages.find(m => m.state?.search?.query === "BETA");
    expect(state.state.search).toEqual({ query: "BETA", matches: ["file:beta"], total: 1 });
    expect(state.selection.nodeId).toBe("file:beta");
    expect(messages.findIndex(m => m.command === "surfaceResult")).toBeGreaterThan(messages.indexOf(state));
  });
  it("rejects missing nodes and failed operations without claiming success", () => {
    const post = vi.fn(); const apply = vi.fn(() => "node-not-visible");
    render(<Harness post={post} apply={apply} />);
    send({ action: "select", nodeId: "missing" });
    expect(apply).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({ command: "surfaceResult", id: "request", reason: "node-not-found" });
    send({ action: "focus", nodeId: "file:alpha" });
    expect(post).toHaveBeenCalledWith({ command: "surfaceResult", id: "request", reason: "node-not-visible" });
  });
  it("does not let the always-mounted call graph acknowledge another mode's command", () => {
    const post = vi.fn(); const apply = vi.fn();
    render(<Harness post={post} apply={apply} mode="callgraph" />);
    send({ action: "set_expanded", nodeId: "file:alpha", expanded: true });
    expect(apply).not.toHaveBeenCalled();
    expect(post.mock.calls.some(([m]) => m.command === "surfaceResult")).toBe(false);
  });
  it("marks real clicks as user actions, but remote selections as programmatic", () => {
    const post = vi.fn(); const apply = vi.fn();
    const view = render(<Harness post={post} apply={apply} />);
    send({ action: "select", nodeId: "file:alpha" });
    expect(post.mock.calls.some(([m]) => m.userInitiated === true)).toBe(false);
    act(() => view.getByText("select").click());
    expect(post.mock.calls.some(([m]) => m.userInitiated && m.selection.nodeId === "file:beta")).toBe(true);
  });
  it("caps returned matches and allows clearing a search", () => {
    const post = vi.fn(); const apply = vi.fn();
    function Many() { useSurfaceBridge({ mode: "file", nodes: Array.from({ length: 150 }, (_, i) => ({ id: `node${i}` })), state: { expandedNodeIds: [] }, post, apply }); return null; }
    render(<Many />); send({ action: "search", query: "node" });
    const state = post.mock.calls.map(([m]) => m).find(m => m.state?.search?.total === 150);
    expect(state.state.search.matches).toHaveLength(100);
    send({ action: "search", query: "" });
    expect(post.mock.calls.some(([m]) => m.state?.search?.total === 0 && m.state.search.query === "")).toBe(true);
  });
});
