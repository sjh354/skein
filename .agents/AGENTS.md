# Skein Agent Guide

VS Code extension and MCP server for dependency and call-graph analysis. Requires Node.js 22+ and npm.

## Commands

- Build: `npm run build`; one test: `npx vitest run <test-file>`; unit suite: `npm test`.
- Quality: `npm run lint`, `npm run check:types`, `npm run test:coverage`; E2E: `npm run test:vscode`.
- Phase checks: `npm run test:viewstate`, `npm run test:change`, `npm run test:refactor`, `npm run test:diagnostics`.
- Package: `npm run package && npm run package:verify`.

Prefix shell commands with `rtk`; use `rtk proxy <command>` when no optimized wrapper exists.

## Core Principles

- **Simplicity First:** make every change as simple as possible with minimal code impact.
- **No Laziness:** find root causes; do not use temporary workarounds.
- **Minimal Impact:** change only what is necessary and avoid introducing unrelated risk.
- **Conflict Check:** if loaded instructions conflict, stop and report the conflict instead of choosing arbitrarily.

## Universal Rules
- Keep `src/analyzer/**` and `src/mcp/**` Node.js-only: never import `vscode`.
- Keep imports compliant with `skein.architecture.json`: call the `check_architecture` MCP tool after source changes (0 violations, 0 unmatched files). New `src/` folder or layer relationship = update that config in the same change; never weaken a rule to pass.
- Define extension↔webview messages in `src/shared/types.ts`; update sender and receiver together.
- Build paths with `node:path`; call `normalizePath()` before path keys enter Sets or Maps.
- Keep TypeScript strict. Avoid `any`; ESLint decides style.
- New functions/modules need success and edge/failure unit tests. User-facing behavior also needs VS Code E2E coverage. Touched files must stay at or above 80% coverage.
- Never delete empty maps eagerly in `ReverseIndex.removeDependenciesFromSource()`; cleanup is query-time to avoid re-index races.
- Build/dependency/package changes require production package validation: zero `.map` files and required WASM/query assets present.
- After source changes, run targeted tests, lint, typecheck, and configured SonarQube analysis; fix findings caused by change.

## Working Method

- For exploration of `.js`, `.jsx`, `.cjs`, `.mjs`, `.ts`, `.tsx`, `.cts`, or `.mts` code, use Skein MCP tools first before `read_file`, `rg`, or other direct source inspection. Use direct inspection afterward to verify details and edit safely.
- Understand full flow and callers before editing. Fix root cause once.
- For architecture, impact, or relationship questions, use the available Skein MCP tools first. Refresh the index with the `rebuild_index` MCP tool after large source changes.
- Prefer deletion, existing helpers, standard library, platform features, and installed dependencies—in that order. Add no abstraction or dependency without need.
- Make smallest complete diff; preserve unrelated code and APIs.

## Detailed / Conditional Instructions

Before modifying matching paths—or when task topic matches—read corresponding rule:

| Scope or task | Rule |
| --- | --- |
| Any `src/**` architecture or code-style change, or `skein.architecture.json` | `.agents/rules/architecture.md` |
| Analyzer, MCP, shared security, paths | `.agents/rules/analyzer-mcp-security.md` |
| React/webview | `.agents/rules/webview-react.md` |
| Tests or coverage | `.agents/rules/testing.md` |
| Build, dependencies, package, WASM | `.agents/rules/build-packaging.md` |
| Live call graph or Cytoscape | `.agents/rules/callgraph-wasm.md` |
| Markdown or Mermaid diagrams | `.agents/rules/documentation-diagrams.md` |
| Broad-task bootstrap, shell use, exploration, refactoring | `.agents/rules/development-workflow.md` |
| Source changes or SonarQube | `.agents/rules/quality-gates.md` |

Read only the files the routing table selects; do not load `.agents/rules/` wholesale.

## Documentation Map

- `.agents/AGENTS.md` — this file, the only copy. Load it explicitly; there is no root `AGENTS.md` or `CLAUDE.md`.
- `.agents/rules/` — agent working rules (this table's targets). Nothing else.
- `docs/DESIGN.md` — product and design decisions, and why.
- `docs/DEVELOPMENT.md` — setup, build, tests and troubleshooting.
- `README.md` — user-facing setup and features.
