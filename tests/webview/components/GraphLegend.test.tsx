// @vitest-environment happy-dom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphLegend } from "../../../src/webview/components/cytoscape/GraphLegend";

afterEach(cleanup);

describe("call graph legend", () => {
  it("publishes filter changes through the supplied webview postMessage", () => {
    const postMessage = vi.fn();
    const onToggle = vi.fn();

    render(
      <GraphLegend
        nodeTypes={["function", "class"]}
        folders={[]}
        hiddenFilters={new Set()}
        onToggle={onToggle}
        postMessage={postMessage}
      />,
    );

    fireEvent.click(screen.getByLabelText("Toggle Function nodes"));

    expect(onToggle).toHaveBeenCalledWith("nodeType", "function", false);
    expect(postMessage).toHaveBeenCalledWith({
      command: "callGraphFilterChanged",
      filterType: "nodeType",
      value: "function",
      visible: false,
    });
  });
});
