/**
 * MCP worker state: the analysis components of this worker thread and the
 * call-graph refresh marks. Plain fields; the `get*()` methods are the checked
 * accessors tool executors use.
 */

import type { FSWatcher } from "chokidar";
import type { AstWorkerHost } from "../../analyzer/ast/AstWorkerHost";
import type { IndexCache } from "../../analyzer/cache/IndexCache";
import type { CallGraphIndexer } from "../../analyzer/callgraph/CallGraphIndexer";
import type { GraphExtractor } from "../../analyzer/callgraph/GraphExtractor";
import type { Parser } from "../../analyzer/Parser";
import type { Spider } from "../../analyzer/Spider";
import type { SymbolReverseIndex } from "../../analyzer/SymbolReverseIndex";
import type { PathResolver } from "../../analyzer/utils/PathResolver";
import { normalizePath } from "../../shared/path";
import type { McpWorkerConfig } from "../types";

/**
 * Warmup completion status
 */
export interface WarmupInfo {
  completed: boolean;
  durationMs?: number;
  /** Source files held in the index. */
  filesIndexed?: number;
  /** Source files discovered on disk. */
  filesFound?: number;
  /** Files parsed during this run — 0 when a warm cache answered everything. */
  filesAnalyzed?: number;
  /** Whether the index was restored from disk rather than rebuilt. */
  fromCache?: boolean;
}

/**
 * Core worker state container
 */
export class WorkerState {
  spider: Spider | null = null;
  parser: Parser | null = null;
  resolver: PathResolver | null = null;
  astWorkerHost: AstWorkerHost | null = null;
  symbolReverseIndex: SymbolReverseIndex | null = null;
  config: McpWorkerConfig | null = null;
  isReady = false;
  warmupInfo: WarmupInfo = { completed: false };
  fileWatcher: FSWatcher | null = null;
  readonly pendingInvalidations = new Map<string, NodeJS.Timeout>();
  callGraphIndexer: CallGraphIndexer | null = null;
  graphExtractor: GraphExtractor | null = null;
  callGraphIndexedRoot: string | null = null;
  /** Shared `.skein/cache/`; null when this process runs without a cache. */
  indexCache: IndexCache | null = null;
  private readonly _callGraphPendingFiles = new Set<string>();
  private _callGraphFullRebuild = false;

  /** Files the next call graph refresh must re-extract, whatever their mtime. */
  get callGraphPendingFiles(): ReadonlySet<string> {
    return this._callGraphPendingFiles;
  }

  /** True when the next call graph refresh must ignore the cache and rebuild everything. */
  get callGraphFullRebuild(): boolean {
    return this._callGraphFullRebuild;
  }

  /**
   * Schedule `filePaths` (or, without argument, the whole call graph) for
   * re-extraction; the next graph query refreshes the call graph first.
   */
  markCallGraphStale(filePaths?: readonly string[]): void {
    if (filePaths === undefined) {
      this._callGraphFullRebuild = true;
    } else {
      for (const filePath of filePaths) this._callGraphPendingFiles.add(normalizePath(filePath));
    }
    this.callGraphIndexedRoot = null;
  }

  /**
   * Called after a successful refresh with what it covered. Files marked while
   * it ran stay pending and keep the call graph flagged for another refresh.
   */
  clearCallGraphPending(refreshed: Iterable<string>, fullRebuild: boolean): void {
    for (const filePath of refreshed) this._callGraphPendingFiles.delete(filePath);
    if (fullRebuild) this._callGraphFullRebuild = false;
    if (this._callGraphPendingFiles.size > 0 || this._callGraphFullRebuild) {
      this.callGraphIndexedRoot = null;
    }
  }

  // ============================================================================
  // Validation Methods
  // ============================================================================

  /**
   * Check if core analysis components are initialized
   * @throws Error if components not ready
   */
  requireReady(): void {
    if (!this.isReady || !this.spider || !this.parser || !this.resolver || !this.config) {
      throw new Error(
        "Worker not initialized. Call init() first. Missing: " +
          [
            !this.spider && "spider",
            !this.parser && "parser",
            !this.resolver && "resolver",
            !this.config && "config",
            !this.isReady && "ready flag",
          ]
            .filter(Boolean)
            .join(", ")
      );
    }
  }

  /**
   * Get spider instance (throws if not initialized)
   */
  getSpider(): Spider {
    this.requireReady();
    // requireReady() guarantees non-null; local alias helps TS narrow
    const spider = this.spider;
    if (!spider) throw new Error("Spider not available after requireReady()");
    return spider;
  }

  /**
   * Get parser instance (throws if not initialized)
   */
  getParser(): Parser {
    this.requireReady();
    const parser = this.parser;
    if (!parser) throw new Error("Parser not available after requireReady()");
    return parser;
  }

  /**
   * Get resolver instance (throws if not initialized)
   */
  getResolver(): PathResolver {
    this.requireReady();
    const resolver = this.resolver;
    if (!resolver) throw new Error("Resolver not available after requireReady()");
    return resolver;
  }

  /**
   * Get AST worker host instance (throws if not initialized)
   */
  getAstWorkerHost(): AstWorkerHost {
    if (!this.astWorkerHost) {
      throw new Error("AstWorkerHost not initialized");
    }
    return this.astWorkerHost;
  }

  /**
   * Get config (throws if not initialized)
   */
  getConfig(): McpWorkerConfig {
    if (!this.config) {
      throw new Error("Config not set. Call init() first.");
    }
    return this.config;
  }

  // ============================================================================
  // Lifecycle Management
  // ============================================================================

  /**
   * Reset all state (for shutdown or re-initialization)
   */
  reset(): void {
    for (const timeout of this.pendingInvalidations.values()) {
      clearTimeout(timeout);
    }
    this.pendingInvalidations.clear();

    if (this.fileWatcher) {
      void this.fileWatcher.close();
      this.fileWatcher = null;
    }

    if (this.astWorkerHost) {
      void this.astWorkerHost.stop();
      this.astWorkerHost = null;
    }

    this.symbolReverseIndex = null;

    if (this.graphExtractor) {
      this.graphExtractor.dispose();
      this.graphExtractor = null;
    }
    if (this.callGraphIndexer) {
      this.callGraphIndexer.dispose();
      this.callGraphIndexer = null;
    }
    this.callGraphIndexedRoot = null;
    this._callGraphPendingFiles.clear();
    this._callGraphFullRebuild = false;
    this.indexCache = null;

    this.spider = null;
    this.parser = null;
    this.resolver = null;
    this.config = null;
    this.isReady = false;
    this.warmupInfo = { completed: false };
  }
}

/**
 * Singleton worker state instance
 */
export const workerState = new WorkerState();
