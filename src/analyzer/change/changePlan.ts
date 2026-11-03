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
  ChangeAnalysis,
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
  /** The file does not exist yet; its before state is an empty file. */
  create?: boolean;
  /** Remove the file instead of writing it. */
  delete?: boolean;
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
  analysis?: ChangeAnalysis;
  now?: number;
}

export interface ChangePreviewFile {
  path: string;
  beforeContent: string;
  afterContent: string;
  diff: LineDiff;
  /** The planned file state is "deleted". */
  deleted?: boolean;
  /** The planned file state is "created". */
  created?: boolean;
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
    const knownContent = input.contents.get(filePath);
    const beforeContent = raw.create ? (knownContent ?? "") : knownContent;
    if (beforeContent === undefined) return { ok: false, reason: "file-not-readable" };
    if (raw.delete && raw.create) return { ok: false, reason: "invalid-edit" };
    const afterContent = raw.delete ? null : applyTextEdits(beforeContent, raw.edits);
    if (!raw.delete && afterContent === null) return { ok: false, reason: "invalid-edit" };
    const beforeHash = hashContent(beforeContent);
    if (!raw.delete && afterContent === beforeContent) continue;
    const fileEdit: ChangeFileEdit = {
      path: filePath,
      beforeContent,
      edits: raw.delete ? [] : raw.edits.map((edit) => ({ ...edit })),
    };
    if (raw.delete) fileEdit.delete = true;
    changedFiles.push(fileEdit);
    fingerprintFiles.push({
      path: filePath,
      exists: !raw.create,
      sha256: raw.create ? null : beforeHash,
    });
    const previewFile: ChangePreviewFile = {
      path: filePath,
      beforeContent,
      afterContent: afterContent ?? "",
      diff: diffLines(beforeContent, afterContent ?? ""),
    };
    if (raw.delete) previewFile.deleted = true;
    if (raw.create) previewFile.created = true;
    preview.push(previewFile);
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
  if (input.analysis) plan.analysis = input.analysis;
  return { ok: true, plan, preview };
}

/** Recomputes the planned content of a file. */
export function fileAfterContent(file: ChangeFileEdit): string | null {
  if (file.delete) return null;
  return applyTextEdits(file.beforeContent, file.edits);
}

/** Preview for a stored task; the before content is part of the plan. */
export function materializePreview(task: ChangeTask): ChangePreviewFile[] {
  const preview: ChangePreviewFile[] = [];
  for (const file of task.plan.files) {
    const afterContent = fileAfterContent(file);
    if (afterContent === null && !file.delete) continue;
    const previewFile: ChangePreviewFile = {
      path: file.path,
      beforeContent: file.beforeContent,
      afterContent: afterContent ?? "",
      diff: diffLines(file.beforeContent, afterContent ?? ""),
    };
    if (file.delete) previewFile.deleted = true;
    const fingerprint = task.plan.fingerprint.files.find((item) => item.path === file.path);
    if (fingerprint?.exists === false) previewFile.created = true;
    preview.push(previewFile);
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
    const diff =
      afterContent === null && !file.delete
        ? null
        : diffLines(file.beforeContent, afterContent ?? "");
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
