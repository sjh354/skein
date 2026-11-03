# Skein

**See your codebase as a graph — in VS Code and your AI assistant.**

Skein analyzes imports, symbols, calls, cycles, unused exports, and change impact. Use it as a VS Code extension or an MCP/native tool provider for GitHub Copilot and other AI clients. Analysis runs locally and returns evidence from your codebase.

## Table of Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Features](#features)
- [AI integrations](#ai-integrations)
- [Configuration](#configuration)
- [Supported languages](#supported-languages)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

## What it does

Skein provides three views of a codebase:

| View | Answers | Analysis layer |
| --- | --- | --- |
| **File graph** | Which files import this file? What depends on this module? | Regex and AST parsing |
| **Symbol view** | Which functions and classes call each other in this file? | AST analysis |
| **Live call graph** | Which symbols call each other across files? | Tree-sitter and SQLite |

Use the same graph data to navigate code, review refactors, generate codemaps, and give AI assistants focused context instead of entire source files.

## Quick start

### VS Code extension

**Requirements:** VS Code 1.96 or later. Not yet published to the Marketplace: run `npm install && npm run build`, then press **F5** to launch the Extension Development Host, or run `npm run package` and install the generated VSIX.

1. Open a project.
2. Click the graph icon in the editor title, or run **Skein: Show Dependency Graph** from the Command Palette. The editor-title action opens the graph in a tab beside the code; the Command Palette keeps the panel view.
3. Click a file to open it, double-click it for the Symbol View, or use **Show Call Graph** for cross-file calls.

Supported projects include TypeScript, JavaScript, Python, Rust, C#, Go, Java, Dart, Vue, Svelte, and GraphQL.

### First useful actions

| Goal | Action |
| --- | --- |
| Explore imports | Open the dependency graph and expand a file node |
| Inspect functions | Switch to **Symbol View** or double-click a file |
| Find callers | Open **Show Call Graph** with a symbol selected |
| Find reverse dependencies | Use **Show Reverse Dependencies** |
| Hide unused imports | Enable **Filter Unused Dependencies** |
| Refresh analysis | Run **Refresh Graph** or **Force Skein re-index** |
| Rename a symbol | Select it in the call graph, then run **Rename Selected Symbol** |
| Review or revert tool changes | Run **Show Change History**, **Undo Last Tool Change** or **Re-apply Last Undone Change** |

## Features

### File dependency graph

- Visualize file-to-file imports across a workspace.
- Detect circular dependencies and highlight cycles.
- Expand and collapse nodes as you explore.
- Open files directly from graph nodes.
- Find reverse dependencies with an indexed lookup.

### Symbol View

Drill into TypeScript, JavaScript, Python, Rust, or Dart files to see functions, classes, variables, outgoing calls, incoming callers, and recursive calls. Click a symbol to navigate to its definition.

### Live Call Graph

The Live Call Graph shows cross-file symbol relationships in a Cytoscape.js panel.

- Expand callers and callees with a depth from 1 to 5. A view shows at most 500 symbols, nearest hops first; a notice counts the hidden ones.
- Group symbols by folder.
- Number calls in invocation order.
- Highlight self-recursion and mutual recursion.
- Filter by symbol type or folder.
- Refresh automatically after file saves.

### Refactoring and change history

Select a symbol in the call graph and run **Skein: Rename Selected Symbol**, **Skein: Move Selected Symbol to File** or **Skein: Inline Function**. In the editor, select code and run **Skein: Extract Selection as Function**. Skein shows a diff preview and applies the change only after you confirm.

- Rename asks the language service (the built-in TypeScript support or the installed Dart extension).
- Move uses a rule engine: helpers used only by the moved code travel with it, public symbols and helpers used elsewhere stay, imports are rewritten, a destination file is created when needed, and entry points, private Dart helpers, unresolved imports, name collisions and circular imports block the plan with a reason.
- Extract derives parameters from the enclosing function and supports expression or statement selections; code that uses `this` or awaits inside a synchronous function is refused.
- Inline supports non-exported, non-async, single-expression top-level functions and replaces every call site (or a chosen call through MCP). Exported or external use is refused instead of guessed.
- The plan is recorded against the exact saved content it was built from; if the file changed first, applying is refused.
- Before and after snapshots are written to a separate Git repository under `.skein/history/`, never to your repository's branches or index. Created and deleted files are recorded and restored by undo/redo.
- Changes are verified by comparing diagnostics before and after. A new error marks the change `verification-failed` and keeps the diff instead of rolling back.
- **Undo** and **Re-apply** use a three-way merge, so edits made after the change survive. A conflict is reported with the path and first conflicting hunk, and no file is overwritten.
- Agents can use `skein_plan_change` (`kind`: `rename`, `move`, `extract`, `inline`), `skein_apply_change`, `skein_get_change_plan`, `skein_list_change_history`, `skein_undo_change` and `skein_redo_change`; they go through the same queue and checks as the UI.

The Live Call Graph supports TypeScript, JavaScript, Vue, Svelte, Python, Rust, C#, Go, Java, Dart, and GraphQL. C#, Go, Java, and GraphQL are supported in the file graph and Live Call Graph; Symbol View support is currently limited to TypeScript, JavaScript, Python, Rust, and Dart. Dart analysis is syntactic: imports resolve through package_config.json or the owning pubspec, and a cross-file call is linked only when its symbol name is unique in the workspace. In GraphQL, operations and fragments call the fragments they spread; an operation's default root type (`Query`, `Mutation`, `Subscription`), type conditions, field, argument and variable types, and union members are type-only references (`USES`, shown with `includeTypeOnly`); `implements` is an `IMPLEMENTS` edge.

### Architecture view

The Architecture view draws the whole workspace as **units** (packages, else top-level folders) in layers, with the import edges between them, their roles and their cycles. It answers three questions: what are my layers, who depends on this, and does the code follow my rules. The [architecture guide](docs/architecture.md) defines every term, explains the marks of each view and how to fix what they raise: cycles, rule violations, unmatched files.

Quick start:

1. Open the *Dependency Graph* view and click *Switch to Architecture View* (icon `$(type-hierarchy)`).
2. Double-click a unit to enter its folders; *Escape* goes back.
3. Click an edge to list the file pairs behind it.
4. Select a node, then *Dependents by group* to see every group that imports it.
5. Click *Matrix* for the dependency structure matrix of the level.

The Architecture view and the MCP tool `skein_explore_architecture` report the same counts.

### Architecture rules

Declare your intended architecture in `skein.architecture.json` at the workspace root: `elements` name sets of files, `rules` say what each may import, and `roles` declare what each unit is. `profiles`/`areas` add per-area layer directions and `exceptions` record known cases with a reason. The view lists each rule with its violations and the five structure diagnostics; the `skein_check_architecture` MCP tool reports new `error` violations, supports a baseline for existing code, and can gate CI, while `skein_diagnose_structure` reports confirmed rule breaks and review candidates. See [the config file](docs/architecture.md#the-config-file) for a complete example.

### Unused dependencies and impact analysis

- Hide or dim unused dependencies.
- Detect unused exported symbols.
- Trace execution from a function or symbol.
- Identify callers affected by a signature change.
- Generate a codemap with exports, internals, dependencies, dependents, and call flow.

## AI integrations

Skein exposes local graph analysis to GitHub Copilot, Claude, Cursor, Windsurf, Antigravity, and other MCP-compatible clients.

### Native Copilot tools

When the extension is installed, use these tools in Copilot Agent mode without configuring MCP:

| Tool group | Capabilities |
| --- | --- |
| Navigation | Dependencies, reverse dependencies, imports, module resolution, workspace index status |
| Symbols | Symbol graphs, callers, dependents, execution traces |
| Refactoring | Breaking changes, impact analysis, unused symbols, dead-code scans |
| Context | File logic, codemaps, unified graph context, natural-language graph queries |
| Call graph | Cross-file caller/callee queries and neighbourhood expansion |

The graph-context tool is available as `#graphContext`. Other native references include `#graphDeps`, `#graphFindRefs`, `#graphCallers`, `#graphImpact`, `#graphCodemap`, `#graphTrace`, `#graphDeadCode`, and `#graphQuery`.

### Shared graph view control

`skein_get_view_state` reads the current window, graph version, per-view selections (`views`) and bounded rendered state (`surface`). Use the exact node IDs it returns with `skein_control_view`:

- `search` searches loaded nodes by ID/name and focuses the first match; use `skein_graph_context` for whole-project search.
- `select` / `focus` target a node in the current view.
- `set_expanded` changes one file dependency node or architecture group.
- `set_architecture` changes `view` (`graph`/`matrix`), `unit`, `folder`, or `minImports`; navigate one level per call.

`surface` includes analysis counts/freshness and architecture diagnostic references. Detailed analysis and diagnostic evidence remain in the query tools. Pin commands with `windowId` and `graphVersion`; unavailable views and invalid nodes return explicit rejection reasons. Use the direct view-mode commands or toolbar; `skein.toggleViewMode` has been removed.

### MCP server

The MCP server exposes 31 graph-analysis tools. Enable it in VS Code with `skein.enableMcpServer`, or point a client at the built bundle with `node <extension>/dist/mcpServer.mjs`.

For VS Code, add `.vscode/mcp.json`:

```json
{
  "servers": {
    "skein": {
      "type": "stdio",
      "command": "node",
      "args": ["<extension>/dist/mcpServer.mjs"],
      "env": {
        "WORKSPACE_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

For Cursor, use `.cursor/mcp.json` with the same server definition under `mcpServers` instead of `servers`. The same `node <extension>/dist/mcpServer.mjs` command works with Claude Desktop, Claude Code, Windsurf, and Antigravity; each client reads its own configuration file and environment variables.

For Codex CLI:

```bash
codex mcp add skein --env WORKSPACE_ROOT=/path/to/project -- node /path/to/skein/dist/mcpServer.mjs
```

### Other MCP clients

Clients without a native integration use the same server entry in their MCP configuration file:

```json
{
  "skein": {
    "type": "stdio",
    "command": "node",
    "args": ["<extension>/dist/mcpServer.mjs"]
  }
}
```

Use the client expected top-level key (`servers` or `mcpServers`). See the [MCP server instructions](#mcp-server) for ready-to-copy VS Code, Cursor and Codex examples.

## Configuration

Set these options in VS Code settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `skein.performanceProfile` | `default` | Select `default`, `low-memory`, `high-performance`, or `custom` |
| `skein.enableMcpServer` | `false` | Enable the built-in MCP server |
| `skein.maxDepth` | `50` | Limit dependency traversal depth |
| `skein.excludeNodeModules` | `true` | Exclude dependencies from `node_modules` |
| `skein.enableBackgroundIndexing` | `true` | Build reverse-dependency indexes in the background |
| `skein.unusedDependencyMode` | `hide` | Hide or dim unused dependencies |
| `skein.communityMode` | `path` | Group graph communities by folder (`path`) or by import structure (`louvain`) |
| `skein.preIndexCallGraph` | `true` | Pre-index the Live Call Graph |
| `skein.symbolViewLayout` | `hierarchical` | Select `hierarchical`, `force-directed`, or `radial` |

Workspace indexing (extension and MCP) skips paths listed in the root `.gitignore`, plus `tests/fixtures/` and `out-*/` by default. Add a root `.skeinignore` with gitignore syntax to exclude more paths, or negate a rule to include it again, for example `!tests/fixtures/`.

`performanceProfile` sets indexing concurrency, cache sizes, and unused-analysis limits. To tune them by hand, select `custom` and edit the **Advanced: Performance overrides** section (search `@tag:advanced skein` in the Settings editor). The other profiles ignore these overrides.

## Supported languages

| Language | File graph | Symbol View | Live Call Graph |
| --- | :---: | :---: | :---: |
| TypeScript / JavaScript | Yes | Yes | Yes |
| Vue / Svelte | Yes | Yes | Yes |
| Python | Yes | Yes | Yes |
| Rust | Yes | Yes | Yes |
| C# / Go / Java | Yes | No | Yes |
| Dart | Yes | Yes | Yes |
| GraphQL | Yes | No | Yes |

## Documentation

- [Design decisions](docs/DESIGN.md) — product scope, responsibilities, and why
- [Development guide](docs/DEVELOPMENT.md) — setup, builds, tests, and WASM architecture
- [Architecture guide](docs/architecture.md) — Architecture view, `skein.architecture.json` rules, and `check-architecture`
- [Handoff](docs/HANDOFF.md) — Marketplace·npm 등록과 GitHub 계정 쪽 남은 작업

## Development

Requirements: Node.js 22 or later and npm.

```bash
git clone https://github.com/sjh354/skein.git
cd skein
npm install
npm run build
```

Press F5 in VS Code to launch the Extension Development Host.

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the extension and copy WASM assets |
| `npm test` | Run unit tests |
| `npm run test:vscode` | Run VS Code E2E tests |
| `npm run test:viewstate` | Verify view-state save and restart restore |
| `npm run test:change` | Verify plan → history → apply → undo/redo |
| `npm run test:refactor` | Verify move, extract and inline |
| `npm run test:diagnostics` | Verify profiles, diagnostics and change blocking |
| `npm run lint` | Run ESLint |
| `npm run check:types` | Run strict TypeScript checks |
| `npm run package` | Build the VSIX package |
| `npm run package:verify` | Verify package contents |

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full project structure, test strategy, WASM details, and troubleshooting.

## License

MIT. See [LICENSE](LICENSE).

Originally based on [Graph-It-Live](https://github.com/magic5644/Graph-It-Live) by magic5644 (MIT).

Language icons are provided by [SuperTinyIcons](https://github.com/edent/SuperTinyIcons) under the CC0-1.0 license.

