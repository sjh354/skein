/**
 * The VS Code side of a change (DESIGN 8.2).
 *
 * `ChangeService` owns the plan/history/verification flow and only talks to the
 * editor through this interface, so the flow is unit-testable without loading
 * VS Code. The production implementation lives in `VSCodeChangeHost`.
 */

import type {
  ChangeDiagnosticSample,
  ChangeFileEdit,
  ChangeTextEdit,
} from "@/shared/change";
import type { ChangePreviewFile } from "@/analyzer/change/changePlan";

export interface RawRenameEdit {
  path: string;
  edits: ChangeTextEdit[];
}

export interface RenameResolution {
  files: RawRenameEdit[];
}

export type RenameFailure = {
  error:
    | "symbol-not-found"
    | "rename-provider-unavailable"
    | "rename-failed"
    | "unsupported-uri";
  message?: string;
};

export interface ChangeEditorHost {
  /** Asks the language service for all edits of a symbol rename. */
  resolveRename(input: {
    path: string;
    name: string;
    line: number;
    newName: string;
  }): Promise<RenameResolution | RenameFailure>;
  /** Saved (not editor-buffer) content, or null when the file is missing. */
  readSavedContent(path: string): Promise<string | null>;
  /** True when the file has unsaved editor changes. */
  isDirty(path: string): boolean;
  /** Applies the text edits to the workspace and saves the files. */
  applyEdits(files: ChangeFileEdit[]): Promise<{ ok: true } | { ok: false; reason: string }>;
  diagnostics(path: string): ChangeDiagnosticSample;
  /** Waits until diagnostics for the paths stop changing. */
  waitForDiagnostics(paths: string[], timeoutMs?: number): Promise<void>;
  /** Opens a diff per changed file; false when the user has no editor UI. */
  showPreview(planId: string, files: ChangePreviewFile[]): Promise<boolean>;
  confirm(message: string, detail?: string): Promise<boolean>;
  report(kind: "info" | "warning" | "error", message: string): void;
}
