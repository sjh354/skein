import { describe, expect, it, vi } from "vitest";
import { SurfaceStateService } from "@/extension/services/SurfaceStateService";

const state = { nodeIds: ["a"], expandedNodeIds: [] };

describe("SurfaceStateService", () => {
  it("keeps the last state per surface and the selection of the non-call-graph surfaces", () => {
    const observer = vi.fn();
    const surfaces = new SurfaceStateService();
    surfaces.setUserActionObserver(observer);

    surfaces.record({ mode: "file", state, selection: { nodeId: "a" }, userInitiated: true });
    surfaces.record({ mode: "callgraph", state, selection: { nodeId: "sym" } });

    expect(surfaces.state("file")).toBe(state);
    expect(surfaces.views()).toEqual({ file: { nodeId: "a" } });
    expect(observer).toHaveBeenCalledTimes(1);

    surfaces.record({ mode: "file", state });
    expect(surfaces.views()).toEqual({});
  });

  it("restores the previous session's selections and surface", () => {
    const surfaces = new SurfaceStateService();
    surfaces.restore({ mode: "symbol", hiddenFilters: [], expandAll: false, surface: state, views: { symbol: { nodeId: "s" } } });
    expect(surfaces.state("symbol")).toBe(state);
    expect(surfaces.selection("symbol")).toEqual({ nodeId: "s" });
  });

  it("resolves a command only when the renderer acknowledges it", async () => {
    const surfaces = new SurfaceStateService();
    const posted: Array<{ id: string }> = [];
    const outcome = surfaces.control(
      async (message) => {
        posted.push(message as { id: string });
        return true;
      },
      "file",
      { action: "search", query: "a" },
    );
    expect(posted).toHaveLength(1);
    surfaces.settle(posted[0].id);
    expect(await outcome).toBe(true);
  });

  it("reports an undelivered message, a rejection and disposal explicitly", async () => {
    const surfaces = new SurfaceStateService();
    expect(await surfaces.control(async () => false, "file", { action: "search", query: "a" })).toBe("view-not-available");

    const posted: Array<{ id: string }> = [];
    const post = async (message: unknown) => {
      posted.push(message as { id: string });
      return true;
    };
    const rejected = surfaces.control(post, "file", { action: "select", nodeId: "x" });
    surfaces.settle(posted[0].id, "node-not-found");
    expect(await rejected).toBe("node-not-found");

    const abandoned = surfaces.control(post, "file", { action: "select", nodeId: "y" });
    surfaces.dispose();
    expect(await abandoned).toBe("view-not-available");
  });

  it("gives up on a renderer that never answers", async () => {
    vi.useFakeTimers();
    try {
      const surfaces = new SurfaceStateService();
      const outcome = surfaces.control(async () => true, "file", { action: "search", query: "a" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await outcome).toBe("view-not-responding");
    } finally {
      vi.useRealTimers();
    }
  });
});
