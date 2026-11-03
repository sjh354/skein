/**
 * Task history persistence and interruption recovery (DESIGN 8.4, 9.2).
 *
 * One change runs at a time. The task file is updated before and after each
 * risky step so a process that dies during `applying` can be classified on the
 * next activation: untouched, fully applied, or partial. Only the extension
 * writes these files, under a history lock.
 */

import type { ChangeTask } from "@/shared/change";
import {
  changeLockPath,
  hashContent,
  listChangeTasks,
  writeChangeTask,
} from "@/shared/change";
import { withFileLock } from "@/shared/lock";
import { ensureSkeinWorkspace } from "@/shared/viewState";
import { fileAfterContent } from "./changePlan";
import { readFileState } from "./fingerprint";

export async function withChangeLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await ensureSkeinWorkspace(root);
  return withFileLock(changeLockPath(root), action);
}

export type RecoveryState = "before" | "after" | "partial";

export interface RecoveryReport {
  planId: string;
  /** `before` = nothing applied, `after` = all files match the plan, `partial` otherwise. */
  state: RecoveryState;
  /** Files whose content matches neither side. */
  files: string[];
}

export async function inspectTaskState(task: ChangeTask): Promise<RecoveryReport> {
  const beforeHashes = new Map(task.plan.fingerprint.files.map((file) => [file.path, file.sha256]));
  const differing: string[] = [];
  let allBefore = true;
  let allAfter = true;
  /* eslint-disable no-await-in-loop -- one stat/read per changed file */
  for (const file of task.plan.files) {
    const current = await readFileState(file.path);
    const beforeHash = beforeHashes.get(file.path) ?? null;
    const afterContent = fileAfterContent(file);
    const afterHash = afterContent === null ? null : hashContent(afterContent);
    if (current.sha256 !== beforeHash || current.exists !== (beforeHash !== null)) {
      allBefore = false;
    }
    if (current.sha256 !== afterHash || current.exists !== (afterHash !== null)) {
      allAfter = false;
      differing.push(file.path);
    }
  }
  /* eslint-enable no-await-in-loop */
  const state: RecoveryState = allBefore ? "before" : allAfter ? "after" : "partial";
  return { planId: task.plan.id, state, files: state === "partial" ? differing : [] };
}

/**
 * Called once on activation. Tasks left in `applying`/`verifying` are inspected
 * against the disk and moved to `recovery`; nothing is applied or rolled back
 * automatically.
 */
export async function recoverInterruptedTasks(root: string): Promise<RecoveryReport[]> {
  return withChangeLock(root, async () => {
    const tasks = await listChangeTasks(root);
    const reports: RecoveryReport[] = [];
    /* eslint-disable no-await-in-loop -- tasks are recovered in order */
    for (const task of tasks) {
      if (task.status !== "applying" && task.status !== "verifying") continue;
      const report = await inspectTaskState(task);
      task.status = "recovery";
      task.reason = `interrupted-${report.state}`;
      task.updatedAt = Date.now();
      await writeChangeTask(root, task);
      reports.push(report);
    }
    /* eslint-enable no-await-in-loop */
    return reports;
  });
}
