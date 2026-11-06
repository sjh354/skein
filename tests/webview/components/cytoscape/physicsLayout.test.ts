import { describe, expect, it } from "vitest";
import {
  ALPHA_MIN,
  PhysicsSimulation,
  seedPositions,
  type PhysicsBody,
  type PhysicsGroup,
  type PhysicsLink,
} from "../../../../src/webview/components/cytoscape/physicsLayout";

/** Three files of five symbols each, two in one folder; calls inside each file plus a few across. */
function fixture() {
  const groups: PhysicsGroup[] = [
    { id: "src", parent: undefined },
    { id: "src/a.ts", parent: "src" },
    { id: "src/b.ts", parent: "src" },
    { id: "lib/c.ts", parent: undefined },
  ];
  const bodies: Array<Pick<PhysicsBody, "id" | "group">> = [];
  const links: PhysicsLink[] = [];
  for (const file of ["src/a.ts", "src/b.ts", "lib/c.ts"]) {
    for (let index = 0; index < 5; index += 1) {
      bodies.push({ id: `${file}:f${index}`, group: file });
      if (index > 0) links.push({ source: `${file}:f${index - 1}`, target: `${file}:f${index}` });
    }
  }
  links.push({ source: "src/a.ts:f0", target: "src/b.ts:f0" }, { source: "src/b.ts:f4", target: "lib/c.ts:f0" });
  const seeds = seedPositions(bodies);
  return {
    groups,
    links,
    bodies: bodies.map((body) => ({ ...body, ...seeds.get(body.id)! })),
  };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function centroid(points: Array<{ x: number; y: number }>) {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

describe("seedPositions", () => {
  it("is deterministic and gives every body its own spot", () => {
    const { bodies } = fixture();
    const again = seedPositions(bodies);
    const first = seedPositions(bodies);
    expect([...again]).toEqual([...first]);
    const spots = new Set([...first.values()].map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`));
    expect(spots.size).toBe(bodies.length);
  });
});

describe("PhysicsSimulation", () => {
  it("settles to finite positions and cools below the minimum alpha", () => {
    const { bodies, links, groups } = fixture();
    const simulation = new PhysicsSimulation(bodies, links, groups);
    const ticks = simulation.settle(500);

    expect(simulation.alpha).toBeLessThan(ALPHA_MIN);
    expect(ticks).toBeLessThan(500);
    for (const point of simulation.positions().values()) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    }
  });

  it("is deterministic", () => {
    const run = () => {
      const { bodies, links, groups } = fixture();
      const simulation = new PhysicsSimulation(bodies, links, groups);
      simulation.settle();
      return [...simulation.positions()];
    };
    expect(run()).toEqual(run());
  });

  it("keeps bodies apart", () => {
    const { bodies, links, groups } = fixture();
    const simulation = new PhysicsSimulation(bodies, links, groups);
    simulation.settle();
    const points = [...simulation.positions().values()];
    let nearest = Infinity;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) nearest = Math.min(nearest, distance(points[i], points[j]));
    }
    expect(nearest).toBeGreaterThan(25);
  });

  it("keeps the nodes of a file together and the files of a folder apart", () => {
    const { bodies, links, groups } = fixture();
    const simulation = new PhysicsSimulation(bodies, links, groups);
    simulation.settle();
    const positions = simulation.positions();
    const ofFile = (file: string) => [...positions].filter(([id]) => id.startsWith(`${file}:`)).map(([, point]) => point);
    const a = ofFile("src/a.ts");
    const b = ofFile("src/b.ts");
    const c = ofFile("lib/c.ts");
    const spread = (points: typeof a) => Math.max(...points.map((point) => distance(point, centroid(points))));

    // a file is compact compared with the distance to another file
    expect(spread(a)).toBeLessThan(distance(centroid(a), centroid(b)));
    expect(spread(c)).toBeLessThan(distance(centroid(a), centroid(c)));
    // sibling file groups do not overlap: the centroid gap exceeds the radii of their members
    expect(distance(centroid(a), centroid(b))).toBeGreaterThan(spread(a) * 0.8 + spread(b) * 0.8);
  });

  it("holds a pinned body and lets its neighbours follow when reheated", () => {
    const { bodies, links, groups } = fixture();
    const simulation = new PhysicsSimulation(bodies, links, groups);
    simulation.settle();
    const before = simulation.positions();
    const neighbour = before.get("src/a.ts:f1")!;

    simulation.pin("src/a.ts:f0", 900, 900);
    simulation.reheat(0.5);
    simulation.settle();
    const after = simulation.positions();

    expect(after.get("src/a.ts:f0")).toEqual({ x: 900, y: 900 });
    expect(distance(after.get("src/a.ts:f1")!, neighbour)).toBeGreaterThan(100);
    // the pulled neighbour stays within reach of the pinned body (the spring holds)
    expect(distance(after.get("src/a.ts:f1")!, { x: 900, y: 900 })).toBeLessThan(600);

    simulation.release("src/a.ts:f0");
    simulation.reheat(0.5);
    simulation.step();
    expect(simulation.positions().get("src/a.ts:f0")).not.toEqual({ x: 900, y: 900 });
  });

  it("separates coincident bodies and ignores links to unknown nodes", () => {
    const simulation = new PhysicsSimulation(
      [{ id: "a", x: 0, y: 0 }, { id: "b", x: 0, y: 0 }],
      [{ source: "a", target: "missing" }, { source: "a", target: "a" }],
      [],
    );
    simulation.settle();
    const positions = simulation.positions();
    expect(distance(positions.get("a")!, positions.get("b")!)).toBeGreaterThan(10);
  });

  it("handles an empty graph and bodies without groups", () => {
    expect(new PhysicsSimulation([], [], []).settle()).toBeGreaterThanOrEqual(0);
    const simulation = new PhysicsSimulation([{ id: "x", x: 5, y: 5 }], [], []);
    simulation.settle();
    expect(simulation.positions().has("x")).toBe(true);
  });
});
