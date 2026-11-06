import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SourceFileCollector } from "@/analyzer/SourceFileCollector";
import { createArchitectureChangeGuard } from "@/extension/services/ArchitectureChangeGuard";

const FILES: Record<string, string[]> = {
  "ui/view.ts": [],
  "infra/db.ts": [],
  "infra/bad.ts": ["ui/view.ts"],
};

const CONFIG = {
  elements: { ui: { path: "ui/" }, infra: { path: "infra/" } },
  profiles: { layers: { layers: [["ui"], ["infra"]] } },
  areas: { app: { path: ["ui/", "infra/"], profile: "layers" } },
};

describe("ArchitectureChangeGuard", () => {
  let root: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skein-guard-")));
    for (const relative of Object.keys(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), "export const x = 1;\n", "utf8");
    }
    fs.writeFileSync(path.join(root, "skein.architecture.json"), JSON.stringify(CONFIG), "utf8");
    vi.spyOn(SourceFileCollector.prototype, "collectAllSourceFiles")
      .mockResolvedValue(Object.keys(FILES).map((relative) => path.join(root, relative)));
  });

  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function guard(invalidate?: (files: readonly string[]) => void) {
    return createArchitectureChangeGuard({
      root,
      logger: { warn: vi.fn() },
      ...(invalidate ? { invalidate } : {}),
      analyzeFile: async (filePath) =>
        FILES[path.relative(root, filePath).split(path.sep).join("/")].map((target) => ({
          path: path.join(root, target),
          type: "import" as const,
          line: 1,
          module: target,
        })),
    });
  }

  it("blocks when an absolute changed path touches a violation", async () => {
    const snapshot = await guard().check([path.join(root, "ui/view.ts")]);

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.findings).toHaveLength(1);
  });

  it("passes when the changed files touch no violation", async () => {
    const snapshot = await guard().check([path.join(root, "infra/db.ts")]);

    expect(snapshot.status).toBe("passed");
    expect(snapshot.findings).toHaveLength(0);
  });

  it("drops cached analysis of the changed files before checking", async () => {
    const invalidate = vi.fn();
    const changed = [path.join(root, "infra/db.ts")];

    await guard(invalidate).check(changed);

    expect(invalidate).toHaveBeenCalledWith(changed);
  });

  it("reports unavailable instead of passing when a changed file cannot be analyzed", async () => {
    const failing = createArchitectureChangeGuard({
      root,
      logger: { warn: vi.fn() },
      analyzeFile: async (filePath) => {
        if (filePath.endsWith("infra/db.ts")) throw new Error("FILE_NOT_FOUND");
        return [];
      },
    });

    const snapshot = await failing.check([path.join(root, "infra/db.ts")]);

    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.message).toContain("infra/db.ts");
  });
});
