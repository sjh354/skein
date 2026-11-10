/**
 * Structural re-ranking of search candidates: Personalized PageRank over the file graph, seeded by
 * the best lexical matches, fused with the lexical rank by reciprocal rank fusion (RRF).
 *
 * The lexical score stays the primary signal; the structural rank only nudges candidates that sit
 * close to other strong matches. It is off by default until a labelled query set shows it helps
 * (see DESIGN).
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic.
 */

import type { GraphContextEdge, GraphContextNode, GraphContextRelation } from '@/shared/graph-context-types';

const DAMPING = 0.85;
const MAX_ITERATIONS = 40;
const TOLERANCE = 1e-7;
const RRF_K = 60;
/** Weight of the structural rank against the lexical one (weight 1). */
const STRUCTURAL_WEIGHT = 0.3;
/** Lexical candidates that seed the walk. */
const SEED_COUNT = 10;

/** Cross-file relations that connect files structurally; docs, tests and containment do not. */
const STRUCTURAL_RELATIONS = new Set<GraphContextRelation>(['IMPORTS', 'CALLS', 'USES', 'IMPLEMENTS', 'INHERITS']);

export interface RankedCandidate {
  node: GraphContextNode;
  score: number;
}

/** Undirected file graph from the cross-file structural edges of a snapshot. */
export function buildFileGraph(nodes: GraphContextNode[], edges: GraphContextEdge[]): Map<string, Set<string>> {
  const fileOf = new Map<string, string>();
  for (const node of nodes) {
    if (node.path) fileOf.set(node.id, node.path);
  }
  const graph = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    const neighbours = graph.get(from) ?? new Set<string>();
    neighbours.add(to);
    graph.set(from, neighbours);
  };
  for (const edge of edges) {
    if (!STRUCTURAL_RELATIONS.has(edge.relation)) continue;
    const source = fileOf.get(edge.source);
    const target = fileOf.get(edge.target);
    if (source === undefined || target === undefined || source === target) continue;
    link(source, target);
    link(target, source);
  }
  return graph;
}

/**
 * Personalized PageRank by power iteration. `seeds` maps a file to its restart weight; mass
 * that reaches a file without neighbours restarts at the seeds, so scores always sum to one.
 */
export function personalizedPageRank(graph: Map<string, Set<string>>, seeds: Map<string, number>): Map<string, number> {
  const total = [...seeds.values()].reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return new Map();
  const restart = new Map([...seeds].map(([file, weight]) => [file, weight / total]));
  let rank = new Map(restart);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const next = new Map<string, number>();
    const add = (file: string, value: number): void => {
      next.set(file, (next.get(file) ?? 0) + value);
    };
    let dangling = 0;
    for (const [file, value] of rank) {
      const neighbours = graph.get(file);
      if (neighbours === undefined || neighbours.size === 0) {
        dangling += value;
        continue;
      }
      const share = (DAMPING * value) / neighbours.size;
      for (const neighbour of neighbours) add(neighbour, share);
    }
    const teleport = (1 - DAMPING) + DAMPING * dangling;
    for (const [file, weight] of restart) add(file, teleport * weight);

    let change = 0;
    for (const [file, value] of next) change += Math.abs(value - (rank.get(file) ?? 0));
    rank = next;
    if (change < TOLERANCE) break;
  }
  return rank;
}

/**
 * Re-orders lexical candidates (best first) by fusing their rank with the rank of their file's
 * Personalized PageRank. Candidates are never added or dropped.
 */
export function rerankByStructure(
  candidates: RankedCandidate[],
  nodes: GraphContextNode[],
  edges: GraphContextEdge[],
): RankedCandidate[] {
  if (candidates.length < 2) return candidates;

  const seeds = new Map<string, number>();
  candidates.slice(0, SEED_COUNT).forEach((candidate, index) => {
    const file = candidate.node.path;
    if (file !== undefined) seeds.set(file, (seeds.get(file) ?? 0) + 1 / (index + 1));
  });
  const pageRank = personalizedPageRank(buildFileGraph(nodes, edges), seeds);
  if (pageRank.size === 0) return candidates;

  const structural = candidates
    .map((candidate, lexicalIndex) => ({
      candidate,
      lexicalIndex,
      value: candidate.node.path === undefined ? 0 : pageRank.get(candidate.node.path) ?? 0,
    }))
    .sort((left, right) => right.value - left.value || left.lexicalIndex - right.lexicalIndex);
  const structuralRank = new Map(structural.map((entry, index) => [entry.lexicalIndex, index]));

  const reordered = candidates
    .map((candidate, lexicalIndex) => ({
      candidate,
      lexicalIndex,
      fused: 1 / (RRF_K + lexicalIndex + 1) + STRUCTURAL_WEIGHT / (RRF_K + (structuralRank.get(lexicalIndex) ?? 0) + 1),
    }))
    .sort((left, right) => right.fused - left.fused || left.lexicalIndex - right.lexicalIndex)
    .map((entry) => entry.candidate);
  // Downstream ordering follows `score`, so hand the original scores out again in the new order.
  return reordered.map((candidate, index) => ({ ...candidate, score: candidates[index].score }));
}
