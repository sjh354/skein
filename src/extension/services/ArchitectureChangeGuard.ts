/**
 * The extension-side architecture guard of a change: builds the import graph with the same
 * analyzer the Architecture view uses, runs the five diagnostics and keeps only the confirmed
 * violations that touch the changed files. Without skein.architecture.json nothing is checked.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ARCHITECTURE_CONFIG_FILE, ArchitectureRulesFileError } from "@/analyzer/architecture/architectureRules";
import { buildArchitectureGraph, type AnalyzeFile } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { architectureBeforeChange } from "@/analyzer/diagnostics/changeArchitecture";
import { runWorkspaceDiagnostics } from "@/analyzer/diagnostics/structureDiagnostics";
import type { ChangeArchitectureSnapshot } from "@/shared/change";
import { normalizePath } from "@/shared/path";
import type { ChangeArchitectureGuard } from "./ChangeService";

export interface ArchitectureChangeGuardOptions {
  root: string;
  analyzeFile: AnalyzeFile;
  /** Drops cached analysis of the changed files: the check runs before the file watcher has. */
  invalidate?: (files: readonly string[]) => void;
  now?: () => number;
  logger: { warn(message: string, ...args: unknown[]): void };
}

export function createArchitectureChangeGuard(options: ArchitectureChangeGuardOptions): ChangeArchitectureGuard {
  const now = options.now ?? Date.now;
  return {
    async check(files: readonly string[]): Promise<ChangeArchitectureSnapshot> {
      if (!fs.existsSync(path.join(options.root, ARCHITECTURE_CONFIG_FILE))) {
        return { status: "not-configured", checkedAt: now(), findings: [] };
      }
      try {
        options.invalidate?.(files);
        const graph = await buildArchitectureGraph(options.root, options.analyzeFile);
        // Diagnostics locate files relative to the workspace; a change names them absolutely.
        const relative = files.map((file) => normalizePath(path.relative(options.root, file)));
        // A changed file the analyzer could not read has no verdict; a deleted one has nothing to read.
        const existing = new Set(files.filter((file) => fs.existsSync(file)).map((file) => normalizePath(path.relative(options.root, file))));
        const unreadable = graph.failedFiles.filter((failed) => existing.has(failed.relativePath));
        if (unreadable.length > 0) {
          return {
            status: "unavailable",
            checkedAt: now(),
            findings: [],
            message: `Architecture check skipped: could not analyze ${unreadable.map((failed) => failed.relativePath).join(", ")}`,
          };
        }
        const result = await runWorkspaceDiagnostics(graph, options.root);
        return architectureBeforeChange(result, relative, now());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn("[Change] Architecture check failed:", error);
        return {
          status: error instanceof ArchitectureRulesFileError ? "config-error" : "unavailable",
          checkedAt: now(),
          findings: [],
          message,
        };
      }
    },
  };
}
