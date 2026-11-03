/**
 * VS Code implementation of `ChangeEditorHost` (DESIGN 8.2).
 *
 * Renames are resolved by the installed language service — the TypeScript
 * extension for TS/JS and the Dart extension for Dart — instead of a second
 * reimplementation. When no provider can answer, the failure is explicit so the
 * UI and MCP do not pretend the change is supported.
 */

import * as vscode from "vscode";
import { normalizeEol } from "@/shared/change";
import type {
  ChangeDiagnosticSample,
  ChangeFileEdit,
  ChangeTextEdit,
} from "@/shared/change";
import type { ChangePreviewFile } from "@/analyzer/change/changePlan";
import type {
  ChangeEditorHost,
  RenameFailure,
  RenameResolution,
} from "./changeHost";
import { ChangePreviewProvider } from "./ChangePreviewProvider";

const MAX_PREVIEW_FILES = 5;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholeWordIndex(line: string, name: string): number {
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
  const match = pattern.exec(line);
  return match ? match.index : -1;
}

interface FlatSymbol {
  name: string;
  range: vscode.Range;
  /** The identifier itself; `range` includes modifiers such as `export`. */
  selectionRange?: vscode.Range;
}

function flattenSymbols(
  symbols: ReadonlyArray<vscode.DocumentSymbol | vscode.SymbolInformation>,
  result: FlatSymbol[] = [],
): FlatSymbol[] {
  for (const symbol of symbols) {
    if ("location" in symbol) {
      result.push({ name: symbol.name, range: symbol.location.range });
    } else {
      result.push({ name: symbol.name, range: symbol.range, selectionRange: symbol.selectionRange });
      if (symbol.children.length > 0) flattenSymbols(symbol.children, result);
    }
  }
  return result;
}

export interface VSCodeChangeHostOptions {
  /** Language services may still be loading their project on the first call. */
  warmupDelayMs?: number;
  retryDelayMs?: number;
  stableRounds?: number;
}

export class VSCodeChangeHost implements ChangeEditorHost {
  private readonly warmupDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly requiredStableRounds: number;

  constructor(
    private readonly preview: ChangePreviewProvider,
    private readonly logger: { warn(message: string, ...args: unknown[]): void },
    options: VSCodeChangeHostOptions = {},
  ) {
    this.warmupDelayMs = options.warmupDelayMs ?? 800;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.requiredStableRounds = options.stableRounds ?? 2;
  }

  async resolveRename(input: {
    path: string;
    name: string;
    line: number;
    newName: string;
  }): Promise<RenameResolution | RenameFailure> {
    const uri = vscode.Uri.file(input.path);
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      return { error: "symbol-not-found", message: String(err) };
    }
    const positions = await this.findIdentifierPositions(document, input.name, input.line);
    if (positions.length === 0) {
      return {
        error: "symbol-not-found",
        message: `Could not locate "${input.name}" at line ${input.line + 1}.`,
      };
    }
    let edit: vscode.WorkspaceEdit | undefined;
    let providerAnswered = false;
    let previousSignature = "";
    let stableRounds = 0;
    // A language server that is still loading its project answers the first
    // rename with an empty or single-file edit. Poll until the same result is
    // returned repeatedly instead of recording a partial rename.
    if (this.warmupDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.warmupDelayMs));
    }
    /* eslint-disable no-await-in-loop -- warm-up polling is sequential */
    for (let attempt = 0; attempt < 10; attempt += 1) {
      let candidate: vscode.WorkspaceEdit | undefined;
      for (const position of positions) {
        try {
          candidate = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
            "vscode.executeDocumentRenameProvider",
            uri,
            position,
            input.newName,
          );
        } catch (err) {
          return { error: "rename-provider-unavailable", message: String(err) };
        }
        // A provider asked at a modifier position can answer with an empty
        // edit; try the identifier position before reporting failure.
        if (candidate && candidate.entries().length > 0) break;
      }
      if (candidate) providerAnswered = true;
      const entries = candidate?.entries() ?? [];
      if (entries.length > 0) {
        edit = candidate;
        const signature = entries
          .map(([fileUri, edits]) =>
            `${fileUri.toString()}:${edits
              .map((item) => `${item.range.start.line}:${item.range.start.character}:${item.range.end.line}:${item.range.end.character}:${item.newText}`)
              .join("|")}`,
          )
          .join(";");
        stableRounds = signature === previousSignature ? stableRounds + 1 : 0;
        previousSignature = signature;
        if (stableRounds >= this.requiredStableRounds) break;
      }
      if (this.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
    /* eslint-enable no-await-in-loop */
    if (!edit) {
      // An empty answer means the provider exists but returned no edits; an
      // undefined answer means no provider is registered for this language.
      return providerAnswered
        ? { error: "rename-failed", message: "The provider returned no edits." }
        : { error: "rename-provider-unavailable" };
    }
    const files: Array<{ path: string; edits: ChangeTextEdit[] }> = [];
    for (const [fileUri, edits] of edit.entries()) {
      if (fileUri.scheme !== "file") return { error: "unsupported-uri" };
      files.push({
        path: fileUri.fsPath,
        edits: edits.map((textEdit) => ({
          startLine: textEdit.range.start.line,
          startCharacter: textEdit.range.start.character,
          endLine: textEdit.range.end.line,
          endCharacter: textEdit.range.end.character,
          newText: textEdit.newText,
        })),
      });
    }
    if (files.length === 0) return { error: "rename-failed", message: "The provider returned no edits." };
    return { files };
  }

  /**
   * Candidate positions, most precise first: the symbol's selection range, then
   * a whole-word match on the declaration line.
   */
  private async findIdentifierPositions(
    document: vscode.TextDocument,
    name: string,
    line: number,
  ): Promise<vscode.Position[]> {
    const positions: vscode.Position[] = [];
    try {
      const symbols = await vscode.commands.executeCommand<
        Array<vscode.DocumentSymbol | vscode.SymbolInformation>
      >("vscode.executeDocumentSymbolProvider", document.uri);
      const matching = flattenSymbols(symbols ?? []).filter((symbol) => symbol.name === name);
      const exact = matching.find((symbol) => symbol.range.start.line === line);
      const containing = matching.find(
        (symbol) => symbol.range.start.line <= line && symbol.range.end.line >= line,
      );
      const target = exact ?? containing;
      if (target) {
        positions.push(target.selectionRange?.start ?? target.range.start);
        positions.push(target.range.start);
      }
    } catch (err) {
      this.logger.warn("[Change] symbol lookup failed:", err);
    }
    if (line >= 0 && line < document.lineCount) {
      const index = wholeWordIndex(document.lineAt(line).text, name);
      if (index >= 0) positions.push(new vscode.Position(line, index));
    }
    const seen = new Set<string>();
    return positions.filter((position) => {
      const key = `${position.line}:${position.character}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async readSavedContent(path: string): Promise<string | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
      // VS Code positions count LF; normalize on the way in so a CRLF checkout
      // still matches the edits the language service returned.
      return normalizeEol(Buffer.from(bytes).toString("utf8"));
    } catch (err) {
      if ((err as { code?: string }).code === "FileNotFound") return null;
      return null;
    }
  }

  isDirty(path: string): boolean {
    const normalized = path.replaceAll("\\", "/");
    return vscode.workspace.textDocuments.some(
      (document) =>
        document.uri.scheme === "file" &&
        document.uri.fsPath.replaceAll("\\", "/") === normalized &&
        document.isDirty,
    );
  }

  async applyEdits(files: ChangeFileEdit[]): Promise<{ ok: true } | { ok: false; reason: string }> {
    const documents: vscode.TextDocument[] = [];
    /* eslint-disable no-await-in-loop -- open each edited document in order */
    for (const file of files) {
      try {
        documents.push(await vscode.workspace.openTextDocument(vscode.Uri.file(file.path)));
      } catch (err) {
        this.logger.warn(`[Change] could not open ${file.path}:`, err);
        return { ok: false, reason: "file-not-readable" };
      }
    }
    /* eslint-enable no-await-in-loop */
    const edit = new vscode.WorkspaceEdit();
    files.forEach((file, position) => {
      const document = documents[position];
      const edits = file.edits.map(
        (textEdit) =>
          new vscode.TextEdit(
            new vscode.Range(
              textEdit.startLine,
              textEdit.startCharacter,
              textEdit.endLine,
              textEdit.endCharacter,
            ),
            textEdit.newText,
          ),
      );
      edit.set(document.uri, edits);
    });
    const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
    if (!applied) return { ok: false, reason: "edit-rejected" };
    /* eslint-disable no-await-in-loop -- save the documents we just edited */
    for (const document of documents) {
      if (document.isDirty) {
        const saved = await document.save();
        if (!saved) return { ok: false, reason: "save-failed" };
      }
    }
    /* eslint-enable no-await-in-loop */
    return { ok: true };
  }

  diagnostics(path: string): ChangeDiagnosticSample {
    const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(path));
    let errors = 0;
    let warnings = 0;
    const messages: string[] = [];
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === vscode.DiagnosticSeverity.Error) errors += 1;
      else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) warnings += 1;
      if (messages.length < 20 && typeof diagnostic.message === "string") {
        messages.push(diagnostic.message);
      }
    }
    return { errors, warnings, messages };
  }

  async waitForDiagnostics(paths: string[], timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stable = 0;
    /* eslint-disable no-await-in-loop -- polling is the point */
    while (Date.now() < deadline) {
      const signature = paths.map((path) => JSON.stringify(this.diagnostics(path))).join("|");
      if (signature === previous) {
        stable += 1;
        if (stable >= 2) return;
      } else {
        previous = signature;
        stable = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    /* eslint-enable no-await-in-loop */
  }

  async showPreview(planId: string, files: ChangePreviewFile[]): Promise<boolean> {
    this.preview.clear();
    const shown = files.slice(0, MAX_PREVIEW_FILES);
    /* eslint-disable no-await-in-loop -- one diff editor per changed file */
    for (const file of shown) {
      const after = this.preview.set(planId, file.path, file.afterContent);
      const title = `Skein: ${vscode.workspace.asRelativePath(file.path)} (planned)`;
      await vscode.commands.executeCommand(
        "vscode.diff",
        vscode.Uri.file(file.path),
        after,
        title,
        { preview: true },
      );
    }
    /* eslint-enable no-await-in-loop */
    return shown.length > 0;
  }

  async confirm(message: string, detail?: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail },
      "Apply",
    );
    return choice === "Apply";
  }

  report(kind: "info" | "warning" | "error", message: string): void {
    if (kind === "error") void vscode.window.showErrorMessage(message);
    else if (kind === "warning") void vscode.window.showWarningMessage(message);
    else void vscode.window.showInformationMessage(message);
  }
}
