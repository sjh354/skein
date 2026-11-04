import { describe, expect, it, vi } from "vitest";
import type cytoscape from "cytoscape";
import { focusZoomFor, registerViewportReporting } from "@/webview/components/cytoscape/viewportReporting";

/** Minimal stand-in for the Cytoscape event bus. */
function fakeCy() {
  const handlers = new Map<string, Array<() => void>>();
  let pan = { x: 0, y: 0 };
  const core = {
    on(event: string, selectorOrHandler: string | (() => void), handler?: () => void): unknown {
      const key = typeof selectorOrHandler === "string" ? `${event}:${selectorOrHandler}` : event;
      const listener = typeof selectorOrHandler === "function" ? selectorOrHandler : handler;
      handlers.set(key, [...(handlers.get(key) ?? []), listener as () => void]);
      return core;
    },
    pan: () => pan,
  };
  return {
    core: core as unknown as cytoscape.Core,
    get events() {
      return [...handlers.keys()];
    },
    setPan(next: { x: number; y: number }) {
      pan = next;
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
    registerViewportReporting(cy.core, { onChange, isProgrammatic: () => false });

    cy.setPan({ x: 40, y: 60 });
    cy.fire("pan");

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("keeps zoom and node drags, and ignores a repaint that pans nowhere", () => {
    const cy = fakeCy();
    const onChange = vi.fn();
    registerViewportReporting(cy.core, { onChange, isProgrammatic: () => false });

    cy.fire("pan");
    expect(onChange).not.toHaveBeenCalled();
    cy.fire("zoom");
    cy.fire("dragfree:node");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not repeat a pan that has already been reported", () => {
    const cy = fakeCy();
    const onChange = vi.fn();
    registerViewportReporting(cy.core, { onChange, isProgrammatic: () => false });

    cy.setPan({ x: 10, y: 20 });
    cy.fire("pan");
    cy.fire("pan");

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("publishes programmatic moves without recording them as user actions", () => {
    const cy = fakeCy();
    const onChange = vi.fn();
    registerViewportReporting(cy.core, { onChange, isProgrammatic: () => true });

    cy.setPan({ x: 40, y: 60 });
    cy.fire("pan");
    cy.fire("zoom");

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("subscribes to pan, zoom and node drags", () => {
    const cy = fakeCy();
    registerViewportReporting(cy.core, { onChange: vi.fn(), isProgrammatic: () => false });

    expect(cy.events).toEqual(["zoom", "pan", "dragfree:node"]);
  });
});

describe("focusZoomFor", () => {
  it("caps the single-node fit at a readable zoom", () => {
    expect(focusZoomFor(5)).toBe(2);
  });

  it("keeps a fitted zoom that is already close", () => {
    expect(focusZoomFor(0.8)).toBe(0.8);
  });
});
