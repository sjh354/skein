#!/usr/bin/env node
/**
 * MCP Server Entry Point
 *
 * Standalone Node.js process that implements the MCP protocol via stdio.
 * Delegates heavy analysis work to McpWorkerHost running in a Worker Thread.
 *
 * This is spawned by McpServerProvider when the user enables the MCP server.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { setLoggerBackend, StderrLogger } from "../shared/logger";

// Configure all loggers in this process to use StderrLogger
// This ensures stdout is kept clean for JSON-RPC
setLoggerBackend({
  createLogger(prefix: string, level) {
    return new StderrLogger(prefix, level);
  },
});

import * as fs from "node:fs";
import * as os from "node:os";

// ============================================================================
// Secure File Logger with Rotation (opt-in via DEBUG_MCP=true)
// ============================================================================
const DEBUG_MCP_ENABLED = process.env.DEBUG_MCP === "true";
const DEBUG_LOG_PATH = `${os.homedir()}/mcp-debug.log`;
const DEBUG_LOG_MAX_SIZE = 5 * 1024 * 1024; // 5MB per file
const DEBUG_LOG_BACKUP = `${DEBUG_LOG_PATH}.1`;

/**
 * Check log file size and rotate if necessary
 * Keeps last 2 files: mcp-debug.log (current) and mcp-debug.log.1 (previous)
 */
function rotateLogIfNeeded(): void {
  if (!DEBUG_MCP_ENABLED) return;

  try {
    const stats = fs.statSync(DEBUG_LOG_PATH);
    if (stats.size >= DEBUG_LOG_MAX_SIZE) {
      // Delete old backup if exists
      if (fs.existsSync(DEBUG_LOG_BACKUP)) {
        fs.unlinkSync(DEBUG_LOG_BACKUP);
      }
      // Rotate: current → backup
      fs.renameSync(DEBUG_LOG_PATH, DEBUG_LOG_BACKUP);
    }
  } catch {
    // File doesn't exist yet or other error - ignore
  }
}

/**
 * Write a debug message to both stderr and optionally to file (if DEBUG_MCP=true)
 * Privacy: Only logs when explicitly enabled to avoid exposing project paths
 */
function debugLog(...args: unknown[]): void {
  const message = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");

  // Always write to stderr for MCP protocol
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);

  // Only write to file if DEBUG logging is explicitly enabled
  if (!DEBUG_MCP_ENABLED) return;

  try {
    rotateLogIfNeeded();
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    // Ignore write errors to avoid crashing on permission issues
  }
}

// EARLY DEBUG: Log immediately to confirm process starts (only if opted-in)
if (DEBUG_MCP_ENABLED) {
  debugLog("[McpServer] ===== PROCESS STARTING (DEBUG MODE) =====");
  debugLog("[McpServer] Node version:", process.version);
  debugLog("[McpServer] PID:", process.pid);
  debugLog("[McpServer] cwd:", process.cwd());
  debugLog("[McpServer] argv:", JSON.stringify(process.argv));
  debugLog("[McpServer] Environment vars:");
  debugLog("  WORKSPACE_ROOT:", process.env.WORKSPACE_ROOT ?? "(not set)");
  debugLog("  TSCONFIG_PATH:", process.env.TSCONFIG_PATH ?? "(not set)");
  debugLog(
    "  EXCLUDE_NODE_MODULES:",
    process.env.EXCLUDE_NODE_MODULES ?? "(not set)",
  );
  debugLog("  MAX_DEPTH:", process.env.MAX_DEPTH ?? "(not set)");
} else {
  process.stderr.write(
    "[McpServer] Starting (debug logging disabled - set DEBUG_MCP=true to enable)\n",
  );
}
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as path from "node:path";
import * as z from "zod/v4";
import { McpWorkerHost } from "./McpWorkerHost";
import { formatToolResponse } from "./responseFormatter";
import { nextWorkspaceConfig } from "./shared/helpers";
import { mcpToolDescription } from "./toolDescriptions";
import {
  ControlViewSchema,
  type ControlViewResult,
  executeControlView,
  executeGetViewState,
  GetViewStateSchema,
  type GetViewStateResult,
} from "./tools/viewState";
import {
  ApplyChangeSchema,
  type ApplyChangeParams,
  type ChangeToolResult,
  executeApplyChange,
  executeGetChangePlan,
  executeListChangeHistory,
  executePlanChange,
  executeRedoChange,
  executeUndoChange,
  GetChangePlanSchema,
  type GetChangePlanParams,
  type GetChangePlanResult,
  ListChangeHistorySchema,
  type ListChangeHistoryParams,
  type ListChangeHistoryResult,
  PlanChangeSchema,
  type PlanChangeParams,
  RedoChangeSchema,
  type RedoChangeParams,
  UndoChangeSchema,
  type UndoChangeParams,
} from "./tools/change";
import {
  AnalyzeBreakingChangesParamsSchema,
  AnalyzeDependenciesParamsSchema,
  CrawlDependencyGraphParamsSchema,
  type CrawlDependencyGraphResult,
  createErrorResponse,
  createSuccessResponse,
  FindReferencingFilesParamsSchema,
  FindUnusedSymbolsParamsSchema,
  GenerateCodemapParamsSchema,
  GetImpactAnalysisParamsSchema,
  CheckArchitectureParamsSchema,
  DiagnoseStructureParamsSchema,
  ExploreArchitectureParamsSchema,
  GraphContextParamsSchema,
  type GetIndexStatusResult,
  GetSymbolGraphParamsSchema,
  InvalidateFilesParamsSchema,
  MCP_SERVER_VERSION,
  MCP_TOOL_VERSION,
  type McpToolName,
  type McpToolResponse,
  type PaginationInfo,
  QueryCallGraphParamsSchema,
  ResolveModulePathParamsSchema,
  ScanDeadCodeParamsSchema,
  QueryNaturalLanguageParamsSchema,
  // Import all parameter schemas with payload limits
  SetWorkspaceParamsSchema,
  type SetWorkspaceResult,
  TraceFunctionExecutionParamsSchema,
  validateFilePath,
  VerifyDependencyUsageParamsSchema,
} from "./types";
import { executeGetSessionStats, GetSessionStatsSchema, type GetSessionStatsResult } from "./tools/stats.js";
import { flushSession } from "../analyzer/stats/statsPersistence";
import { findWorkspaceRoot } from "../analyzer/utils/workspaceBoundary";
import { sessionStats } from "../shared/sessionStats";

// Session stats: this process is the MCP entry point.
sessionStats.setSource("mcp");

// Idempotent stats flush — signal handlers and exit path may all fire.
let statsFlushed = false;
function flushStatsOnce(): void {
  if (statsFlushed) {
    return;
  }
  statsFlushed = true;
  try {
    // flushSession is synchronous — safe inside signal/exit handlers.
    flushSession(sessionStats.snapshot());
  } catch (error) {
    debugLog(`[McpServer] Stats flush failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================================
// Environment Configuration
// ============================================================================

// Mutable configuration - can be changed via setWorkspace tool
const currentConfig = {
  workspaceRoot: process.env.WORKSPACE_ROOT ?? "",
  extensionPath: process.env.EXTENSION_PATH ?? path.resolve(__dirname, ".."),
  tsConfigPath: process.env.TSCONFIG_PATH,
  excludeNodeModules: process.env.EXCLUDE_NODE_MODULES !== "false",
  maxDepth: Number.parseInt(process.env.MAX_DEPTH ?? "50", 10),
};

// Check for unresolved variables (common misconfiguration)
if (
  currentConfig.workspaceRoot &&
  (currentConfig.workspaceRoot.includes("${") ||
    currentConfig.workspaceRoot.includes("$("))
) {
  debugLog(
    "[McpServer] WARNING: WORKSPACE_ROOT contains unresolved variable:",
    currentConfig.workspaceRoot,
  );
  debugLog(
    "[McpServer] Workspace not set - use skein_set_workspace tool to configure",
  );
  currentConfig.workspaceRoot = "";
}

// Fallback logic for WORKSPACE_ROOT (only if set via env)
if (!currentConfig.workspaceRoot) {
  const cwd = process.cwd();

  // If cwd is root or empty, don't set a default - require explicit configuration
  if (cwd === "/" || cwd === "") {
    debugLog(
      "[McpServer] No workspace configured - use skein_set_workspace tool to set workspace",
    );
  } else {
    // Same rule as the CLI without --workspace: the nearest package root.
    currentConfig.workspaceRoot = findWorkspaceRoot(cwd);
    debugLog(
      "[McpServer] WORKSPACE_ROOT not set, using the package root of the current working directory:",
      currentConfig.workspaceRoot,
    );
  }
}

// Validate workspace if set
if (
  currentConfig.workspaceRoot &&
  !fs.existsSync(currentConfig.workspaceRoot)
) {
  debugLog(
    "[McpServer] WARNING: WORKSPACE_ROOT path does not exist:",
    currentConfig.workspaceRoot,
  );
  debugLog(
    "[McpServer] Use skein_set_workspace tool to configure a valid workspace",
  );
  currentConfig.workspaceRoot = "";
}

// Helper to get current workspace (may be empty if not configured)
function getWorkspaceRoot(): string {
  return currentConfig.workspaceRoot;
}

const ResponseFormatSchema = z
  .enum(["json", "markdown", "toon"])
  .default("toon");
const PaginationInfoSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});
const McpResponseMetadataSchema = z.object({
  executionTimeMs: z.number(),
  toolVersion: z.string(),
  timestamp: z.string(),
  workspaceRoot: z.string(),
  indexedAt: z.string().nullable().optional(),
  stale: z.boolean().optional(),
});
const McpToolResponseSchema = z.object({
  success: z.boolean(),
  data: z.any(),
  metadata: McpResponseMetadataSchema,
  pagination: PaginationInfoSchema.optional(),
  error: z.string().optional(),
});

// ============================================================================
// Server Setup
// ============================================================================

const server = new McpServer({
  name: "skein",
  version: MCP_SERVER_VERSION,
});

let workerHost: McpWorkerHost | null = null;
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;
let initializationError: Error | null = null;

/**
 * Reset initialization state so the next call to initializeWorker()
 * creates a fresh worker. Used for auto-recovery after a worker crash.
 */
function resetInitializationState(): void {
  isInitialized = false;
  initializationPromise = null;
  initializationError = null;
}

/**
 * Initialize the worker host with warmup
 * Uses a singleton pattern to avoid multiple initializations.
 * Automatically recovers from dead workers and transient init failures.
 */
async function initializeWorker(): Promise<void> {
  // If we previously succeeded but the worker has since died, reset and re-init
  if (isInitialized && !workerHost?.ready()) {
    debugLog(
      "[McpServer] Worker was initialized but is no longer ready — auto-recovering",
    );
    if (workerHost) {
      await workerHost.dispose();
      workerHost = null;
    }
    resetInitializationState();
  }

  // Already initialized and worker is alive
  if (isInitialized) {
    return;
  }

  // Previous initialization failed — allow a single retry so callers
  // don't stay permanently stuck (set_workspace still does a full reset)
  if (initializationError) {
    debugLog(
      "[McpServer] Previous init failed, allowing retry",
    );
    resetInitializationState();
  }

  // Initialization already in progress, wait for it
  if (initializationPromise !== null) {
    debugLog("[McpServer] Waiting for existing initialization...");
    return initializationPromise;
  }

  // Start new initialization
  initializationPromise = doInitializeWorker();

  try {
    await initializationPromise;
  } catch (error) {
    initializationError =
      error instanceof Error ? error : new Error(String(error));
    initializationPromise = null;
    throw initializationError;
  }
}

/**
 * Actual worker initialization logic
 */
async function doInitializeWorker(): Promise<void> {
  const workerPath = path.join(__dirname, "mcpWorker.js");

  // Debug: Log worker path resolution
  debugLog(`[McpServer] __dirname: ${__dirname}`);
  debugLog(`[McpServer] Worker path: ${workerPath}`);

  // Check if worker file exists
  try {
    const fs = await import("node:fs/promises");
    await fs.access(workerPath);
    debugLog("[McpServer] Worker file exists: true");
  } catch {
    debugLog("[McpServer] Worker file exists: false - THIS IS THE PROBLEM!");
    throw new Error(`Worker file not found at ${workerPath}`);
  }

  workerHost = new McpWorkerHost({
    workerPath,
    warmupTimeout: 120000, // 2 minutes for large workspaces
    invokeTimeout: 60000, // 1 minute per tool call
  });

  debugLog("[McpServer] Starting worker with warmup...");

  try {
    const result = await workerHost.start(
      {
        rootDir: getWorkspaceRoot(),
        tsConfigPath: currentConfig.tsConfigPath,
        extensionPath: currentConfig.extensionPath,
        excludeNodeModules: currentConfig.excludeNodeModules,
        maxDepth: currentConfig.maxDepth,
        shareIndexCache: true,
      },
      (processed, total, currentFile) => {
        debugLog(
          `[McpServer] Warmup progress: ${processed}/${total} - ${currentFile ?? ""}`,
        );
      },
    );

    debugLog(
      `[McpServer] Worker ready: ${result.filesIndexed} files indexed in ${result.durationMs}ms`,
    );
    isInitialized = true;
  } catch (error) {
    debugLog(`[McpServer] Worker initialization failed: ${error}`);
    throw error;
  }
}

/**
 * Helper to invoke a tool and wrap result in McpToolResponse
 */
async function invokeToolWithResponse<T>(
  toolName: string,
  params: unknown,
): Promise<McpToolResponse<T>> {
  if (!workerHost?.ready()) {
    return createErrorResponse<T>("Worker not ready", 0, getWorkspaceRoot());
  }

  const startTime = Date.now();

  try {
    const result = await workerHost.invoke<T>(
      toolName as Parameters<typeof workerHost.invoke>[0],
      params,
    );
    const executionTimeMs = Date.now() - startTime;
    return createSuccessResponse(
      result,
      executionTimeMs,
      getWorkspaceRoot(),
      undefined,
      workerHost.freshness(),
    );
  } catch (error) {
    const executionTimeMs = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return createErrorResponse<T>(
      errorMessage,
      executionTimeMs,
      getWorkspaceRoot(),
    );
  }
}

/**
 * Helper to ensure worker is initialized, returns error response if not
 */
async function ensureWorkerReady(): Promise<
  { error: true; response: McpToolResponse<unknown> } | { error: false }
> {
  try {
    await initializeWorker();
    return { error: false };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Worker initialization failed";
    debugLog(
      `[McpServer] Tool call failed - worker init error: ${errorMessage}`,
    );
    return {
      error: true,
      response: createErrorResponse<unknown>(
        errorMessage,
        0,
        getWorkspaceRoot(),
      ),
    };
  }
}

// ============================================================================
// Helper functions for setWorkspace tool
// ============================================================================

/**
 * Creates an error response for the setWorkspace tool
 */
function createSetWorkspaceErrorResponse(
  workspacePath: string,
  previousWorkspace: string,
  errorMessage: string,
  startTime: number,
): McpToolResponse<SetWorkspaceResult> {
  return {
    success: false,
    data: {
      success: false,
      workspacePath,
      filesIndexed: 0,
      indexingTimeMs: Date.now() - startTime,
      previousWorkspace: previousWorkspace || undefined,
      message: errorMessage,
    },
    error: errorMessage,
    metadata: {
      executionTimeMs: Date.now() - startTime,
      toolVersion: MCP_TOOL_VERSION,
      timestamp: new Date().toISOString(),
      workspaceRoot: workspacePath,
    },
  };
}

/**
 * Validates that the workspace path exists and is a directory
 */
function validateWorkspacePath(workspacePath: string): string | null {
  if (!fs.existsSync(workspacePath)) {
    return `Path does not exist: ${workspacePath}`;
  }

  const stats = fs.statSync(workspacePath);
  if (!stats.isDirectory()) {
    return `Path is not a directory: ${workspacePath}`;
  }

  return null;
}

/**
 * Validates and resolves the tsConfigPath if provided
 */
function validateTsConfigPath(
  tsConfigPath: string | undefined,
  workspacePath: string,
): { resolvedPath: string | undefined; error: string | null } {
  if (!tsConfigPath) {
    return { resolvedPath: undefined, error: null };
  }

  const resolvedPath = path.isAbsolute(tsConfigPath)
    ? tsConfigPath
    : path.join(workspacePath, tsConfigPath);

  if (!fs.existsSync(resolvedPath)) {
    return {
      resolvedPath: undefined,
      error: `tsConfigPath does not exist: ${resolvedPath}`,
    };
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    return {
      resolvedPath: undefined,
      error: `tsConfigPath is not a file: ${resolvedPath}`,
    };
  }

  try {
    validateFilePath(resolvedPath, workspacePath);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid tsConfigPath";
    return { resolvedPath: undefined, error: message };
  }

  return { resolvedPath, error: null };
}

// ============================================================================
// Rate limiting for expensive/destructive tools (in-memory sliding window)
// Bounds repeated full re-index / cache-invalidation calls that would
// otherwise saturate CPU/IO in this single stdio process (M2/M5 security audit).
// ============================================================================
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_CALLS: Record<string, number> = {
  set_workspace: 5,
  rebuild_index: 5,
  invalidate_files: 20,
};
const rateLimitCallTimestamps = new Map<string, number[]>();

function checkRateLimit(tool: string): string | null {
  const max = RATE_LIMIT_MAX_CALLS[tool];
  if (max === undefined) return null;

  const now = Date.now();
  const recentCalls = (rateLimitCallTimestamps.get(tool) ?? []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );

  if (recentCalls.length >= max) {
    return `Rate limit exceeded: max ${max} calls per ${RATE_LIMIT_WINDOW_MS / 1000}s for ${tool}. Wait before retrying.`;
  }

  recentCalls.push(now);
  rateLimitCallTimestamps.set(tool, recentCalls);
  return null;
}

// ============================================================================
// Tool Definitions - Using registerTool (recommended over deprecated tool())
// ============================================================================

// Tool: skein_set_workspace
// This tool is special - it doesn't require the worker to be ready first
server.registerTool(
  "skein_set_workspace",
  {
    title: "Set Workspace Directory",
    description: mcpToolDescription("set_workspace"),
    inputSchema: SetWorkspaceParamsSchema.extend({
      response_format: ResponseFormatSchema.describe(
        "Output format: 'json', 'markdown' (readable lists and tables), or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)",
      ),
    }),
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({
    workspacePath,
    tsConfigPath,
    excludeNodeModules,
    maxDepth,
    response_format,
  }) => {
    const startTime = Date.now();
    const previousWorkspace = getWorkspaceRoot();
    const responseFormat = response_format;

    const rateLimitError = checkRateLimit("set_workspace");
    if (rateLimitError) {
      return formatToolResponse(
        createSetWorkspaceErrorResponse(
          workspacePath,
          previousWorkspace,
          rateLimitError,
          startTime,
        ),
        responseFormat,
        "skein_set_workspace",
      );
    }

    debugLog(`[McpServer] setWorkspace called with: ${workspacePath}`);

    // Validate workspace path
    const workspaceError = validateWorkspacePath(workspacePath);
    if (workspaceError) {
      return formatToolResponse(
        createSetWorkspaceErrorResponse(
          workspacePath,
          previousWorkspace,
          workspaceError,
          startTime,
        ),
        responseFormat,
      "skein_set_workspace",
      );
    }

    // Validate tsConfigPath if provided
    const { resolvedPath: resolvedTsConfigPath, error: tsConfigError } =
      validateTsConfigPath(tsConfigPath, workspacePath);
    if (tsConfigError) {
      return formatToolResponse(
        createSetWorkspaceErrorResponse(
          workspacePath,
          previousWorkspace,
          tsConfigError,
          startTime,
        ),
        responseFormat,
      "skein_set_workspace",
      );
    }

    Object.assign(currentConfig, nextWorkspaceConfig(currentConfig, {
      workspaceRoot: workspacePath,
      tsConfigPath: resolvedTsConfigPath,
      excludeNodeModules,
      maxDepth,
    }));

    debugLog(`[McpServer] Workspace updated to: ${workspacePath}`);

    // Dispose existing worker if any
    if (workerHost) {
      debugLog("[McpServer] Disposing previous worker...");
      await workerHost.dispose();
      workerHost = null;
    }

    // Reset initialization state
    resetInitializationState();

    // Initialize with new workspace
    try {
      await initializeWorker();

      const executionTimeMs = Date.now() - startTime;
      let filesIndexed = 0;

      // Get index status to report number of files indexed
      // workerHost is reassigned inside initializeWorker() — re-read the module-level variable.
      // Type assertion required: TS control-flow narrows workerHost to `null` (set above)
      // but initializeWorker() reassigns it — TS cannot track cross-function mutations.
      const activeWorker = workerHost as McpWorkerHost | null; // NOSONAR
      if (activeWorker?.ready()) {
        const statusResult = await activeWorker.invoke<GetIndexStatusResult>(
          "get_index_status",
          {},
        );
        // cacheSize counts the in-memory analysis cache: empty after a cache
        // restore and capped on large workspaces.
        filesIndexed = statusResult.warmup.filesIndexed ?? statusResult.reverseIndexStats?.indexedFiles ?? 0;
      }

      const response: McpToolResponse<SetWorkspaceResult> = {
        success: true,
        data: {
          success: true,
          workspacePath,
          workspaceName: path.basename(workspacePath),
          filesIndexed,
          indexingTimeMs: executionTimeMs,
          previousWorkspace: previousWorkspace || undefined,
          // The basename, not the path: response redaction only rewrites whole path strings.
          message: `Workspace set to ${path.basename(workspacePath)}. Indexed ${filesIndexed} files in ${executionTimeMs}ms.`,
        },
        metadata: {
          executionTimeMs,
          toolVersion: MCP_TOOL_VERSION,
          timestamp: new Date().toISOString(),
          workspaceRoot: workspacePath,
        },
      };

      debugLog(
        `[McpServer] Workspace configured successfully: ${filesIndexed} files indexed`,
      );

      return formatToolResponse(response, responseFormat, "skein_set_workspace");
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during initialization";
      debugLog(`[McpServer] setWorkspace failed: ${errorMessage}`);

      return formatToolResponse(
        createSetWorkspaceErrorResponse(
          workspacePath,
          previousWorkspace,
          `Failed to initialize workspace: ${errorMessage}`,
          startTime,
        ),
        responseFormat,
      "skein_set_workspace",
      );
    }
  },
);

// ============================================================================
// Worker-backed tools
// ============================================================================

const RESPONSE_FORMAT_DESCRIPTION =
  "Output format: 'json', 'markdown' (readable lists and tables), or 'toon' (Token-Oriented Object Notation for reduced token usage) (default: toon - RECOMMENDED for 30-60% token savings)";

type ResponseFormat = z.infer<typeof ResponseFormatSchema>;
type ToolParams = Record<string, unknown>;

interface WorkerToolOptions {
  title: string;
  /** Tool parameters; `response_format` is added to a plain object schema that lacks it. */
  inputSchema: z.ZodType;
  /** The tool rewrites the index: advertised as destructive and rate-limited. */
  mutates?: boolean;
  /** Page information for a paged result. */
  paginate?: (params: ToolParams, result: unknown) => PaginationInfo | undefined;
  /** Formatter hint read from the parameters. */
  detail?: (params: ToolParams) => Parameters<typeof formatToolResponse>[3];
}

/**
 * Registers a tool whose work runs in the worker. Worker readiness, the
 * response envelope and output formatting are the same for every one of them;
 * only the name, the schema and the hints differ.
 */
function registerWorkerTool(tool: McpToolName, options: WorkerToolOptions): void {
  const name = `skein_${tool}`;
  const inputSchema =
    options.inputSchema instanceof z.ZodObject && !("response_format" in options.inputSchema.shape)
      ? options.inputSchema.extend({
          response_format: ResponseFormatSchema.describe(RESPONSE_FORMAT_DESCRIPTION),
        })
      : options.inputSchema;
  server.registerTool(
    name,
    {
      title: options.title,
      description: mcpToolDescription(tool),
      inputSchema,
      outputSchema: McpToolResponseSchema,
      annotations: {
        readOnlyHint: !options.mutates,
        destructiveHint: options.mutates === true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: unknown) => {
      const { response_format, ...params } = input as ToolParams;
      const responseFormat = (response_format as ResponseFormat | undefined) ?? "toon";
      if (options.mutates) {
        const rateLimitError = checkRateLimit(tool);
        if (rateLimitError) {
          return formatToolResponse(
            createErrorResponse<unknown>(rateLimitError, 0, getWorkspaceRoot()),
            responseFormat,
            name,
          );
        }
      }
      const workerCheck = await ensureWorkerReady();
      if (workerCheck.error) return formatToolResponse(workerCheck.response, responseFormat, name);

      const response = await invokeToolWithResponse<unknown>(tool, params);
      if (options.paginate && response.success) {
        const pagination = options.paginate(params, response.data);
        if (pagination) response.pagination = pagination;
      }
      return formatToolResponse(response, responseFormat, name, options.detail?.(params));
    },
  );
}

registerWorkerTool("analyze_dependencies", {
  title: "Analyze File Dependencies",
  inputSchema: AnalyzeDependenciesParamsSchema,
});

registerWorkerTool("crawl_dependency_graph", {
  title: "Crawl Full Dependency Graph",
  inputSchema: CrawlDependencyGraphParamsSchema,
  // Nodes keep crawl order; the page is [offset, offset + limit).
  paginate: (params, data) => {
    if (params.limit === undefined && params.offset === undefined) return undefined;
    const result = data as CrawlDependencyGraphResult;
    const offset = (params.offset as number | undefined) ?? 0;
    const limit = (params.limit as number | undefined) ?? result.nodeCount;
    return {
      total: result.nodeCount,
      limit,
      offset,
      hasMore: offset + result.nodes.length < result.nodeCount,
    };
  },
});

registerWorkerTool("find_referencing_files", {
  title: "Find Files That Import This File",
  inputSchema: FindReferencingFilesParamsSchema,
});

registerWorkerTool("verify_dependency_usage", {
  title: "Verify Dependency Usage",
  inputSchema: VerifyDependencyUsageParamsSchema,
});

registerWorkerTool("resolve_module_path", {
  title: "Resolve Module Specifier to File Path",
  inputSchema: ResolveModulePathParamsSchema,
});

registerWorkerTool("get_index_status", {
  title: "Get Dependency Index Status",
  inputSchema: z.object({}),
});

registerWorkerTool("invalidate_files", {
  title: "Invalidate File Cache",
  inputSchema: InvalidateFilesParamsSchema,
  mutates: true,
});

registerWorkerTool("rebuild_index", {
  title: "Rebuild Full Dependency Index",
  inputSchema: z.object({}),
  mutates: true,
});

registerWorkerTool("get_symbol_graph", {
  title: "Get Symbol-Level Dependency Graph",
  inputSchema: GetSymbolGraphParamsSchema,
});

registerWorkerTool("find_unused_symbols", {
  title: "Find Dead Code (Unused Exports)",
  inputSchema: FindUnusedSymbolsParamsSchema,
});

registerWorkerTool("trace_function_execution", {
  title: "Trace Function Execution Chain",
  inputSchema: TraceFunctionExecutionParamsSchema,
});

registerWorkerTool("analyze_breaking_changes", {
  title: "Analyze Breaking Changes in Signature",
  inputSchema: AnalyzeBreakingChangesParamsSchema,
});

registerWorkerTool("get_impact_analysis", {
  title: "Get Comprehensive Impact Analysis",
  inputSchema: GetImpactAnalysisParamsSchema,
});

registerWorkerTool("generate_codemap", {
  title: "Generate File Codemap",
  inputSchema: GenerateCodemapParamsSchema,
});

registerWorkerTool("query_call_graph", {
  title: "Query Cross-File Call Graph",
  inputSchema: QueryCallGraphParamsSchema,
});

registerWorkerTool("scan_dead_code", {
  title: "Scan Workspace for Dead Code",
  inputSchema: ScanDeadCodeParamsSchema,
});

registerWorkerTool("graph_context", {
  title: "Retrieve Unified Graph Context",
  inputSchema: GraphContextParamsSchema,
  detail: (params) => params.detail as Parameters<typeof formatToolResponse>[3],
});

registerWorkerTool("explore_architecture", {
  title: "Explore Grouped Architecture",
  inputSchema: ExploreArchitectureParamsSchema,
});

registerWorkerTool("check_architecture", {
  title: "Check Architecture Rules",
  inputSchema: CheckArchitectureParamsSchema,
});

registerWorkerTool("diagnose_structure", {
  title: "Diagnose Structure",
  inputSchema: DiagnoseStructureParamsSchema,
});

registerWorkerTool("query_natural_language", {
  title: "Query Codebase with Natural Language",
  inputSchema: QueryNaturalLanguageParamsSchema,
});

// Tool: skein_get_view_state
// Runs in the server process: reads the state file the VS Code extension writes.
server.registerTool(
  "skein_get_view_state",
  {
    title: "Get Graph View State",
    description: mcpToolDescription("get_view_state"),
    inputSchema: GetViewStateSchema,
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const startTime = Date.now();
    const result = await executeGetViewState(getWorkspaceRoot());
    const response = createSuccessResponse<GetViewStateResult>(
      result,
      Date.now() - startTime,
      getWorkspaceRoot(),
    );
    return formatToolResponse(response, "json", "skein_get_view_state");
  },
);

// Tool: skein_control_view
// Queues an action for the VS Code extension and waits for its result.
server.registerTool(
  "skein_control_view",
  {
    title: "Control Graph View",
    description: mcpToolDescription("control_view"),
    inputSchema: ControlViewSchema,
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params) => {
    const startTime = Date.now();
    const result = await executeControlView(getWorkspaceRoot(), params);
    const response = createSuccessResponse<ControlViewResult>(
      result,
      Date.now() - startTime,
      getWorkspaceRoot(),
    );
    return formatToolResponse(response, "json", "skein_control_view");
  },
);

// Tool: skein_plan_change
// Creates a plan against the saved code; no file is modified.
server.registerTool(
  "skein_plan_change",
  {
    title: "Plan a Change",
    description: mcpToolDescription("plan_change"),
    inputSchema: PlanChangeSchema,
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params: PlanChangeParams) => {
    const startTime = Date.now();
    const result = await executePlanChange(getWorkspaceRoot(), params);
    const response = createSuccessResponse<ChangeToolResult>(
      result,
      Date.now() - startTime,
      getWorkspaceRoot(),
    );
    return formatToolResponse(response, "json", "skein_plan_change");
  },
);

// Tool: skein_apply_change
server.registerTool(
  "skein_apply_change",
  {
    title: "Apply a Change",
    description: mcpToolDescription("apply_change"),
    inputSchema: ApplyChangeSchema,
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params: ApplyChangeParams) => {
    const startTime = Date.now();
    const result = await executeApplyChange(getWorkspaceRoot(), params);
    const response = createSuccessResponse<ChangeToolResult>(
      result,
      Date.now() - startTime,
      getWorkspaceRoot(),
    );
    return formatToolResponse(response, "json", "skein_apply_change");
  },
);

// Tool: skein_get_change_plan
server.registerTool(
  "skein_get_change_plan",
  {
    title: "Get a Change Plan",
    description: mcpToolDescription("get_change_plan"),
    inputSchema: GetChangePlanSchema,
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: GetChangePlanParams) => {
    const startTime = Date.now();
    const result = await executeGetChangePlan(getWorkspaceRoot(), params);
    const response = createSuccessResponse<GetChangePlanResult>(
      result,
      Date.now() - startTime,
      getWorkspaceRoot(),
    );
    return formatToolResponse(response, "json", "skein_get_change_plan");
  },
);

// Tool: skein_list_change_history
server.registerTool(
  "skein_list_change_history",
  {
    title: "List Change History",
    description: mcpToolDescription("list_change_history"),
    inputSchema: ListChangeHistorySchema,
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: ListChangeHistoryParams) => {
    const startTime = Date.now();
    const result = await executeListChangeHistory(getWorkspaceRoot(), params);
    const response = createSuccessResponse<ListChangeHistoryResult>(
      result,
      Date.now() - startTime,
      getWorkspaceRoot(),
    );
    return formatToolResponse(response, "json", "skein_list_change_history");
  },
);

// Tool: skein_undo_change
server.registerTool(
  "skein_undo_change",
  {
    title: "Undo a Change",
    description: mcpToolDescription("undo_change"),
    inputSchema: UndoChangeSchema,
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params: UndoChangeParams) => {
    const startTime = Date.now();
    const result = await executeUndoChange(getWorkspaceRoot(), params);
    const response = createSuccessResponse<ChangeToolResult>(
      result,
      Date.now() - startTime,
      getWorkspaceRoot(),
    );
    return formatToolResponse(response, "json", "skein_undo_change");
  },
);

// Tool: skein_redo_change
server.registerTool(
  "skein_redo_change",
  {
    title: "Re-apply a Change",
    description: mcpToolDescription("redo_change"),
    inputSchema: RedoChangeSchema,
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async (params: RedoChangeParams) => {
    const startTime = Date.now();
    const result = await executeRedoChange(getWorkspaceRoot(), params);
    const response = createSuccessResponse<ChangeToolResult>(
      result,
      Date.now() - startTime,
      getWorkspaceRoot(),
    );
    return formatToolResponse(response, "json", "skein_redo_change");
  },
);

// Tool: skein_get_session_stats
// Runs in the server process (no worker needed): the sessionStats singleton
// is populated by responseFormatter in this same process.
server.registerTool(
  "skein_get_session_stats",
  {
    title: "Get Session Token Stats",
    description: mcpToolDescription("get_session_stats"),
    inputSchema: GetSessionStatsSchema,
    outputSchema: McpToolResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const startTime = Date.now();
    const result = executeGetSessionStats();
    const response = createSuccessResponse<GetSessionStatsResult>(
      result,
      Date.now() - startTime,
      getWorkspaceRoot(),
    );
    // Always JSON: stats output is small and must stay exact (no TOON re-encoding).
    return formatToolResponse(response, "json", "skein_get_session_stats");
  },
);

// ============================================================================
// Server Startup
// ============================================================================

async function main(): Promise<void> {
  debugLog("[McpServer] Skein MCP Server starting...");
  debugLog(
    `[McpServer] Workspace: ${getWorkspaceRoot() || "(not configured - use skein_set_workspace)"}`,
  );
  debugLog(
    `[McpServer] TSConfig: ${currentConfig.tsConfigPath ?? "auto-detect"}`,
  );
  debugLog(
    `[McpServer] Exclude node_modules: ${currentConfig.excludeNodeModules}`,
  );
  debugLog(`[McpServer] Max depth: ${currentConfig.maxDepth}`);

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  debugLog("[McpServer] MCP Server connected via stdio");

  // Start warmup immediately in background
  initializeWorker().catch((error) => {
    debugLog(`[McpServer] Background warmup failed: ${error}`);
  });

  // Handle graceful shutdown
  const shutdown = (reason: string): void => {
    debugLog(`[McpServer] ${reason}, shutting down...`);
    flushStatsOnce();
    void workerHost?.dispose().then(() => process.exit(0)).catch(() => process.exit(0));
    if (!workerHost) process.exit(0);
  };
  process.on("SIGINT", () => shutdown("Received SIGINT"));
  process.on("SIGTERM", () => shutdown("Received SIGTERM"));
  // MCP stdio shutdown starts with the client closing stdin. Exiting here also
  // ends the MCP server, whose parent may not forward signals (Windows).
  process.stdin.on("end", () => shutdown("stdin closed"));

  // Covers stdio transport close / normal exit paths (flushStatsOnce is idempotent).
  process.on("exit", () => {
    flushStatsOnce();
  });
}

// Run main - IIFE pattern for entry point (NOSONAR: top-level await not supported by tsconfig)
main().catch((error: unknown) => {// NOSONAR
  debugLog(`[McpServer] Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
