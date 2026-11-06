/**
 * E2E verification of DESIGN 13.2 step 6 — move, extract and inline through
 * the real MCP stdio server, extension command bridge and internal history.
 *
 * Runs in the disposable sandbox `tests/fixtures/refactor-sandbox` (see
 * scripts/verify-refactor.mjs). TypeScript uses VS Code's built-in language
 * service; Dart needs the external Dart extension and is covered separately by
 * the manual checklist.
 */

import { after, before, test } from 'mocha';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { McpStdioClient } from './mcpStdioClient';

const EXTENSION_ID = 'sjh354.skein';

let root = '';
let appPath = '';
let otherPath = '';
let movedPath = '';
let extractPath = '';
let inlinePath = '';
let serverPath = '';
let mcp: McpStdioClient;
let userHead = '';
let userIndex = '';

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function indexDigest(): string {
  return createHash('sha256').update(git(['ls-files', '-s'])).digest('hex');
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

async function waitFor<T>(
  readValue: () => T | null | undefined,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = readValue();
      if (value !== null && value !== undefined && value !== false) return value;
      last = value;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)}`);
}

async function changeTool(name: string, args: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await mcp.callTool(name, args, 60_000);
    if (result.data?.reason !== 'extension-not-responding') return result.data;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Extension never answered ${name}`);
}

suite('Move / extract / inline (step 6)', () => {
  before(async function () {
    this.timeout(90_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} should be installed`);
    if (!extension.isActive) await extension.activate();
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, 'A workspace folder is required');
    root = folders[0].uri.fsPath;
    assert.strictEqual(path.basename(root), 'refactor-sandbox', 'expected the disposable sandbox workspace');
    appPath = path.join(root, 'src', 'app.ts');
    otherPath = path.join(root, 'src', 'other.ts');
    movedPath = path.join(root, 'src', 'moved.ts');
    extractPath = path.join(root, 'src', 'extract.ts');
    inlinePath = path.join(root, 'src', 'inline.ts');
    serverPath = path.join(extension.extensionPath, 'dist', 'mcpServer.mjs');
    assert.ok(fs.existsSync(serverPath), `MCP bundle should exist at ${serverPath}`);

    userHead = git(['rev-parse', 'HEAD']).trim();
    userIndex = indexDigest();

    mcp = new McpStdioClient(serverPath, root);
    await mcp.initialize();
    await waitFor(() => fs.existsSync(path.join(root, '.skein', 'state.json')), 'published state');
    // Warm the built-in TypeScript language service before the first plan.
    await vscode.workspace.openTextDocument(vscode.Uri.file(appPath));
  });

  after(async () => {
    await mcp?.close();
  });

  test('plans a move without creating the destination file', async function () {
    this.timeout(90_000);
    const beforeContent = read(appPath);
    const result = await changeTool('skein_plan_change', {
      kind: 'move',
      path: appPath,
      name: 'alpha',
      line: 0,
      newPath: movedPath,
    });
    assert.strictEqual(result.applied, true, JSON.stringify(result));
    assert.strictEqual(result.plan?.kind, 'move', JSON.stringify(result.plan));
    assert.strictEqual(result.plan?.status, 'preview-ready');
    assert.ok(result.diff?.includes('import { helper }'), result.diff);
    assert.strictEqual(read(appPath), beforeContent, 'planning must not write files');
    assert.strictEqual(fs.existsSync(movedPath), false, 'planning must not create the file');
  });

  test('applies the move and updates imports', async function () {
    this.timeout(120_000);
    const planned = await changeTool('skein_plan_change', {
      kind: 'move',
      path: appPath,
      name: 'alpha',
      line: 0,
      newPath: movedPath,
    });
    assert.strictEqual(planned.applied, true, JSON.stringify(planned));
    const result = await changeTool('skein_apply_change', { planId: planned.plan.planId });
    assert.strictEqual(result.applied, true, JSON.stringify(result));
    assert.strictEqual(result.plan?.status, 'succeeded', JSON.stringify(result.plan));
    assert.ok(read(movedPath).includes('export function alpha'), read(movedPath));
    assert.ok(read(movedPath).includes('import { helper } from "./app";'), read(movedPath));
    assert.ok(!read(appPath).includes('function alpha'), read(appPath));
    assert.ok(read(otherPath).includes('from "./moved"'), read(otherPath));
    assert.strictEqual(result.history.files.find((file: any) => path.basename(file.path) === 'moved.ts').change, 'created');
  });

  test('undo deletes the created file and redo recreates it', async function () {
    this.timeout(120_000);
    const undone = await changeTool('skein_undo_change', {});
    assert.strictEqual(undone.applied, true, JSON.stringify(undone));
    assert.strictEqual(fs.existsSync(movedPath), false, 'undo should remove the created file');
    assert.ok(read(appPath).includes('function alpha'));
    assert.ok(read(otherPath).includes('from "./app"'));

    const redone = await changeTool('skein_redo_change', {});
    assert.strictEqual(redone.applied, true, JSON.stringify(redone));
    assert.ok(read(movedPath).includes('export function alpha'));
  });

  test('extracts a selected expression into a function', async function () {
    this.timeout(120_000);
    const planned = await changeTool('skein_plan_change', {
      kind: 'extract',
      path: extractPath,
      name: 'extracted',
      startLine: 2,
      startCharacter: 14,
      endLine: 2,
      endCharacter: 19,
    });
    assert.strictEqual(planned.applied, true, JSON.stringify(planned));
    assert.strictEqual(planned.plan?.kind, 'extract');
    const result = await changeTool('skein_apply_change', { planId: planned.plan.planId });
    assert.strictEqual(result.applied, true, JSON.stringify(result));
    const after = read(extractPath);
    assert.ok(after.includes('const sum = extracted(a, b);'), after);
    assert.ok(after.includes('function extracted(a: number, b: any)'), after);
  });

  test('inlines a function at every call site', async function () {
    this.timeout(120_000);
    const planned = await changeTool('skein_plan_change', {
      kind: 'inline',
      path: inlinePath,
      name: 'twice',
      line: 0,
    });
    assert.strictEqual(planned.applied, true, JSON.stringify(planned));
    assert.strictEqual(planned.plan?.kind, 'inline');
    const result = await changeTool('skein_apply_change', { planId: planned.plan.planId });
    assert.strictEqual(result.applied, true, JSON.stringify(result));
    const after = read(inlinePath);
    assert.ok(!after.includes('function twice'), after);
    assert.ok(after.includes('const first = ((1) * 2);'), after);
    assert.ok(after.includes('const second = ((first + 1) * 2);'), after);
  });

  test('refuses a move whose source changed after planning', async function () {
    this.timeout(120_000);
    const sourceLines = read(appPath).split('\n');
    const betaLine = sourceLines.findIndex((line) => line.includes('function beta('));
    assert.ok(betaLine >= 0, 'beta should still be in app.ts');
    const planned = await changeTool('skein_plan_change', {
      kind: 'move',
      path: appPath,
      name: 'beta',
      line: betaLine,
      newPath: path.join(root, 'src', 'moved-beta.ts'),
    });
    assert.strictEqual(planned.applied, true, JSON.stringify(planned));
    fs.appendFileSync(appPath, '// edited after planning\n', 'utf8');

    const applied = await changeTool('skein_apply_change', { planId: planned.plan.planId });
    assert.strictEqual(applied.applied, false);
    assert.strictEqual(applied.reason, 'stale-plan');
    assert.ok(read(appPath).includes('function beta'));
  });

  test('leaves the user Git HEAD and index untouched', function () {
    assert.strictEqual(git(['rev-parse', 'HEAD']).trim(), userHead);
    assert.strictEqual(indexDigest(), userIndex);
    assert.ok(!git(['ls-files']).split('\n').some((file) => file.startsWith('.skein/')));
  });

  test('records creation and deletion in the change history', async function () {
    const listed = await changeTool('skein_list_change_history', { limit: 20 });
    const kinds = listed.entries.map((entry: any) => entry.kind);
    assert.ok(kinds.includes('move'), JSON.stringify(kinds));
    assert.ok(kinds.includes('extract'), JSON.stringify(kinds));
    assert.ok(kinds.includes('inline'), JSON.stringify(kinds));
    assert.ok(kinds.includes('undo'), JSON.stringify(kinds));
    assert.ok(kinds.includes('redo'), JSON.stringify(kinds));
  });
});
