import { workerState } from "../shared/state";
import {
  executeAnalyzeBreakingChanges,
  executeAnalyzeDependencies,
  executeCrawlDependencyGraph,
  executeCheckArchitecture,
  executeDiagnoseStructure,
  executeExploreArchitecture,
  executeFindReferencingFiles,
  executeFindUnusedSymbols,
  executeGenerateCodemap,
  executeGraphContext,
  executeGetImpactAnalysis,
  executeGetIndexStatus,
  executeGetSymbolGraph,
  executeInvalidateFiles,
  executeQueryCallGraph,
  executeRebuildIndex,
  executeResolveModulePath,
  executeScanDeadCode,
  executeTraceFunctionExecution,
  executeVerifyDependencyUsage,
  executeQueryNaturalLanguage,
} from "../tools";
import type {
  AnalyzeBreakingChangesParams,
  AnalyzeDependenciesParams,
  CrawlDependencyGraphParams,
  CheckArchitectureParams,
  DiagnoseStructureParams,
  ExploreArchitectureParams,
  FindReferencingFilesParams,
  FindUnusedSymbolsParams,
  GenerateCodemapParams,
  GraphContextParams,
  GetImpactAnalysisParams,
  GetSymbolGraphParams,
  InvalidateFilesParams,
  McpToolName,
  McpWorkerConfig,
  McpWorkerResponse,
  QueryCallGraphParams,
  ResolveModulePathParams,
  ScanDeadCodeParams,
  TraceFunctionExecutionParams,
  VerifyDependencyUsageParams,
  QueryNaturalLanguageParams,
} from "../types";
import {
  resolveToolFilePaths,
  validateToolParams,
} from "../types";

type ToolHandler = (
  params: unknown,
  config: McpWorkerConfig,
  postMessage: (msg: McpWorkerResponse) => void,
  signal: AbortSignal,
) => unknown;

const toolHandlers: Partial<Record<McpToolName, ToolHandler>> = {
  graph_context: (params, _config, _postMessage, signal) =>
    executeGraphContext(params as GraphContextParams, signal),
  analyze_dependencies: (params) =>
    executeAnalyzeDependencies(params as AnalyzeDependenciesParams),
  crawl_dependency_graph: (params, _config, _postMessage, signal) =>
    executeCrawlDependencyGraph(params as CrawlDependencyGraphParams, signal),
  find_referencing_files: (params) =>
    executeFindReferencingFiles(params as FindReferencingFilesParams),
  verify_dependency_usage: (params) =>
    executeVerifyDependencyUsage(params as VerifyDependencyUsageParams),
  resolve_module_path: (params) =>
    executeResolveModulePath(params as ResolveModulePathParams),
  get_index_status: () => executeGetIndexStatus(),
  invalidate_files: (params) =>
    executeInvalidateFiles(params as InvalidateFilesParams),
  rebuild_index: (_params, _config, postMessage) => executeRebuildIndex(postMessage),
  get_symbol_graph: (params) =>
    executeGetSymbolGraph(params as GetSymbolGraphParams),
  find_unused_symbols: (params) =>
    executeFindUnusedSymbols(params as FindUnusedSymbolsParams),
  trace_function_execution: (params) =>
    executeTraceFunctionExecution(params as TraceFunctionExecutionParams),
  analyze_breaking_changes: (params) =>
    executeAnalyzeBreakingChanges(params as AnalyzeBreakingChangesParams),
  get_impact_analysis: (params) =>
    executeGetImpactAnalysis(params as GetImpactAnalysisParams),
  generate_codemap: (params) =>
    executeGenerateCodemap(params as GenerateCodemapParams),
  query_call_graph: (params) =>
    executeQueryCallGraph(params as QueryCallGraphParams),
  scan_dead_code: (params, _config, _postMessage, signal) =>
    executeScanDeadCode(params as ScanDeadCodeParams, signal),
  query_natural_language: (params) => executeQueryNaturalLanguage(params as QueryNaturalLanguageParams),
  explore_architecture: (params, _config, _postMessage, signal) =>
    executeExploreArchitecture(params as ExploreArchitectureParams, signal),
  check_architecture: (params, _config, _postMessage, signal) =>
    executeCheckArchitecture(params as CheckArchitectureParams, signal),
  diagnose_structure: (params, _config, _postMessage, signal) =>
    executeDiagnoseStructure(params as DiagnoseStructureParams, signal),
};

async function executeValidatedTool(
  tool: McpToolName,
  params: unknown,
  config: McpWorkerConfig,
  postMessage: (msg: McpWorkerResponse) => void,
  signal: AbortSignal,
): Promise<unknown> {
  const handler = toolHandlers[tool];
  if (!handler) throw new Error(`Unknown tool: ${tool}`);
  return handler(resolveToolFilePaths(tool, params, config.rootDir), config, postMessage, signal);
}

export async function invokeTool(
  requestId: string,
  tool: McpToolName,
  params: unknown,
  postMessage: (msg: McpWorkerResponse) => void,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  if (
    !workerState.isReady ||
    !workerState.spider ||
    !workerState.parser ||
    !workerState.resolver ||
    !workerState.config
  ) {
    postMessage({
      type: "error",
      requestId,
      error: "Worker not initialized",
      code: "NOT_INITIALIZED",
    });
    return;
  }

  const startTime = Date.now();

  try {
    if (signal.aborted) throw createAbortError();
    // Validate parameters using Zod schema
    const validation = validateToolParams(tool, params);
    if (!validation.success) {
      postMessage({
        type: "error",
        requestId,
        error: validation.error,
        code: "VALIDATION_ERROR",
      });
      return;
    }

    const validatedParams = validation.data;
    const config = workerState.getConfig();
    const result = await executeValidatedTool(tool, validatedParams, config, postMessage, signal);
    if (signal.aborted) throw createAbortError();

    const executionTimeMs = Date.now() - startTime;

    postMessage({
      type: "result",
      requestId,
      data: result,
      executionTimeMs,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    let errorCode = "EXECUTION_ERROR";
    if (error instanceof Error && error.name === "AbortError") {
      errorCode = "CANCELLED";
    } else if (
      errorMessage.includes("Path traversal") ||
      errorMessage.includes("outside workspace")
    ) {
      errorCode = "SECURITY_ERROR";
    }

    postMessage({
      type: "error",
      requestId,
      error: errorMessage,
      code: errorCode,
    });
  }
}

function createAbortError(): Error {
  const error = new Error("Tool invocation cancelled");
  error.name = "AbortError";
  return error;
}
