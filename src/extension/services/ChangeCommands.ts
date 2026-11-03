/**
 * User-facing change commands (DESIGN 8.1, 9.3).
 *
 * Every command goes through the same plan → preview → apply path as an MCP
 * request, so a rename done by hand and one requested by an agent produce the
 * same history entry. The preview is a diff against the current file; nothing
 * is written before the modal confirmation.
 */

import * as vscode from "vscode";
import type { ChangeTask } from "@/shared/change";
import {
  canRedo,
  canUndo,
  readChangeHistory,
  summarizeHistoryEntry,
} from "@/shared/change";
import { summarizeTask } from "@/analyzer/change/changePlan";
import { ChangeService, describeReason, type ChangeResult } from "./ChangeService";
import type { ChangeEditorHost } from "./changeHost";

const MAX_HISTORY_ITEMS = 50;

export interface ChangeSelection {
  nodeId?: string;
  name?: string;
  path?: string;
  startLine?: number;
}

export interface ChangeCommandsOptions {
  service: ChangeService;
  host: ChangeEditorHost;
  logger: { warn(message: string, ...args: unknown[]): void };
  /** Current graph selection, or the last one published to state.json. */
  getSelection: () => ChangeSelection | undefined;
  getGraphVersion: () => number;
}

function fileSummary(task: ChangeTask): string {
  const summary = summarizeTask(task);
  return `${summary.files.length} file${summary.files.length === 1 ? "" : "s"} changed`;
}

function reportResult(options: ChangeCommandsOptions, result: ChangeResult, success: string): void {
  if (!result.ok) {
    options.host.report("warning", `Skein: ${describeReason(result.reason ?? "apply-failed")}`);
    return;
  }
  const status = result.task?.status;
  if (status === "succeeded") {
    options.host.report(
      "info",
      `Skein: ${success}. ${result.task ? fileSummary(result.task) : ""}. Undo is available.`,
    );
    return;
  }
  if (status === "verification-failed") {
    options.host.report(
      "warning",
      "Skein: The change was applied, but new errors appeared. Inspect the diff and undo if needed.",
    );
    return;
  }
  options.host.report(
    "warning",
    "Skein: The change was applied but verification is incomplete. Inspect the history before continuing.",
  );
}

export function registerChangeCommands(options: ChangeCommandsOptions): vscode.Disposable[] {
  const { service, host } = options;

  const rename = vscode.commands.registerCommand("skein.renameSymbol", async () => {
    const selection = options.getSelection();
    if (!selection?.path || !selection.name || selection.startLine === undefined) {
      host.report("warning", "Skein: Select a symbol in the call graph first.");
      return;
    }
    const newName = await vscode.window.showInputBox({
      prompt: `Rename "${selection.name}"`,
      value: selection.name,
      validateInput: (value) =>
        value.trim().length === 0 ? "The name cannot be empty." : undefined,
    });
    if (!newName || newName === selection.name) return;

    const planned = await service.planRename({
      nodeId: selection.nodeId,
      path: selection.path,
      name: selection.name,
      line: selection.startLine,
      newName,
      source: "ui",
      graphVersion: options.getGraphVersion(),
    });
    if (!planned.ok || !planned.task) {
      host.report("warning", `Skein: ${describeReason(planned.reason ?? "rename-failed")}`);
      return;
    }
    const task = planned.task;
    await host.showPreview(task.plan.id, service.preview(task));
    const summary = summarizeTask(task);
    const detail = summary.files
      .map((file) => `${vscode.workspace.asRelativePath(file.path)} (+${file.added} -${file.removed})`)
      .join("\n");
    const confirmed = await host.confirm(`Rename "${selection.name}" to "${newName}"?`, detail);
    if (!confirmed) return;

    const applied = await service.apply(task.plan.id);
    reportResult(options, applied, `Renamed to "${newName}"`);
  });

  const undo = vscode.commands.registerCommand("skein.undoLastChange", async () => {
    const result = await service.undo();
    reportResult(options, result, "Undid the last change");
  });

  const redo = vscode.commands.registerCommand("skein.redoLastChange", async () => {
    const result = await service.redo();
    reportResult(options, result, "Re-applied the change");
  });

  const history = vscode.commands.registerCommand("skein.showChangeHistory", async () => {
    const index = await readChangeHistory(service.getRoot());
    if (index.entries.length === 0) {
      host.report("info", "Skein: No tool changes have been recorded yet.");
      return;
    }
    const items = [...index.entries].reverse().slice(0, MAX_HISTORY_ITEMS).map((entry) => {
      const summary = summarizeHistoryEntry(entry);
      const actionable = canUndo(entry, index) ? "undo" : canRedo(entry, index) ? "redo" : "";
      return {
        label: `${entry.kind === "rename" ? "$(symbol-method)" : "$(history)"} ${summary.target?.newName ?? summary.target?.name ?? entry.planId}`,
        description: `${entry.status}${actionable ? ` · ${actionable} available` : ""}`,
        detail: `${new Date(entry.createdAt).toLocaleString()} · ${summary.files.length} file(s)`,
        entry,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: "Skein change history",
      placeHolder: "Select a change",
    });
    if (!picked) return;
    const indexNow = await readChangeHistory(service.getRoot());
    const entry = indexNow.entries.find((item) => item.id === picked.entry.id);
    if (!entry) return;
    const actions: Array<{ label: string; action: "undo" | "redo" }> = [];
    if (canUndo(entry, indexNow)) actions.push({ label: "Undo this change", action: "undo" });
    if (canRedo(entry, indexNow)) actions.push({ label: "Re-apply this change", action: "redo" });
    if (actions.length === 0) {
      host.report("info", "Skein: This entry has already been undone or re-applied.");
      return;
    }
    const pickedAction = await vscode.window.showQuickPick(actions, {
      title: "Skein change history",
      placeHolder: "Choose an action",
    });
    if (!pickedAction) return;
    const result =
      pickedAction.action === "undo" ? await service.undo(entry.id) : await service.redo(entry.id);
    reportResult(
      options,
      result,
      pickedAction.action === "undo" ? "Undid the change" : "Re-applied the change",
    );
  });

  return [rename, undo, redo, history];
}
