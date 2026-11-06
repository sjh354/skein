/**
 * Move / extract / inline planning without VS Code types (DESIGN 8.1–8.3).
 *
 * The rule engine works on saved file text and on symbol/reference lookups the
 * editor host provides. It never silently guesses: an ambiguous reference, an
 * unresolved import, a private Dart symbol that would lose library access, or a
 * name collision stops the plan with an explicit reason.
 *
 * The result is a set of whole-file edits that feed the same plan → history →
 * apply → verify path as a rename.
 */

import * as path from "node:path";
import type {
  ChangeAnalysis,
  ChangeBundleDecision,
  ChangeTarget,
  ChangeTextEdit,
} from "@/shared/change";
import { replaceWholeFileEdit } from "@/shared/change";
import { normalizePath } from "@/shared/path";
import type { RawFileEdit } from "./changePlan";

export type RefactorLanguage = "typescript" | "javascript" | "dart" | "unknown";

export interface RefactorSymbol {
  name: string;
  /** VS Code symbol kind name, lower-cased (function, class, method, variable…). */
  kind: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  selectionLine: number;
  selectionCharacter: number;
  isExported: boolean;
  /** Enclosing class/interface name when the symbol is nested. */
  parentName?: string;
}

export interface RefactorReference {
  path: string;
  line: number;
  character: number;
}

export type ReferenceLookup =
  | { references: RefactorReference[] }
  | { error: string; message?: string };

export interface RefactorIo {
  listSymbols(filePath: string): Promise<RefactorSymbol[] | { error: string; message?: string }>;
  findReferences(symbol: RefactorSymbol, filePath: string): Promise<ReferenceLookup>;
  readFile(filePath: string): Promise<string | null>;
}

export interface RefactorBuild {
  files: RawFileEdit[];
  /** Saved content for every existing file the plan starts from. */
  contents: Map<string, string>;
  target: ChangeTarget;
  analysis?: ChangeAnalysis;
  /** Files the caller must confirm are saved (references and destination). */
  touchedFiles: string[];
}

export type RefactorResult =
  | { ok: true; build: RefactorBuild }
  | { ok: false; reason: string; files?: string[]; analysis?: ChangeAnalysis };

export function languageForPath(filePath: string): RefactorLanguage {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".ts" || extension === ".tsx" || extension === ".mts" || extension === ".cts") {
    return "typescript";
  }
  if (extension === ".js" || extension === ".jsx" || extension === ".mjs" || extension === ".cjs") {
    return "javascript";
  }
  if (extension === ".dart") return "dart";
  return "unknown";
}

function isTsLanguage(language: RefactorLanguage): boolean {
  return language === "typescript" || language === "javascript";
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

/** Joins lines into content that ends in exactly one newline, as editors with trimFinalNewlines save it. */
function joinLines(lines: string[]): string {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  return end === 0 ? "\n" : `${lines.slice(0, end).join("\n")}\n`;
}

function collapseBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blanks += 1;
      if (blanks > 2) continue;
    } else {
      blanks = 0;
    }
    result.push(line);
  }
  return result;
}

function removeLineRanges(lines: string[], ranges: Array<{ start: number; end: number }>): void {
  for (const range of ranges) {
    for (let line = range.start; line <= range.end && line < lines.length; line += 1) {
      lines[line] = `\u0000remove`;
    }
  }
}

function dropRemovedLines(lines: string[]): string[] {
  return lines.filter((line) => line !== `\u0000remove`);
}

function stripCommentsAndStrings(source: string, language: RefactorLanguage): string {
  let text = source;
  if (isTsLanguage(language)) {
    text = text.replace(/\/\*[\s\S]*?\*\//g, " ");
    text = text.replace(/\/\/[^\n]*/g, " ");
    text = text.replace(/`(?:\\.|[^`\\])*`/g, " ");
    text = text.replace(/"(?:\\.|[^"\\])*"/g, " ");
    text = text.replace(/'(?:\\.|[^'\\])*'/g, " ");
  } else if (language === "dart") {
    text = text.replace(/\/\*[\s\S]*?\*\//g, " ");
    text = text.replace(/\/\/[^\n]*/g, " ");
    text = text.replace(/'''[\s\S]*?'''/g, " ");
    text = text.replace(/"""[\s\S]*?"""/g, " ");
    text = text.replace(/'(?:\\.|[^'\\])*'/g, " ");
    text = text.replace(/"(?:\\.|[^"\\])*"/g, " ");
  }
  return text;
}

/** Identifiers used as values; property names after `.` are not included. */
export function collectIdentifierUsage(source: string, language: RefactorLanguage): Set<string> {
  const stripped = stripCommentsAndStrings(source, language);
  const names = new Set<string>();
  const pattern = /(^|[^.\w$])([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) names.add(match[2]);
  return names;
}

/** Identifiers declared in a text block (used to exclude locals from parameters). */
function collectDeclaredNames(source: string, language: RefactorLanguage): Set<string> {
  const stripped = stripCommentsAndStrings(source, language);
  const names = new Set<string>();
  const patterns: RegExp[] = [];
  if (isTsLanguage(language)) {
    patterns.push(/\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g);
    patterns.push(/\b(?:catch)\s*\(\s*([A-Za-z_$][\w$]*)/g);
  } else if (language === "dart") {
    patterns.push(/\b(?:final|var|const|late\s+final|late\s+var)\s+([A-Za-z_$][\w$]*)/g);
    patterns.push(
      /\b(?:int|double|String|bool|num|dynamic|Object|[A-Z][A-Za-z0-9_$]*(?:<[^>]+>)?\??)\s+([a-z_$][\w$]*)\s*=/g,
    );
    patterns.push(/\b(?:class|mixin|enum|typedef)\s+([A-Za-z_$][\w$]*)/g);
    patterns.push(/\bfor\s*\(\s*(?:final|var|const)?\s*[A-Za-z_$][\w$<>?, ]*\s+([A-Za-z_$][\w$]*)/g);
    patterns.push(/\b(?:final|const)\s+([A-Z_][\w$]*)\s*=/g);
  }
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stripped)) !== null) names.add(match[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

interface ImportedName {
  imported: string;
  local: string;
}

interface ImportStatement {
  startLine: number;
  endLine: number;
  text: string;
  specifier: string;
  isExport: boolean;
  sideEffect: boolean;
  defaultName?: string;
  namespaceName?: string;
  names: ImportedName[];
}

function parseTsClause(clause: string): {
  defaultName?: string;
  namespaceName?: string;
  names: ImportedName[];
} {
  let rest = clause.trim().replace(/^type\s+/, "");
  const result: { defaultName?: string; namespaceName?: string; names: ImportedName[] } = {
    names: [],
  };
  const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(rest);
  if (namespace) {
    result.namespaceName = namespace[1];
    rest = rest.replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, " ");
  }
  const named = /\{([\s\S]*?)\}/.exec(rest);
  if (named) {
    for (const part of named[1].split(",")) {
      const item = part.trim().replace(/^type\s+/, "");
      if (item.length === 0) continue;
      const [imported, local] = item.split(/\s+as\s+/);
      if (!imported || !/^[A-Za-z_$][\w$]*$/.test(imported)) continue;
      result.names.push({ imported, local: local ?? imported });
    }
    rest = rest.replace(/\{[\s\S]*?\}/, " ");
  }
  const first = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(rest);
  if (first && rest.trim() !== "*") result.defaultName = first[1];
  return result;
}

function parseImports(content: string, language: RefactorLanguage): ImportStatement[] {
  const lines = splitLines(content);
  const imports: ImportStatement[] = [];
  if (isTsLanguage(language)) {
    let index = 0;
    while (index < lines.length) {
      const trimmed = lines[index].trim();
      const isImport = trimmed.startsWith("import ");
      const isExportFrom = trimmed.startsWith("export ") && /\bfrom\s+["']/.test(trimmed);
      if (!isImport && !isExportFrom) {
        index += 1;
        continue;
      }
      const start = index;
      let text = lines[index];
      while (
        index + 1 < lines.length &&
        !/;\s*$/.test(text) &&
        !/["']\s*;?\s*$/.test(text) &&
        index - start < 40
      ) {
        index += 1;
        text = `${text}\n${lines[index]}`;
      }
      const fromMatch = /\bfrom\s+["']([^"']+)["']/.exec(text);
      const sideEffectMatch = /^import\s+["']([^"']+)["']/.exec(text.trim());
      const specifier = fromMatch?.[1] ?? sideEffectMatch?.[1];
      if (specifier) {
        const clauseMatch = /\b(?:import|export)\s+([\s\S]*?)\s+from\s+["'][^"']+["']/.exec(
          text,
        );
        const clause = clauseMatch?.[1] ?? "";
        const parsed = parseTsClause(clause);
        const statement: ImportStatement = {
          startLine: start,
          endLine: index,
          text,
          specifier,
          isExport: trimmed.startsWith("export "),
          sideEffect: !fromMatch && Boolean(sideEffectMatch),
          names: parsed.names,
        };
        if (parsed.defaultName) statement.defaultName = parsed.defaultName;
        if (parsed.namespaceName) statement.namespaceName = parsed.namespaceName;
        imports.push(statement);
      }
      index += 1;
    }
    return imports;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith("import ") && !trimmed.startsWith("export ")) continue;
    const match = /^(import|export)\s+["']([^"']+)["']/.exec(trimmed);
    if (!match) continue;
    let end = index;
    while (end + 1 < lines.length && !/;\s*$/.test(lines[end]) && end - index < 20) end += 1;
    imports.push({
      startLine: index,
      endLine: end,
      text: lines.slice(index, end + 1).join("\n"),
      specifier: match[2],
      isExport: match[1] === "export",
      sideEffect: false,
      names: [],
    });
    index = end;
  }
  return imports;
}

function stripExtension(value: string): string {
  return value.replace(/\.(?:d\.ts|tsx?|jsx?|mts|cts|mjs|cjs)$/i, "");
}

function relativeTsSpecifier(fromFile: string, toFile: string): string {
  let relative = normalizePath(path.relative(path.dirname(fromFile), toFile));
  relative = stripExtension(relative).replace(/\/index$/i, "");
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

function resolveRelativePath(importerPath: string, specifier: string): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  return normalizePath(path.resolve(path.dirname(importerPath), specifier));
}

function tsSpecifierMatches(importerPath: string, specifier: string, targetPath: string): boolean {
  const resolved = resolveRelativePath(importerPath, specifier);
  if (!resolved) return false;
  const target = stripExtension(normalizePath(targetPath));
  const candidate = stripExtension(resolved);
  if (candidate === target) return true;
  return stripExtension(`${resolved.replace(/\/index$/i, "")}`) === target;
}

function importResolvesTo(
  importerPath: string,
  specifier: string,
  targetPath: string,
  language: RefactorLanguage,
): boolean {
  if (isTsLanguage(language)) return tsSpecifierMatches(importerPath, specifier, targetPath);
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  const resolved = normalizePath(path.resolve(path.dirname(importerPath), specifier));
  return resolved === normalizePath(targetPath);
}

function relativeDartUri(fromFile: string, toFile: string): string {
  let relative = normalizePath(path.relative(path.dirname(fromFile), toFile));
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

function rebaseDartUri(uri: string, fromFile: string, toFile: string): string {
  if (uri.startsWith("dart:") || uri.startsWith("package:")) return uri;
  const resolved = path.resolve(path.dirname(fromFile), uri);
  return relativeDartUri(toFile, resolved);
}

function rewriteSpecifier(text: string, specifier: string): string {
  return text.replace(/(["'])([^"']+)(["'])/, `$1${specifier}$3`);
}

function renderTsImport(
  specifier: string,
  names: ImportedName[],
  defaultName?: string,
  namespaceName?: string,
  isExport = false,
): string {
  const parts: string[] = [];
  if (defaultName) parts.push(defaultName);
  if (namespaceName) parts.push(`* as ${namespaceName}`);
  if (names.length > 0) {
    parts.push(
      `{ ${names
        .map((item) => (item.imported === item.local ? item.imported : `${item.imported} as ${item.local}`))
        .join(", ")} }`,
    );
  }
  return `${isExport ? "export" : "import"} ${parts.join(", ")} from "${specifier}";`;
}

function renderDartImport(specifier: string, isExport = false): string {
  return `${isExport ? "export" : "import"} '${specifier}';`;
}

/** Inserts import lines after the last existing import. */
function insertImports(lines: string[], imports: string[]): string[] {
  if (imports.length === 0) return lines;
  let last = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("import ") || trimmed.startsWith("export ")) last = index;
  }
  const result = [...lines];
  result.splice(last + 1, 0, ...imports);
  return result;
}

function removeTsUnusedImports(
  lines: string[],
  language: RefactorLanguage,
  used: Set<string>,
): string[] {
  const content = lines.join("\n");
  const imports = parseImports(content, language);
  const remove: Array<{ startLine: number; endLine: number }> = [];
  const replace = new Map<number, { endLine: number; text: string }>();
  for (const statement of imports) {
    if (statement.sideEffect || statement.isExport) continue;
    const names = statement.names.filter((item) => used.has(item.local));
    const defaultUsed = statement.defaultName ? used.has(statement.defaultName) : false;
    const namespaceUsed = statement.namespaceName ? used.has(statement.namespaceName) : false;
    if (names.length === 0 && !defaultUsed && !namespaceUsed) {
      remove.push({ startLine: statement.startLine, endLine: statement.endLine });
      continue;
    }
    if (names.length !== statement.names.length) {
      replace.set(statement.startLine, {
        endLine: statement.endLine,
        text: renderTsImport(
          statement.specifier,
          names,
          defaultUsed ? statement.defaultName : undefined,
          namespaceUsed ? statement.namespaceName : undefined,
          statement.isExport,
        ),
      });
    }
  }
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (remove.some((range) => index >= range.startLine && index <= range.endLine)) continue;
    const replacement = replace.get(index);
    if (replacement) {
      result.push(replacement.text);
      index = replacement.endLine;
      continue;
    }
    result.push(lines[index]);
  }
  return result;
}

/** Text of a file with its import/export-from statements removed. */
function contentWithoutImports(content: string, language: RefactorLanguage): string {
  const lines = splitLines(content);
  const imports = parseImports(content, language);
  const remove = new Set<number>();
  for (const statement of imports) {
    for (let index = statement.startLine; index <= statement.endLine; index += 1) remove.add(index);
  }
  return lines.filter((_, index) => !remove.has(index)).join("\n");
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

const ENTRY_NAMES = new Set(["main", "build", "handler", "default"]);

function isMovableKind(kind: string): boolean {
  return [
    "function",
    "method",
    "class",
    "interface",
    "struct",
    "enum",
    "typealias",
    "type",
    "variable",
    "constant",
    "module",
    "namespace",
  ].includes(kind);
}

function symbolText(lines: string[], symbol: RefactorSymbol): string {
  return lines.slice(symbol.startLine, symbol.endLine + 1).join("\n");
}

function containsLine(symbol: RefactorSymbol, line: number): boolean {
  return symbol.startLine <= line && symbol.endLine >= line;
}

export interface MoveRefactorInput {
  sourcePath: string;
  destinationPath: string;
  symbol: RefactorSymbol;
  io: RefactorIo;
}

export async function buildMoveRefactor(input: MoveRefactorInput): Promise<RefactorResult> {
  const sourcePath = normalizePath(input.sourcePath);
  const destinationPath = normalizePath(input.destinationPath);
  const language = languageForPath(sourcePath);
  if (language === "unknown" || languageForPath(destinationPath) !== language) {
    return { ok: false, reason: "unsupported-language" };
  }
  if (sourcePath === destinationPath) return { ok: false, reason: "same-file" };

  const sourceContent = await input.io.readFile(sourcePath);
  if (sourceContent === null) return { ok: false, reason: "file-not-readable", files: [sourcePath] };
  const destinationContent = await input.io.readFile(destinationPath);
  const sourceLines = splitLines(sourceContent);
  const declaration = symbolText(sourceLines, input.symbol);
  if (declaration.trim().length === 0) return { ok: false, reason: "symbol-not-found" };
  if (!isMovableKind(input.symbol.kind)) return { ok: false, reason: "unsupported-symbol-kind" };
  if (input.symbol.parentName) return { ok: false, reason: "nested-symbol" };
  if (ENTRY_NAMES.has(input.symbol.name) || /\bexport\s+default\b/.test(declaration)) {
    return { ok: false, reason: "entry-point" };
  }
  if (language === "dart" && input.symbol.name.startsWith("_")) {
    return { ok: false, reason: "access-restricted" };
  }

  const sourceSymbols = await input.io.listSymbols(sourcePath);
  if ("error" in sourceSymbols) {
    return { ok: false, reason: sourceSymbols.error, files: [sourcePath] };
  }
  const topLevel = sourceSymbols.filter(
    (symbol) => !symbol.parentName && symbol.name !== input.symbol.name,
  );
  const destinationSymbols =
    destinationContent === null ? [] : await input.io.listSymbols(destinationPath);
  if ("error" in destinationSymbols) {
    return {
      ok: false,
      reason: destinationSymbols.error,
      files: [destinationPath],
    };
  }

  const bundle: RefactorSymbol[] = [input.symbol];
  const decisions = new Map<string, ChangeBundleDecision>();
  decisions.set(input.symbol.name, { name: input.symbol.name, decision: "moved", reason: "target" });
  const stay: RefactorSymbol[] = [];
  const pending = new Set(topLevel.map((symbol) => symbol.name));
  let changed = true;
  let rounds = 0;
  while (changed && rounds < 50) {
    changed = false;
    rounds += 1;
    const used = collectIdentifierUsage(
      bundle.map((symbol) => symbolText(sourceLines, symbol)).join("\n"),
      language,
    );
    for (const symbol of topLevel) {
      if (!pending.has(symbol.name) || !used.has(symbol.name)) continue;
      pending.delete(symbol.name);
      if (symbol.isExported) {
        stay.push(symbol);
        decisions.set(symbol.name, {
          name: symbol.name,
          decision: "kept",
          reason: "public-api",
        });
        continue;
      }
      if (language === "dart" && symbol.name.startsWith("_")) {
        decisions.set(symbol.name, {
          name: symbol.name,
          decision: "blocked",
          reason: "access-restricted",
        });
        return {
          ok: false,
          reason: "access-restricted",
          files: [sourcePath],
          analysis: { language, bundle: [...decisions.values()] },
        };
      }
      // eslint-disable-next-line no-await-in-loop -- candidates are checked in order
      const lookup = await input.io.findReferences(symbol, sourcePath);
      if ("error" in lookup) {
        return {
          ok: false,
          reason: lookup.error,
          files: [sourcePath],
          analysis: { language, bundle: [...decisions.values()] },
        };
      }
      const outside = lookup.references.filter(
        (reference) =>
          normalizePath(reference.path) !== sourcePath ||
          !bundle.some((item) => containsLine(item, reference.line)),
      );
      if (outside.length === 0) {
        bundle.push(symbol);
        decisions.set(symbol.name, {
          name: symbol.name,
          decision: "moved",
          reason: "only-used-by-bundle",
        });
        changed = true;
      } else {
        stay.push(symbol);
        decisions.set(symbol.name, {
          name: symbol.name,
          decision: "kept",
          reason: "used-outside-bundle",
        });
      }
    }
  }
  if (rounds >= 50) return { ok: false, reason: "bundle-too-large" };
  for (const name of pending) {
    decisions.set(name, { name, decision: "kept", reason: "not-used-by-bundle" });
  }

  const targetLookup = await input.io.findReferences(input.symbol, sourcePath);
  if ("error" in targetLookup) {
    return {
      ok: false,
      reason: targetLookup.error,
      files: [sourcePath],
      analysis: { language, bundle: [...decisions.values()] },
    };
  }

  const destinationNames = new Set(destinationSymbols.map((symbol) => symbol.name));
  for (const symbol of bundle) {
    if (destinationNames.has(symbol.name)) {
      return { ok: false, reason: "name-collision", files: [destinationPath] };
    }
  }

  const movedText = bundle.map((symbol) => symbolText(sourceLines, symbol)).join("\n\n");
  const movedUsed = collectIdentifierUsage(movedText, language);
  if (
    language === "dart" &&
    stay.some((symbol) => movedUsed.has(symbol.name) && symbol.name.startsWith("_"))
  ) {
    return {
      ok: false,
      reason: "access-restricted",
      files: [sourcePath, destinationPath],
      analysis: { language, bundle: [...decisions.values()] },
    };
  }
  const sourceImports = parseImports(sourceContent, language);
  const destinationImports = parseImports(destinationContent ?? "", language);

  const sourceImportsDest = sourceImports.some((statement) =>
    importResolvesTo(sourcePath, statement.specifier, destinationPath, language),
  );
  const destImportsSource = destinationImports.some((statement) =>
    importResolvesTo(destinationPath, statement.specifier, sourcePath, language),
  );

  const removedRanges = bundle.map((symbol) => ({
    start: symbol.startLine,
    end: symbol.endLine,
  }));
  const sourceWithoutMoved = sourceLines.map((line) => line);
  removeLineRanges(sourceWithoutMoved, removedRanges);
  const remainingSource = collapseBlankLines(dropRemovedLines(sourceWithoutMoved)).join("\n");
  const remainingUsed = collectIdentifierUsage(
    contentWithoutImports(remainingSource, language),
    language,
  );
  const sourceWillImportDest = bundle.some((symbol) => remainingUsed.has(symbol.name));
  const destWillImportSource = stay.some((symbol) => movedUsed.has(symbol.name));
  if (sourceWillImportDest && destWillImportSource) {
    return {
      ok: false,
      reason: "circular-import",
      files: [sourcePath, destinationPath],
      analysis: { language, bundle: [...decisions.values()] },
    };
  }
  if (sourceImportsDest && destWillImportSource) {
    return {
      ok: false,
      reason: "circular-import",
      files: [sourcePath, destinationPath],
      analysis: { language, bundle: [...decisions.values()] },
    };
  }
  if (destImportsSource && sourceWillImportDest) {
    return {
      ok: false,
      reason: "circular-import",
      files: [sourcePath, destinationPath],
      analysis: { language, bundle: [...decisions.values()] },
    };
  }

  // Destination imports: imports the moved code still needs, plus kept helpers.
  const destinationImportLines: string[] = [];
  if (isTsLanguage(language)) {
    for (const statement of sourceImports) {
      if (statement.sideEffect || statement.isExport) continue;
      const names = statement.names.filter((item) => movedUsed.has(item.local));
      const defaultUsed = statement.defaultName ? movedUsed.has(statement.defaultName) : false;
      const namespaceUsed = statement.namespaceName
        ? movedUsed.has(statement.namespaceName)
        : false;
      if (names.length === 0 && !defaultUsed && !namespaceUsed) continue;
      const resolved = resolveImportTarget(sourcePath, statement.specifier);
      const specifier =
        resolved === null ? statement.specifier : relativeTsSpecifier(destinationPath, resolved);
      destinationImportLines.push(
        renderTsImport(
          specifier,
          names,
          defaultUsed ? statement.defaultName : undefined,
          namespaceUsed ? statement.namespaceName : undefined,
        ),
      );
    }
    const keptNames = stay.filter((symbol) => movedUsed.has(symbol.name)).map((symbol) => symbol.name);
    if (keptNames.length > 0) {
      destinationImportLines.push(
        renderTsImport(relativeTsSpecifier(destinationPath, sourcePath), keptNames.map((name) => ({
          imported: name,
          local: name,
        }))),
      );
    }
  } else {
    for (const statement of sourceImports) {
      if (statement.isExport) continue;
      destinationImportLines.push(
        renderDartImport(rebaseDartUri(statement.specifier, sourcePath, destinationPath)),
      );
    }
    const keptNames = stay.filter((symbol) => movedUsed.has(symbol.name));
    if (keptNames.length > 0) {
      destinationImportLines.push(renderDartImport(relativeDartUri(destinationPath, sourcePath)));
    }
  }

  // Reference files must point their import at the destination.
  const referenceFiles = new Map<string, string>();
  for (const reference of targetLookup.references) {
    const referencePath = normalizePath(reference.path);
    if (referencePath === sourcePath || referencePath === destinationPath) continue;
    referenceFiles.set(referencePath, "");
  }
  const touchedFiles = [sourcePath, destinationPath, ...referenceFiles.keys()];
  const contents = new Map<string, string>([[sourcePath, sourceContent]]);
  if (destinationContent !== null) contents.set(destinationPath, destinationContent);
  const referenceAfter = new Map<string, string>();

  /* eslint-disable no-await-in-loop -- read and rewrite each reference file in order */
  for (const referencePath of referenceFiles.keys()) {
    const content = await input.io.readFile(referencePath);
    if (content === null) return { ok: false, reason: "file-not-readable", files: [referencePath] };
    contents.set(referencePath, content);
    const imports = parseImports(content, language);
    let changedFile = false;
    const referenceLines = splitLines(content);
    if (isTsLanguage(language)) {
      for (const statement of imports) {
        if (!importResolvesTo(referencePath, statement.specifier, sourcePath, language)) continue;
        const providesTarget =
          statement.names.some((item) => item.local === input.symbol.name) ||
          statement.defaultName === input.symbol.name ||
          statement.namespaceName === input.symbol.name;
        if (!providesTarget) continue;
        const replaced = rewriteSpecifier(
          statement.text,
          relativeTsSpecifier(referencePath, destinationPath),
        );
        referenceLines.splice(statement.startLine, statement.endLine - statement.startLine + 1, replaced);
        changedFile = true;
        break;
      }
      if (!changedFile) {
        return {
          ok: false,
          reason: "unresolved-import",
          files: [referencePath],
          analysis: { language, bundle: [...decisions.values()] },
        };
      }
    } else {
      const importsSource = imports.filter((statement) =>
        importResolvesTo(referencePath, statement.specifier, sourcePath, language),
      );
      if (importsSource.length === 0) {
        return {
          ok: false,
          reason: "unresolved-import",
          files: [referencePath],
          analysis: { language, bundle: [...decisions.values()] },
        };
      }
      const destinationUri = relativeDartUri(referencePath, destinationPath);
      if (!imports.some((statement) => importResolvesTo(referencePath, statement.specifier, destinationPath, language))) {
        referenceLines.splice(
          importsSource[0].startLine,
          0,
          renderDartImport(destinationUri),
        );
      }
    }
    referenceAfter.set(referencePath, joinLines(collapseBlankLines(referenceLines)));
  }
  /* eslint-enable no-await-in-loop */

  // Source: drop the moved declarations, prune now-unused TS imports, and
  // import the destination when the remaining code still uses a moved name.
  let sourceLinesAfter = dropRemovedLines(sourceWithoutMoved);
  if (isTsLanguage(language)) {
    sourceLinesAfter = removeTsUnusedImports(sourceLinesAfter, language, remainingUsed);
    if (sourceWillImportDest) {
      sourceLinesAfter = insertImports(sourceLinesAfter, [
        renderTsImport(
          relativeTsSpecifier(sourcePath, destinationPath),
          bundle
            .filter((symbol) => remainingUsed.has(symbol.name))
            .map((symbol) => ({ imported: symbol.name, local: symbol.name })),
        ),
      ]);
    }
  } else if (sourceWillImportDest) {
    sourceLinesAfter = insertImports(sourceLinesAfter, [renderDartImport(relativeDartUri(sourcePath, destinationPath))]);
  }
  const sourceAfter = joinLines(collapseBlankLines(sourceLinesAfter));

  // Destination: merge import lines and append the moved declarations.
  let destinationLines = destinationContent === null ? [] : splitLines(destinationContent);
  if (isTsLanguage(language) && destinationContent !== null) {
    // The destination may import the moved names from the source; they are declared there now.
    const movedNames = new Set(bundle.map((symbol) => symbol.name));
    for (const statement of parseImports(destinationContent, language).reverse()) {
      if (statement.isExport || !importResolvesTo(destinationPath, statement.specifier, sourcePath, language)) continue;
      const kept = statement.names.filter((item) => !movedNames.has(item.local));
      if (kept.length === statement.names.length) continue;
      const count = statement.endLine - statement.startLine + 1;
      if (kept.length === 0 && !statement.defaultName && !statement.namespaceName) {
        destinationLines.splice(statement.startLine, count);
      } else {
        destinationLines.splice(
          statement.startLine,
          count,
          renderTsImport(statement.specifier, kept, statement.defaultName, statement.namespaceName),
        );
      }
    }
    destinationLines = mergeTsImports(destinationLines, destinationImportLines, language);
  } else {
    const missing = destinationImportLines.filter(
      (line) => !destinationLines.some((existing) => existing.trim() === line.trim()),
    );
    destinationLines = insertImports(destinationLines, missing);
  }
  if (destinationLines.length > 0 && destinationLines[destinationLines.length - 1].trim() !== "") {
    destinationLines.push("");
  }
  destinationLines.push(...movedText.split("\n"), "");
  const destinationAfter = joinLines(collapseBlankLines(destinationLines));

  const files: RawFileEdit[] = [];
  if (destinationAfter !== destinationContent) {
    files.push({
      path: destinationPath,
      edits: [replaceWholeFileEdit(destinationContent ?? "", destinationAfter)],
      ...(destinationContent === null ? { create: true } : {}),
    });
  }
  if (sourceAfter !== sourceContent) {
    files.push({ path: sourcePath, edits: [replaceWholeFileEdit(sourceContent, sourceAfter)] });
  }
  for (const [referencePath, before] of contents) {
    if (referencePath === sourcePath || referencePath === destinationPath) continue;
    const after = referenceAfter.get(referencePath);
    if (after === undefined || after === before) continue;
    files.push({ path: referencePath, edits: [replaceWholeFileEdit(before, after)] });
  }
  if (files.length === 0) return { ok: false, reason: "no-changes" };

  const analysis: ChangeAnalysis = {
    language,
    bundle: [...decisions.values()],
    notes: [
      "move bundle follows references; public symbols and helpers used elsewhere stay",
    ],
  };
  return {
    ok: true,
    build: {
      files,
      contents,
      target: {
        name: input.symbol.name,
        path: sourcePath,
        line: input.symbol.startLine,
        character: input.symbol.startCharacter,
        newPath: destinationPath,
      },
      analysis,
      touchedFiles,
    },
  };
}

function resolveImportTarget(importerPath: string, specifier: string): string | null {
  const resolved = resolveRelativePath(importerPath, specifier);
  return resolved;
}

function mergeTsImports(
  lines: string[],
  additions: string[],
  language: RefactorLanguage,
): string[] {
  if (additions.length === 0) return lines;
  const content = lines.join("\n");
  const existing = parseImports(content, language);
  const toAdd: string[] = [];
  const replacements = new Map<number, { endLine: number; text: string }>();
  for (const addition of additions) {
    const parsed = parseImports(addition, language)[0];
    if (!parsed) {
      toAdd.push(addition);
      continue;
    }
    const same = existing.find(
      (statement) => statement.specifier === parsed.specifier && !statement.isExport,
    );
    if (!same) {
      toAdd.push(addition);
      continue;
    }
    const names = new Map(same.names.map((item) => [item.local, item]));
    for (const item of parsed.names) {
      if (!names.has(item.local)) names.set(item.local, item);
    }
    replacements.set(same.startLine, {
      endLine: same.endLine,
      text: renderTsImport(
        same.specifier,
        [...names.values()],
        same.defaultName,
        same.namespaceName,
      ),
    });
  }
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const replacement = replacements.get(index);
    if (replacement) {
      result.push(replacement.text);
      index = replacement.endLine;
      continue;
    }
    result.push(lines[index]);
  }
  return insertImports(result, toAdd);
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

export interface ExtractRefactorInput {
  sourcePath: string;
  content: string;
  symbols: RefactorSymbol[];
  selection: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
  name: string;
}

function parseParameterNames(text: string, language: RefactorLanguage): string[] | null {
  const open = text.indexOf("(");
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close === -1) return null;
  const raw = text.slice(open + 1, close).trim();
  if (raw.length === 0) return [];
  const names: string[] = [];
  let current = "";
  let nested = 0;
  for (const char of raw) {
    if (char === "{" || char === "[" || char === "(" || char === "<") nested += 1;
    if (char === "}" || char === "]" || char === ")" || char === ">") nested -= 1;
    if (char === "," && nested === 0) {
      const name = parameterName(current, language);
      if (name === null) return null;
      names.push(name);
      current = "";
    } else {
      current += char;
    }
  }
  const last = parameterName(current, language);
  if (last === null) return null;
  names.push(last);
  return names;
}

/** Type annotations of the first parameter list in `text` (TypeScript only), by parameter name. */
function parseParameterTypes(text: string): Map<string, string> {
  const types = new Map<string, string>();
  const open = text.indexOf("(");
  if (open === -1) return types;
  let depth = 0;
  let close = -1;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")" && --depth === 0) {
      close = index;
      break;
    }
  }
  if (close === -1) return types;
  const parts: string[] = [];
  let current = "";
  let nested = 0;
  const raw = text.slice(open + 1, close);
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "=" && raw[index + 1] === ">") {
      current += "=>";
      index += 1;
      continue;
    }
    if ("{[(<".includes(char)) nested += 1;
    if ("}])>".includes(char)) nested -= 1;
    if (char === "," && nested === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  for (const part of parts) {
    const match = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)(\??)\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (!match) continue;
    const type = match[3].replace(/\s*=(?!>)[\s\S]*$/, "").trim();
    types.set(match[1], match[2] ? `${type} | undefined` : type);
  }
  return types;
}

function parameterName(raw: string, language: RefactorLanguage): string | null {
  let value = raw.trim();
  if (value.length === 0) return null;
  if (value.includes("{") || value.includes("[")) return null;
  if (value.startsWith("...")) value = value.slice(3).trim();
  value = value.replace(/^(?:required|final|const|var|this\.)\s*/, "");
  if (value.startsWith("this.")) return null;
  if (isTsLanguage(language)) {
    const match = /^([A-Za-z_$][\w$]*)/.exec(value);
    return match ? match[1] : null;
  }
  const identifiers = value.match(/[A-Za-z_$][\w$]*/g);
  return identifiers && identifiers.length > 0 ? identifiers[identifiers.length - 1] : null;
}

function enclosingSymbol(symbols: RefactorSymbol[], selection: ExtractRefactorInput["selection"]): RefactorSymbol | null {
  let best: RefactorSymbol | null = null;
  for (const symbol of symbols) {
    if (symbol.startLine > selection.startLine || symbol.endLine < selection.endLine) continue;
    if (!["function", "method", "constructor", "getter", "setter"].includes(symbol.kind)) continue;
    if (!best || symbol.endLine - symbol.startLine < best.endLine - best.startLine) best = symbol;
  }
  return best;
}

const TS_GLOBALS = new Set([
  "console", "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Promise",
  "Date", "Error", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "BigInt",
  "parseInt", "parseFloat", "isNaN", "isFinite", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "undefined", "null", "true", "false", "NaN", "Infinity", "globalThis",
  "window", "document", "process", "require", "module", "exports", "this", "super",
  "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "try", "catch", "finally", "throw", "new", "typeof", "instanceof", "in", "of", "delete",
  "void", "yield", "await", "async", "function", "class", "const", "let", "var", "import",
  "export", "default", "extends", "implements", "interface", "type", "enum", "namespace",
]);

const DART_GLOBALS = new Set([
  "print", "true", "false", "null", "this", "super", "dynamic", "int", "double", "String",
  "bool", "List", "Map", "Set", "Future", "Stream", "Object", "DateTime", "Duration",
  "Iterable", "num", "void", "await", "async", "const", "final", "var", "late", "required",
  "static", "factory", "get", "set", "new", "return", "if", "else", "for", "while", "do",
  "switch", "case", "break", "continue", "try", "catch", "finally", "throw", "class",
  "mixin", "enum", "typedef", "extension", "import", "export", "part", "show", "hide",
]);

export function buildExtractRefactor(input: ExtractRefactorInput): RefactorResult {
  const language = languageForPath(input.sourcePath);
  if (language === "unknown") return { ok: false, reason: "unsupported-language" };
  if (!/^[A-Za-z_$][\w$]*$/.test(input.name)) return { ok: false, reason: "invalid-name" };
  const lines = splitLines(input.content);
  const selection = input.selection;
  if (
    selection.startLine < 0 ||
    selection.endLine >= lines.length ||
    (selection.startLine === selection.endLine && selection.startCharacter === selection.endCharacter)
  ) {
    return { ok: false, reason: "empty-selection" };
  }
  const selectedLines = lines.slice(selection.startLine, selection.endLine + 1);
  const startOffset = selection.startCharacter;
  const endOffset =
    selection.endLine === selection.startLine
      ? selection.endCharacter
      : selection.endCharacter;
  if (selection.startLine === selection.endLine) {
    selectedLines[0] = lines[selection.startLine].slice(startOffset, endOffset);
  } else {
    selectedLines[0] = selectedLines[0].slice(startOffset);
    selectedLines[selectedLines.length - 1] = selectedLines[selectedLines.length - 1].slice(0, endOffset);
  }
  const selectedText = selectedLines.join("\n");
  if (selectedText.trim().length === 0) return { ok: false, reason: "empty-selection" };

  const enclosing = enclosingSymbol(input.symbols, selection);
  const enclosingText = enclosing
    ? lines.slice(enclosing.startLine, enclosing.endLine + 1).join("\n")
    : "";
  if (collectIdentifierUsage(selectedText, language).has("this")) {
    return { ok: false, reason: "extract-uses-this" };
  }
  const params = new Set<string>();
  if (enclosing) {
    const names = parseParameterNames(enclosingText, language);
    if (names === null) return { ok: false, reason: "extract-params-unsupported" };
    names.forEach((name) => params.add(name));
    const beforeSelection = lines
      .slice(enclosing.startLine, selection.startLine)
      .join("\n");
    collectDeclaredNames(beforeSelection, language).forEach((name) => params.add(name));
  }
  const declaredInside = collectDeclaredNames(selectedText, language);
  const afterSelection = [
    lines[selection.endLine].slice(selection.endCharacter),
    ...lines.slice(selection.endLine + 1, enclosing ? enclosing.endLine + 1 : lines.length),
  ].join("\n");
  const usedAfter = collectIdentifierUsage(afterSelection, language);
  if ([...declaredInside].some((name) => usedAfter.has(name))) {
    return { ok: false, reason: "extract-declaration-used-after" };
  }
  const topLevel = new Set(
    input.symbols.filter((symbol) => !symbol.parentName).map((symbol) => symbol.name),
  );
  const imported = new Set<string>();
  for (const statement of parseImports(input.content, language)) {
    statement.names.forEach((item) => imported.add(item.local));
    if (statement.defaultName) imported.add(statement.defaultName);
    if (statement.namespaceName) imported.add(statement.namespaceName);
  }
  const globals = language === "dart" ? DART_GLOBALS : TS_GLOBALS;
  const used = collectIdentifierUsage(selectedText, language);
  const parameterNames: string[] = [];
  for (const name of used) {
    if (declaredInside.has(name) || imported.has(name) || topLevel.has(name) || globals.has(name)) {
      continue;
    }
    if (params.has(name)) {
      parameterNames.push(name);
      continue;
    }
    // A name declared nowhere near the selection is treated as a parameter so
    // the extracted body does not silently capture a different value.
    parameterNames.push(name);
  }
  parameterNames.sort();

  const startIndent = lines[selection.startLine].slice(0, startOffset);
  const dedented = dedent(
    selection.startLine !== selection.endLine && startIndent.trim() === ""
      ? [startIndent + selectedLines[0], ...selectedLines.slice(1)]
      : selectedLines,
  );
  const isExpression =
    selectedLines.length === 1 &&
    !/[;{}]/.test(dedented.trim()) &&
    !/^(?:if|for|while|switch|try|return|throw|const|let|var|final|await)\b/.test(dedented.trim());
  const body = isExpression ? `return ${dedented.trim()};` : dedented;
  const usesAwait = language === "dart" ? /\bawait\b/.test(body) : /\bawait\b/.test(body);
  const enclosingAsync = /\basync\b/.test(enclosingText);
  if (usesAwait && enclosing && !enclosingAsync) {
    return { ok: false, reason: "extract-await-in-sync" };
  }
  const call = `${input.name}(${parameterNames.join(", ")})`;
  // Only parameters of the enclosing function carry a known type; TypeScript locals get an
  // explicit `any` so the result still compiles under noImplicitAny.
  const types = isTsLanguage(language) ? parseParameterTypes(enclosingText) : new Map<string, string>();
  const declaredParameters = parameterNames
    .map((name) => {
      if (types.has(name)) return `${name}: ${types.get(name)}`;
      return language === "typescript" ? `${name}: any` : name;
    })
    .join(", ");
  const declaration = isTsLanguage(language)
    ? `${usesAwait ? "async " : ""}function ${input.name}(${declaredParameters}) {\n${indent(body, "  ")}\n}`
    : `dynamic ${input.name}(${parameterNames.join(", ")})${usesAwait ? " async" : ""} {\n${indent(body, "  ")}\n}`;

  // Replace the selection with the call, then insert the declaration after the
  // enclosing symbol.
  const replacementText = isExpression ? call : `${call};`;
  const nextLines = [...lines];
  const removedLines = selection.endLine - selection.startLine;
  const merged =
    lines[selection.startLine].slice(0, startOffset) +
    replacementText +
    lines[selection.endLine].slice(endOffset);
  nextLines.splice(selection.startLine, removedLines + 1, merged);
  const insertLine = enclosing ? enclosing.endLine + 1 - removedLines : nextLines.length;
  nextLines.splice(insertLine, 0, "", ...declaration.split("\n"));
  const after = joinLines(collapseBlankLines(nextLines));

  return {
    ok: true,
    build: {
      files: [{ path: normalizePath(input.sourcePath), edits: [replaceWholeFileEdit(input.content, after)] }],
      contents: new Map([[normalizePath(input.sourcePath), input.content]]),
      target: {
        name: input.name,
        path: normalizePath(input.sourcePath),
        line: selection.startLine,
        character: selection.startCharacter,
        selection,
      },
      analysis: {
        language,
        notes: [
          isExpression ? "extracted as an expression" : "extracted as statements",
          ...(parameterNames.length > 0 ? [`parameters: ${parameterNames.join(", ")}`] : []),
        ],
      },
      touchedFiles: [normalizePath(input.sourcePath)],
    },
  };
}

function dedent(lines: string[]): string {
  const values = lines.slice();
  const indents = values
    .filter((line) => line.trim().length > 0)
    .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const min = indents.length > 0 ? Math.min(...indents) : 0;
  return values.map((line) => line.slice(Math.min(min, /^[ \t]*/.exec(line)?.[0].length ?? 0))).join("\n");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

export interface InlineRefactorInput {
  sourcePath: string;
  content: string;
  symbol: RefactorSymbol;
  references: RefactorReference[];
  callLine?: number;
  callCharacter?: number;
}

interface CallSite {
  start: number;
  end: number;
  replacement: string;
}

function offsetOf(content: string, line: number, character: number): number {
  const lines = content.split("\n");
  if (line < 0 || line >= lines.length) return -1;
  let offset = 0;
  for (let index = 0; index < line; index += 1) offset += lines[index].length + 1;
  return offset + Math.min(character, lines[line].length);
}

function skipWhitespace(content: string, index: number): number {
  while (index < content.length && /\s/.test(content[index])) index += 1;
  return index;
}

/** Finds the matching `)` while skipping strings and comments. */
function closingParen(content: string, open: number): number {
  let depth = 0;
  for (let index = open; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (char === "/" && next === "/") {
      const end = content.indexOf("\n", index);
      if (end === -1) return -1;
      index = end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = content.indexOf("*/", index + 2);
      if (end === -1) return -1;
      index = end + 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      for (index += 1; index < content.length; index += 1) {
        if (content[index] === "\\") {
          index += 1;
          continue;
        }
        if (content[index] === quote) break;
      }
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitArguments(raw: string): string[] {
  if (raw.trim().length === 0) return [];
  const args: string[] = [];
  let current = "";
  let depth = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (char === "/" && next === "/") {
      const end = raw.indexOf("\n", index);
      const stop = end === -1 ? raw.length : end;
      current += raw.slice(index, stop);
      index = stop - 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = raw.indexOf("*/", index + 2);
      const stop = end === -1 ? raw.length : end + 2;
      current += raw.slice(index, stop);
      index = stop - 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      let end = index + 1;
      for (; end < raw.length; end += 1) {
        if (raw[end] === "\\") {
          end += 1;
          continue;
        }
        if (raw[end] === quote) break;
      }
      current += raw.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") depth += 1;
    else if (char === ")" || char === "}" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  args.push(current.trim());
  return args;
}

function parseInlineFunction(
  declaration: string,
  name: string,
  language: RefactorLanguage,
): { params: string[]; expression: string | null; statements: string[] } | { reason: string } {
  if (/\basync\b|\byield\b/.test(declaration)) return { reason: "inline-async-unsupported" };
  if (/\breturn\b[\s\S]*\breturn\b/.test(declaration)) {
    return { reason: "inline-multiple-returns" };
  }
  if (isTsLanguage(language)) {
    const arrow = new RegExp(
      `(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*\\(?([^)=]*)\\)?\\s*=>\\s*([\\s\\S]*?);?\\s*$`,
    ).exec(declaration);
    if (arrow) {
      const params = parseParameterNames(`(${arrow[1]})`, language);
      if (params === null) return { reason: "inline-params-unsupported" };
      return { params, expression: arrow[2].trim().replace(/;$/, "").trim(), statements: [] };
    }
    const block = new RegExp(
      `\\bfunction\\s+${name}\\s*\\(([^)]*)\\)\\s*(?::[^{]+)?\\{([\\s\\S]*)\\}\\s*$`,
    ).exec(declaration);
    if (block) {
      const params = parseParameterNames(`(${block[1]})`, language);
      if (params === null) return { reason: "inline-params-unsupported" };
      const body = block[2].trim();
      const single = /^return\s+([\s\S]*?);?$/.exec(body);
      if (single) return { params, expression: single[1].trim(), statements: [] };
      return { params, expression: null, statements: body.split("\n").map((line) => line.trim()).filter(Boolean) };
    }
    return { reason: "inline-unsupported-declaration" };
  }
  const dartBlock = new RegExp(
    `\\b${name}\\s*\\(([^)]*)\\)\\s*(?:async\\s*)?(?::[^{]+)?\\{([\\s\\S]*)\\}\\s*$`,
  ).exec(declaration);
  if (dartBlock) {
    const params = parseParameterNames(`(${dartBlock[1]})`, language);
    if (params === null) return { reason: "inline-params-unsupported" };
    const body = dartBlock[2].trim();
    const single = /^return\s+([\s\S]*?);?$/.exec(body);
    if (single) return { params, expression: single[1].trim(), statements: [] };
    return { params, expression: null, statements: body.split("\n").map((line) => line.trim()).filter(Boolean) };
  }
  const dartArrow = new RegExp(
    `\\b${name}\\s*\\(([^)]*)\\)\\s*=>\\s*([\\s\\S]*?);\\s*$`,
  ).exec(declaration);
  if (dartArrow) {
    const params = parseParameterNames(`(${dartArrow[1]})`, language);
    if (params === null) return { reason: "inline-params-unsupported" };
    return { params, expression: dartArrow[2].trim(), statements: [] };
  }
  return { reason: "inline-unsupported-declaration" };
}

function substituteParameters(expression: string, params: string[], args: string[]): string {
  let result = expression;
  const values = new Map(params.map((param, index) => [param, args[index]]));
  result = result.replace(/\b[A-Za-z_$][\w$]*\b/g, (match, offset: number) => {
    const value = values.get(match);
    if (value === undefined) return match;
    const before = expression.slice(0, offset).trimEnd();
    if (before.endsWith(".")) return match;
    return `(${value})`;
  });
  return result;
}

export function buildInlineRefactor(input: InlineRefactorInput): RefactorResult {
  const sourcePath = normalizePath(input.sourcePath);
  const language = languageForPath(sourcePath);
  if (language === "unknown") return { ok: false, reason: "unsupported-language" };
  if (input.symbol.isExported) return { ok: false, reason: "inline-exported-unsupported" };
  if (!["function", "method"].includes(input.symbol.kind)) {
    return { ok: false, reason: "inline-unsupported-symbol" };
  }
  if (input.symbol.parentName) return { ok: false, reason: "inline-unsupported-symbol" };
  const lines = splitLines(input.content);
  const declaration = lines
    .slice(input.symbol.startLine, input.symbol.endLine + 1)
    .join("\n");
  const parsed = parseInlineFunction(declaration, input.symbol.name, language);
  if ("reason" in parsed) return { ok: false, reason: parsed.reason };
  if (parsed.expression === null) return { ok: false, reason: "inline-statement-body-unsupported" };
  if (new RegExp(`\\b${input.symbol.name}\\s*\\(`).test(parsed.expression)) {
    return { ok: false, reason: "inline-recursive" };
  }

  const references = input.references.filter(
    (reference) =>
      !(
        normalizePath(reference.path) === sourcePath &&
        reference.line >= input.symbol.startLine &&
        reference.line <= input.symbol.endLine
      ),
  );
  if (references.length === 0) return { ok: false, reason: "inline-no-call-sites" };
  if (references.some((reference) => normalizePath(reference.path) !== sourcePath)) {
    return { ok: false, reason: "inline-external-references" };
  }
  const selected =
    input.callLine === undefined
      ? references
      : references.filter(
          (reference) =>
            reference.line === input.callLine &&
            (input.callCharacter === undefined || reference.character === input.callCharacter),
        );
  if (selected.length === 0) return { ok: false, reason: "inline-call-not-found" };

  const calls: CallSite[] = [];
  for (const reference of selected) {
    const offset = offsetOf(input.content, reference.line, reference.character);
    if (offset < 0) return { ok: false, reason: "inline-call-not-found" };
    if (input.content.slice(offset, offset + input.symbol.name.length) !== input.symbol.name) {
      return { ok: false, reason: "inline-call-not-found" };
    }
    const open = skipWhitespace(input.content, offset + input.symbol.name.length);
    if (input.content[open] !== "(") return { ok: false, reason: "inline-call-not-found" };
    const close = closingParen(input.content, open);
    if (close === -1) return { ok: false, reason: "inline-call-not-found" };
    const args = splitArguments(input.content.slice(open + 1, close));
    if (args.length !== parsed.params.length) {
      return { ok: false, reason: "inline-arity-mismatch" };
    }
    calls.push({
      start: offset,
      end: close + 1,
      replacement: `(${substituteParameters(parsed.expression, parsed.params, args)})`,
    });
  }

  calls.sort((left, right) => right.start - left.start);
  for (let index = 1; index < calls.length; index += 1) {
    if (calls[index].end > calls[index - 1].start) {
      return { ok: false, reason: "inline-overlapping-calls" };
    }
  }
  let after = input.content;
  for (const call of calls) {
    after = after.slice(0, call.start) + call.replacement + after.slice(call.end);
  }
  const afterLines = splitLines(after);
  // The declaration stays while calls that were not selected still need it.
  if (selected.length === references.length) {
    afterLines.splice(input.symbol.startLine, input.symbol.endLine - input.symbol.startLine + 1);
  }
  const finalContent = joinLines(collapseBlankLines(afterLines));

  return {
    ok: true,
    build: {
      files: [{ path: sourcePath, edits: [replaceWholeFileEdit(input.content, finalContent)] }],
      contents: new Map([[sourcePath, input.content]]),
      target: {
        name: input.symbol.name,
        path: sourcePath,
        line: input.symbol.startLine,
        character: input.symbol.startCharacter,
        ...(input.callLine !== undefined ? { callLine: input.callLine } : {}),
        ...(input.callCharacter !== undefined ? { callCharacter: input.callCharacter } : {}),
      },
      analysis: {
        language,
        notes: [
          selected.length === references.length
            ? "inlined every call site"
            : "inlined the selected call site",
        ],
      },
      touchedFiles: [sourcePath],
    },
  };
}

/** Exposed for the plan summary and tests. */
export function textEditForContent(before: string, after: string): ChangeTextEdit {
  return replaceWholeFileEdit(before, after);
}
