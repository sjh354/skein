/**
 * Builds a change plan from language-service edits (DESIGN 8.2, 8.4).
 *
 * The provider gives text edits; this module keeps the exact content they were
 * computed against, rejects edits that leave the workspace or overlap, and
 * stores only files whose content actually changes. No VS Code types.
 */

import type {
  ChangeFileEdit,
  ChangeFileState,
  ChangePlan,
  ChangePlanSummary,
  ChangeRequestSource,
  ChangeTask,
  ChangeTarget,
  ChangeTextEdit,
  ChangeKind,
  ChangeFileChange,
} from "@/shared/change";
import {
  applyTextEdits,
  hashContent,
  isProtectedChangePath,
} from "@/shared/change";
import { normalizePath } from "@/shared/path";
import { diffLines, type LineDiff } from "./lineDiff";

export interface RawFileEdit {
  path: string;
  edits: ChangeTextEdit[];
}

export interface BuildChangePlanInput {
  id: string;
  kind: ChangeKind;
  root: string;
  graphVersion: number;
  source: ChangeRequestSource;
  /** Saved content of every file the provider edited. */
  contents: Map<string, string>;
  files: RawFileEdit[];
  target?: ChangeTarget;
  historyTargetId?: string;
  now?: number;
}

export interface ChangePreviewFile {
  path: string;
  beforeContent: string;
  afterContent: string;
  diff: LineDiff;
}

export type ChangeFileKind = ChangeFileChange;

export type BuildChangePlanResult =
  | { ok: true; plan: ChangePlan; preview: ChangePreviewFile[] }
  | { ok: false; reason: string };

export function buildChangePlan(input: BuildChangePlanInput): BuildChangePlanResult {
  if (input.files.length === 0) return { ok: false, reason: "no-edits" };
  const seen = new Set<string>();
  const changedFiles: ChangeFileEdit[] = [];
  const fingerprintFiles: ChangeFileState[] = [];
  const preview: ChangePreviewFile[] = [];

  for (const raw of input.files) {
    const filePath = normalizePath(raw.path);
    if (seen.has(filePath)) return { ok: false, reason: "duplicate-path" };
    seen.add(filePath);
    if (isProtectedChangePath(filePath, input.root)) {
      return { ok: false, reason: "path-not-allowed" };
    }
    const beforeContent = input.contents.get(filePath);
    if (beforeContent === undefined) return { ok: false, reason: "file-not-readable" };
    const afterContent = applyTextEdits(beforeContent, raw.edits);
    if (afterContent === null) return { ok: false, reason: "invalid-edit" };
    const beforeHash = hashContent(beforeContent);
    if (afterContent === beforeContent) continue;
    changedFiles.push({ path: filePath, beforeContent, edits: raw.edits.map((edit) => ({ ...edit })) });
    fingerprintFiles.push({ path: filePath, exists: true, sha256: beforeHash });
    preview.push({
      path: filePath,
      beforeContent,
      afterContent,
      diff: diffLines(beforeContent, afterContent),
    });
  }

  if (changedFiles.length === 0) return { ok: false, reason: "no-changes" };

  const plan: ChangePlan = {
    id: input.id,
    kind: input.kind,
    createdAt: input.now ?? Date.now(),
    workspaceRoot: normalizePath(input.root),
    graphVersion: input.graphVersion,
    source: input.source,
    files: changedFiles,
    fingerprint: { files: fingerprintFiles, graphVersion: input.graphVersion },
  };
  if (input.target) plan.target = input.target;
  if (input.historyTargetId) plan.historyTargetId = input.historyTargetId;
  return { ok: true, plan, preview };
}

/** Recomputes the planned content of a file. */
export function fileAfterContent(file: ChangeFileEdit): string | null {
  return applyTextEdits(file.beforeContent, file.edits);
}

/** Preview for a stored task; the before content is part of the plan. */
export function materializePreview(task: ChangeTask): ChangePreviewFile[] {
  const preview: ChangePreviewFile[] = [];
  for (const file of task.plan.files) {
    const afterContent = fileAfterContent(file);
    if (afterContent === null) continue;
    preview.push({
      path: file.path,
      beforeContent: file.beforeContent,
      afterContent,
      diff: diffLines(file.beforeContent, afterContent),
    });
  }
  return preview;
}

export function summarizeTask(task: ChangeTask): ChangePlanSummary {
  const summary: ChangePlanSummary = {
    planId: task.plan.id,
    kind: task.plan.kind,
    status: task.status,
    createdAt: task.plan.createdAt,
    graphVersion: task.plan.graphVersion,
    files: [],
  };
  if (task.plan.target) summary.target = task.plan.target;
  if (task.reason) summary.reason = task.reason;
  if (task.historyId) summary.historyId = task.historyId;
  for (const file of task.plan.files) {
    const afterContent = fileAfterContent(file);
    const diff = afterContent === null ? null : diffLines(file.beforeContent, afterContent);
    summary.files.push({
      path: file.path,
      edits: file.edits.length,
      added: diff?.added ?? 0,
      removed: diff?.removed ?? 0,
    });
  }
  return summary;
}

/** Unified diff for a plan, for MCP responses and the Output channel. */
export function planDiff(task: ChangeTask): string {
  return materializePreview(task)
    .map((file) => [`--- ${file.path}`, file.diff.unified].join("\n"))
    .join("\n\n");
}
