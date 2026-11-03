/**
 * Tool descriptions - single source of truth for the MCP server, the
 * tool summaries and the VS Code Language Model tool
 * `modelDescription` fields in package.json.
 *
 * Each description is a one-sentence summary followed by labelled lines.
 * A plain string line is shared by every surface. A `{ mcp, lm }` line differs
 * per surface because the LM tools are implemented separately
 * (src/extension/services/LmToolsService.ts) with smaller input schemas and no
 * tokenBudget paging; a surface whose key is absent omits the line.
 *
 * MCP and LM tools share the `skein_` name prefix.
 *
 * package.json is regenerated with `npm run sync:tool-descriptions`;
 * tests/mcp/toolDescriptions.test.ts fails when it drifts.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { McpToolName } from "./types";

type DescriptionLine = string | { mcp?: string; lm?: string };

interface ToolDescription {
  summary: string;
  lines: DescriptionLine[];
}

/** VS Code Language Model tools with no MCP or CLI counterpart since v1.20.0. */
type LmOnlyToolName =
  | "get_symbol_callers"
  | "get_symbol_dependents"
  | "parse_imports"
  | "expand_node"
  | "analyze_file_logic";

/** MCP-only tools for the shared graph view (no LM or CLI counterpart). */
type McpViewToolName = "get_view_state" | "control_view";

/** MCP-only tools for the common change path (step 5). */
type McpChangeToolName =
  | "plan_change"
  | "apply_change"
  | "get_change_plan"
  | "list_change_history"
  | "undo_change"
  | "redo_change";

export type DescribedToolName =
  | McpToolName
  | "get_session_stats"
  | McpViewToolName
  | McpChangeToolName
  | LmOnlyToolName;

const OPEN_ENDED_HINT =
  "For an open-ended question, start with skein_graph_context and come here when you need this specific cut.";
const TOKEN_BUDGET_LIMIT =
  "output capped by tokenBudget (default 4000, 0 = no limit); a cut sets truncated=true, omitted counts and nextOffset - pass it as offset to read the rest.";
const LM_CALL_GRAPH_INDEX =
  "needs the call graph index, built in the background when the Skein view first loads (skein.preIndexCallGraph) or when the Call Graph panel opens; until then the tool returns an error.";

const TOOL_DESCRIPTIONS: Record<DescribedToolName, ToolDescription> = {
  set_workspace: {
    summary: "Points this server session at the project root the other tools analyse.",
    lines: [
      "WHEN: once per session, as setup before the first analysis. The root resolved at startup comes from WORKSPACE_ROOT or the working directory the client happened to spawn the server in, so it is often absent or points at the wrong project. Call this again during a session only to switch projects, or to reach a path outside the current root (paths outside it are rejected).",
      "NOT THIS TOOL: it is setup, and answers no question about code. It is never the reply to a question about architecture, callers, dependencies, dead code or documentation - once the root is set, call the tool that answers the question. One call holds for the whole session; repeating it re-indexes for nothing.",
      "RETURNS: workspace name (the path itself is reported relative to the new root), previous workspace, number of files indexed, indexing duration.",
    ],
  },
  graph_context: {
    summary:
      "Returns a token-bounded subgraph answering a question about the codebase - the default entry point for graph questions.",
    lines: [
      "WHEN: any question spanning file dependencies, symbol calls, implementations, tests or impact; reach for a specialised tool only when this cannot express the cut you need.",
      "WHY: one deterministic gateway over the same index the specialised tools use, with an explicit token budget so large graphs come back bounded instead of truncated arbitrarily.",
      "MODES: search, neighbors, path, impact, refactor, overview.",
      "RETURNS: nodes and edges with workspace-relative paths, an index revision and a freshness flag, and a cursor when results are paginated.",
      { lm: `LIMITS: ${LM_CALL_GRAPH_INDEX}` },
    ],
  },
  analyze_dependencies: {
    summary:
      "Lists the import/export statements of one file, with each specifier resolved to a path on disk.",
    lines: [
      `WHEN: "what does this file import", "what are this file's dependencies".`,
      "WHY: read from the parsed source, so tsconfig path aliases, implicit extensions and index files are already resolved.",
      {
        mcp: "RETURNS: per statement - module specifier, resolved absolute path, workspace-relative path, import type (import, require, export, dynamic, side-effect), line number.",
        lm: "RETURNS: one entry per resolved workspace file - module specifier, workspace-relative path, import type (import, require, export, dynamic, side-effect), line number. Unresolved and external imports are left out.",
      },
      "SUPPORTS: TypeScript, JavaScript, Vue, Svelte, GraphQL.",
    ],
  },
  crawl_dependency_graph: {
    summary: "Builds the transitive file dependency graph reachable from one entry file.",
    lines: [
      {
        mcp: "WHEN: project architecture, full dependency tree from an entry point, circular-import detection.",
        lm: "WHEN: project architecture, full dependency tree from an entry point.",
      },
      "WHY: crawls real import edges across the workspace rather than inferring structure from file names.",
      {
        mcp: "RETURNS: nodes (path, extension, dependency count, dependent count, circular flag, communityId/communityKey: by folder, or by import structure with communityMode 'louvain') and edges (import relations); paginated via offset/limit.",
        lm: "RETURNS: nodes (workspace-relative path) and edges (import relations, source and target). maxDepth defaults to the configured skein.maxDepth, else 3.",
      },
      { mcp: `LIMITS: ${TOKEN_BUDGET_LIMIT}` },
      OPEN_ENDED_HINT,
    ],
  },
  find_referencing_files: {
    summary:
      "Lists every file that imports or references a given file (reverse dependency lookup).",
    lines: [
      `WHEN: impact analysis, "who uses this file", refactoring-safety checks before changing or deleting a file.`,
      "WHY: served from a prebuilt reverse index, so it covers the whole workspace rather than the files already in context.",
      {
        mcp: "RETURNS: absolute and workspace-relative path of each referencing file.",
        lm: "RETURNS: workspace-relative path, import type, line and module specifier of each referencing file.",
      },
      "BARRELS: files that import the target's exports through re-export barrels (export { x } from, export *, chained) are listed after the direct importers, with via = the barrel they import.",
      OPEN_ENDED_HINT,
    ],
  },
  expand_node: {
    summary:
      "Returns the dependencies of one file that are not already in a set of paths you provide.",
    lines: [
      "WHEN: exploring a large graph incrementally, or lazily loading one node at a time.",
      "WHY: crawls the file's transitive dependencies and drops what you already hold, so only newly discovered files come back.",
      "RETURNS: the new nodes and edges only, with the same fields as crawl_dependency_graph.",
    ],
  },
  parse_imports: {
    summary: "Returns the import statements of one file: module specifier, import type and line.",
    lines: [
      "WHEN: inspecting import style or alias usage, without the resolved paths.",
      "WHY: uses the language-aware parser pipeline, so it is more accurate than a text search.",
      "RETURNS: module specifier as written, import type, line number.",
      "LIMITS: lists only imports that resolve to a workspace file, once per file - use skein_resolve_module_path to debug one that does not.",
    ],
  },
  verify_dependency_usage: {
    summary: "Reports whether a source file actually uses any symbol from a target file it imports.",
    lines: [
      "WHEN: identifying unused imports, or confirming a dependency edge is real before acting on it.",
      "WHY: AST analysis of actual references, so an import that is never used is distinguished from one that is.",
      "RETURNS: boolean.",
    ],
  },
  resolve_module_path: {
    summary: "Resolves one module specifier, as seen from a given file, to a path on disk.",
    lines: [
      `WHEN: "where does this import point", or debugging alias and extension resolution.`,
      "WHY: applies tsconfig path aliases, implicit extensions (.ts, .tsx, .js, .jsx, .vue, .svelte, .gql) and index-file resolution.",
      {
        mcp: "RETURNS: resolved absolute path and whether it lies inside the workspace, or null for an unresolvable or external module.",
        lm: "RETURNS: whether resolution succeeded and the resolved workspace-relative path.",
      },
    ],
  },
  get_index_status: {
    summary: "Reports the state of the dependency index backing the other tools.",
    lines: [
      "WHEN: checking readiness before a large analysis, or explaining unexpectedly empty or incomplete results.",
      `WHY: distinguishes "no results" from "index not built yet", and tells whether imports were skipped because they resolve outside the workspace root (a monorepo sub-package misses its sibling packages).`,
      {
        mcp: "RETURNS: index state, files indexed, reverse-index statistics, cache size and hit rate, warmup completion and duration, cacheFiles (on-disk bytes of the cached reverse index and call graph), and outOfRootImports (with examples, the relative monorepoRoot and a warning when above 0).",
        lm: "RETURNS: index state, readiness flag, whether the reverse index exists, cache size, reverse-index statistics (files indexed included), cacheFiles (on-disk bytes of the cached reverse index and call graph), and outOfRootImports (with examples, the relative monorepoRoot and a warning when above 0).",
      },
    ],
  },
  invalidate_files: {
    summary: "Drops the cached analysis for specific files so the next query re-reads them.",
    lines: [
      {
        mcp: "WHEN: after editing files outside the watched workspace, when results look stale.",
        lm: "WHEN: results look stale after edits the file watcher missed. Paths must lie inside an open workspace folder.",
      },
      "WHY: analysis is cached per file; the cache is otherwise refreshed by the file watcher.",
      {
        mcp: "RETURNS: how many files were invalidated, which were cleared, and which held no cache entry. The call graph re-extracts these files on the next graph query.",
        lm: "RETURNS: how many files were invalidated, which were cleared, and which held no cache entry.",
      },
    ],
  },
  rebuild_index: {
    summary: "Clears all cached analysis and re-indexes the whole workspace.",
    lines: [
      "WHEN: after a branch switch or large refactor when the index no longer matches the tree; invalidate_files is enough for a few files.",
      "WHY: restores a graph that is consistent with what is on disk.",
      {
        mcp: "RETURNS: files re-indexed, duration, new cache size, reverse-index statistics, and the call graph rebuilt from scratch (files, symbols, relations) or why it could not be.",
        lm: "RETURNS: rebuild duration and new cache size.",
      },
      "LIMITS: takes seconds on a large workspace.",
    ],
  },
  get_symbol_graph: {
    summary:
      "Lists the symbols a file exports and the symbols OUTSIDE the file that each of them depends on.",
    lines: [
      `WHEN: "which function in this file calls the database / uses X", scoping a refactor to one symbol rather than the whole file.`,
      "WHY: ts-morph AST parsing, so import aliases are tracked back to their original names and type-only imports are separated from runtime ones.",
      {
        mcp: "RETURNS: exported symbols (name, kind, line, category) and symbol-to-symbol edges tagged runtime or type-only.",
        lm: "RETURNS: every symbol of the file (name, kind, line, category, internal ones included) and symbol-to-symbol edges tagged runtime or type-only.",
      },
      "NOT THIS TOOL: for calls between symbols defined in the same file, use skein_generate_codemap (its call flow section). This tool crosses the file boundary outward; that one stays inside it.",
      OPEN_ENDED_HINT,
    ],
  },
  find_unused_symbols: {
    summary: "Lists the symbols a file exports that nothing else in the workspace imports.",
    lines: [
      "WHEN: dead-code cleanup in one file, or checking which parts of an API are consumed.",
      "WHY: cross-references the file's exports against the reverse index, then widens the used set through the file's internal call graph so a symbol reached only indirectly is not reported.",
      "RETURNS: unused exported symbols (name, kind, line, category), unused and total counts, unused percentage.",
      "LIMITS: an export reached only through a dynamic or string-keyed lookup can still be reported as unused; confirm before deleting.",
    ],
  },
  get_symbol_dependents: {
    summary:
      "Lists the symbols that use one given symbol - one hop, computed from source at call time.",
    lines: [
      "WHEN: changing a signature and needing every call site, or assessing the blast radius of a symbol-level change.",
      "WHY: walks the symbol graphs of every file that references the target, so file-level imports count as well as calls.",
      "RETURNS: caller symbol id, file path and workspace-relative path per dependent, plus a total count.",
      "PICKING BETWEEN THE THREE: this one for every reference, including file-level imports, computed fresh; skein_get_symbol_callers for call sites only; skein_query_call_graph for multi-hop traversal, callees, or relation types.",
    ],
  },
  trace_function_execution: {
    summary: "Follows the call chain outward from one symbol, recursively, across files.",
    lines: [
      "WHEN: tracing a request through controller, service and repository, or mapping what a feature actually reaches.",
      "WHY: follows calls through multiple files instead of stopping at direct dependencies; stops at external modules, at maxDepth, or on a cycle.",
      "RETURNS: root symbol, call chain entries (depth, caller, callee, resolved path), visited symbols, and whether maxDepth was hit.",
      OPEN_ENDED_HINT,
    ],
  },
  get_symbol_callers: {
    summary: "Lists the call sites of one given symbol - one hop, from the call graph index.",
    lines: [
      `WHEN: the plain question "who calls X"; finding call sites before a rename; spotting a symbol with no callers.`,
      "WHY: reads CALLS edges from the indexed call graph, so it returns only symbols that call X. File-level imports and other references are not callers; use skein_get_symbol_dependents for those.",
      "RETURNS: one entry per caller symbol with workspace-relative path, line of the first call and a type-only flag, plus runtime and type-only counts. Type-only references are added only with includeTypeOnly. The source field says whether the call graph or the symbol dependents fallback answered (the call graph is used once indexed; line is null in the fallback).",
      "PICKING BETWEEN THE THREE: this one for call sites; skein_get_symbol_dependents for every reference (imports included) computed fresh from source; skein_query_call_graph when you need more than one hop, callees as well as callers, or relation types such as INHERITS and IMPLEMENTS.",
    ],
  },
  analyze_breaking_changes: {
    summary: "Compares two versions of a file and reports which signature changes break callers.",
    lines: [
      "WHEN: validating an edit before committing, or writing migration notes for an API change.",
      "WHY: diffs the parsed signatures rather than the text, so added optional parameters are separated from breaking ones.",
      {
        mcp: "RETURNS: breaking changes with kind and description, severity, suggested migration steps, and the callers that need updating.",
        lm: "RETURNS: breaking changes (type, symbol, description, severity, old and new value, line) and non-breaking changes. Without newContent the current file on disk is used.",
      },
      {
        mcp: "DETECTS: added required parameter, removed parameter, changed parameter type, changed return type, parameter reordering.",
        lm: "DETECTS: added required parameter, removed parameter, changed parameter or return type, optional made required, reduced visibility, removed or changed interface member, changed type alias.",
      },
      "INPUT: oldContent must be the full previous file content, not a placeholder. With symbolName, an unknown symbol returns an error listing close name matches, a symbol missing from a non-empty oldContent that declares nothing returns an error, and a symbol new in newContent is reported as a non-breaking change.",
    ],
  },
  get_impact_analysis: {
    summary: "Reports everything affected by changing one symbol, direct and transitive.",
    lines: [
      "WHEN: assessing a refactor before starting it, or prioritising which call sites to update first.",
      "WHY: walks the symbol reverse index outward, keeping runtime and type-only impact separate and aggregating per file.",
      {
        mcp: "RETURNS: impact level (high, medium, low), total impact count, runtime versus type-only breakdown, impacted symbols with depth (1 = direct), affected files, and a written summary. An unknown symbol returns an error listing close name matches.",
        lm: "RETURNS: impact level (high, medium, low), total impact count, runtime versus type-only breakdown, impacted symbols with depth (1 = direct) and affected files. Transitive impact only with includeTransitive. An unknown symbol returns an error listing close name matches.",
      },
      OPEN_ENDED_HINT,
    ],
  },
  analyze_file_logic: {
    summary:
      "Returns the call hierarchy among the symbols defined INSIDE one file, ignoring anything it imports.",
    lines: [
      "WHEN: understanding how a file works internally, or spotting recursion before a refactor.",
      "WHY: built from the file's AST, so no language server is needed. Calls are matched by name within the file.",
      "RETURNS: nodes (symbol id, LSP SymbolKind number, type, export status, start/end line range), call edges with call-site line numbers, and cycle detection with the symbols involved.",
      "NOT THIS TOOL: for what this file's symbols reach in OTHER files, use skein_get_symbol_graph.",
      "SUPPORTS: TypeScript, JavaScript, Python, Rust.",
      OPEN_ENDED_HINT,
    ],
  },
  generate_codemap: {
    summary:
      "Returns one file's exports, internals, dependencies, dependents and internal call flow in a single call.",
    lines: [
      "WHEN: getting oriented in an unfamiliar file, or gathering the full context of a file before refactoring it.",
      "WHY: one call in place of analyze_dependencies, get_symbol_graph and find_referencing_files together, plus the calls between the file's own symbols.",
      "RETURNS: path, language, line count, exported and internal symbols, dependencies, dependents, intra-file call flow, cycle detection.",
      "SUPPORTS: TypeScript, JavaScript, Python, Rust, Vue, Svelte.",
    ],
  },
  query_call_graph: {
    summary:
      "Traces calls across files for several hops, in either direction, from a SQLite-backed call graph.",
    lines: [
      `WHEN: "who calls X" (direction=callers, depth=1), "what does X call" (direction=callees), multi-hop traversal ("three levels deep"), or cycle detection across modules.`,
      {
        mcp: "WHY: built from tree-sitter AST analysis, so it holds real call edges (CALLS, INHERITS, IMPLEMENTS) rather than import edges. Type-only references (USES) are added with includeTypeOnly.",
        lm: "WHY: built from tree-sitter AST analysis, so it holds real call edges (CALLS, INHERITS, IMPLEMENTS) and type-only references (USES) rather than import edges. Every relation type is returned unless relationTypes narrows it.",
      },
      {
        mcp: "RETURNS: the matched symbol, its callers and callees with file and line, relation type, and a cyclic flag per edge.",
        lm: "RETURNS: the matched symbol, its callers and callees with file and call-site line, relation type, and a cyclic flag per edge. Defaults: direction=both, depth=2.",
      },
      "SELECTING: two same-name methods in one file return reason=ambiguous with candidates; pass one candidate's symbolId or startLine to select it exactly. A stale selector returns reason=stale_selector (ids embed the line and change after edits); 'Class.method' names are not supported.",
      "NOT THIS TOOL: for every file that imports a file, use skein_find_referencing_files.",
      {
        mcp: `LIMITS: the first call indexes the workspace (3-8s); later queries are fast. Output capped by tokenBudget (default 4000, 0 = no limit); a cut sets truncated=true, omitted counts and nextOffset - pass it as offset to read the rest.`,
        lm: `LIMITS: ${LM_CALL_GRAPH_INDEX}`,
      },
    ],
  },
  scan_dead_code: {
    summary: "Lists the unused exported symbols across a whole workspace or directory.",
    lines: [
      "WHEN: auditing code quality, or cleaning up before a refactor; use find_unused_symbols for a single file.",
      "WHY: combines the reverse index with per-file symbol analysis, so the scan stays linear instead of comparing every file against every other.",
      "RETURNS: files scanned, files holding dead code, total unused symbols, per-file unused symbol lists, scan duration, and truncated with filesBeyondLimit when maxFiles stopped the scan.",
      {
        mcp: "LIMITS: needs background indexing to have finished; an export reached only through a dynamic lookup can still be listed.",
        lm: "LIMITS: scopePath must be an absolute path inside the workspace; results are incomplete while background indexing runs; an export reached only through a dynamic lookup can still be listed.",
      },
    ],
  },
  query_natural_language: {
    summary:
      "Returns the subgraph relevant to a plain-language question, for you to turn into an answer.",
    lines: [
      "WHEN: exploring a codebase from a concept rather than a known file or symbol name.",
      "WHY: extracts keywords, scores seed nodes with full-text search over the call graph index, then traverses outward from them.",
      "RETURNS: the question, the extracted keywords, the subgraph, and timing and truncation metadata.",
      {
        mcp: "LIMITS: returns graph data, not prose - you write the answer from it. The first call indexes the workspace (3-8s).",
        lm: `LIMITS: returns graph data, not prose - you write the answer from it; ${LM_CALL_GRAPH_INDEX}`,
      },
    ],
  },
  explore_architecture: {
    summary:
      "Explores the workspace architecture step by step: groups, one group's boundary, then the file pairs behind a group edge.",
    lines: [
      `WHEN: "how is this project structured", "what depends on the analyzer layer", "why does group A import group B".`,
      "WHY: aggregates the whole import graph by folder domain (communityMode 'path') or import structure ('louvain') before any paging, so counts match `skein_explore_architecture` at the group level and every group edge is backed by its file pairs.",
      "RETURNS: no group/from/to - totals, unassigned files, the largest groups and group edges; group (a number is an id, a string a key or label) - its files and incoming / outgoing group edges; from + to - the distinct file pairs of that edge; level 'units' - packages (else top-level folders) with their layer (0 = depends on no other unit), role (function, micro-frontend, frontend, service, library, tooling, unknown) with its confidence (inferred, or declared in skein.architecture.json) and evidence, roleCounts, layerCount, unit edges flagged down, upward or cycle, and the cycle count; level 'units' + from + to (unit keys, e.g. 'apps/web', '(root)') - the file pairs of that unit edge, sorted by target then source, total = the edge's file-pair count; folder (a unit key, or a group key of a folder level, path mode) - the same views one level down: its sub-folders and own files as groups, nestedGroups those that go deeper; view 'matrix' (with level 'units', folder or neither) - the level's dependency structure matrix: rows by layer with each cycle's rows together, non-zero cells (row imports column, diagonal = pairs inside, upward = above the diagonal), Ce/Ca/instability per row with the formula, cycles and totals. Each response states its context (grouping, graph kind, truncation, revision) and separates code facts from computed groupings.",
      "LIMITS: import relations only (static analysis, not observed execution); every list (groups, group edges, files, incoming, outgoing, pairs, matrix cells) paginated by offset/limit (default 50) with totals, truncated and nextOffset; analyses every source file on each call, so pass the previous context.revision with a group id or offset: the call fails if the architecture changed, and you restart from the summary. Symbols and lines come from skein_find_referencing_files, skein_query_call_graph and skein_get_impact_analysis.",
    ],
  },
  check_architecture: {
    summary:
      "Checks the workspace imports against the architecture rules declared in skein.architecture.json.",
    lines: [
      `WHEN: "does this change break the architecture", "may the frontend import the backend", before adding an import across packages, or to list the violations a CI gate reports.`,
      "WHY: rules are human annotation (elements selected by path patterns, units or unit roles; forbid, allowOnly, noCycles); the check compares every static import pair with them, as `skein_check_architecture` does, and a baseline separates accepted violations from new ones (`skein_check_architecture`).",
      "RETURNS: passed (false when an error-severity violation is new), totals per severity, each rule with its violation count and element pairs, the violating file pairs (source, target, import line, element pairs, new) sorted by rule, files no element selects, baseline entries no longer found (resolved), and config warnings (patterns matching nothing). Invalid configs fail with the JSON path of each error.",
      "LIMITS: import relations only (static analysis), no rule on symbols or calls; violations paginated by offset/limit (default 50) with totals; analyses every source file on each call, so pass the previous context.revision with an offset: the call fails if the code, rules or baseline changed. Pair it with skein_explore_architecture to see the units and edges the rules refer to.",
    ],
  },
  diagnose_structure: {
    summary:
      "Runs the five structure diagnostics: responsibility concentration, duplicated implementation, feature placement, over-abstraction and dependency problems.",
    lines: [
      "WHEN: reviewing a project's structure, before a refactor, or after adopting skein.architecture.json profiles and exceptions.",
      "WHY: reuses the architecture graph, units and declared rules; confirmed means a declared rule is broken, candidate means the evidence is shown and a reader decides.",
      "RETURNS: profile thresholds, declared areas and profiles, diagnostic counts by kind (confirmed, candidate, new, worsened, excepted), the page of diagnostics with stable ids, locations, evidence, limits and baseline state, plus resolved baseline entries and the limits of the analysis.",
      "LIMITS: static imports and text metrics only; runtime wiring, reflection and semantic responsibility are outside the analysis. Candidates are never used to block a change. Analyses every source file on each call, so pass the previous revision with an offset: the call fails if the code, rules or baseline changed.",
    ],
  },
  get_session_stats: {
    summary:
      "Reports how large this session's TOON responses were against their JSON equivalent, plus real token usage.",
    lines: [
      "WHEN: asked how much the TOON encoding is saving, or for a summary of tool usage.",
      "WHY: encoding sizes are estimated (characters / 4); provider-reported LLM usage is reported separately and never mixed into that estimate.",
      "RETURNS: per-tool and total encoding sizes for this session, llmUsage as its own section, and per-source history.",
      "LIMITS: compares two encodings of the same data - not a saving attributable to the tools themselves.",
    ],
  },
  get_view_state: {
    summary:
      "Returns the graph tab the user is looking at: view mode, file, selection, call graph root and depth, filters, and the graph version.",
    lines: [
      "WHEN: before answering a question about what is on screen, or before controlling the view, so commands can be pinned to the graph the user sees.",
      "RETURNS: available=false with reason state-file-missing when the VS Code extension has not published a view for this workspace yet - this tool never reads the index as a substitute for the screen.",
      "LIMITS: reflects the last published state (sub-second polling); it is not a live stream.",
    ],
  },
  control_view: {
    summary:
      "Drives the user's graph tab: select or focus a call graph node, change depth, open a file, toggle a filter, or expand/collapse the dependency graph.",
    lines: [
      "WHEN: the user asked to move or highlight something in the graph they are looking at.",
      "WHY: the same command queue the UI uses, so a human interaction always wins: a command queued before the user's last action is rejected with reason user-action-superseded.",
      "RETURNS: applied, status, reason and the resulting state. Pass graphVersion from get_view_state to have stale commands rejected after a re-analysis.",
      "LIMITS: requires the VS Code window with the graph tab to be open; without it the call fails with extension-not-responding.",
    ],
  },
  plan_change: {
    summary:
      "Plans a rename, move, extract or inline change against the saved code and returns a plan id and diff without modifying files.",
    lines: [
      "WHEN: the user asked to rename/move a symbol, extract a selected range into a function, or inline a function, and wants to inspect the change before applying it.",
      "WHY: rename comes from the workspace's language service; move uses a deterministic rule engine that moves helper symbols only when every reference stays inside the bundle, keeps public symbols and shared helpers in place, updates imports and creates a new file when needed; extract derives parameters from the enclosing function; inline replaces every call of a single-expression function. The plan records the exact saved content it was computed against.",
      "RETURNS: applied/status/reason, a plan summary (planId, target, files, added/removed lines) and a unified diff capped at 12000 characters.",
      "LIMITS: one change at a time; a dirty editor for a touched file is rejected with unsaved-changes. Move blocks entry points, unresolved references/imports, name collisions, circular imports and Dart private helpers. Inline only supports non-exported, non-async, single-expression top-level functions used inside their own file. Unsupported cases return an explicit reason instead of a guessed edit.",
    ],
  },
  apply_change: {
    summary:
      "Applies a planned change, records it in the internal history, verifies diagnostics and returns the result.",
    lines: [
      "WHEN: after the user has reviewed the plan and explicitly asked to apply it. Planning alone never approves applying.",
      "WHY: the same path the UI uses: fingerprint check, before snapshot, apply, after snapshot, diagnostics comparison. A failure is reported with its reason rather than hidden.",
      "RETURNS: applied/status/reason, the resulting plan status (succeeded, verification-failed, incomplete, recovery), and the history entry when one was recorded.",
      "LIMITS: refuses a stale plan (stale-plan), unsaved editor changes (unsaved-changes) and a missing internal history (history-unavailable). Project test commands and architecture rules are not run in step 5.",
    ],
  },
  get_change_plan: {
    summary: "Returns a stored change plan and its diff without modifying anything.",
    lines: [
      "WHEN: re-reading a plan created earlier in the session, or checking why an apply was rejected.",
      "RETURNS: available=false with plan-not-found when the plan id is unknown; otherwise the plan summary and the unified diff.",
      "LIMITS: read-only; it does not re-resolve the rename against the current code. Apply performs that check.",
    ],
  },
  list_change_history: {
    summary:
      "Lists recorded tool changes with their verification status and shows which entry a bare undo or redo would use.",
    lines: [
      "WHEN: before undoing, to choose a specific entry, or to review what the tool changed in this workspace.",
      "RETURNS: newest-first entries (id, planId, kind, status, target, files, verification), total, plus undoable and redoable entry ids.",
      "LIMITS: reads the local history index only; it does not include edits made outside this tool.",
    ],
  },
  undo_change: {
    summary:
      "Reverts a recorded change by applying its recorded before state to the current files, preserving later edits where they do not conflict.",
    lines: [
      "WHEN: the user asked to undo a tool change, optionally a specific history entry.",
      "WHY: a three-way merge (recorded after, current, recorded before) instead of reset/checkout, so edits made after the change survive. Conflicts are reported and nothing is overwritten.",
      "RETURNS: applied/status/reason, the new history entry, and conflict details (path, conflicts, first hunk) with reason conflict when the merge stops.",
      "LIMITS: defaults to the newest undoable entry; undo itself is verified and recorded as a new entry. Requires the VS Code extension to be running.",
    ],
  },
  redo_change: {
    summary:
      "Re-applies an undone change to the current files using the same three-way merge and verification path.",
    lines: [
      "WHEN: the user asked to re-apply a change that was undone.",
      "RETURNS: applied/status/reason and the new history entry; conflict details when later edits prevent a clean re-apply.",
      "LIMITS: defaults to the newest undo entry that has not been redone. Requires the VS Code extension to be running.",
    ],
  },
};

function render(name: DescribedToolName, surface: "mcp" | "lm"): string {
  const { summary, lines } = TOOL_DESCRIPTIONS[name];
  const body = lines
    .map((line) => (typeof line === "string" ? line : line[surface]))
    .filter((line): line is string => line !== undefined);
  return `${summary}\n\n${body.join("\n")}`;
}

/** One-sentence summary used by the tool list. */
export function toolSummary(name: DescribedToolName): string {
  return TOOL_DESCRIPTIONS[name].summary;
}

/** Full description registered on the MCP server. */
export function mcpToolDescription(name: DescribedToolName): string {
  return render(name, "mcp");
}

/** `modelDescription` of the VS Code Language Model tool `skein_<name>`. */
export function lmToolDescription(name: DescribedToolName): string {
  return render(name, "lm");
}
