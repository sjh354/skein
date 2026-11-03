/**
 * VS Code implementation of `ChangeEditorHost` (DESIGN 8.2).
 *
 * Renames are resolved by the installed language service — the TypeScript
 * extension for TS/JS and the Dart extension for Dart — instead of a second
 * reimplementation. When no provider can answer, the failure is explicit so the
 * UI and MCP do not pretend the change is supported.
 */

import * as vscode from "vscode";
import * as path from "node:path";
import { normalizeEol, applyTextEdits } from "@/shared/change";
import type {
  ChangeDiagnosticSample,
  ChangeFileEdit,
  ChangeTextEdit,
} from "@/shared/change";
import type { ChangePreviewFile } from "@/analyzer/change/changePlan";
import { normalizePath } from "@/shared/path";
import type {
  ChangeEditorHost,
  ChangeReferenceLocation,
  ChangeReferenceLookup,
  ChangeSymbolInfo,
  ChangeSymbolLookup,
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
  kind: string;
  parentName?: string;
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
  0: "file",
  1: "module",
  2: "namespace",
  3: "package",
  4: "class",
  5: "method",
  6: "property",
  7: "field",
  8: "constructor",
  9: "enum",
  10: "interface",
  11: "function",
  12: "variable",
  13: "constant",
  14: "string",
  15: "number",
  16: "boolean",
  17: "array",
  18: "object",
  19: "key",
  20: "null",
  21: "enummember",
  22: "struct",
  23: "event",
  24: "operator",
  25: "typeparameter",
};

function symbolKindName(kind: number | undefined): string {
  return kind === undefined ? "unknown" : SYMBOL_KIND_NAMES[kind] ?? "unknown";
}

type DocumentLanguage = "typescript" | "javascript" | "dart" | "other";

function languageForDocument(document: vscode.TextDocument): DocumentLanguage {
  if (document.languageId === "typescript" || document.languageId === "typescriptreact") {
    return "typescript";
  }
  if (
    document.languageId === "javascript" ||
    document.languageId === "javascriptreact"
  ) {
    return "javascript";
  }
  if (document.languageId === "dart") return "dart";
  return "other";
}

/**
 * VS Code's DocumentSymbol does not expose module visibility, so read the
 * declaration line. Dart's library privacy is the leading underscore.
 */
function isExportedSymbol(
  document: vscode.TextDocument,
  language: DocumentLanguage,
  symbol: FlatSymbol,
): boolean {
  if (symbol.parentName) return false;
  if (language === "dart") return !symbol.name.startsWith("_");
  if (language === "typescript" || language === "javascript") {
    const line = symbol.range.start.line;
    if (line < 0 || line >= document.lineCount) return false;
    const text = document.lineAt(line).text.trim();
    return /^export\b/.test(text);
  }
  return !symbol.name.startsWith("_");
}

function flattenSymbols(
  symbols: ReadonlyArray<vscode.DocumentSymbol | vscode.SymbolInformation>,
  result: FlatSymbol[] = [],
  parentName?: string,
): FlatSymbol[] {
  for (const symbol of symbols) {
    if ("location" in symbol) {
      result.push({
        name: symbol.name,
        range: symbol.location.range,
        kind: symbolKindName(symbol.kind),
      });
    } else {
      const entry: FlatSymbol = {
        name: symbol.name,
        range: symbol.range,
        selectionRange: symbol.selectionRange,
        kind: symbolKindName(symbol.kind),
      };
      if (parentName) entry.parentName = parentName;
      result.push(entry);
      if (symbol.children.length > 0) flattenSymbols(symbol.children, result, symbol.name);
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

  async listSymbols(filePath: string): Promise<ChangeSymbolLookup> {
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    } catch (err) {
      return { error: "symbol-lookup-failed", message: String(err) };
    }
    let raw: Array<vscode.DocumentSymbol | vscode.SymbolInformation>;
    try {
      raw =
        (await vscode.commands.executeCommand<
          Array<vscode.DocumentSymbol | vscode.SymbolInformation>
        >("vscode.executeDocumentSymbolProvider", document.uri)) ?? [];
      // The language service may still be loading the project on the first
      // call; poll briefly instead of reporting an empty symbol list.
      /* eslint-disable no-await-in-loop -- warm-up polling is sequential */
      for (let attempt = 0; raw.length === 0 && attempt < 10; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        raw =
          (await vscode.commands.executeCommand<
            Array<vscode.DocumentSymbol | vscode.SymbolInformation>
          >("vscode.executeDocumentSymbolProvider", document.uri)) ?? [];
      }
      /* eslint-enable no-await-in-loop */
    } catch (err) {
      return { error: "symbol-lookup-failed", message: String(err) };
    }
    const language = languageForDocument(document);
    const symbols: ChangeSymbolInfo[] = flattenSymbols(raw).map((symbol) => {
      const info: ChangeSymbolInfo = {
        name: symbol.name,
        kind: symbol.kind,
        startLine: symbol.range.start.line,
        startCharacter: symbol.range.start.character,
        endLine: symbol.range.end.line,
        endCharacter: symbol.range.end.character,
        selectionLine: (symbol.selectionRange ?? symbol.range).start.line,
        selectionCharacter: (symbol.selectionRange ?? symbol.range).start.character,
        isExported: false,
      };
      if (symbol.parentName) {
        info.parentName = symbol.parentName;
      } else {
        info.isExported = isExportedSymbol(document, language, symbol);
      }
      return info;
    });
    return { symbols };
  }

  async findReferences(
    filePath: string,
    symbol: ChangeSymbolInfo,
  ): Promise<ChangeReferenceLookup> {
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    } catch (err) {
      return { error: "symbol-lookup-failed", message: String(err) };
    }
    let locations: vscode.Location[] | undefined;
    try {
      locations = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
        "vscode.executeReferenceProvider",
        document.uri,
        new vscode.Position(symbol.selectionLine, symbol.selectionCharacter),
      );
      if (!locations || locations.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        locations = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
          "vscode.executeReferenceProvider",
          document.uri,
          new vscode.Position(symbol.selectionLine, symbol.selectionCharacter),
        );
      }
    } catch (err) {
      return { error: "reference-provider-unavailable", message: String(err) };
    }
    if (!locations) return { error: "reference-provider-unavailable" };
    const references: ChangeReferenceLocation[] = [];
    const seen = new Set<string>();
    for (const location of locations) {
      if (location.uri.scheme !== "file") continue;
      const key = `${location.uri.fsPath}:${location.range.start.line}:${location.range.start.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({
        path: normalizePath(location.uri.fsPath),
        line: location.range.start.line,
        character: location.range.start.character,
      });
    }
    return { references };
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

  async exists(path: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(path));
      return true;
    } catch {
      return false;
    }
  }

  /** Closes editor tabs for a path the plan replaces or deletes. */
  private async closeTabsForPath(filePath: string): Promise<void> {
    const target = normalizePath(filePath);
    const groups = vscode.window.tabGroups?.all ?? [];
    const TabInput = (vscode as { TabInputText?: typeof vscode.TabInputText }).TabInputText;
    if (!TabInput) return;
    const tabs: vscode.Tab[] = [];
    for (const group of groups) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof TabInput &&
          input.uri.scheme === "file" &&
          normalizePath(input.uri.fsPath) === target
        ) {
          tabs.push(tab);
        }
      }
    }
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, true);
  }

  async applyEdits(files: ChangeFileEdit[]): Promise<{ ok: true } | { ok: false; reason: string }> {
    const editable: ChangeFileEdit[] = [];
    /* eslint-disable no-await-in-loop -- file operations run in plan order */
    for (const file of files) {
      const uri = vscode.Uri.file(file.path);
      if (file.delete) {
        await this.closeTabsForPath(file.path);
        try {
          await vscode.workspace.fs.delete(uri, { useTrash: false });
        } catch (err) {
          if ((err as { code?: string }).code !== "FileNotFound") {
            this.logger.warn(`[Change] could not delete ${file.path}:`, err);
            return { ok: false, reason: "delete-failed" };
          }
        }
        continue;
      }
      const fingerprintMissing = file.beforeContent === "";
      let created = false;
      if (fingerprintMissing) {
        // A tab left over from an earlier version of the file keeps a stale
        // mtime and makes the save fail with "File Modified Since".
        await this.closeTabsForPath(file.path);
        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          created = true;
        }
      }
      if (created) {
        const after = applyTextEdits(file.beforeContent, file.edits);
        if (after === null) return { ok: false, reason: "invalid-edit" };
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file.path)));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(after, "utf8"));
        continue;
      }
      editable.push(file);
    }
    /* eslint-enable no-await-in-loop */

    const documents: vscode.TextDocument[] = [];
    /* eslint-disable no-await-in-loop -- open each edited document in order */
    for (const file of editable) {
      try {
        documents.push(await vscode.workspace.openTextDocument(vscode.Uri.file(file.path)));
      } catch (err) {
        this.logger.warn(`[Change] could not open ${file.path}:`, err);
        return { ok: false, reason: "file-not-readable" };
      }
    }
    /* eslint-enable no-await-in-loop */
    const edit = new vscode.WorkspaceEdit();
    editable.forEach((file, position) => {
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
      const before = file.created
        ? this.preview.setBefore(planId, file.path, file.beforeContent)
        : vscode.Uri.file(file.path);
      const label = file.deleted ? "deleted" : file.created ? "created" : "planned";
      const title = `Skein: ${vscode.workspace.asRelativePath(file.path)} (${label})`;
      await vscode.commands.executeCommand(
        "vscode.diff",
        before,
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
