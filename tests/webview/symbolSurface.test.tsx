// @vitest-environment happy-dom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SymbolCardView from "../../src/webview/components/SymbolCardView";
import { AtomicSymbolGraph } from "../../src/webview/components/AtomicSymbolGraph";
import type { SymbolInfo } from "../../src/shared/types";
const symbols: SymbolInfo[] = [{ id: "/p/a.ts:alpha", name: "alpha", line: 1, kind: "function", category: "function", isExported: false }];
const send = (mode: string) => act(() => window.dispatchEvent(new MessageEvent("message", { data: { command: "surfaceCommand", mode, id: "select", action: { action: "select", nodeId: symbols[0].id } } })));
afterEach(cleanup);
describe("symbol surface selections", () => {
  it("publishes list clicks and remotely selects without opening an editor", () => {
    const post = vi.fn(); const open = vi.fn();
    render(<SymbolCardView postMessage={post} filePath="/p/a.ts" symbols={symbols} dependencies={[]} referencingFiles={[]} showTypes onShowTypesChange={vi.fn()} onSymbolClick={open} onNavigateToFile={vi.fn()} onBack={vi.fn()} onSwitchToGraphView={vi.fn()} />);
    send("list");
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { pressed: true })).toBeTruthy();
    expect(post.mock.calls.some(([m]) => m.mode === "list" && m.selection?.nodeId === symbols[0].id)).toBe(true);
    fireEvent.click(screen.getByText("alpha"));
    expect(post.mock.calls.some(([m]) => m.userInitiated && m.selection?.nodeId === symbols[0].id)).toBe(true);
  });
  it("publishes atomic symbol clicks and remotely selects without opening an editor", () => {
    const post = vi.fn(); const open = vi.fn();
    render(<AtomicSymbolGraph postMessage={post} filePath="/p/a.ts" symbols={symbols} dependencies={[]} onNodeClick={open} />);
    send("symbol");
    expect(open).not.toHaveBeenCalled();
    expect(post.mock.calls.some(([m]) => m.mode === "symbol" && m.selection?.nodeId === symbols[0].id)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Symbol alpha" }));
    expect(post.mock.calls.some(([m]) => m.userInitiated && m.selection?.nodeId === symbols[0].id)).toBe(true);
  });
});
