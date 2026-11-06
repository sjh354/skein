/**
 * Physics (force-directed) layout of the call graph with compound groups.
 *
 * Leaf nodes are bodies. Edges are springs, every pair of bodies repels, and the folder/file
 * groups that wrap the nodes (compound nodes) act as part of the simulation:
 *   - a body is pulled toward the centroid of its file group and, more weakly, of its folder groups,
 *   - sibling groups push each other apart so their boxes do not overlap.
 * Cytoscape derives a compound's box from its children, so only the bodies are simulated.
 *
 * The simulation cools like d3-force (`alpha` decays toward zero) and can be reheated, so dragging a
 * node lets its neighbours follow and settle again. It is deterministic: no randomness anywhere.
 *
 * NO @/ path aliases — webview uses relative imports. No cytoscape or DOM dependency.
 */

export interface PhysicsBody {
  id: string;
  /** File compound the node sits in; groups may nest through `PhysicsGroup.parent`. */
  group?: string;
  x: number;
  y: number;
}

export interface PhysicsLink {
  source: string;
  target: string;
}

export interface PhysicsGroup {
  id: string;
  parent?: string;
}

interface Body extends PhysicsBody {
  vx: number;
  vy: number;
  fixed: boolean;
  /** Group chain, own group first, outermost last. */
  chain: string[];
}

interface GroupState {
  id: string;
  parent?: string;
  members: Body[];
  cx: number;
  cy: number;
  radius: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Repulsion strength between bodies (force ~ k / distance). */
const REPULSION = 3500;
/** Beyond this distance bodies no longer repel; keeps distant clusters independent and ticks cheap. */
const REPULSION_RANGE = 700;
const MIN_DISTANCE = 12;
/** Rest length of a call edge inside one file and between files. */
const LINK_LENGTH_SAME_GROUP = 90;
const LINK_LENGTH_CROSS_GROUP = 210;
const LINK_STRENGTH = 0.4;
/** Pull toward the centroid of the own file group and of each outer folder group. */
const COHESION_OWN_GROUP = 0.2;
const COHESION_OUTER_GROUP = 0.03;
/** Footprint of a group: radius per sqrt(member count), plus padding. */
const GROUP_RADIUS_UNIT = 38;
const GROUP_PADDING = 40;
const GROUP_SEPARATION = 0.5;
/** Weak pull to the origin so detached clusters do not drift away. */
const GRAVITY = 0.04;
const VELOCITY_DECAY = 0.45;
const MAX_STEP = 60;
const ALPHA_DECAY = 0.0228;
export const ALPHA_MIN = 0.001;

export class PhysicsSimulation {
  alpha = 1;
  private readonly bodies: Body[];
  private readonly byId = new Map<string, Body>();
  private readonly links: Array<{ source: Body; target: Body; length: number }>;
  private readonly groups: GroupState[];

  constructor(bodies: PhysicsBody[], links: PhysicsLink[], groups: PhysicsGroup[]) {
    const parentOf = new Map(groups.map((group) => [group.id, group.parent]));
    const chainOf = (start: string | undefined): string[] => {
      const chain: string[] = [];
      const seen = new Set<string>();
      for (let id = start; id !== undefined && parentOf.has(id) && !seen.has(id); id = parentOf.get(id)) {
        seen.add(id);
        chain.push(id);
      }
      return chain;
    };

    this.bodies = bodies.map((body) => ({ ...body, vx: 0, vy: 0, fixed: false, chain: chainOf(body.group) }));
    for (const body of this.bodies) this.byId.set(body.id, body);

    this.links = links.flatMap((link) => {
      const source = this.byId.get(link.source);
      const target = this.byId.get(link.target);
      if (!source || !target || source === target) return [];
      const sameGroup = source.chain.length > 0 && source.chain[0] === target.chain[0];
      return [{ source, target, length: sameGroup ? LINK_LENGTH_SAME_GROUP : LINK_LENGTH_CROSS_GROUP }];
    });

    const states = new Map<string, GroupState>();
    for (const group of groups) {
      states.set(group.id, { id: group.id, parent: group.parent, members: [], cx: 0, cy: 0, radius: 0 });
    }
    for (const body of this.bodies) {
      for (const id of body.chain) states.get(id)?.members.push(body);
    }
    // Groups without bodies (all members hidden) take no part.
    this.groups = [...states.values()].filter((group) => group.members.length > 0);
  }

  /** Current position of every body. */
  positions(): Map<string, { x: number; y: number }> {
    return new Map(this.bodies.map((body) => [body.id, { x: body.x, y: body.y }]));
  }

  /** Holds a body at a position (a node under the pointer); the others keep reacting to it. */
  pin(id: string, x: number, y: number): void {
    const body = this.byId.get(id);
    if (!body) return;
    body.fixed = true;
    body.x = x;
    body.y = y;
    body.vx = 0;
    body.vy = 0;
  }

  release(id: string): void {
    const body = this.byId.get(id);
    if (body) body.fixed = false;
  }

  /** Restarts cooling from at least `alpha`, so a moved node lets its neighbours follow. */
  reheat(alpha = 0.3): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  get settled(): boolean {
    return this.alpha < ALPHA_MIN;
  }

  /** Advances one tick. */
  step(): void {
    const alpha = this.alpha;
    this.refreshGroups();
    this.repel(alpha);
    this.pull(alpha);
    this.cohere(alpha);
    this.separate(alpha);
    this.integrate(alpha);
    this.alpha += (0 - this.alpha) * ALPHA_DECAY;
  }

  /** Runs until cooled or `maxTicks`; returns the ticks used. */
  settle(maxTicks = 300): number {
    let ticks = 0;
    while (!this.settled && ticks < maxTicks) {
      this.step();
      ticks += 1;
    }
    return ticks;
  }

  private refreshGroups(): void {
    for (const group of this.groups) {
      let sx = 0;
      let sy = 0;
      for (const member of group.members) {
        sx += member.x;
        sy += member.y;
      }
      group.cx = sx / group.members.length;
      group.cy = sy / group.members.length;
      group.radius = GROUP_RADIUS_UNIT * Math.sqrt(group.members.length) + GROUP_PADDING;
    }
  }

  private repel(alpha: number): void {
    const bodies = this.bodies;
    const rangeSquared = REPULSION_RANGE * REPULSION_RANGE;
    for (let i = 0; i < bodies.length; i += 1) {
      const a = bodies[i];
      for (let j = i + 1; j < bodies.length; j += 1) {
        const b = bodies[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > rangeSquared) continue;
        if (distanceSquared < 1) {
          // Coincident bodies: separate them along a fixed, index-based direction.
          const angle = (i + 1) * GOLDEN_ANGLE;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distanceSquared = 1;
        }
        const distance = Math.sqrt(distanceSquared);
        const magnitude = (REPULSION * alpha) / Math.max(distance, MIN_DISTANCE);
        const fx = (dx / distance) * magnitude;
        const fy = (dy / distance) * magnitude;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
  }

  private pull(alpha: number): void {
    for (const { source, target, length } of this.links) {
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const correction = ((distance - length) / distance) * LINK_STRENGTH * alpha;
      const fx = dx * correction * 0.5;
      const fy = dy * correction * 0.5;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    }
  }

  private cohere(alpha: number): void {
    const byId = new Map(this.groups.map((group) => [group.id, group]));
    for (const body of this.bodies) {
      body.chain.forEach((id, level) => {
        const group = byId.get(id);
        if (!group) return;
        const strength = (level === 0 ? COHESION_OWN_GROUP : COHESION_OUTER_GROUP) * alpha;
        body.vx += (group.cx - body.x) * strength;
        body.vy += (group.cy - body.y) * strength;
      });
    }
  }

  /** Sibling groups (same parent) must not overlap: push their members apart along the centroid line. */
  private separate(alpha: number): void {
    const groups = this.groups;
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const a = groups[i];
        const b = groups[j];
        if (a.parent !== b.parent) continue;
        let dx = b.cx - a.cx;
        let dy = b.cy - a.cy;
        let distance = Math.hypot(dx, dy);
        if (distance < 1) {
          const angle = (i + 1) * GOLDEN_ANGLE;
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        const overlap = a.radius + b.radius - distance;
        if (overlap <= 0) continue;
        const push = overlap * GROUP_SEPARATION * alpha;
        const ux = dx / distance;
        const uy = dy / distance;
        for (const member of a.members) {
          member.vx -= ux * push;
          member.vy -= uy * push;
        }
        for (const member of b.members) {
          member.vx += ux * push;
          member.vy += uy * push;
        }
      }
    }
  }

  private integrate(alpha: number): void {
    for (const body of this.bodies) {
      if (body.fixed) {
        body.vx = 0;
        body.vy = 0;
        continue;
      }
      body.vx -= body.x * GRAVITY * alpha;
      body.vy -= body.y * GRAVITY * alpha;
      body.vx *= 1 - VELOCITY_DECAY;
      body.vy *= 1 - VELOCITY_DECAY;
      const speed = Math.hypot(body.vx, body.vy);
      if (speed > MAX_STEP) {
        body.vx = (body.vx / speed) * MAX_STEP;
        body.vy = (body.vy / speed) * MAX_STEP;
      }
      body.x += body.vx;
      body.y += body.vy;
    }
  }
}

/**
 * Deterministic starting positions: groups on a phyllotaxis spiral, the members of a group on a small
 * spiral around their group's centre. Bodies outside any group count as groups of one.
 */
export function seedPositions(bodies: Array<Pick<PhysicsBody, 'id' | 'group'>>): Map<string, { x: number; y: number }> {
  const members = new Map<string, string[]>();
  for (const body of bodies) {
    const key = body.group ?? `\u0000${body.id}`;
    members.set(key, [...(members.get(key) ?? []), body.id]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  [...members.keys()].sort().forEach((key, groupIndex) => {
    const radius = 160 * Math.sqrt(groupIndex);
    const angle = groupIndex * GOLDEN_ANGLE;
    const cx = Math.cos(angle) * radius;
    const cy = Math.sin(angle) * radius;
    members.get(key)!.forEach((id, index) => {
      const spread = 45 * Math.sqrt(index);
      positions.set(id, {
        x: cx + Math.cos(index * GOLDEN_ANGLE) * spread,
        y: cy + Math.sin(index * GOLDEN_ANGLE) * spread,
      });
    });
  });
  return positions;
}
