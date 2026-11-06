import { describe, expect, it } from "vitest";
import {
  buildFileGraph,
  personalizedPageRank,
  rerankByStructure,
} from "@/analyzer/graph-context/GraphContextStructuralRank";
import type { GraphContextEdge, GraphContextNode, GraphContextRelation } from "@/shared/graph-context-types";

const node = (name: string, path: string): GraphContextNode => ({ id: `symbol:${path}:${name}:1`, kind: "symbol", name, path });
const edge = (from: GraphContextNode, to: GraphContextNode, relation: GraphContextRelation = "IMPORTS"): GraphContextEdge => ({
  source: from.id,
  target: to.id,
  relation,
  confidence: "EXTRACTED",
});

describe("buildFileGraph", () => {
  it("links files through cross-file structural edges only", () => {
    const a = node("a", "src/a.ts");
    const b = node("b", "src/b.ts");
    const a2 = node("a2", "src/a.ts");
    const c = node("c", "src/c.ts");
    const graph = buildFileGraph([a, b, a2, c], [
      edge(a, b),
      edge(a, a2, "CALLS"),
      edge(b, c, "CONTAINS"),
      edge(a, c, "TESTED_BY"),
    ]);

    expect([...graph.get("src/a.ts")!]).toEqual(["src/b.ts"]);
    expect([...graph.get("src/b.ts")!]).toEqual(["src/a.ts"]);
    expect(graph.has("src/c.ts")).toBe(false);
  });
});

describe("personalizedPageRank", () => {
  const graph = new Map([
    ["seed", new Set(["near"])],
    ["near", new Set(["seed", "far"])],
    ["far", new Set(["near"])],
    ["isolated", new Set<string>()],
  ]);

  it("scores files near the seed above distant ones, ignores the unreachable, and sums to one", () => {
    const rank = personalizedPageRank(graph, new Map([["seed", 1]]));

    expect(rank.get("seed")!).toBeGreaterThan(rank.get("far")!);
    expect(rank.get("near")!).toBeGreaterThan(rank.get("far")!);
    expect(rank.get("isolated") ?? 0).toBe(0);
    expect([...rank.values()].reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 5);
  });

  it("returns nothing without a seed weight", () => {
    expect(personalizedPageRank(graph, new Map()).size).toBe(0);
  });

  it("keeps mass when a seed has no neighbours", () => {
    const rank = personalizedPageRank(graph, new Map([["isolated", 1]]));
    expect(rank.get("isolated")).toBeCloseTo(1, 5);
  });
});

describe("rerankByStructure", () => {
  const top = node("top", "src/lonely.ts");
  const second = node("second", "src/hub.ts");
  const third = node("third", "src/hub-helper.ts");
  const fourth = node("fourth", "src/hub-other.ts");
  const nodes = [top, second, third, fourth];
  const candidates = [
    { node: top, score: 10 },
    { node: second, score: 9 },
    { node: third, score: 8 },
    { node: fourth, score: 7 },
  ];
  const edges = [edge(second, third), edge(second, fourth), edge(third, fourth)];

  it("promotes candidates that sit close to other strong matches", () => {
    const ordered = rerankByStructure(candidates, nodes, edges).map((candidate) => candidate.node.name);

    expect(new Set(ordered)).toEqual(new Set(["top", "second", "third", "fourth"]));
    expect(ordered[0]).toBe("top");
    expect(ordered.indexOf("second")).toBeLessThan(ordered.indexOf("fourth"));
  });

  it("can overtake a close lexical neighbour with a better-connected cluster", () => {
    const tight = [
      { node: top, score: 10 },
      { node: second, score: 9.9 },
      { node: third, score: 9.8 },
      { node: fourth, score: 9.7 },
    ];
    const ordered = rerankByStructure(tight, nodes, [edge(second, third), edge(third, fourth), edge(second, fourth)]);
    // the isolated top candidate has no structural support, the connected trio does
    expect(ordered.map((candidate) => candidate.node.name).slice(0, 2)).toContain("second");
  });

  it("hands the original scores out in the new order so scores stay descending", () => {
    const scores = rerankByStructure(candidates, nodes, edges).map((candidate) => candidate.score);
    expect(scores).toEqual([10, 9, 8, 7]);
  });

  it("leaves one candidate or a graph-less snapshot untouched", () => {
    expect(rerankByStructure([candidates[0]], nodes, edges)).toEqual([candidates[0]]);
    expect(rerankByStructure(candidates, nodes, [])).toEqual(candidates);
  });
});
