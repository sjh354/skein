import { describe, expect, it } from "vitest";
import {
  buildExtractRefactor,
  buildInlineRefactor,
  buildMoveRefactor,
  type ReferenceLookup,
  type RefactorIo,
  type RefactorReference,
  type RefactorSymbol,
} from "@/analyzer/change/refactor";
import { applyTextEdits, type ChangeFileEdit } from "@/shared/change";

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

describe("move rule engine", () => {
  const sourcePath = "/repo/src/a.ts";
  const destinationPath = "/repo/src/b.ts";
  const otherPath = "/repo/src/other.ts";

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
    const dartSource = "/repo/lib/a.dart";
    const dartDestination = "/repo/lib/b.dart";
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
    const dartSource = "/repo/lib/a.dart";
    const dartDestination = "/repo/lib/b.dart";
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
      sourcePath: "/repo/lib/main.dart",
      destinationPath: "/repo/lib/moved.dart",
      symbol: symbol("main", 0, 0, { isExported: true }),
      io: io(
        { "/repo/lib/main.dart": main },
        { "/repo/lib/main.dart": [symbol("main", 0, 0, { isExported: true })] },
        { "/repo/lib/main.dart:main": { references: [] } },
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
      sourcePath: "/repo/lib/a.dart",
      content,
      symbols: [symbol("outer", 0, 4)],
      selection: { startLine: 2, startCharacter: 14, endLine: 2, endCharacter: 19 },
      name: "extracted",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = afterOf(result.build, "/repo/lib/a.dart", content);
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
      sourcePath: "/repo/src/a.ts",
      content,
      symbols: [symbol("outer", 0, 4)],
      selection: { startLine: 2, startCharacter: 14, endLine: 2, endCharacter: 19 },
      name: "extracted",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = afterOf(result.build, "/repo/src/a.ts", content);
    expect(after).toContain("const sum = extracted(a, b);");
    expect(after).toContain("function extracted(a, b) {");
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
      sourcePath: "/repo/src/a.ts",
      content,
      symbols: [symbol("outer", 0, 4)],
      selection: { startLine: 2, startCharacter: 2, endLine: 2, endCharacter: 20 },
      name: "logSum",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = afterOf(result.build, "/repo/src/a.ts", content);
    expect(after).toContain("logSum(a, b);");
    expect(after).toContain("function logSum(a, b) {");
  });
});

describe("inline", () => {
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
      sourcePath: "/repo/src/a.ts",
      content,
      symbol: symbol("twice", 0, 2),
      references: [reference("/repo/src/a.ts", 0, 9), reference("/repo/src/a.ts", 4, 10), reference("/repo/src/a.ts", 5, 10)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = afterOf(result.build, "/repo/src/a.ts", content);
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
      sourcePath: "/repo/src/a.ts",
      content,
      symbol: symbol("twice", 0, 2, { isExported: true }),
      references: [reference("/repo/src/a.ts", 3, 10)],
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
        sourcePath: "/repo/src/a.ts",
        content: multi,
        symbol: symbol("twice", 0, 3),
        references: [reference("/repo/src/a.ts", 4, 10)],
      }),
    ).toMatchObject({ ok: false, reason: "inline-multiple-returns" });

    expect(
      buildInlineRefactor({
        sourcePath: "/repo/src/a.ts",
        content,
        symbol: symbol("twice", 0, 2),
        references: [reference("/repo/src/b.ts", 1, 10)],
      }),
    ).toMatchObject({ ok: false, reason: "inline-external-references" });
  });
});
