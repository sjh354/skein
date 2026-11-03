import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTextEdits } from "@/shared/change";

const state = vi.hoisted(() => ({
  docs: new Map<string, string>(),
  dirty: new Set<string>(),
  saved: [] as string[],
  diagnostics: new Map<string, Array<{ severity: number; message: string }>>(),
  symbols: [] as unknown[],
  symbolError: null as string | null,
  rename: null as null | ((path: string, line: number, character: number) => unknown),
  renameError: null as string | null,
  renameCalls: [] as Array<{ path: string; line: number; character: number }>,
  applyResult: true,
  saveResult: true,
  openFailure: null as string | null,
  confirmChoice: "Apply" as string | undefined,
  diffCalls: [] as string[],
  reports: [] as Array<{ kind: string; message: string }>,
  provider: null as null | { provideTextDocumentContent(uri: unknown): string },
}));

vi.mock("vscode", () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }
  class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(start: Position | number, end: Position | number, endLine?: number, endCharacter?: number) {
      if (typeof start === "number" && typeof end === "number") {
        this.start = new Position(start, end);
        this.end = new Position(endLine ?? 0, endCharacter ?? 0);
      } else {
        this.start = start as Position;
        this.end = end as Position;
      }
    }
  }
  class TextEdit {
    constructor(
      public range: Range,
      public newText: string,
    ) {}
  }
  class WorkspaceEdit {
    private readonly files = new Map<string, { uri: unknown; edits: TextEdit[] }>();
    set(uri: { fsPath: string; scheme?: string }, edits: TextEdit[]): void {
      const normalized = uri.scheme ? uri : fileUri(uri.fsPath);
      this.files.set(uri.fsPath, { uri: normalized, edits });
    }
    entries(): Array<[unknown, TextEdit[]]> {
      return [...this.files.values()].map((file) => [file.uri, file.edits]);
    }
  }
  class DocumentSymbol {
    constructor(
      public name: string,
      public range: Range,
      public selectionRange: Range,
      public children: DocumentSymbol[] = [],
    ) {}
  }
  const fileUri = (filePath: string) => ({
    scheme: "file",
    fsPath: filePath,
    path: filePath,
    toString: () => `file://${filePath}`,
  });
  const documentFor = (filePath: string) => {
    const text = state.docs.get(filePath) ?? "";
    return {
      uri: fileUri(filePath),
      get lineCount() {
        return text.split("\n").length;
      },
      lineAt(line: number) {
        return { text: text.split("\n")[line] ?? "" };
      },
      getText() {
        return text;
      },
      get isDirty() {
        return state.dirty.has(filePath);
      },
      async save() {
        state.dirty.delete(filePath);
        state.saved.push(filePath);
        return state.saveResult;
      },
    };
  };
  return {
    Uri: {
      file: fileUri,
      parse: (value: string) => ({
        scheme: "skein-preview",
        fsPath: value,
        toString: () => value,
      }),
    },
    Position,
    Range,
    TextEdit,
    WorkspaceEdit,
    DocumentSymbol,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    workspace: {
      async openTextDocument(uri: { fsPath: string }) {
        if (state.openFailure === uri.fsPath) throw new Error("cannot open");
        if (!state.docs.has(uri.fsPath)) throw new Error("missing");
        return documentFor(uri.fsPath);
      },
      fs: {
        async readFile(uri: { fsPath: string }) {
          const text = state.docs.get(uri.fsPath);
          if (text === undefined) throw { code: "FileNotFound" };
          return Buffer.from(text, "utf8");
        },
        async stat(uri: { fsPath: string }) {
          if (!state.docs.has(uri.fsPath)) throw { code: "FileNotFound" };
          return {};
        },
        async writeFile(uri: { fsPath: string }, bytes: Uint8Array) {
          state.docs.set(uri.fsPath, Buffer.from(bytes).toString("utf8"));
        },
        async delete(uri: { fsPath: string }) {
          state.docs.delete(uri.fsPath);
        },
        async createDirectory() {
          return undefined;
        },
      },
      get textDocuments() {
        return [...state.docs.keys()].map(documentFor);
      },
      async applyEdit(edit: WorkspaceEdit) {
        if (!state.applyResult) return false;
        for (const [uri, edits] of edit.entries() as Array<[{ fsPath: string }, TextEdit[]]>) {
          const current = state.docs.get(uri.fsPath) ?? "";
          const mapped = edits.map((item) => ({
            startLine: item.range.start.line,
            startCharacter: item.range.start.character,
            endLine: item.range.end.line,
            endCharacter: item.range.end.character,
            newText: item.newText,
          }));
          const next = applyTextEdits(current, mapped);
          if (next === null) throw new Error("invalid edit");
          state.docs.set(uri.fsPath, next);
          state.dirty.add(uri.fsPath);
        }
        return true;
      },
      registerTextDocumentContentProvider(_scheme: string, provider: unknown) {
        state.provider = provider as { provideTextDocumentContent(uri: unknown): string };
        return { dispose: () => undefined };
      },
      asRelativePath(filePath: string) {
        return filePath;
      },
    },
    commands: {
      async executeCommand(name: string, ...args: unknown[]) {
        if (name === "vscode.executeDocumentSymbolProvider") {
          if (state.symbolError) throw new Error(state.symbolError);
          return state.symbols;
        }
        if (name === "vscode.executeDocumentRenameProvider") {
          const [, position, newName] = args as [
            { fsPath: string },
            { line: number; character: number },
            string,
          ];
          const first = args[0] as { fsPath: string };
          state.renameCalls.push({
            path: first.fsPath,
            line: position.line,
            character: position.character,
          });
          if (state.renameError) throw new Error(state.renameError);
          return state.rename?.(first.fsPath, position.line, position.character) ?? undefined;
        }
        if (name === "vscode.diff") {
          state.diffCalls.push(String(args[2]));
          return undefined;
        }
        return undefined;
      },
    },
    window: {
      async showWarningMessage(_message: string, _options: unknown, _action: string) {
        return state.confirmChoice;
      },
      async showErrorMessage(message: string) {
        state.reports.push({ kind: "error", message });
      },
      async showWarningMessage2(message: string) {
        state.reports.push({ kind: "warning", message });
      },
      async showInformationMessage(message: string) {
        state.reports.push({ kind: "info", message });
      },
    },
    languages: {
      getDiagnostics(uri: { fsPath: string }) {
        return state.diagnostics.get(uri.fsPath) ?? [];
      },
    },
  };
});

import { ChangePreviewProvider } from "@/extension/services/ChangePreviewProvider";
import { VSCodeChangeHost } from "@/extension/services/VSCodeChangeHost";
import type { ChangePreviewFile } from "@/analyzer/change/changePlan";

const logger = { warn: vi.fn() };
const APP = "/workspace/src/app.ts";
const OTHER = "/workspace/src/other.ts";

function previewFile(): ChangePreviewFile {
  return {
    path: APP,
    beforeContent: "alpha\n",
    afterContent: "beta\n",
    diff: { added: 1, removed: 1, unified: "-alpha\n+beta", truncated: false },
  };
}

function host(): VSCodeChangeHost {
  return new VSCodeChangeHost(new ChangePreviewProvider(), logger, {
    warmupDelayMs: 0,
    retryDelayMs: 0,
    stableRounds: 0,
  });
}

describe("VSCodeChangeHost", () => {
  it("recognizes an unsaved Windows document across drive-letter and separator representations", () => {
    const nativePath = String.raw`C:\workspace\src\app.ts`;
    state.docs.set(nativePath, "unsaved");
    state.dirty.add(nativePath);
    expect(host().isDirty("c:/workspace/src/app.ts")).toBe(true);
    expect(host().isDirty("c:/workspace/src/other.ts")).toBe(false);
  });

  beforeEach(() => {
    state.docs.clear();
    state.dirty.clear();
    state.saved.length = 0;
    state.diagnostics.clear();
    state.symbols = [];
    state.symbolError = null;
    state.rename = null;
    state.renameError = null;
    state.renameCalls.length = 0;
    state.applyResult = true;
    state.saveResult = true;
    state.openFailure = null;
    state.confirmChoice = "Apply";
    state.diffCalls.length = 0;
    state.reports.length = 0;
    state.docs.set(APP, "export function alpha() {}\n");
    state.docs.set(OTHER, 'import { alpha } from "./app";\n');
    logger.warn.mockClear();
  });

  it("resolves a rename with the symbol selection range and maps edits", async () => {
    const { DocumentSymbol, Range, Position, WorkspaceEdit, TextEdit } = await import("vscode");
    state.symbols = [
      new DocumentSymbol(
        "alpha",
        new Range(new Position(0, 0), new Position(0, 26)),
        new Range(new Position(0, 16), new Position(0, 21)),
      ),
    ];
    state.rename = () => {
      const edit = new WorkspaceEdit();
      edit.set({ fsPath: APP }, [
        new TextEdit(new Range(new Position(0, 16), new Position(0, 21)), "beta"),
      ]);
      edit.set({ fsPath: OTHER }, [
        new TextEdit(new Range(new Position(0, 9), new Position(0, 14)), "beta"),
      ]);
      return edit;
    };
    const result = await host().resolveRename({ path: APP, name: "alpha", line: 0, newName: "beta" });
    expect("files" in result && result.files).toHaveLength(2);
    expect(state.renameCalls[0]).toEqual({ path: APP, line: 0, character: 16 });
  });

  it("falls back to the declaration line when the symbol provider returns nothing", async () => {
    state.symbolError = "no symbols";
    const { Range, Position, WorkspaceEdit, TextEdit } = await import("vscode");
    state.rename = () => {
      const edit = new WorkspaceEdit();
      edit.set({ fsPath: APP }, [
        new TextEdit(new Range(new Position(0, 16), new Position(0, 21)), "beta"),
      ]);
      return edit;
    };
    const result = await host().resolveRename({ path: APP, name: "alpha", line: 0, newName: "beta" });
    expect("files" in result).toBe(true);
    expect(state.renameCalls[0].character).toBe(16);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("retries an empty answer before accepting a warmed-up edit", async () => {
    const { Range, Position, WorkspaceEdit, TextEdit } = await import("vscode");
    let attempt = 0;
    state.rename = () => {
      attempt += 1;
      if (attempt === 1) return new WorkspaceEdit();
      const edit = new WorkspaceEdit();
      edit.set({ fsPath: APP }, [
        new TextEdit(new Range(new Position(0, 16), new Position(0, 21)), "beta"),
      ]);
      return edit;
    };
    const result = await host().resolveRename({ path: APP, name: "alpha", line: 0, newName: "beta" });
    expect("files" in result).toBe(true);
    expect(attempt).toBe(2);
  });

  it("reports unavailable and empty rename providers explicitly", async () => {
    state.renameError = "no provider";
    expect(
      await host().resolveRename({ path: APP, name: "alpha", line: 0, newName: "beta" }),
    ).toMatchObject({ error: "rename-provider-unavailable" });

    state.renameError = null;
    state.rename = () => undefined;
    expect(
      await host().resolveRename({ path: APP, name: "alpha", line: 0, newName: "beta" }),
    ).toMatchObject({ error: "rename-provider-unavailable" });

    state.rename = () => ({ entries: () => [] });
    expect(
      await host().resolveRename({ path: APP, name: "alpha", line: 0, newName: "beta" }),
    ).toMatchObject({ error: "rename-failed" });
  });

  it("rejects edits in non-file documents", async () => {
    const { Range, Position, WorkspaceEdit, TextEdit } = await import("vscode");
    state.rename = () => {
      const edit = new WorkspaceEdit();
      edit.set({ scheme: "untitled", fsPath: "untitled:1" }, [
        new TextEdit(new Range(new Position(0, 0), new Position(0, 1)), "x"),
      ]);
      return edit;
    };
    expect(
      await host().resolveRename({ path: APP, name: "alpha", line: 0, newName: "beta" }),
    ).toMatchObject({ error: "unsupported-uri" });
  });

  it("reports a missing declaration", async () => {
    expect(
      await host().resolveRename({ path: APP, name: "missing", line: 0, newName: "beta" }),
    ).toMatchObject({ error: "symbol-not-found" });
  });

  it("reads saved content with normalized line endings and reports missing files", async () => {
    state.docs.set(APP, "a\r\nb\r\n");
    const service = host();
    expect(await service.readSavedContent(APP)).toBe("a\nb\n");
    expect(await service.readSavedContent("/workspace/none.ts")).toBeNull();
  });

  it("detects dirty editors", () => {
    state.dirty.add(APP);
    expect(host().isDirty(APP)).toBe(true);
    expect(host().isDirty(OTHER)).toBe(false);
  });

  it("applies and saves edits", async () => {
    const result = await host().applyEdits([
      {
        path: APP,
        beforeContent: "export function alpha() {}\n",
        edits: [{ startLine: 0, startCharacter: 16, endLine: 0, endCharacter: 21, newText: "beta" }],
      },
    ]);
    expect(result).toEqual({ ok: true });
    expect(state.docs.get(APP)).toContain("beta");
    expect(state.saved).toEqual([APP]);
  });

  it("reports rejected edits, unreadable files and failed saves", async () => {
    const edit = {
      path: APP,
      beforeContent: "x",
      edits: [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0, newText: "y" }],
    };
    state.applyResult = false;
    expect(await host().applyEdits([edit])).toEqual({ ok: false, reason: "edit-rejected" });

    state.applyResult = true;
    state.openFailure = APP;
    expect(await host().applyEdits([edit])).toEqual({ ok: false, reason: "file-not-readable" });

    state.openFailure = null;
    state.saveResult = false;
    expect(await host().applyEdits([edit])).toEqual({ ok: false, reason: "save-failed" });
  });

  it("summarizes diagnostics", async () => {
    state.diagnostics.set(APP, [
      { severity: 0, message: "error" },
      { severity: 1, message: "warning" },
      { severity: 2, message: "info" },
    ]);
    const sample = host().diagnostics(APP);
    expect(sample).toMatchObject({ errors: 1, warnings: 1 });
    expect(sample.messages).toEqual(["error", "warning", "info"]);
  });

  it("waits for diagnostics to settle", async () => {
    const started = Date.now();
    await host().waitForDiagnostics([APP], 2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("opens up to five preview diffs and serves the planned content", async () => {
    const files = Array.from({ length: 6 }, (_, index) => ({
      ...previewFile(),
      path: `/workspace/src/file${index}.ts`,
    }));
    const service = host();
    expect(await service.showPreview("plan-1", files)).toBe(true);
    expect(state.diffCalls).toHaveLength(5);
    expect(state.provider?.provideTextDocumentContent({ toString: () => "missing" })).toBe("");
  });

  it("asks for confirmation and reports messages", async () => {
    const service = host();
    expect(await service.confirm("Apply?")).toBe(true);
    state.confirmChoice = undefined;
    expect(await service.confirm("Apply?")).toBe(false);
    service.report("error", "bad");
    service.report("warning", "careful");
    service.report("info", "done");
  });
});

describe("ChangePreviewProvider", () => {
  it("stores and clears planned content", () => {
    const provider = new ChangePreviewProvider();
    const uri = provider.set("plan-1", APP, "beta\n");
    expect(provider.provideTextDocumentContent(uri)).toBe("beta\n");
    provider.clear();
    expect(provider.provideTextDocumentContent(uri)).toBe("");
    provider.dispose();
  });
});
