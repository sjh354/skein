import { validateFileExists } from "../../shared/pathSecurity";
import { workerState, type ToolContext } from "../shared/state";
import type {
    AnalyzeDependenciesParams,
    AnalyzeDependenciesResult,
    VerifyDependencyUsageParams,
    VerifyDependencyUsageResult,
} from "../types";
import { enrichDependency } from "../types";

/**
 * Analyze dependencies of a single file
 */
export async function executeAnalyzeDependencies(
  params: AnalyzeDependenciesParams,
  ctx: ToolContext = workerState,
): Promise<AnalyzeDependenciesResult> {
  const { filePath } = params;
  const spider = ctx.getSpider();
  const config = ctx.getConfig();

  // Validate file exists
  await validateFileExists(filePath);

  const dependencies = await spider.analyze(filePath);

  return {
    filePath,
    dependencyCount: dependencies.length,
    dependencies: dependencies.map((dep) =>
      enrichDependency(dep, config.rootDir),
    ),
  };
}

/**
 * Verify if a dependency is actually used
 */
export async function executeVerifyDependencyUsage(
  params: VerifyDependencyUsageParams,
  ctx: ToolContext = workerState,
): Promise<VerifyDependencyUsageResult> {
  const { sourceFile, targetFile } = params;
  const spider = ctx.getSpider();

  // Validate file exists
  await validateFileExists(sourceFile);
  await validateFileExists(targetFile);

  const isUsed = await spider.verifyDependencyUsage(sourceFile, targetFile);

  return {
    sourceFile,
    targetFile,
    isUsed,
    usedSymbolCount: isUsed ? undefined : 0, // We don't have count yet, but if unused it's 0
  };
}
