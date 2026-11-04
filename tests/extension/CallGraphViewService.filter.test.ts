import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: { createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }) },
  workspace: { workspaceFolders: undefined, fs: { delete: vi.fn() } },
  commands: { executeCommand: vi.fn() },
}));

import { CallGraphViewService } from "@/extension/services/CallGraphViewService";

function createService() {
  const posted: Array<Record<string, unknown>> = [];
  const service = new CallGraphViewService({ subscriptions: [] } as never);
  service.setSidebarWebview({
    webview: {
      postMessage: (message: unknown) => {
        posted.push(message as Record<string, unknown>);
        return Promise.resolve(true);
      },
    },
  } as never);
  return { service, posted };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CallGraphViewService.setFilter", () => {
  it("does not publish a hidden filter before a renderer confirms it", async () => {
    const { service, posted } = createService();

    const pending = service.setFilter("nodeType", "function", false);
    expect(service.getHiddenFilters()).toEqual([]);
    expect(posted[0]).toMatchObject({
      type: "callGraphSetFilter",
      filterType: "nodeType",
      value: "function",
      visible: false,
    });

    service.handleWebviewMessage({
      command: "callGraphFilterApplied",
      requestId: String(posted[0].requestId),
    });

    await expect(pending).resolves.toBe(true);
    expect(service.getHiddenFilters()).toEqual([{ filterType: "nodeType", value: "function" }]);
  });

  it("reports the renderer's rejection instead of claiming success", async () => {
    const { service, posted } = createService();

    const pending = service.setFilter("nodeType", "missing", false);
    service.handleWebviewMessage({
      command: "callGraphFilterApplied",
      requestId: String(posted[0].requestId),
      reason: "filter-not-found",
    });

    await expect(pending).resolves.toBe("filter-not-found");
    expect(service.getHiddenFilters()).toEqual([]);
  });

  it("times out when no renderer confirms the filter", async () => {
    vi.useFakeTimers();
    const { service } = createService();

    const pending = service.setFilter("folder", "src", false);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toBe("view-not-responding");
    expect(service.getHiddenFilters()).toEqual([]);
  });
});
