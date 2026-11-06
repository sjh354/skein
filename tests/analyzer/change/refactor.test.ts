import * as path from "node:path";
import { normalizePath } from "@/shared/path";
import { describe, expect, it } from "vitest";
import {
  buildExtractRefactor,
  buildInlineRefactor,
  buildMoveRefactor,
  mentionsModule,
  type ReferenceLookup,
  type RefactorIo,
  type RefactorReference,
  type RefactorSymbol,
} from "@/analyzer/change/refactor";
import { applyTextEdits, type ChangeFileEdit } from "@/shared/change";

const REPO = normalizePath(path.resolve("/repo"));

function symbol(
  name: string,
  startLine: number,
  endLine: number,
  options: Partial<RefactorSymbol> = {},
): RefactorSymbol {
  return {
    name,
    kind: "function",
    startLine,
    startCharacter: 0,
    endLine,
    endCharacter: 0,
    selectionLine: startLine,
    selectionCharacter: 0,
    isExported: false,
    ...options,
  };
}

function reference(path: string, line: number, character = 0): RefactorReference {
  return { path, line, character };
}

function io(
  files: Record<string, string>,
  symbols: Record<string, RefactorSymbol[]>,
  references: Record<string, ReferenceLookup>,
): RefactorIo {
  return {
    async listSymbols(filePath) {
      return symbols[filePath] ?? { error: "symbol-lookup-failed" };
    },
    async findReferences(symbolValue, filePath) {
      return references[`${filePath}:${symbolValue.name}`] ?? { references: [] };
    },
    async readFile(filePath) {
      return files[filePath] ?? null;
    },
  };
}

function afterOf(build: { files: ChangeFileEdit[] }, filePath: string, before: string): string {
  const file = build.files.find((item) => item.path === filePath);
  if (!file) return before;
  return applyTextEdits(before, file.edits) ?? "";
}

describe("mentionsModule", () => {
  it("matches imports, requires and config paths of the module, not look-alikes", () => {
    const file = "/repo/src/db.ts";
    expect(mentionsModule('import { q } from "./db";', file)).toBe(true);
    expect(mentionsModule("const m = require('../db.ts');", file)).toBe(true);
    expect(mentionsModule('await import(`@/db`)', file)).toBe(true);
    expect(mentionsModule('{ "main": "src/db.js" }', file)).toBe(true);
    expect(mentionsModule('import { q } from "./mydb";', file)).toBe(false);
    expect(mentionsModule('import { q } from "./dbx";', file)).toBe(false);
    expect(mentionsModule("const db = 1;", file)).toBe(false);
  });
});

describe("move deletes an emptied source", () => {
  const dbPath = `${REPO}/src/db.ts`;
  const viewPath = `${REPO}/src/view.ts`;
  const db = "export function query(sql: string) {\n  return sql;\n}\n";
  const view = 'import { query } from "./db";\n\nexport function render() {\n  return query("x");\n}\n';

  function moveQuery(
    mentions: RefactorIo["findPathMentions"] | undefined,
    source = dbPath,
    sourceContent = db,
  ) {
    const stem = source.replace(/^.*\//, "").replace(/\.ts$/, "");
    const base = io(
      { [source]: sourceContent, [viewPath]: view.replace("./db", `./${stem}`) },
      { [source]: [symbol("query", 0, 2, { isExported: true })], [viewPath]: [symbol("render", 2, 4, { isExported: true })] },
      { [`${source}:query`]: { references: [reference(source, 0), reference(viewPath, 0, 9), reference(viewPath, 3, 9)] } },
    );
    return buildMoveRefactor({
      sourcePath: source,
      destinationPath: viewPath,
      symbol: symbol("query", 0, 2, { isExported: true }),
      io: { ...base, ...(mentions ? { findPathMentions: mentions } : {}) },
    });
  }

  it("deletes the source when only files this move rewrites mentioned it", async () => {
    const result = await moveQuery(async () => [viewPath]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const source = result.build.files.find((file) => file.path === dbPath);
    expect(source).toMatchObject({ delete: true, edits: [] });
    expect(result.build.analysis?.notes?.join(" ")).toContain("deleted");
  });

  it("keeps the source when a file outside the plan still names it", async () => {
    const result = await moveQuery(async () => [viewPath, `${REPO}/package.json`]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const source = result.build.files.find((file) => file.path === dbPath);
    expect(source?.delete).toBeUndefined();
    expect(result.build.analysis?.notes?.join(" ")).toContain("package.json still refers to it");
  });

  it("keeps the source when mentions cannot be searched", async () => {
    for (const mentions of [undefined, async () => ({ error: "search-failed" })] as const) {
      const result = await moveQuery(mentions);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.build.files.find((file) => file.path === dbPath)?.delete).toBeUndefined();
    }
  });

  it("keeps an emptied entry file", async () => {
    const indexPath = `${REPO}/src/index.ts`;
    const result = await moveQuery(async () => [viewPath], indexPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.build.files.find((file) => file.path === indexPath)?.delete).toBeUndefined();
    expect(result.build.analysis?.notes?.join(" ")).toContain("entry file");
  });
});

describe("move rule engine", () => {
  const sourcePath = `${REPO}/src/a.ts`;
  const destinationPath = `${REPO}/src/b.ts`;
  const otherPath = `${REPO}/src/other.ts`;

  const source = [
    'import { gamma } from "./util";',
    "",
    "export function alpha(x: number) {",
    "  return _local(x) + gamma;",
    "}",
    "",
    "function _local(value: number) {",
    "  return value + 1;",
    "}",
    "",
    "function _shared() {",
    "  return 1;",
    "}",
    "",
    "export function beta() {",
    "  return _shared();",
    "}",
    "",
  ].join("\n");
  const other = 'import { alpha } from "./a";\n\nexport const value = alpha(1);\n';

  it("moves the target and private helpers used only by the bundle", async () => {
    const result = await buildMoveRefactor({
      sourcePath,
      destinationPath,
      symbol: symbol("alpha", 2, 4, { isExported: true }),
      io: io(
        { [sourcePath]: source, [otherPath]: other },
        {
          [sourcePath]: [
            symbol("alpha", 2, 4, { isExported: true }),
            symbol("_local", 6, 8),
            symbol("_shared", 10, 12),
            symbol("beta", 14, 16, { isExported: true }),
          ],
        },
        {
          [`${sourcePath}:alpha`]: {
            references: [
              reference(sourcePath, 2),
              reference(otherPath, 0, 9),
              reference(otherPath, 2, 21),
            ],
          },
          [`${sourcePath}:_local`]: { references: [reference(sourcePath, 3)] },
          [`${sourcePath}:_shared`]: { references: [reference(sourcePath, 15)] },
        },
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const decisions = new Map(result.build.analysis?.bundle?.map((item) => [item.name, item.decision]));
    expect(decisions.get("alpha")).toBe("moved");
    expect(decisions.get("_local")).toBe("moved");
    expect(decisions.get("_shared")).toBe("kept");

    const destination = afterOf(result.build, destinationPath, "");
    expect(destination).toContain('import { gamma } from "./util";');
    expect(destination).toContain("export function alpha");
    expect(destination).toContain("function _local");
    expect(destination).not.toContain("_shared");

    const remaining = afterOf(result.build, sourcePath, source);
    expect(remaining).not.toContain("function alpha");
    expect(remaining).not.toContain("function _local");
    expect(remaining).not.toContain("./util");
    expect(remaining).toContain("export function beta");

    const referencing = afterOf(result.build, otherPath, other);
    expect(referencing).toContain('from "./b"');
    const created = result.build.files.find((file) => file.path === destinationPath);
    expect(created?.create).toBe(true);
  });

  it("imports the destination at the top of a source that had no imports", async () => {
    const appPath = `${REPO}/src/app.ts`;
    const helperPath = `${REPO}/src/helper.ts`;
    const app = [
      "export function alpha(value: number): number {",
      "  return helper(value) + 1;",
      "}",
      "",
      "export function helper(value: number): number {",
      "  return value * 2;",
      "}",
      "",
      "export function beta(value: number): number {",
      "  return helper(value);",
      "}",
      "",
    ].join("\n");
    const result = await buildMoveRefactor({
      sourcePath: appPath,
      destinationPath: helperPath,
      symbol: symbol("helper", 4, 6, { isExported: true }),
      io: io(
        { [appPath]: app },
        { [appPath]: [symbol("alpha", 0, 2, { isExported: true }), symbol("helper", 4, 6, { isExported: true }), symbol("beta", 8, 10, { isExported: true })] },
        { [`${appPath}:helper`]: { references: [reference(appPath, 1, 9), reference(appPath, 4, 16), reference(appPath, 9, 9)] } },
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const remaining = afterOf(result.build, appPath, app);
    expect(remaining.startsWith('import { helper } from "./helper";\n')).toBe(true);
    expect(remaining).toContain("export function beta(value: number): number {\n  return helper(value);");
  });

  it("drops the destination's own import of the moved name", async () => {
    const dbPath = `${REPO}/src/db.ts`;
    const viewPath = `${REPO}/src/view.ts`;
    const db = "export function query(sql: string) {\n  return sql;\n}\n";
    const view = 'import { query } from "./db";\n\nexport function render() {\n  return query("x");\n}\n';
    const result = await buildMoveRefactor({
      sourcePath: dbPath,
      destinationPath: viewPath,
      symbol: symbol("query", 0, 2, { isExported: true }),
      io: io(
        { [dbPath]: db, [viewPath]: view },
        { [dbPath]: [symbol("query", 0, 2, { isExported: true })], [viewPath]: [symbol("render", 2, 4, { isExported: true })] },
        { [`${dbPath}:query`]: { references: [reference(dbPath, 0), reference(viewPath, 0, 9), reference(viewPath, 3, 9)] } },
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const destination = afterOf(result.build, viewPath, view);
    expect(destination).not.toContain('from "./db"');
    expect(destination).toContain("export function query");
    expect(destination).toContain("export function render");
  });

  it("keeps public helpers and imports them from the new file", async () => {
    const content = [
      "export function alpha() {",
      "  return helper();",
      "}",
      "",
      "export function helper() {",
      "  return 1;",
      "}",
      "",
      "export function beta() {",
      "  return helper();",
      "}",
      "",
    ].join("\n");
    const result = await buildMoveRefactor({
      sourcePath,
      destinationPath,
      symbol: symbol("alpha", 0, 2, { isExported: true }),
      io: io(
        { [sourcePath]: content },
        {
          [sourcePath]: [
            symbol("alpha", 0, 2, { isExported: true }),
            symbol("helper", 4, 6, { isExported: true }),
            symbol("beta", 8, 10, { isExported: true }),
          ],
        },
        {
          [`${sourcePath}:alpha`]: { references: [reference(sourcePath, 0)] },
          [`${sourcePath}:helper`]: {
            references: [reference(sourcePath, 1), reference(sourcePath, 9)],
          },
        },
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(afterOf(result.build, destinationPath, "")).toContain(
      'import { helper } from "./a";',
    );
  });

  it("blocks a Dart private helper that the moved code keeps using", async () => {
    const dartSource = `${REPO}/lib/a.dart`;
    const dartDestination = `${REPO}/lib/b.dart`;
    const content = [
      "void alpha() {",
      "  _helper();",
      "}",
      "",
      "void _helper() {}",
      "",
      "void beta() {",
      "  _helper();",
      "}",
      "",
    ].join("\n");
    const result = await buildMoveRefactor({
      sourcePath: dartSource,
      destinationPath: dartDestination,
      symbol: symbol("alpha", 0, 2, { isExported: true }),
      io: io(
        { [dartSource]: content },
        {
          [dartSource]: [
            symbol("alpha", 0, 2, { isExported: true }),
            symbol("_helper", 4, 4),
            symbol("beta", 6, 8, { isExported: true }),
          ],
        },
        {
          [`${dartSource}:alpha`]: { references: [reference(dartSource, 0)] },
          [`${dartSource}:_helper`]: {
            references: [reference(dartSource, 1), reference(dartSource, 7)],
          },
        },
      ),
    });
    expect(result).toMatchObject({ ok: false, reason: "access-restricted" });
  });

  it("moves a public Dart function and imports the kept helper library", async () => {
    const dartSource = `${REPO}/lib/a.dart`;
    const dartDestination = `${REPO}/lib/b.dart`;
    const content = [
      "void alpha() {",
      "  helper();",
      "}",
      "",
      "void helper() {}",
      "",
      "void beta() {",
      "  helper();",
      "}",
      "",
    ].join("\n");
    const result = await buildMoveRefactor({
      sourcePath: dartSource,
      destinationPath: dartDestination,
      symbol: symbol("alpha", 0, 2, { isExported: true }),
      io: io(
        { [dartSource]: content },
        {
          [dartSource]: [
            symbol("alpha", 0, 2, { isExported: true }),
            symbol("helper", 4, 4, { isExported: true }),
            symbol("beta", 6, 8, { isExported: true }),
          ],
        },
        {
          [`${dartSource}:alpha`]: { references: [reference(dartSource, 0)] },
          [`${dartSource}:helper`]: {
            references: [reference(dartSource, 1), reference(dartSource, 7)],
          },
        },
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const destination = afterOf(result.build, dartDestination, "");
    expect(destination).toContain("import './a.dart';");
    expect(destination).toContain("void alpha()");
    expect(afterOf(result.build, dartSource, content)).toContain("void beta()");
  });

  it("rejects a destination that already declares the name", async () => {
    const result = await buildMoveRefactor({
      sourcePath,
      destinationPath,
      symbol: symbol("alpha", 2, 4, { isExported: true }),
      io: io(
        { [sourcePath]: source, [destinationPath]: "export function alpha() {}\n" },
        {
          [sourcePath]: [symbol("alpha", 2, 4, { isExported: true })],
          [destinationPath]: [symbol("alpha", 0, 0, { isExported: true })],
        },
        { [`${sourcePath}:alpha`]: { references: [reference(sourcePath, 2)] } },
      ),
    });
    expect(result).toMatchObject({ ok: false, reason: "name-collision" });
  });

  it("rejects a move that would create a circular import", async () => {
    const content = [
      'import { fromB } from "./b";',
      "",
      "export function alpha() {",
      "  return helper() + fromB;",
      "}",
      "",
      "export function helper() {",
      "  return 1;",
      "}",
      "",
      "export function beta() {",
      "  return helper();",
      "}",
      "",
    ].join("\n");
    const destination = "export const fromB = 1;\n";
    const result = await buildMoveRefactor({
      sourcePath,
      destinationPath,
      symbol: symbol("alpha", 2, 4, { isExported: true }),
      io: io(
        { [sourcePath]: content, [destinationPath]: destination },
        {
          [sourcePath]: [
            symbol("alpha", 2, 4, { isExported: true }),
            symbol("helper", 6, 8, { isExported: true }),
            symbol("beta", 10, 12, { isExported: true }),
          ],
          [destinationPath]: [symbol("fromB", 0, 0, { isExported: true })],
        },
        {
          [`${sourcePath}:alpha`]: { references: [reference(sourcePath, 2)] },
          [`${sourcePath}:helper`]: {
            references: [reference(sourcePath, 3), reference(sourcePath, 11)],
          },
        },
      ),
    });
    expect(result).toMatchObject({ ok: false, reason: "circular-import" });
  });

  it("blocks entry points and unresolved reference imports", async () => {
    const main = "void main() {}\n";
    const entry = await buildMoveRefactor({
      sourcePath: `${REPO}/lib/main.dart`,
      destinationPath: `${REPO}/lib/moved.dart`,
      symbol: symbol("main", 0, 0, { isExported: true }),
      io: io(
        { [`${REPO}/lib/main.dart`]: main },
        { [`${REPO}/lib/main.dart`]: [symbol("main", 0, 0, { isExported: true })] },
        { [`${REPO}/lib/main.dart:main`]: { references: [] } },
      ),
    });
    expect(entry).toMatchObject({ ok: false, reason: "entry-point" });

    const unresolved = await buildMoveRefactor({
      sourcePath,
      destinationPath,
      symbol: symbol("alpha", 2, 4, { isExported: true }),
      io: io(
        { [sourcePath]: source, [otherPath]: "export const value = alpha(1);\n" },
        {
          [sourcePath]: [symbol("alpha", 2, 4, { isExported: true })],
        },
        {
          [`${sourcePath}:alpha`]: {
            references: [reference(sourcePath, 2), reference(otherPath, 0, 21)],
          },
        },
      ),
    });
    expect(unresolved).toMatchObject({ ok: false, reason: "unresolved-import" });
  });
});

describe("extract", () => {
  it("extracts a Dart expression with typed locals kept out of the parameters", () => {
    const content = [
      "int outer(int a) {",
      "  final b = 2;",
      "  final sum = a + b;",
      "  return sum;",
      "}",
      "",
    ].join("\n");
    const result = buildExtractRefactor({
      sourcePath: `${REPO}/lib/a.dart`,
      content,
      symbols: [symbol("outer", 0, 4)],
      selection: { startLine: 2, startCharacter: 14, endLine: 2, endCharacter: 19 },
      name: "extracted",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = afterOf(result.build, `${REPO}/lib/a.dart`, content);
    expect(after).toContain("final sum = extracted(a, b);");
    expect(after).toContain("dynamic extracted(a, b)");
  });

  it("extracts an expression with enclosing-function parameters", () => {
    const content = [
      "function outer(a: number) {",
      "  const b = 2;",
      "  const sum = a + b;",
      "  return sum;",
      "}",
      "",
    ].join("\n");
    const result = buildExtractRefactor({
      sourcePath: `${REPO}/src/a.ts`,
      content,
      symbols: [symbol("outer", 0, 4)],
      selection: { startLine: 2, startCharacter: 14, endLine: 2, endCharacter: 19 },
      name: "extracted",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = afterOf(result.build, `${REPO}/src/a.ts`, content);
    expect(after).toContain("const sum = extracted(a, b);");
    expect(after).toContain("function extracted(a: number, b: any) {");
    expect(after).toContain("return a + b;");
  });

  it("extracts statements and calls them with a semicolon", () => {
    const content = [
      "function outer(a: number) {",
      "  const b = 2;",
      "  console.log(a + b);",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const result = buildExtractRefactor({
      sourcePath: `${REPO}/src/a.ts`,
      content,
      symbols: [symbol("outer", 0, 4)],
      selection: { startLine: 2, startCharacter: 2, endLine: 2, endCharacter: 20 },
      name: "logSum",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = afterOf(result.build, `${REPO}/src/a.ts`, content);
    expect(after).toContain("logSum(a, b);");
    expect(after).toContain("function logSum(a: number, b: any) {");
  });
});

describe("extract declarations", () => {
  const content = [
    "function outer(a: number) {",
    "  const b = 2;",
    "  const sum = a + b;",
    "  return sum;",
    "}",
    "",
  ].join("\n");

  it("rejects a selection whose declaration is used after it", () => {
    const result = buildExtractRefactor({
      sourcePath: `${REPO}/src/a.ts`,
      content,
      symbols: [symbol("outer", 0, 4)],
      selection: { startLine: 1, startCharacter: 2, endLine: 2, endCharacter: 20 },
      name: "setup",
    });
    expect(result).toMatchObject({ ok: false, reason: "extract-declaration-used-after" });
  });

  it("keeps the enclosing parameter types on the extracted function", () => {
    const typed = [
      "function outer(a: number, label?: string, map: Map<string, number> = new Map()) {",
      "  const b = 2;",
      "  return a + b + label.length + map.size;",
      "}",
      "",
    ].join("\n");
    const result = buildExtractRefactor({
      sourcePath: `${REPO}/src/a.ts`,
      content: typed,
      symbols: [symbol("outer", 0, 3)],
      selection: { startLine: 2, startCharacter: 9, endLine: 2, endCharacter: 41 },
      name: "measure",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = afterOf(result.build, `${REPO}/src/a.ts`, typed);
    expect(after).toContain("function measure(a: number, b: any, label: string | undefined, map: Map<string, number>) {");
  });

  it("keeps relative indentation of a multi-line selection", () => {
    const body = [
      "function outer(a: number) {",
      "  const b = 2;",
      "  console.log(a + b);",
      "  console.log(b);",
      "  return 1;",
      "}",
      "",
    ].join("\n");
    const result = buildExtractRefactor({
      sourcePath: `${REPO}/src/a.ts`,
      content: body,
      symbols: [symbol("outer", 0, 5)],
      selection: { startLine: 2, startCharacter: 2, endLine: 3, endCharacter: 17 },
      name: "logBoth",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = afterOf(result.build, `${REPO}/src/a.ts`, body);
    expect(after).toContain("function logBoth(a: number, b: any) {\n  console.log(a + b);\n  console.log(b);\n}");
  });
});

describe("inline", () => {
  it("leaves a single trailing newline when the removed declaration was last", () => {
    const content = [
      "const a = twice(1);",
      "",
      "function twice(x: number) {",
      "  return x * 2;",
      "}",
      "",
    ].join("\n");
    const result = buildInlineRefactor({
      sourcePath: `${REPO}/src/a.ts`,
      content,
      symbol: symbol("twice", 2, 4),
      references: [reference(`${REPO}/src/a.ts`, 0, 10), reference(`${REPO}/src/a.ts`, 2, 9)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(afterOf(result.build, `${REPO}/src/a.ts`, content)).toBe("const a = ((1) * 2);\n");
  });

  it("keeps the declaration when only one of several calls is inlined", () => {
    const content = [
      "function twice(x: number) {",
      "  return x * 2;",
      "}",
      "",
      "const a = twice(1);",
      "const b = twice(a + 1);",
      "",
    ].join("\n");
    const result = buildInlineRefactor({
      sourcePath: `${REPO}/src/a.ts`,
      content,
      symbol: symbol("twice", 0, 2),
      references: [reference(`${REPO}/src/a.ts`, 0, 9), reference(`${REPO}/src/a.ts`, 4, 10), reference(`${REPO}/src/a.ts`, 5, 10)],
      callLine: 5,
      callCharacter: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = afterOf(result.build, `${REPO}/src/a.ts`, content);
    expect(after).toContain("function twice");
    expect(after).toContain("const a = twice(1);");
    expect(after).toContain("const b = ((a + 1) * 2);");
  });

  it("replaces every call of a single-expression function", () => {
    const content = [
      "function twice(x: number) {",
      "  return x * 2;",
      "}",
      "",
      "const a = twice(1);",
      "const b = twice(a + 1);",
      "",
    ].join("\n");
    const result = buildInlineRefactor({
      sourcePath: `${REPO}/src/a.ts`,
      content,
      symbol: symbol("twice", 0, 2),
      references: [reference(`${REPO}/src/a.ts`, 0, 9), reference(`${REPO}/src/a.ts`, 4, 10), reference(`${REPO}/src/a.ts`, 5, 10)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = afterOf(result.build, `${REPO}/src/a.ts`, content);
    expect(after).toContain("const a = ((1) * 2);");
    expect(after).toContain("const b = ((a + 1) * 2);");
    expect(after).not.toContain("function twice");
  });

  it("rejects exported, multi-return and external functions", () => {
    const content = [
      "export function twice(x: number) {",
      "  return x * 2;",
      "}",
      "const a = twice(1);",
      "",
    ].join("\n");
    const exported = buildInlineRefactor({
      sourcePath: `${REPO}/src/a.ts`,
      content,
      symbol: symbol("twice", 0, 2, { isExported: true }),
      references: [reference(`${REPO}/src/a.ts`, 3, 10)],
    });
    expect(exported).toMatchObject({ ok: false, reason: "inline-exported-unsupported" });

    const multi = [
      "function twice(x: number) {",
      "  if (x) return 1;",
      "  return 2;",
      "}",
      "const a = twice(1);",
      "",
    ].join("\n");
    expect(
      buildInlineRefactor({
        sourcePath: `${REPO}/src/a.ts`,
        content: multi,
        symbol: symbol("twice", 0, 3),
        references: [reference(`${REPO}/src/a.ts`, 4, 10)],
      }),
    ).toMatchObject({ ok: false, reason: "inline-multiple-returns" });

    expect(
      buildInlineRefactor({
        sourcePath: `${REPO}/src/a.ts`,
        content,
        symbol: symbol("twice", 0, 2),
        references: [reference(`${REPO}/src/b.ts`, 1, 10)],
      }),
    ).toMatchObject({ ok: false, reason: "inline-external-references" });
  });
});
