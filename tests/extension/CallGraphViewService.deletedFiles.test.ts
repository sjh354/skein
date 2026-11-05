import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ existing: new Set<string>() }));

vi.mock("vscode", () => ({
  Uri: { file: (p: string) => ({ fsPath: p }) },
  window: { createOutputChannel: () => ({ appendLine: vi.fn(), dispose: vi.fn() }) },
  workspace: {
    workspaceFolders: undefined,
    fs: {
      stat: async (uri: { fsPath: string }) => {
        if (!mocks.existing.has(uri.fsPath)) throw Object.assign(new Error("gone"), { code: "FileNotFound" });
        return {};
      },
    },
  },
  commands: { executeCommand: vi.fn() },
}));

import { CallGraphViewService } from "@/extension/services/CallGraphViewService";

type Internals = {
  indexer: unknown;
  prunedRoot: string | null;
  pruneMissingFiles(indexer: unknown, root: string): Promise<void>;
  removeDeletedPath(path: string): Promise<void>;
  resolveIndexedRootId(indexer: unknown, rootId: string): string;
};

function fakeIndexer(paths: string[]) {
  return {
    getDb: () => ({ exec: () => [{ values: paths.map((p) => [p]) }] }),
    invalidateFile: vi.fn(),
    resolveExternalEdges: vi.fn(),
  };
}

function createService(indexer: unknown) {
  const service = new CallGraphViewService({ subscriptions: [] } as never);
  const internals = service as unknown as Internals;
  internals.indexer = indexer;
  return internals;
}

describe("CallGraphViewService deleted files", () => {
  it("prunes indexed files that no longer exist, once per root", async () => {
    mocks.existing = new Set(["/ws/a.ts"]);
    const indexer = fakeIndexer(["/ws/a.ts", "/ws/gone.ts"]);
    const service = createService(indexer);

    await service.pruneMissingFiles(indexer, "/ws");
    await service.pruneMissingFiles(indexer, "/ws");

    expect(indexer.invalidateFile).toHaveBeenCalledTimes(1);
    expect(indexer.invalidateFile).toHaveBeenCalledWith("/ws/gone.ts");
    expect(indexer.resolveExternalEdges).toHaveBeenCalledTimes(1);
  });

  it("removes a deleted file and every file under a deleted folder", async () => {
    const indexer = fakeIndexer(["/ws/src/a.ts", "/ws/src/sub/b.ts", "/ws/srcx/c.ts"]);
    const service = createService(indexer);

    await service.removeDeletedPath("/ws/src");

    expect(indexer.invalidateFile.mock.calls.map(([p]) => p)).toEqual(["/ws/src/a.ts", "/ws/src/sub/b.ts"]);
  });

  it("leaves the index alone when the deleted path is not indexed", async () => {
    const indexer = fakeIndexer(["/ws/a.ts"]);
    const service = createService(indexer);

    await service.removeDeletedPath("/ws/other.ts");

    expect(indexer.invalidateFile).not.toHaveBeenCalled();
    expect(indexer.resolveExternalEdges).not.toHaveBeenCalled();
  });

  describe("following a root symbol that moved to another file", () => {
    function indexerWithNodes(rows: { byId?: string[]; byPathName?: string[]; byName?: string[] }) {
      const values = (ids: string[] | undefined) => (ids?.length ? [{ values: ids.map((id) => [id]) }] : []);
      return {
        getDb: () => ({
          exec: (sql: string) => {
            if (sql.includes("WHERE id = ?")) return values(rows.byId);
            if (sql.includes("path = ? AND name = ?")) return values(rows.byPathName);
            if (sql.includes("WHERE name = ?")) return values(rows.byName);
            return [];
          },
        }),
      };
    }
    const ROOT = "/ws/app.ts:beta:8";

    it("keeps the root while its node still exists", () => {
      const service = createService(null);
      expect(service.resolveIndexedRootId(indexerWithNodes({ byId: [ROOT] }), ROOT)).toBe(ROOT);
    });

    it("follows the only symbol with that name into the new file", () => {
      const service = createService(null);
      const indexer = indexerWithNodes({ byName: ["/ws/beta.ts:beta:2"] });
      expect(service.resolveIndexedRootId(indexer, ROOT)).toBe("/ws/beta.ts:beta:2");
    });

    it("does not guess between several symbols with that name", () => {
      const service = createService(null);
      const indexer = indexerWithNodes({ byName: ["/ws/a.ts:beta:1", "/ws/b.ts:beta:1"] });
      expect(service.resolveIndexedRootId(indexer, ROOT)).toBe(ROOT);
    });
  });
});
