// @vitest-environment happy-dom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SerializedCallEdge,
  SerializedCallNode,
} from "@/shared/callgraph-types";
import {
  buildReferenceText,
  CallGraphDetail,
  callEdgeId,
} from "@/webview/components/cytoscape/CallGraphDetail";

const symbol = (overrides: Partial<SerializedCallNode>): SerializedCallNode => ({
  id: "/workspace/src/a.ts:alpha:3",
  name: "alpha",
  type: "function",
  lang: "typescript",
  path: "/workspace/src/a.ts",
  folder: "src",
  startLine: 3,
  endLine: 8,
  startCol: 0,
  isExported: true,
  isRoot: false,
  ...overrides,
});

const alpha = symbol({ isRoot: true });
const beta = symbol({
  id: "/workspace/src/b.ts:beta:10",
  name: "beta",
  path: "/workspace/src/b.ts",
  startLine: 10,
  endLine: 14,
});
const call: SerializedCallEdge = {
  sourceId: alpha.id,
  targetId: beta.id,
  typeRelation: "CALLS",
  isCyclic: false,
  sourceLine: 6,
  direction: "outgoing",
};

const renderPanel = (overrides: Partial<React.ComponentProps<typeof CallGraphDetail>> = {}) => {
  const props = {
    nodes: [alpha, beta],
    edges: [call],
    rootSymbolId: alpha.id,
    projectName: "skein",
    generatedAt: 1_700_000_000_000,
    onOpenFile: vi.fn(),
    onFocusNode: vi.fn(),
    onSelectEdge: vi.fn(),
    onCopy: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<CallGraphDetail {...props} />);
  return props;
};

afterEach(cleanup);

describe("CallGraphDetail", () => {
  it("shows a selected symbol with its relations, not the source editor", () => {
    const props = renderPanel({ selectedNodeId: beta.id });

    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.getByText("function")).toBeTruthy();
    expect(screen.getByText("Called by (1)")).toBeTruthy();
    expect(screen.getByText("alpha", { exact: false })).toBeTruthy();
    expect(props.onOpenFile).not.toHaveBeenCalled();
    expect(props.onFocusNode).not.toHaveBeenCalled();
  });

  it("opens code only when the button is pressed", () => {
    const props = renderPanel({ selectedNodeId: beta.id });

    fireEvent.click(screen.getByText("Open code"));

    expect(props.onOpenFile).toHaveBeenCalledWith(beta.path, beta.startLine, beta.startCol);
  });

  it("centres on the symbol through the explicit button", () => {
    const props = renderPanel({ selectedNodeId: beta.id });

    fireEvent.click(screen.getByText("Centre on symbol"));

    expect(props.onFocusNode).toHaveBeenCalledWith(beta.id);
  });

  it("does not offer to centre the root on itself", () => {
    renderPanel({ selectedNodeId: alpha.id });

    expect(screen.queryByText("Centre on symbol")).toBeNull();
  });

  it("copies the reference fields from DESIGN 3.2", () => {
    const props = renderPanel({ selectedNodeId: beta.id });

    fireEvent.click(screen.getByText("Copy reference"));

    const text = (props.onCopy as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(text).toContain("project: skein");
    expect(text).toContain(`node: ${beta.id}`);
    expect(text).toContain("symbol: beta (function, typescript) exported");
    expect(text).toContain(`path: ${beta.path}`);
    expect(text).toContain("position: 11:1-15");
    expect(text).toContain("analysis: 2023-11-14T22:13:20.000Z");
  });

  it("shows an edge's call site and opens it", () => {
    const props = renderPanel({ selectedEdgeId: callEdgeId(call) });

    expect(screen.getByText("Relation")).toBeTruthy();
    expect(screen.getByText("alpha → beta")).toBeTruthy();

    fireEvent.click(screen.getByText("Open line 7"));
    expect(props.onOpenFile).toHaveBeenCalledWith(alpha.path, call.sourceLine, 0);
  });

  it("selects a related edge from the symbol list", () => {
    const props = renderPanel({ selectedNodeId: alpha.id });

    fireEvent.click(screen.getByText("beta"));

    expect(props.onSelectEdge).toHaveBeenCalledWith(callEdgeId(call));
  });

  it("renders nothing without a selection", () => {
    const props = renderPanel();

    expect(screen.queryByTestId("call-graph-detail")).toBeNull();
  });
});

describe("buildReferenceText", () => {
  it("marks an unknown analysis version instead of inventing one", () => {
    const text = buildReferenceText({ node: alpha, rootSymbolId: alpha.id });

    expect(text).toContain("project: unknown");
    expect(text).toContain("analysis: unknown");
  });
});
