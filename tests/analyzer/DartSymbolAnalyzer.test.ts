import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizePath } from "@/shared/path";
import { DartSymbolAnalyzer } from "@/analyzer/languages/DartSymbolAnalyzer";
import { maskDart, parseDartDeclarations } from "@/analyzer/languages/dartSyntax";

const SAMPLE = `import 'package:flutter/material.dart';

const appName = 'ggultarae';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();

  void _privateHelper() {
    print("not a call to the scanner");
  }
}

class _HomePageState extends State<HomePage> {
  int count = 0;

  @override
  Widget build(BuildContext context) {
    increment();
    return Text(appName);
  }

  void increment() {
    count++;
    refresh();
  }

  void refresh() {}
}

Future<List<String>> loadItems() async {
  return fetchRemote();
}

Future<List<String>> fetchRemote() async => [];

void main() {
  runApp(const MyApp());
}
`;

describe("dartSyntax", () => {
  it("blanks comments and strings but keeps offsets and newlines", () => {
    const source = "// class Fake {}\nfinal a = 'class Hidden {}';\n/* nested /* class X {} */ */\nclass Real {}";

    const masked = maskDart(source);

    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
    expect(masked).not.toContain("Fake");
    expect(masked).not.toContain("Hidden");
    expect(masked).toContain("class Real");
  });

  it("finds fields, mixins, enums and typedefs without mistaking initializers for methods", () => {
    const source = [
      "typedef UserId = String;",
      "enum Role { admin, user }",
      "mixin Logging {",
      "  void log() {}",
      "}",
      "class Controller {",
      "  final items = <String>[];",
      "  late final client;",
      "  int count = 0;",
      "  Controller(this.client);",
      "}",
    ].join("\n");

    const declarations = parseDartDeclarations(source);
    const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));

    expect(byName.get("Role")).toMatchObject({ kind: "type" });
    expect(byName.get("UserId")).toMatchObject({ kind: "type" });
    expect(byName.get("Logging")).toMatchObject({ kind: "class" });
    expect(byName.get("log")).toMatchObject({ kind: "method", parentName: "Logging" });
    expect(byName.get("items")).toMatchObject({ kind: "variable", parentName: "Controller" });
    expect(byName.get("count")).toMatchObject({ kind: "variable", parentName: "Controller" });
    // `final items = <String>[];` must not become a method named after its initializer.
    expect(declarations.some((declaration) => declaration.name === "List")).toBe(false);
  });

  it("finds classes, members and top-level functions", () => {
    const declarations = parseDartDeclarations(SAMPLE);
    const names = declarations.map((declaration) => declaration.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "appName",
        "HomePage",
        "createState",
        "_privateHelper",
        "_HomePageState",
        "build",
        "increment",
        "refresh",
        "loadItems",
        "fetchRemote",
        "main",
      ]),
    );
    expect(declarations.find((declaration) => declaration.name === "increment")).toMatchObject({
      kind: "method",
      parentName: "_HomePageState",
      isExported: false,
    });
    expect(declarations.find((declaration) => declaration.name === "HomePage")).toMatchObject({
      kind: "class",
      isExported: true,
    });
  });
});

describe("DartSymbolAnalyzer", () => {
  let root: string;
  let file: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dart-symbols-"));
    file = normalizePath(path.join(root, "lib/home.dart"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SAMPLE);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns Dart declarations with stable ids and visibility", async () => {
    const analyzer = new DartSymbolAnalyzer(root);
    const symbols = await analyzer.analyzeFile(file);
    const byName = new Map([...symbols.values()].map((symbol) => [symbol.name, symbol]));

    expect(byName.get("HomePage")).toMatchObject({ kind: "Class", isExported: true, category: "class" });
    expect(byName.get("_HomePageState")).toMatchObject({ isExported: false });
    expect(byName.get("increment")).toMatchObject({
      category: "function",
      parentSymbolId: expect.stringContaining("_HomePageState"),
    });
    expect(byName.get("loadItems")?.line).toBe(33);
  });

  it("links calls whose target is declared in the same file", async () => {
    const analyzer = new DartSymbolAnalyzer(root);
    const dependencies = await analyzer.getSymbolDependencies(file);
    const pairs = dependencies.map((dependency) => `${dependency.sourceSymbolId}->${dependency.targetSymbolId}`);

    expect(pairs).toEqual(
      expect.arrayContaining([
        `${file}:_HomePageState.build->${file}:_HomePageState.increment`,
        `${file}:_HomePageState.increment->${file}:_HomePageState.refresh`,
        `${file}:loadItems->${file}:fetchRemote`,
      ]),
    );
    expect(dependencies.find((dependency) => dependency.sourceSymbolId.endsWith(".build"))?.line).toBe(21);
  });

  it("does not invent targets for calls it cannot resolve", async () => {
    const analyzer = new DartSymbolAnalyzer(root);
    const dependencies = await analyzer.getSymbolDependencies(file);

    // runApp, print and Text are not declared in this file.
    expect(dependencies.some((dependency) => dependency.targetSymbolId.includes("runApp"))).toBe(false);
    expect(dependencies.some((dependency) => dependency.targetSymbolId.includes("print"))).toBe(false);
  });
});
