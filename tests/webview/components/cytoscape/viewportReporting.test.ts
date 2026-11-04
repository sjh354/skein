import { describe, expect, it, vi } from "vitest";
import type cytoscape from "cytoscape";
import { registerViewportReporting } from "@/webview/components/cytoscape/viewportReporting";

/** Minimal stand-in for the Cytoscape event bus. */
function fakeCy() {
  const handlers = new Map<string, Array<() => void>>();
  const core = {
    on(event: string, selectorOrHandler: string | (() => void), handler?: () => void): unknown {
      const key = typeof selectorOrHandler === "string" ? `${event}:${selectorOrHandler}` : event;
      const listener = typeof selectorOrHandler === "function" ? selectorOrHandler : handler;
      handlers.set(key, [...(handlers.get(key) ?? []), listener as () => void]);
      return core;
    },
  };
  return {
    core: core as unknown as cytoscape.Core,
    get events() {
      return [...handlers.keys()];
    },
    fire(key: string) {
      for (const listener of handlers.get(key) ?? []) listener();
    },
  };
}

describe("registerViewportReporting", () => {
  it("publishes a background drag, which Cytoscape reports as pan only", () => {
    const cy = fakeCy();
    const onChange = vi.fn();
    registerViewportReporting(cy.core, {
      onChange,
      isProgrammatic: () => false,
      isPanUnchanged: () => false,
    });

    cy.fire("pan");

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("keeps zoom and node drags, and ignores a repaint that pans nowhere", () => {
    const cy = fakeCy();
    const onChange = vi.fn();
    registerViewportReporting(cy.core, {
      onChange,
      isProgrammatic: () => false,
      isPanUnchanged: () => true,
    });

    cy.fire("pan");
    expect(onChange).not.toHaveBeenCalled();
    cy.fire("zoom");
    cy.fire("dragfree:node");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("publishes programmatic moves without recording them as user actions", () => {
    const cy = fakeCy();
    const onChange = vi.fn();
    registerViewportReporting(cy.core, {
      onChange,
      isProgrammatic: () => true,
      isPanUnchanged: () => false,
    });

    cy.fire("pan");
    cy.fire("zoom");

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("subscribes to pan, zoom and node drags", () => {
    const cy = fakeCy();
    registerViewportReporting(cy.core, {
      onChange: vi.fn(),
      isProgrammatic: () => false,
      isPanUnchanged: () => false,
    });

    expect(cy.events).toEqual(["zoom", "pan", "dragfree:node"]);
  });
});
