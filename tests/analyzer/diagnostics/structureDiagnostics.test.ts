import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildArchitectureGraph, type ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { SourceFileCollector } from "@/analyzer/SourceFileCollector";
import { exploreDiagnostics, runWorkspaceDiagnostics } from "@/analyzer/diagnostics/structureDiagnostics";
import { formatBaseline } from "@/analyzer/architecture/architectureRules";
import { normalizePath } from "@/shared/path";

const IDENTICAL = `export function total(values: number[]) {
  let sum = 0;
  for (const value of values) {
    if (value > 0) {
      sum = sum + value * 2;
    } else {
      sum = sum - value;
    }
  }
  return sum;
}
export function label(value: string) {
  return value.trim().toLowerCase();
}
`;

const files: Record<string, { text: string; imports: string[] }> = {
  "large.ts": { text: `${"const line = 1;\n".repeat(420)}`, imports: [] },
  "dup/a.ts": { text: IDENTICAL, imports: [] },
  "dup/b.ts": { text: IDENTICAL, imports: [] },
  "wrapper.ts": { text: "export function wrap(value: string) { return inner(value); }\n", imports: [] },
  "store.ts": { text: "export interface Store {\n  read(): string;\n}\n", imports: [] },
  "store-impl.ts": { text: 'import type { Store } from "./store";\nexport class FileStore implements Store {\n  read() { return ""; }\n}\n', imports: ["store.ts"] },
  "ui/a.ts": { text: "export const a = 1;\n", imports: [] },
  "infra/db.ts": { text: 'import { a } from "../ui/a";\nexport const db = a;\n', imports: ["ui/a.ts"] },
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`heavy/a${index}.ts`, {
    text: `import { shared } from "../other/b";\nexport const a${index} = shared;\n`,
    imports: ["other/b.ts"],
  }])),
  "other/b.ts": { text: "export const shared = 1;\n", imports: [] },
};

const CONFIG = {
  elements: {
    ui: { path: "ui/" },
    infra: { path: "infra/" },
  },
  profiles: { layers: { layers: [["ui"], ["infra"]] } },
  areas: { web: { path: ["ui/", "infra/"], profile: "layers" } },
  exceptions: [
    {
      rule: "profile:web",
      source: "infra/db.ts",
      target: "ui/a.ts",
      reason: "Legacy callback registered by the UI",
      until: "2099-12-31",
    },
  ],
};

const write = (root: string, relative: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), text, "utf8");
};

async function build(root: string): Promise<ArchitectureGraph> {
  vi.spyOn(SourceFileCollector.prototype, "collectAllSourceFiles")
    .mockResolvedValue(Object.keys(files).map((relative) => path.join(root, relative)));
  return buildArchitectureGraph(root, async (filePath) => {
    const relative = normalizePath(path.relative(root, filePath));
    return files[relative].imports.map((target) => ({
      path: path.join(root, target),
      type: "import" as const,
      line: 1,
      module: target,
    }));
  });
}

describe("structure diagnostics", () => {
  let root: string;
  let graph: ArchitectureGraph;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skein-diagnostics-")));
    for (const [relative, file] of Object.entries(files)) write(root, relative, file.text);
    write(root, "skein.architecture.json", JSON.stringify(CONFIG, null, 2));
    write(root, "skein.architecture.baseline.json", formatBaseline([], [{ id: "responsibility:large.ts", value: 0.5 }]));
    graph = await build(root);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports the five areas, with only declared rules confirmed", async () => {
    const result = await runWorkspaceDiagnostics(graph, root);
    const kinds = new Set(result.diagnostics.map((diagnostic) => diagnostic.kind));

    expect(kinds).toEqual(new Set(["responsibility", "duplication", "placement", "abstraction", "dependency"]));
    expect(result.totals.placement.confirmed).toBe(1);
    expect(result.totals.placement.excepted).toBe(1);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.kind !== "placement")
      .every((diagnostic) => diagnostic.status === "candidate")).toBe(true);
  });

  it("names the profile import that goes up a layer and accepts its exception", async () => {
    const result = await runWorkspaceDiagnostics(graph, root);
    const placement = result.diagnostics.filter((diagnostic) => diagnostic.kind === "placement");

    expect(placement).toHaveLength(1);
    expect(placement[0]).toMatchObject({
      status: "confirmed",
      area: "web",
      rule: "profile:web",
      baseline: "excepted",
      locations: [{ path: "infra/db.ts" }, { path: "ui/a.ts" }],
    });
    expect(result.diagnostics.find((diagnostic) => diagnostic.kind === "dependency")!.baseline).toBe("new");
  });

  it("keeps candidates separate and records duplication, wrappers and single implementations", async () => {
    const result = await runWorkspaceDiagnostics(graph, root);
    const duplication = result.diagnostics.filter((diagnostic) => diagnostic.kind === "duplication");
    const abstraction = result.diagnostics.filter((diagnostic) => diagnostic.kind === "abstraction");

    expect(duplication.some((diagnostic) => diagnostic.id === "duplication:dup/a.ts|dup/b.ts")).toBe(true);
    expect(abstraction.some((diagnostic) => diagnostic.id === "abstraction:wrapper:wrapper.ts:wrap")).toBe(true);
    expect(abstraction.some((diagnostic) => diagnostic.id === "abstraction:single-implementation:Store")).toBe(true);
  });

  it("marks a diagnostic above its baseline value as worsened", async () => {
    const result = await runWorkspaceDiagnostics(graph, root);
    const responsibility = result.diagnostics.find((diagnostic) => diagnostic.id === "responsibility:large.ts");

    expect(responsibility).toMatchObject({ status: "candidate", baseline: "worsened" });
    expect(responsibility!.value).toBeGreaterThan(0.5);
  });

  it("pages by kind and refuses a page from another revision", async () => {
    const result = await runWorkspaceDiagnostics(graph, root);
    const page = exploreDiagnostics(result, { kind: "duplication", limit: 1 });

    expect(page.diagnostics).toHaveLength(1);
    expect(page.page.total).toBeGreaterThanOrEqual(1);
    expect(() => exploreDiagnostics(result, { revision: "0".repeat(64) })).toThrow(/revision/);
  });

  it("accepts a finding whose violation the baseline lists", async () => {
    const config = JSON.stringify({ ...CONFIG, exceptions: [] });
    const violation = { rule: "profile:web", source: "infra/db.ts", target: "ui/a.ts" };
    write(root, "skein.architecture.json", config);
    write(root, "skein.architecture.baseline.json", formatBaseline([violation]));
    try {
      const result = await runWorkspaceDiagnostics(graph, root);
      const placement = result.diagnostics.find((diagnostic) => diagnostic.kind === "placement");

      expect(placement).toMatchObject({ status: "confirmed", baseline: "accepted" });
      expect(result.totals.placement.new).toBe(0);
    } finally {
      write(root, "skein.architecture.json", JSON.stringify(CONFIG, null, 2));
      write(root, "skein.architecture.baseline.json", formatBaseline([], [{ id: "responsibility:large.ts", value: 0.5 }]));
    }
  });
});
