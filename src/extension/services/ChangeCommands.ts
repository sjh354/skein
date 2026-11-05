/**
 * User-facing change commands (DESIGN 8.1, 9.3).
 *
 * Every command goes through the same plan → preview → apply path as an MCP
 * request, so a rename done by hand and one requested by an agent produce the
 * same history entry. The preview is a diff against the current file; nothing
 * is written before the modal confirmation.
 */

import * as vscode from "vscode";
import * as path from "node:path";
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

  const previewAndApply = async (
    task: ChangeTask,
    title: string,
    detail: string,
    success: string,
  ): Promise<void> => {
    const confirmed = await host.confirm(title, detail);
    if (!confirmed) return;
    const applied = await service.apply(task.plan.id);
    reportResult(options, applied, success);
    if (applied.ok) await host.openFiles(summarizeTask(task).files.map((file) => file.path));
  };

  const planDetail = (task: ChangeTask): string => {
    const summary = summarizeTask(task);
    return summary.files
      .map((file) => `${vscode.workspace.asRelativePath(file.path)} (+${file.added} -${file.removed})`)
      .join("\n");
  };

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
    await previewAndApply(
      planned.task,
      `Rename "${selection.name}" to "${newName}"?`,
      planDetail(planned.task),
      `Renamed to "${newName}"`,
    );
  });

  const move = vscode.commands.registerCommand("skein.moveSymbol", async () => {
    const selection = options.getSelection();
    if (!selection?.path || !selection.name || selection.startLine === undefined) {
      host.report("warning", "Skein: Select a symbol in the call graph first.");
      return;
    }
    const destination = await vscode.window.showInputBox({
      prompt: `Move "${selection.name}" to a file`,
      value: vscode.workspace.asRelativePath(selection.path).replace(/[^/]+$/, "moved.ts"),
      placeHolder: "Workspace-relative or absolute path",
      validateInput: (value) => (value.trim().length === 0 ? "A destination is required." : undefined),
    });
    if (!destination) return;
    const newPath = path.isAbsolute(destination)
      ? destination
      : path.join(service.getRoot(), destination);

    const planned = await service.planMove({
      nodeId: selection.nodeId,
      path: selection.path,
      name: selection.name,
      line: selection.startLine,
      newPath,
      source: "ui",
      graphVersion: options.getGraphVersion(),
    });
    if (!planned.ok || !planned.task) {
      host.report("warning", `Skein: ${describeReason(planned.reason ?? "apply-failed")}`);
      return;
    }
    await previewAndApply(
      planned.task,
      `Move "${selection.name}" to ${vscode.workspace.asRelativePath(newPath)}?`,
      planDetail(planned.task),
      `Moved "${selection.name}"`,
    );
  });

  const extract = vscode.commands.registerCommand("skein.extractFunction", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      host.report("warning", "Skein: Select the code to extract in the editor first.");
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "Name of the extracted function",
      validateInput: (value) =>
        /^[A-Za-z_$][\w$]*$/.test(value) ? undefined : "Enter a valid identifier.",
    });
    if (!name) return;
    const range = editor.selection;
    const planned = await service.planExtract({
      path: editor.document.uri.fsPath,
      selection: {
        startLine: range.start.line,
        startCharacter: range.start.character,
        endLine: range.end.line,
        endCharacter: range.end.character,
      },
      name,
      source: "ui",
      graphVersion: options.getGraphVersion(),
    });
    if (!planned.ok || !planned.task) {
      host.report("warning", `Skein: ${describeReason(planned.reason ?? "apply-failed")}`);
      return;
    }
    await previewAndApply(
      planned.task,
      `Extract the selection as "${name}"?`,
      planDetail(planned.task),
      `Extracted "${name}"`,
    );
  });

  const inline = vscode.commands.registerCommand("skein.inlineFunction", async () => {
    const selection = options.getSelection();
    const editor = vscode.window.activeTextEditor;
    const target = selection?.path && selection.name && selection.startLine !== undefined
      ? selection
      : editor
        ? {
            path: editor.document.uri.fsPath,
            name: editor.document.getText(
              editor.document.getWordRangeAtPosition(editor.selection.active) ?? editor.selection,
            ),
            startLine: editor.selection.active.line,
          }
        : undefined;
    if (!target?.path || !target.name || target.startLine === undefined) {
      host.report("warning", "Skein: Put the cursor on a function call or select it in the graph.");
      return;
    }
    const planned = await service.planInline({
      path: target.path,
      name: target.name,
      line: target.startLine,
      source: "ui",
      graphVersion: options.getGraphVersion(),
    });
    if (!planned.ok || !planned.task) {
      host.report("warning", `Skein: ${describeReason(planned.reason ?? "apply-failed")}`);
      return;
    }
    await previewAndApply(
      planned.task,
      `Inline "${target.name}" at every call site?`,
      planDetail(planned.task),
      `Inlined "${target.name}"`,
    );
  });

  const undo = vscode.commands.registerCommand("skein.undoLastChange", async () => {
    const result = await service.undo();
    reportResult(options, result, "Undid the last change");
  });

  const redo = vscode.commands.registerCommand("skein.redoLastChange", async () => {
    const result = await service.redo();
    reportResult(options, result, "Re-applied the change");
    if (result.ok && result.task) {
      const paths = summarizeTask(result.task).files.map((file) => file.path);
      const existing = await Promise.all(paths.map(async (file) => ((await host.exists(file)) ? file : null)));
      await host.openFiles(existing.filter((file): file is string => file !== null));
    }
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
      const icon =
        entry.kind === "rename"
          ? "$(symbol-method)"
          : entry.kind === "move"
            ? "$(file-symlink-file)"
            : entry.kind === "extract"
              ? "$(symbol-function)"
              : entry.kind === "inline"
                ? "$(arrow-right)"
                : "$(history)";
      return {
        label: `${icon} ${summary.target?.newName ?? summary.target?.name ?? entry.planId}`,
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

  return [rename, move, extract, inline, undo, redo, history];
}
