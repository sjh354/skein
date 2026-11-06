import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeService, describeReason } from "@/extension/services/ChangeService";
import type {
  ChangeEditorHost,
  ChangeReferenceLocation,
  ChangeSymbolInfo,
  RenameFailure,
  RenameResolution,
} from "@/extension/services/changeHost";
import { HistoryError, HistoryRepo } from "@/analyzer/change/historyRepo";
import { fileAfterContent } from "@/analyzer/change/changePlan";
import {
  applyTextEdits,
  hashContent,
  normalizeEol,
  readChangeHistory,
  readChangeTask,
  type ChangeDiagnosticSample,
  type ChangeFileEdit,
  type ChangeTask,
} from "@/shared/change";

import { normalizePath } from "@/shared/path";

const joinPath = (...parts: string[]) => normalizePath(path.join(...parts));

const logger = { debug: () => undefined, warn: () => undefined };

class FakeHost implements ChangeEditorHost {
  files = new Map<string, string>();
  dirty = new Set<string>();
  diagnosticsByPath = new Map<string, ChangeDiagnosticSample>();
  resolution: RenameResolution = { files: [] };
  resolveFailure: RenameFailure | null = null;
  symbols = new Map<string, ChangeSymbolInfo[]>();
  references = new Map<string, ChangeReferenceLocation[] | { error: string }>();
  openCount = 0;
  appliedCount = 0;
  waitCount = 0;
  /** Set a test to give the host a workspace-wide mention search; absent means unavailable. */
  findPathMentions?: (path: string) => Promise<string[] | { error: string }>;

  async resolveRename(): Promise<RenameResolution | RenameFailure> {
    return this.resolveFailure ?? this.resolution;
  }
  async listSymbols(filePath: string) {
    if (this.symbols.has(filePath)) return { symbols: this.symbols.get(filePath)! };
    return { error: "symbol-lookup-failed" };
  }
  async findReferences(_filePath: string, symbol: ChangeSymbolInfo) {
    const value = this.references.get(symbol.name);
    if (value === undefined) return { references: [] };
    return "error" in value ? value : { references: value };
  }
  async readSavedContent(filePath: string): Promise<string | null> {
    try {
      return normalizeEol(await fs.readFile(filePath, "utf8"));
    } catch {
      return null;
    }
  }
  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
  isDirty(filePath: string): boolean {
    return this.dirty.has(filePath);
  }
  async applyEdits(files: ChangeFileEdit[]): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.appliedCount += 1;
    for (const file of files) {
      if (file.delete) {
        await fs.rm(file.path, { force: true });
        this.files.delete(file.path);
        continue;
      }
      const before = this.files.get(file.path) ?? file.beforeContent;
      const after = applyTextEdits(before, file.edits);
      if (after === null) return { ok: false, reason: "invalid-edit" };
      this.files.set(file.path, after);
      await fs.writeFile(file.path, after, "utf8");
    }
    return { ok: true };
  }
  diagnostics(filePath: string): ChangeDiagnosticSample {
    return this.diagnosticsByPath.get(filePath) ?? { errors: 0, warnings: 0, messages: [] };
  }
  async waitForDiagnostics(): Promise<void> {
    this.waitCount += 1;
  }
  async openFiles(): Promise<void> {
    this.openCount += 1;
  }
  async confirm(): Promise<boolean> {
    return true;
  }
  report(): void {}
}

describe("ChangeService", () => {
  let root: string;
  let appPath: string;
  let otherPath: string;
  let host: FakeHost;
  let service: ChangeService;

  beforeEach(async () => {
    root = await fs.mkdtemp(joinPath(os.tmpdir(), "skein-change-service-"));
    await fs.mkdir(joinPath(root, "src"), { recursive: true });
    appPath = joinPath(root, "src", "app.ts");
    otherPath = joinPath(root, "src", "other.ts");
    const app = "export function alpha() {\n  return 1;\n}\n";
    const other = 'import { alpha } from "./app";\n\nexport const value = alpha();\n';
    await fs.writeFile(appPath, app, "utf8");
    await fs.writeFile(otherPath, other, "utf8");

    host = new FakeHost();
    host.files.set(appPath, app);
    host.files.set(otherPath, other);
    host.resolution = {
      files: [
        {
          path: appPath,
          edits: [{ startLine: 0, startCharacter: 16, endLine: 0, endCharacter: 21, newText: "gamma" }],
        },
        {
          path: otherPath,
          edits: [
            { startLine: 0, startCharacter: 9, endLine: 0, endCharacter: 14, newText: "gamma" },
            { startLine: 2, startCharacter: 21, endLine: 2, endCharacter: 26, newText: "gamma" },
          ],
        },
      ],
    };
    service = new ChangeService({ root, logger, host, sleep: async () => undefined });
    await service.start();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  async function plan(): Promise<ChangeTask> {
    const result = await service.planRename({
      nodeId: `${appPath}:alpha:0`,
      newName: "gamma",
      source: "mcp",
      graphVersion: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.task).toBeDefined();
    return result.task!;
  }

  it("creates a preview-ready plan without touching files", async () => {
    const task = await plan();
    expect(task.status).toBe("preview-ready");
    expect(task.plan.files).toHaveLength(2);
    expect(await fs.readFile(appPath, "utf8")).toContain("alpha");
    expect(host.appliedCount).toBe(0);
    expect((await readChangeTask(root, task.plan.id))?.plan.files).toHaveLength(2);
  });

  it("rejects a plan for a dirty editor", async () => {
    host.dirty.add(appPath);
    const result = await service.planRename({
      path: appPath,
      name: "alpha",
      line: 0,
      newName: "gamma",
      source: "ui",
      graphVersion: 1,
    });
    expect(result).toEqual({ ok: false, reason: "unsaved-changes", files: [appPath] });
  });

  it("applies the rename, records history and verifies diagnostics", async () => {
    const task = await plan();
    const result = await service.apply(task.plan.id);
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("succeeded");
    expect(result.history?.status).toBe("succeeded");
    expect(await fs.readFile(appPath, "utf8")).toContain("gamma");
    expect(await fs.readFile(otherPath, "utf8")).toContain("gamma");
    expect(host.openCount).toBe(0);
    const history = await readChangeHistory(root);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].beforeCommit).not.toBe(history.entries[0].afterCommit);
    expect(history.entries[0].files.every((file) => file.change === "modified")).toBe(true);
  });

  it("refuses to apply a stale plan", async () => {
    const task = await plan();
    await fs.writeFile(appPath, "export function alpha() {\n  return 2;\n}\n", "utf8");
    const result = await service.apply(task.plan.id);
    expect(result).toMatchObject({ ok: false, reason: "stale-plan", files: [appPath] });
    expect(await fs.readFile(appPath, "utf8")).toContain("return 2");
    expect(host.appliedCount).toBe(0);
  });

  it("does not apply when the before snapshot cannot be recorded", async () => {
    const failing = new (class extends HistoryRepo {
      override async snapshot(): Promise<string> {
        throw new HistoryError("git-unavailable", "no git");
      }
    })(root);
    service = new ChangeService({ root, logger, host, history: failing });
    const task = await plan();
    const result = await service.apply(task.plan.id);
    expect(result).toMatchObject({ ok: false, reason: "git-unavailable" });
    expect(host.appliedCount).toBe(0);
    expect(await fs.readFile(appPath, "utf8")).toContain("alpha");
    expect((await readChangeTask(root, task.plan.id))?.status).toBe("apply-failed");
  });

  it("records verification failures without rolling back", async () => {
    const task = await plan();
    host.diagnosticsByPath.set(appPath, { errors: 0, warnings: 0, messages: [] });
    const original = host.applyEdits.bind(host);
    host.applyEdits = async (files) => {
      const result = await original(files);
      host.diagnosticsByPath.set(appPath, { errors: 1, warnings: 0, messages: ["boom"] });
      return result;
    };
    const result = await service.apply(task.plan.id);
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("verification-failed");
    expect(result.task?.verification?.status).toBe("failed");
    expect(await fs.readFile(appPath, "utf8")).toContain("gamma");
  });

  it("undoes cleanly and preserves later edits", async () => {
    const task = await plan();
    await service.apply(task.plan.id);
    await fs.appendFile(appPath, "// later edit\n");
    host.files.set(appPath, `${host.files.get(appPath)}// later edit\n`);

    const result = await service.undo();
    expect(result.ok).toBe(true);
    const content = await fs.readFile(appPath, "utf8");
    expect(content).toContain("alpha");
    expect(content).toContain("// later edit");
    expect(await fs.readFile(otherPath, "utf8")).toContain("alpha");
    const history = await readChangeHistory(root);
    expect(history.entries.at(-1)?.kind).toBe("undo");
    expect(history.entries.at(-1)?.undoTargetId).toBe(history.entries[0].id);
  });

  it("reports a conflict and leaves the edit in place", async () => {
    const task = await plan();
    await service.apply(task.plan.id);
    const conflicting = "export function delta() {\n  return 1;\n}\n";
    await fs.writeFile(appPath, conflicting, "utf8");

    const result = await service.undo();
    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    expect(result.conflicts?.[0].path).toBe(appPath);
    expect(await fs.readFile(appPath, "utf8")).toBe(conflicting);
    expect((await readChangeHistory(root)).entries).toHaveLength(1);
  });

  it("re-applies an undone change", async () => {
    const task = await plan();
    await service.apply(task.plan.id);
    expect((await service.undo()).ok).toBe(true);
    expect(await fs.readFile(appPath, "utf8")).toContain("alpha");
    const result = await service.redo();
    expect(result.ok).toBe(true);
    expect(await fs.readFile(appPath, "utf8")).toContain("gamma");
    const history = await readChangeHistory(root);
    expect(history.entries.at(-1)?.kind).toBe("redo");
    expect(history.entries.at(-1)?.redoOfId).toBe(history.entries[1].id);
    expect((await service.redo()).reason).toBe("nothing-to-redo");
  });

  it("maps MCP requests to results", async () => {
    const planned = await service.handleRequest({
      id: "request-1",
      kind: "change",
      createdAt: 1,
      command: { action: "change_plan", kind: "rename", nodeId: `${appPath}:alpha:0`, newName: "gamma" },
    });
    expect(planned.status).toBe("applied");
    const planId = planned.task!.plan.id;

    const applied = await service.handleRequest({
      id: "request-2",
      kind: "change",
      createdAt: 2,
      command: { action: "change_apply", planId },
    });
    expect(applied.status).toBe("applied");
    expect(applied.task?.status).toBe("succeeded");

    const undone = await service.handleRequest({
      id: "request-3",
      kind: "change",
      createdAt: 3,
      command: { action: "change_undo" },
    });
    expect(undone.status).toBe("applied");

    const rejected = await service.handleRequest({
      id: "request-4",
      kind: "change",
      createdAt: 4,
      command: { action: "change_apply", planId: "missing" },
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.reason).toBe("plan-not-found");
  });

  it("returns the preview for a stored plan", async () => {
    const task = await plan();
    const preview = service.preview(task);
    expect(preview).toHaveLength(2);
    expect(preview[0].afterContent).toContain("gamma");
    expect(preview[0].diff.added).toBe(1);
  });

  it("rejects an unresolvable target and a provider failure", async () => {
    const noTarget = await service.planRename({
      nodeId: "bad",
      newName: "gamma",
      source: "ui",
      graphVersion: 1,
    });
    expect(noTarget.reason).toBe("target-not-found");

    host.resolveFailure = { error: "symbol-not-found" };
    const providerFailure = await service.planRename({
      path: appPath,
      name: "alpha",
      line: 0,
      newName: "gamma",
      source: "ui",
      graphVersion: 1,
    });
    expect(providerFailure.reason).toBe("symbol-not-found");
  });

  it("rejects a plan when an edited file cannot be read", async () => {
    await fs.rm(otherPath);
    const result = await service.planRename({
      path: appPath,
      name: "alpha",
      line: 0,
      newName: "gamma",
      source: "ui",
      graphVersion: 1,
    });
    expect(result).toMatchObject({ ok: false, reason: "file-not-readable", files: [otherPath] });
  });

  it("refuses to apply while the editor is dirty and only applies once", async () => {
    const task = await plan();
    host.dirty.add(appPath);
    expect((await service.apply(task.plan.id)).reason).toBe("unsaved-changes");
    host.dirty.clear();
    expect((await service.apply(task.plan.id)).ok).toBe(true);
    expect((await service.apply(task.plan.id)).reason).toBe("plan-not-ready");
  });

  it("marks a rejected edit as apply-failed", async () => {
    const task = await plan();
    host.applyEdits = async () => ({ ok: false, reason: "edit-rejected" });
    const result = await service.apply(task.plan.id);
    expect(result).toMatchObject({ ok: false, reason: "edit-rejected" });
    expect(result.task?.status).toBe("apply-failed");
  });

  it("marks a partially applied change as recovery", async () => {
    const task = await plan();
    host.applyEdits = async (files) => {
      const [first] = files;
      const after = applyTextEdits(first.beforeContent, first.edits);
      await fs.writeFile(first.path, after ?? "", "utf8");
      return { ok: true };
    };
    const result = await service.apply(task.plan.id);
    expect(result).toMatchObject({ ok: false, reason: "partial-apply" });
    expect(result.task?.status).toBe("recovery");
  });

  it("records an incomplete verification when diagnostics are unavailable", async () => {
    const task = await plan();
    host.waitForDiagnostics = async () => {
      throw new Error("no language service");
    };
    const result = await service.apply(task.plan.id);
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("incomplete");
    expect(result.task?.verification?.reason).toBe("diagnostics-unavailable");
  });

  it("keeps an applied change recoverable when the after snapshot fails", async () => {
    const repo = new (class extends HistoryRepo {
      private calls = 0;
      override async snapshot(label: string, paths: string[]): Promise<string> {
        if (this.calls === 0) {
          this.calls += 1;
          return super.snapshot(label, paths);
        }
        throw new HistoryError("history-record-failed", "boom");
      }
    })(root);
    service = new ChangeService({ root, logger, host, history: repo });
    const task = await plan();
    const result = await service.apply(task.plan.id);
    expect(result.reason).toBe("history-record-failed");
    expect(result.task?.status).toBe("incomplete");
    expect(await fs.readFile(appPath, "utf8")).toContain("gamma");
    expect((await readChangeHistory(root)).entries).toHaveLength(0);
  });

  it("returns nothing to undo or redo when the history is empty", async () => {
    expect((await service.undo()).reason).toBe("nothing-to-undo");
    expect((await service.redo()).reason).toBe("nothing-to-redo");
    const task = await plan();
    await service.apply(task.plan.id);
    expect((await service.undo()).ok).toBe(true);
    expect((await service.undo()).reason).toBe("nothing-to-undo");
  });

  it("returns an error result when the host throws during a request", async () => {
    host.resolveRename = async () => {
      throw new Error("boom");
    };
    const result = await service.handleRequest({
      id: "request-error",
      kind: "change",
      createdAt: 1,
      command: { action: "change_plan", kind: "rename", nodeId: `${appPath}:alpha:0`, newName: "gamma" },
    });
    expect(result.status).toBe("error");
    expect(result.reason).toBe("boom");
  });

  it("moves a symbol to a new file, records creation and restores it on undo", async () => {
    const movedPath = joinPath(root, "src", "moved.ts");
    const app = [
      "export function alpha(x: number) {",
      "  return helper(x);",
      "}",
      "",
      "export function helper(x: number) {",
      "  return x + 1;",
      "}",
      "",
      "export function beta() {",
      "  return helper(1);",
      "}",
      "",
    ].join("\n");
    const other = 'import { alpha } from "./app";\n\nexport const value = alpha(1);\n';
    await fs.writeFile(appPath, app, "utf8");
    await fs.writeFile(otherPath, other, "utf8");
    host.files.set(appPath, app);
    host.files.set(otherPath, other);
    host.symbols.set(appPath, [
      { name: "alpha", kind: "function", startLine: 0, startCharacter: 0, endLine: 2, endCharacter: 2, selectionLine: 0, selectionCharacter: 16, isExported: true },
      { name: "helper", kind: "function", startLine: 4, startCharacter: 0, endLine: 6, endCharacter: 2, selectionLine: 4, selectionCharacter: 16, isExported: true },
      { name: "beta", kind: "function", startLine: 8, startCharacter: 0, endLine: 10, endCharacter: 2, selectionLine: 8, selectionCharacter: 16, isExported: true },
    ]);
    host.symbols.set(otherPath, []);
    host.references.set("alpha", [
      { path: appPath, line: 0, character: 16 },
      { path: otherPath, line: 0, character: 9 },
      { path: otherPath, line: 2, character: 21 },
    ]);
    host.references.set("helper", [
      { path: appPath, line: 1, character: 9 },
      { path: appPath, line: 9, character: 9 },
    ]);

    const planned = await service.planMove({
      nodeId: `${appPath}:alpha:0`,
      newPath: movedPath,
      source: "mcp",
      graphVersion: 2,
    });
    expect(planned.ok).toBe(true);
    const task = planned.task!;
    expect(task.plan.kind).toBe("move");
    expect(task.plan.files.find((file) => file.path === movedPath)?.beforeContent).toBe("");

    const applied = await service.apply(task.plan.id);
    expect(applied.ok).toBe(true);
    expect(applied.history?.files.find((file) => file.path === movedPath)?.change).toBe("created");
    expect(await fs.readFile(movedPath, "utf8")).toContain('import { helper } from "./app";');
    expect(await fs.readFile(movedPath, "utf8")).toContain("export function alpha");
    expect(await fs.readFile(appPath, "utf8")).not.toContain("function alpha");
    expect(await fs.readFile(otherPath, "utf8")).toContain('from "./moved"');

    const undone = await service.undo();
    expect(undone.ok).toBe(true);
    await expect(fs.stat(movedPath)).rejects.toThrow();
    expect(await fs.readFile(appPath, "utf8")).toContain("function alpha");
    expect(await fs.readFile(otherPath, "utf8")).toContain('from "./app"');

    const redone = await service.redo();
    expect(redone.ok).toBe(true);
    expect(await fs.readFile(movedPath, "utf8")).toContain("function alpha");
  });

  it("deletes a source emptied by a move, restores it on undo and deletes it again on redo", async () => {
    const movedPath = joinPath(root, "src", "moved.ts");
    const app = "export function alpha(x: number) {\n  return x + 1;\n}\n";
    const other = 'import { alpha } from "./app";\n\nexport const value = alpha(1);\n';
    await fs.writeFile(appPath, app, "utf8");
    await fs.writeFile(otherPath, other, "utf8");
    host.symbols.set(appPath, [
      { name: "alpha", kind: "function", startLine: 0, startCharacter: 0, endLine: 2, endCharacter: 1, selectionLine: 0, selectionCharacter: 16, isExported: true },
    ]);
    host.symbols.set(otherPath, []);
    host.references.set("alpha", [
      { path: appPath, line: 0, character: 16 },
      { path: otherPath, line: 0, character: 9 },
      { path: otherPath, line: 2, character: 21 },
    ]);
    host.findPathMentions = async () => [otherPath];

    const planned = await service.planMove({ nodeId: `${appPath}:alpha:0`, newPath: movedPath, source: "mcp", graphVersion: 1 });
    expect(planned.ok).toBe(true);
    const applied = await service.apply(planned.task!.plan.id);
    expect(applied.ok).toBe(true);
    expect(applied.history?.files.find((file) => file.path === appPath)?.change).toBe("deleted");
    await expect(fs.stat(appPath)).rejects.toThrow();
    expect(await fs.readFile(otherPath, "utf8")).toContain('from "./moved"');

    expect((await service.undo()).ok).toBe(true);
    expect(await fs.readFile(appPath, "utf8")).toBe(app);
    await expect(fs.stat(movedPath)).rejects.toThrow();

    expect((await service.redo()).ok).toBe(true);
    await expect(fs.stat(appPath)).rejects.toThrow();
    expect(await fs.readFile(movedPath, "utf8")).toContain("function alpha");
  });

  it("extracts a selected expression and applies the plan", async () => {
    const content = [
      "function outer(a: number) {",
      "  const b = 2;",
      "  const sum = a + b;",
      "  return sum;",
      "}",
      "",
    ].join("\n");
    await fs.writeFile(appPath, content, "utf8");
    host.files.set(appPath, content);
    host.symbols.set(appPath, [
      { name: "outer", kind: "function", startLine: 0, startCharacter: 0, endLine: 4, endCharacter: 1, selectionLine: 0, selectionCharacter: 9, isExported: false },
    ]);
    const planned = await service.planExtract({
      path: appPath,
      selection: { startLine: 2, startCharacter: 14, endLine: 2, endCharacter: 19 },
      name: "extracted",
      source: "ui",
      graphVersion: 1,
    });
    expect(planned.ok).toBe(true);
    const applied = await service.apply(planned.task!.plan.id);
    expect(applied.ok).toBe(true);
    const after = await fs.readFile(appPath, "utf8");
    expect(after).toContain("const sum = extracted(a, b);");
    expect(after).toContain("function extracted(a: number, b: any)");
  });

  it("inlines a function at every call site", async () => {
    const content = [
      "function twice(x: number) {",
      "  return x * 2;",
      "}",
      "",
      "const a = twice(1);",
      "const b = twice(a + 1);",
      "",
    ].join("\n");
    await fs.writeFile(appPath, content, "utf8");
    host.files.set(appPath, content);
    host.symbols.set(appPath, [
      { name: "twice", kind: "function", startLine: 0, startCharacter: 0, endLine: 2, endCharacter: 1, selectionLine: 0, selectionCharacter: 9, isExported: false },
    ]);
    host.references.set("twice", [
      { path: appPath, line: 0, character: 9 },
      { path: appPath, line: 4, character: 10 },
      { path: appPath, line: 5, character: 10 },
    ]);
    const planned = await service.planInline({
      path: appPath,
      name: "twice",
      line: 0,
      source: "mcp",
      graphVersion: 1,
    });
    expect(planned.ok).toBe(true);
    const applied = await service.apply(planned.task!.plan.id);
    expect(applied.ok).toBe(true);
    const after = await fs.readFile(appPath, "utf8");
    expect(after).not.toContain("function twice");
    expect(after).toContain("const a = ((1) * 2);");
    expect(after).toContain("const b = ((a + 1) * 2);");
  });

  it("follows the active workspace area", async () => {
    const otherRoot = await fs.mkdtemp(joinPath(os.tmpdir(), "skein-other-area-"));
    try {
      await fs.mkdir(joinPath(otherRoot, "src"), { recursive: true });
      await fs.writeFile(joinPath(otherRoot, "src", "app.ts"), "alpha\n", "utf8");
      await service.setRoot(otherRoot);
      expect(service.getRoot()).toBe(otherRoot);
      expect(service.getRoot()).toBe(otherRoot);
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("describes known failure reasons", () => {
    expect(describeReason("stale-plan")).toContain("changed");
    expect(describeReason("rename-failed")).toContain("language extension");
    expect(describeReason("custom")).toBe("custom");
  });

  it("keeps the plan fingerprint aligned with normalized line endings", async () => {
    const crlf = "export function alpha() {\r\n  return 1;\r\n}\r\n";
    await fs.writeFile(appPath, crlf, "utf8");
    host.resolution = {
      files: [
        {
          path: appPath,
          edits: [{ startLine: 0, startCharacter: 16, endLine: 0, endCharacter: 21, newText: "gamma" }],
        },
      ],
    };
    const task = await plan();
    expect(task.plan.fingerprint.files[0].sha256).toBe(hashContent(crlf));
    const result = await service.apply(task.plan.id);
    expect(result.ok).toBe(true);
    expect(fileAfterContent(task.plan.files[0])).not.toBeNull();
  });

  it("blocks a change the architecture guard reports for a new rule violation", async () => {
    let calls = 0;
    service = new ChangeService({
      root,
      logger,
      host,
      sleep: async () => undefined,
      architectureGuard: {
        async check() {
          calls += 1;
          return {
            status: "blocked",
            checkedAt: 1,
            revision: "r",
            findings: [{ id: "dependency:rule:x", title: "rule", paths: [appPath], value: 1, baseline: "new" }],
          };
        },
      },
    });
    const task = await plan();
    const result = await service.apply(task.plan.id);
    expect(result).toMatchObject({ ok: false, reason: "architecture-blocked" });
    expect(calls).toBe(1);
    expect(host.appliedCount).toBe(0);
    expect(await fs.readFile(appPath, "utf8")).toContain("alpha");
  });

  it("does not block undo before apply even when its files carry a violation", async () => {
    let calls = 0;
    const violation = { id: "dependency:rule:x", title: "rule", paths: [appPath], value: 1, baseline: "new" as const };
    service = new ChangeService({
      root,
      logger,
      host,
      sleep: async () => undefined,
      architectureGuard: {
        async check() {
          calls += 1;
          // 1-2: the original apply; 3: undo pre-check sees the violation; 4: undo removes it.
          return calls === 3
            ? { status: "blocked", checkedAt: calls, revision: "r", findings: [violation] }
            : { status: "passed", checkedAt: calls, revision: "r", findings: [] };
        },
      },
    });
    const task = await plan();
    expect((await service.apply(task.plan.id)).ok).toBe(true);
    const undone = await service.undo();
    expect(undone.ok).toBe(true);
    expect(undone.task?.status).toBe("succeeded");
    expect(await fs.readFile(appPath, "utf8")).toContain("alpha");
  });

  it("records not-configured when the workspace has no architecture rules", async () => {
    service = new ChangeService({
      root,
      logger,
      host,
      sleep: async () => undefined,
      architectureGuard: { async check() { return { status: "not-configured", checkedAt: 1, findings: [] }; } },
    });
    const task = await plan();
    const result = await service.apply(task.plan.id);
    expect(result.task?.status).toBe("succeeded");
    expect(result.task?.verification?.architecture).toMatchObject({ status: "not-configured", findings: [] });
  });

  it("fails verification when the guard finds a confirmed violation after apply", async () => {
    let calls = 0;
    service = new ChangeService({
      root,
      logger,
      host,
      sleep: async () => undefined,
      architectureGuard: {
        async check() {
          calls += 1;
          return {
            status: "passed",
            checkedAt: calls,
            revision: "r",
            findings: calls === 1
              ? []
              : [{ id: "dependency:rule:x", title: "rule", paths: [appPath], value: 1, baseline: "new" }],
          };
        },
      },
    });
    const task = await plan();
    const result = await service.apply(task.plan.id);
    expect(result.task?.status).toBe("verification-failed");
    expect(result.task?.verification?.reason).toBe("architecture-violation");
    expect(result.task?.verification?.architecture).toMatchObject({
      status: "failed",
      findings: [{ id: "dependency:rule:x" }],
    });
  });
});
