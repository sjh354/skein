/**
 * The architecture gate of a change (DESIGN 6.1, 7): confirmed violations only, and only the
 * ones the change introduces or worsens. Candidates never block. The comparison is a pure
 * function so the change flow stays testable without VS Code.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic.
 */

import type { ChangeArchitectureFinding, ChangeArchitectureSnapshot } from "../../shared/change";
import type { StructureDiagnosticsResult } from "../../shared/diagnostics-model";

const findingOf = (diagnostic: StructureDiagnosticsResult["diagnostics"][number]): ChangeArchitectureFinding => ({
  id: diagnostic.id,
  title: diagnostic.title,
  ...(diagnostic.rule === undefined ? {} : { rule: diagnostic.rule }),
  paths: diagnostic.locations.map((location) => location.path).filter((path) => path !== ""),
  value: diagnostic.value,
  baseline: diagnostic.baseline,
});

/** Confirmed violations that touch a changed file, with their baseline state. */
export function changedViolations(result: StructureDiagnosticsResult, files: readonly string[]): ChangeArchitectureFinding[] {
  const touched = new Set(files);
  return result.diagnostics
    .filter((diagnostic) => diagnostic.status === "confirmed" && diagnostic.locations.some((location) => touched.has(location.path)))
    .map(findingOf);
}

/** What applying this change would do to declared rules: block new or worsened confirmed violations. */
export function architectureBeforeChange(
  result: StructureDiagnosticsResult,
  files: readonly string[],
  checkedAt: number,
): ChangeArchitectureSnapshot {
  const findings = changedViolations(result, files);
  const blocking = findings.filter((finding) => finding.baseline === "new" || finding.baseline === "worsened");
  return {
    status: blocking.length > 0 ? "blocked" : "passed",
    checkedAt,
    revision: result.revision,
    findings,
  };
}

/** After apply: a confirmed violation absent before, or a larger value, fails the verification. */
export function architectureAfterChange(
  before: ChangeArchitectureSnapshot | undefined,
  after: ChangeArchitectureSnapshot,
): { status: "passed" | "failed" | "not-configured" | "unavailable"; findings: ChangeArchitectureFinding[]; message?: string } {
  if (before === undefined) return { status: "unavailable", findings: [], message: "no architecture check ran before apply" };
  if (before.status === "not-configured") return { status: "not-configured", findings: [] };
  if (before.status === "config-error" || before.status === "unavailable") {
    return { status: "unavailable", findings: [], message: before.message };
  }
  if (after.status === "unavailable" || after.status === "config-error") {
    return { status: "unavailable", findings: [], message: after.message };
  }
  const prior = new Map(before.findings.map((finding) => [finding.id, finding.value]));
  const introduced = after.findings.filter((finding) => {
    const value = prior.get(finding.id);
    return value === undefined || finding.value > value;
  });
  return {
    status: introduced.length > 0 ? "failed" : "passed",
    findings: introduced,
    ...(introduced.length === 0 ? {} : { message: `${introduced.length} new or worsened confirmed violation(s)` }),
  };
}
