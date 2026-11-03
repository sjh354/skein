/**
 * The five structure diagnostics (DESIGN 7): responsibility concentration, duplicated
 * implementation, feature placement, over-abstraction and dependency problems.
 *
 * A result is `confirmed` only when a declared rule produces it (a profile rule or a rule of
 * skein.architecture.json). Everything the analysis infers is a `candidate`: the evidence is
 * shown, the verdict is left to the reader. The analysis never edits code.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ARCHITECTURE_CONFIG_FILE,
  PROFILE_RULE_PREFIX,
  checkArchitecture,
  loadArchitectureRules,
  parseArchitectureConfig,
  type ArchitectureConfig,
  type ArchitectureViolation,
  type DiagnosticBaselineEntry,
} from "../architecture/architectureRules";
import type { ArchitectureGraph } from "../architecture/ArchitectureGraphBuilder";
import { assignUnits, buildArchitectureUnits, byCodeUnit } from "../architecture/architectureUnits";
import type { ArchitectureUnits } from "../../shared/architecture-model";
import {
  DEFAULT_DIAGNOSTIC_THRESHOLDS,
  type DiagnosticArea,
  type DiagnosticBaselineState,
  type DiagnosticKind,
  type DiagnosticKindTotals,
  type DiagnosticThresholds,
  type StructureDiagnostic,
  type StructureDiagnosticsResult,
} from "../../shared/diagnostics-model";
import { normalizePath } from "../../shared/path";
import { mapWithConcurrency } from "../../shared/concurrency";

const ANALYZE_CONCURRENCY = 8;
/** Files above this are skipped by duplicate detection: the result would only add noise. */
const MAX_DUPLICATION_TOKENS_PER_FILE = 50_000;
/** A shingle in more files than this is boilerplate: the pair list would grow quadratically. */
const MAX_FILES_PER_SHINGLE = 50;

const KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "return", "class", "function", "import", "export", "const", "let", "var",
  "async", "await", "new", "throw", "try", "catch", "switch", "case", "break", "continue", "interface", "extends",
  "implements", "public", "private", "protected", "static", "final", "void", "null", "true", "false", "this", "super",
  "in", "of", "is", "as", "with", "yield", "enum", "type", "struct", "fmt", "def", "fn", "mut", "pub", "use", "mod",
]);

interface FileText {
  relativePath: string;
  text: string;
  lineCount: number;
}

interface Draft {
  id: string;
  kind: DiagnosticKind;
  status: "confirmed" | "candidate";
  title: string;
  area?: string;
  rule?: string;
  locations: StructureDiagnostic["locations"];
  evidence: StructureDiagnostic["evidence"];
  limits: string[];
  metrics: Record<string, number>;
  value: number;
  /** A rule exception already accepts this finding. */
  excepted?: string;
}

/** Thresholds of a config, with the defaults for everything it leaves out. */
export function diagnosticThresholds(config?: ArchitectureConfig): DiagnosticThresholds {
  const custom = config?.diagnostics?.thresholds;
  return {
    responsibility: { ...DEFAULT_DIAGNOSTIC_THRESHOLDS.responsibility, ...custom?.responsibility },
    duplication: { ...DEFAULT_DIAGNOSTIC_THRESHOLDS.duplication, ...custom?.duplication },
    dependency: { ...DEFAULT_DIAGNOSTIC_THRESHOLDS.dependency, ...custom?.dependency },
  };
}

function kindTotals(): DiagnosticKindTotals {
  return { confirmed: 0, candidate: 0, new: 0, worsened: 0, excepted: 0 };
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1;
  return line;
}

/** Raw line count and non-empty line count: stated as facts, never as a verdict. */
function countLines(text: string): number {
  return text.split("\n").length;
}

// ---------------------------------------------------------------------------
// Responsibility concentration
// ---------------------------------------------------------------------------

function responsibilityDiagnostics(files: readonly FileText[], graph: ArchitectureGraph, thresholds: DiagnosticThresholds): Draft[] {
  const drafts: Draft[] = [];
  const nodes = new Map(graph.nodes.map((node) => [node.relativePath, node]));
  for (const file of files) {
    const node = nodes.get(file.relativePath);
    if (node === undefined) continue;
    const ratios = [
      ["lines", file.lineCount / thresholds.responsibility.loc],
      ["imports", node.dependencyCount / thresholds.responsibility.fanOut],
      ["importers", node.dependentCount / thresholds.responsibility.fanIn],
    ] as const;
    const value = Math.max(...ratios.map(([, ratio]) => ratio));
    if (value < 1) continue;
    const triggers = ratios.filter(([, ratio]) => ratio >= 1).map(([name]) => name);
    drafts.push({
      id: `responsibility:${file.relativePath}`,
      kind: "responsibility",
      status: "candidate",
      title: `Large file with many relations (${triggers.join(", ")})`,
      locations: [{ path: file.relativePath, line: 1 }],
      evidence: [
        { label: "lines", value: file.lineCount },
        { label: "imports", value: node.dependencyCount },
        { label: "importers", value: node.dependentCount },
        { label: "thresholds", value: `${thresholds.responsibility.loc} lines, ${thresholds.responsibility.fanOut} imports, ${thresholds.responsibility.fanIn} importers` },
      ],
      limits: [
        "Size and relation counts are facts; whether the file holds several responsibilities needs a reader.",
        "Generated code and comments are not separated from code lines.",
      ],
      metrics: { lines: file.lineCount, imports: node.dependencyCount, importers: node.dependentCount },
      value: Math.round(value * 100) / 100,
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Duplicated implementation
// ---------------------------------------------------------------------------

/** Comments removed, string and number literals normalised, identifiers folded but keywords kept. */
function tokensOf(text: string): string[] {
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const raw = cleaned.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\d+(?:\.\d+)?|[A-Za-z_$][\w$]*|===|!==|=>|==|!=|<=|>=|&&|\|\||\?\?|[^\s]/g) ?? [];
  return raw.map((token) => {
    if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) return "str";
    if (/^\d/.test(token)) return "num";
    if (/^[A-Za-z_$]/.test(token)) return KEYWORDS.has(token) ? token : "id";
    return token;
  });
}

/** FNV-1a over the shingle, so the map holds numbers instead of token strings. */
function hashShingle(tokens: readonly string[], start: number, size: number): number {
  let hash = 0x811c9dc5;
  for (let index = start; index < start + size; index += 1) {
    const token = tokens[index];
    for (let cursor = 0; cursor < token.length; cursor += 1) {
      hash ^= token.charCodeAt(cursor);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function duplicationDiagnostics(files: readonly FileText[], thresholds: DiagnosticThresholds): Draft[] {
  const shingles = new Map<string, Set<number>>();
  const sizes = new Map<string, number>();
  for (const file of files) {
    const tokens = tokensOf(file.text);
    if (tokens.length < thresholds.duplication.minTokens) continue;
    if (tokens.length > MAX_DUPLICATION_TOKENS_PER_FILE) continue;
    const set = new Set<number>();
    for (let start = 0; start + thresholds.duplication.shingleSize <= tokens.length; start += 1) {
      set.add(hashShingle(tokens, start, thresholds.duplication.shingleSize));
    }
    if (set.size === 0) continue;
    shingles.set(file.relativePath, set);
    sizes.set(file.relativePath, tokens.length);
  }
  const byShingle = new Map<number, string[]>();
  for (const [file, set] of shingles) {
    for (const shingle of set) {
      const list = byShingle.get(shingle);
      if (list === undefined) byShingle.set(shingle, [file]);
      else list.push(file);
    }
  }
  const shared = new Map<string, number>();
  for (const filesOfShingle of byShingle.values()) {
    if (filesOfShingle.length < 2 || filesOfShingle.length > MAX_FILES_PER_SHINGLE) continue;
    for (let left = 0; left < filesOfShingle.length; left += 1) {
      for (let right = left + 1; right < filesOfShingle.length; right += 1) {
        const key = `${filesOfShingle[left]}\0${filesOfShingle[right]}`;
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
    }
  }
  const drafts: Draft[] = [];
  for (const [key, count] of shared) {
    const [left, right] = key.split("\0");
    const similarity = count / Math.min(shingles.get(left)!.size, shingles.get(right)!.size);
    if (similarity < thresholds.duplication.similarity) continue;
    drafts.push({
      id: `duplication:${left}|${right}`,
      kind: "duplication",
      status: "candidate",
      title: "Similar code in two files",
      locations: [{ path: left }, { path: right }],
      evidence: [
        { label: "shared token shingles", value: count },
        { label: "containment", value: `${Math.round(similarity * 100)}%` },
        { label: "tokens", value: `${sizes.get(left)} and ${sizes.get(right)}` },
        { label: "shingle size", value: thresholds.duplication.shingleSize },
      ],
      limits: [
        "Whole files are compared, so shared framework boilerplate can match.",
        "Identifier and literal normalisation only: two different features written alike still match.",
        "Line ranges of the matching blocks are not reported.",
      ],
      metrics: { sharedShingles: count, similarity: Math.round(similarity * 100) / 100 },
      value: Math.round(similarity * 100) / 100,
    });
  }
  return drafts
    .sort((left, right) => right.value - left.value || byCodeUnit(left.id, right.id))
    .slice(0, thresholds.duplication.maxResults);
}

// ---------------------------------------------------------------------------
// Feature placement
// ---------------------------------------------------------------------------

function placementDiagnostics(violations: readonly ArchitectureViolation[]): Draft[] {
  const drafts: Draft[] = [];
  for (const violation of violations) {
    if (!violation.rule.startsWith(PROFILE_RULE_PREFIX)) continue;
    const area = violation.rule.slice(PROFILE_RULE_PREFIX.length);
    drafts.push({
      id: `placement:${violation.rule}:${violation.source}>${violation.target}`,
      kind: "placement",
      status: "confirmed",
      title: `Import goes up the profile (${violation.from} → ${violation.to})`,
      area,
      rule: violation.rule,
      locations: [{ path: violation.source, line: violation.line }, { path: violation.target }],
      evidence: [
        { label: "area", value: area },
        { label: "from", value: violation.from },
        { label: "to", value: violation.to },
        ...(violation.excepted === undefined ? [] : [{ label: "exception", value: violation.excepted.reason }]),
      ],
      limits: ["Static import only: runtime wiring and dynamic imports are outside the analysis."],
      metrics: { violations: 1 },
      value: 1,
      ...(violation.excepted === undefined ? {} : { excepted: violation.excepted.reason }),
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Over-abstraction
// ---------------------------------------------------------------------------

const WRAPPER_PATTERNS = [
  /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*return\s+([A-Za-z_$][\w$.]*)\s*\([^;{}]*\)\s*;?\s*\}/g,
  /(?:export\s+)?(?:async\s+)?(?:const|let|var|final)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:return\s+)?([A-Za-z_$][\w$.]*)\s*\([^;{}]*\)\s*;?/g,
];

function abstractionDiagnostics(files: readonly FileText[]): Draft[] {
  const drafts: Draft[] = [];
  const implementations = new Map<string, number>();
  for (const file of files) {
    for (const pattern of WRAPPER_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of file.text.matchAll(pattern)) {
        const name = match[1];
        const target = match[2].split(".").at(-1) ?? match[2];
        if (target === name) continue;
        drafts.push({
          id: `abstraction:wrapper:${file.relativePath}:${name}`,
          kind: "abstraction",
          status: "candidate",
          title: `Thin wrapper ${name} delegates to ${match[2]}`,
          locations: [{ path: file.relativePath, line: lineOf(file.text, match.index ?? 0), symbol: name }],
          evidence: [
            { label: "call", value: match[2] },
            { label: "body", value: "a single call" },
          ],
          limits: [
            "Call sites and dynamic usage are not counted; this can be an intentional boundary.",
            "Only one-expression functions and arrows are recognised.",
          ],
          metrics: { delegatingCalls: 1 },
          value: 1,
        });
      }
    }
    for (const match of file.text.matchAll(/\b(?:interface|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g)) {
      implementations.set(match[1], 0);
    }
    for (const match of file.text.matchAll(/\b(?:implements|extends)\s+([A-Za-z_$][\w$]*)/g)) {
      const name = match[1];
      implementations.set(name, (implementations.get(name) ?? 0) + 1);
    }
  }
  for (const [name, count] of implementations) {
    if (count !== 1) continue;
    drafts.push({
      id: `abstraction:single-implementation:${name}`,
      kind: "abstraction",
      status: "candidate",
      title: `${name} has a single implementation`,
      locations: [{ path: "", symbol: name }],
      evidence: [{ label: "implementations or subclasses", value: count }],
      limits: ["Text matching counts `implements` and `extends`; external implementations and dependency injection are not seen."],
      metrics: { implementations: count },
      value: 1,
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Dependency problems
// ---------------------------------------------------------------------------

function dependencyDiagnostics(
  violations: readonly ArchitectureViolation[],
  units: ArchitectureUnits,
  thresholds: DiagnosticThresholds,
): Draft[] {
  const drafts: Draft[] = [];
  for (const violation of violations) {
    if (violation.rule.startsWith(PROFILE_RULE_PREFIX)) continue;
    drafts.push({
      id: `dependency:rule:${violation.rule}:${violation.source}>${violation.target}`,
      kind: "dependency",
      status: "confirmed",
      title: `Declared rule ${violation.rule} is broken`,
      rule: violation.rule,
      locations: [{ path: violation.source, line: violation.line }, { path: violation.target }],
      evidence: [
        { label: "rule", value: violation.rule },
        { label: "from", value: violation.from },
        { label: "to", value: violation.to },
        ...(violation.excepted === undefined ? [] : [{ label: "exception", value: violation.excepted.reason }]),
      ],
      limits: ["Static import only: runtime wiring and dynamic imports are outside the analysis."],
      metrics: { violations: 1 },
      value: 1,
      ...(violation.excepted === undefined ? {} : { excepted: violation.excepted.reason }),
    });
  }
  for (const edge of units.unitEdges) {
    if (edge.kind === "cycle") {
      drafts.push({
        id: `dependency:cycle:${edge.from}>${edge.to}`,
        kind: "dependency",
        status: "candidate",
        title: `Units ${edge.from} and ${edge.to} depend on each other`,
        locations: [{ path: edge.from }, { path: edge.to }],
        evidence: [{ label: "file pairs", value: edge.fileEdgeCount }],
        limits: ["File imports form the cycle; runtime-only cycles are not seen."],
        metrics: { filePairs: edge.fileEdgeCount },
        value: edge.fileEdgeCount,
      });
    } else if (edge.fileEdgeCount >= thresholds.dependency.heavyPairs) {
      drafts.push({
        id: `dependency:heavy:${edge.from}>${edge.to}`,
        kind: "dependency",
        status: "candidate",
        title: `Heavy dependency ${edge.from} → ${edge.to}`,
        locations: [{ path: edge.from }, { path: edge.to }],
        evidence: [
          { label: "file pairs", value: edge.fileEdgeCount },
          { label: "threshold", value: thresholds.dependency.heavyPairs },
        ],
        limits: ["A heavy edge is a fact; whether the dependency is unintended needs a reader."],
        metrics: { filePairs: edge.fileEdgeCount },
        value: edge.fileEdgeCount,
      });
    }
  }
  return drafts
    .sort((left, right) => right.value - left.value || byCodeUnit(left.id, right.id))
    .slice(0, thresholds.dependency.maxResults);
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function applyBaseline(
  drafts: readonly Draft[],
  baseline: readonly DiagnosticBaselineEntry[],
  exceptions: ArchitectureConfig["exceptions"],
  today: string,
) {
  const accepted = new Map(baseline.map((entry) => [entry.id, entry.value]));
  const excepted = new Map<string, string>();
  for (const exception of exceptions ?? []) {
    if (exception.diagnostic === undefined) continue;
    if (exception.until !== undefined && exception.until < today) continue;
    excepted.set(exception.diagnostic, exception.reason);
  }
  const diagnostics: StructureDiagnostic[] = drafts.map((draft) => {
    const reason = draft.excepted ?? excepted.get(draft.id);
    const acceptedValue = accepted.get(draft.id);
    const state: DiagnosticBaselineState = reason !== undefined
      ? "excepted"
      : acceptedValue === undefined
        ? "new"
        : draft.value > acceptedValue
          ? "worsened"
          : "accepted";
    return {
      ...draft,
      baseline: state,
      ...(reason === undefined ? {} : { evidence: [...draft.evidence, { label: "exception", value: reason }] }),
    };
  });
  const ids = new Set(drafts.map((draft) => draft.id));
  const resolved = baseline.filter((entry) => !ids.has(entry.id)).map((entry) => ({ ...entry }))
    .sort((left, right) => byCodeUnit(left.id, right.id));
  return { diagnostics, resolved };
}

/**
 * Runs all five diagnostics on a built graph. Without a config the defaults apply; a config the
 * parser refuses is thrown, so the caller can say the check did not run instead of passing it.
 */
export async function runWorkspaceDiagnostics(
  graph: ArchitectureGraph,
  workspaceRoot: string,
  options: { signal?: AbortSignal; now?: Date } = {},
): Promise<StructureDiagnosticsResult> {
  const { signal, now = new Date() } = options;
  const hasConfig = fsSync.existsSync(path.join(workspaceRoot, ARCHITECTURE_CONFIG_FILE));
  const loaded = hasConfig
    ? await loadArchitectureRules(workspaceRoot)
    : { configFile: ARCHITECTURE_CONFIG_FILE, config: parseArchitectureConfig("{}"), baseline: undefined, diagnosticBaseline: undefined };
  const { config } = loaded;
  const thresholds = diagnosticThresholds(config);
  const assignment = assignUnits(workspaceRoot, graph.nodes.map((node) => node.relativePath));
  const architectureUnits = buildArchitectureUnits(graph, workspaceRoot, assignment, config.roles);
  const roleOf = new Map(architectureUnits.units.map((unit) => [unit.key, unit.role]));
  const check = checkArchitecture(graph, assignment, config, loaded.baseline, roleOf, now);
  const relativePaths = graph.nodes.map((node) => node.relativePath);
  const files = (await mapWithConcurrency(relativePaths, ANALYZE_CONCURRENCY, async (relativePath): Promise<FileText | undefined> => {
    signal?.throwIfAborted();
    try {
      const text = await fs.readFile(path.join(workspaceRoot, relativePath), "utf8");
      return { relativePath: normalizePath(relativePath), text, lineCount: countLines(text) };
    } catch {
      return undefined;
    }
  })).filter((file): file is FileText => file !== undefined);
  signal?.throwIfAborted();

  const drafts = [
    ...responsibilityDiagnostics(files, graph, thresholds),
    ...duplicationDiagnostics(files, thresholds),
    ...placementDiagnostics(check.violations),
    ...abstractionDiagnostics(files),
    ...dependencyDiagnostics(check.violations, architectureUnits, thresholds),
  ];
  const { diagnostics, resolved } = applyBaseline(drafts, loaded.diagnosticBaseline ?? [], config.exceptions, now.toISOString().slice(0, 10));
  diagnostics.sort((left, right) => byCodeUnit(left.kind, right.kind) || right.value - left.value || byCodeUnit(left.id, right.id));

  const totals = {
    ...kindTotals(),
    ...Object.fromEntries((["responsibility", "duplication", "placement", "abstraction", "dependency"] as const)
      .map((kind) => [kind, kindTotals()])),
  } as StructureDiagnosticsResult["totals"];
  for (const diagnostic of diagnostics) {
    const perKind = totals[diagnostic.kind];
    perKind[diagnostic.status] += 1;
    if (diagnostic.baseline === "new") perKind.new += 1;
    if (diagnostic.baseline === "worsened") perKind.worsened += 1;
    if (diagnostic.baseline === "excepted") perKind.excepted += 1;
    totals[diagnostic.status] += 1;
    if (diagnostic.baseline === "new") totals.new += 1;
    if (diagnostic.baseline === "worsened") totals.worsened += 1;
    if (diagnostic.baseline === "excepted") totals.excepted += 1;
  }
  const areas: DiagnosticArea[] = Object.entries(config.areas ?? {}).map(([name, area]) => ({
    name,
    path: (Array.isArray(area.path) ? area.path : [area.path]).map(String),
    profile: area.profile,
    strict: area.strict === true,
  }));
  const revision = createHash("sha256")
    .update(JSON.stringify([check.context.revision, thresholds, diagnostics.map((diagnostic) => diagnostic.id)]))
    .digest("hex");
  return {
    revision,
    thresholds,
    areas,
    profiles: Object.fromEntries(Object.entries(config.profiles ?? {}).map(([name, profile]) => [name, { layers: profile.layers }])),
    exceptions: (config.exceptions ?? []).length,
    diagnostics,
    totals,
    resolved,
    limits: [
      "Static analysis only: runtime wiring, reflection, generated code and semantic responsibility need a reader.",
      "Candidates are never treated as confirmed violations or used to block a change.",
      "Duplicate detection compares whole files and ignores token shingles shared by more than 50 files as boilerplate.",
      check.context.baseline ? "Violations are compared with the baseline." : "No baseline file: every rule violation is new.",
    ],
  };
}

/** Cursor-style paging of a result, as the other architecture views page theirs. */
export function exploreDiagnostics(
  result: StructureDiagnosticsResult,
  options: { kind?: DiagnosticKind; status?: "confirmed" | "candidate"; area?: string; offset?: number; limit?: number; revision?: string } = {},
) {
  if (options.revision !== undefined && options.revision !== result.revision) {
    throw new Error(
      `Diagnostics changed (revision ${options.revision} -> ${result.revision}): pages from earlier responses no longer apply. ` +
      "Restart without offset or revision.",
    );
  }
  const shown = result.diagnostics.filter((diagnostic) =>
    (options.kind === undefined || diagnostic.kind === options.kind)
    && (options.status === undefined || diagnostic.status === options.status)
    && (options.area === undefined || diagnostic.area === options.area));
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  const items = shown.slice(offset, offset + limit);
  const nextOffset = offset + items.length < shown.length ? offset + items.length : undefined;
  const { diagnostics: _diagnostics, ...rest } = result;
  return {
    ...rest,
    diagnostics: items,
    page: { total: shown.length, offset, returned: items.length, truncated: nextOffset !== undefined, nextOffset, limit },
  };
}

export type StructureDiagnosticsPage = ReturnType<typeof exploreDiagnostics>;
