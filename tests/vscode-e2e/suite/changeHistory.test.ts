/**
 * E2E verification of DESIGN 13.2 step 5 — one change through the whole path.
 *
 * Runs in the disposable sandbox `tests/fixtures/change-sandbox` (see
 * scripts/verify-change.mjs): plan → apply → history → undo → redo → conflict
 * → stale plan, all through the real MCP stdio server and the real extension
 * command bridge. The recovery phase is in changeRecovery.test.ts.
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
let serverPath = '';
let mcp: McpStdioClient;
let userHead = '';
let userBranch = '';
let userIndex = '';
let planId = '';
let firstHistoryId = '';

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

suite('Change history (step 5, phase 1)', () => {
  before(async function () {
    this.timeout(90_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} should be installed`);
    if (!extension.isActive) await extension.activate();
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, 'A workspace folder is required');
    root = folders[0].uri.fsPath;
    assert.strictEqual(path.basename(root), 'change-sandbox', 'expected the disposable sandbox workspace');
    appPath = path.join(root, 'src', 'app.ts');
    otherPath = path.join(root, 'src', 'other.ts');
    serverPath = path.join(extension.extensionPath, 'dist', 'mcpServer.mjs');
    assert.ok(fs.existsSync(serverPath), `MCP bundle should exist at ${serverPath}`);

    userHead = git(['rev-parse', 'HEAD']).trim();
    userBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    userIndex = indexDigest();

    mcp = new McpStdioClient(serverPath, root);
    await mcp.initialize();
    await waitFor(() => fs.existsSync(path.join(root, '.skein', 'state.json')), 'published state');
  });

  after(async () => {
    await mcp?.close();
  });

  test('plans a TypeScript rename without modifying files', async function () {
    this.timeout(90_000);
    const before = read(appPath);
    const result = await changeTool('skein_plan_change', {
      kind: 'rename',
      nodeId: `${appPath.replaceAll('\\', '/')}:alpha:0`,
      newName: 'gamma',
    });
    assert.strictEqual(result.applied, true, JSON.stringify(result));
    assert.strictEqual(result.plan?.status, 'preview-ready');
    assert.ok(result.plan?.planId, 'planId');
    assert.ok(result.diff?.includes('gamma'), 'diff should show the new name');
    assert.strictEqual(read(appPath), before, 'planning must not write files');
    planId = result.plan.planId;
  });

  test('applies the rename, records history and verifies diagnostics', async function () {
    this.timeout(120_000);
    const result = await changeTool('skein_apply_change', { planId });
    assert.strictEqual(result.applied, true, JSON.stringify(result));
    assert.strictEqual(result.plan?.status, 'succeeded', JSON.stringify(result.plan));
    assert.strictEqual(result.history?.status, 'succeeded');
    firstHistoryId = result.history.id;
    assert.ok(read(appPath).includes('gamma'), 'declaration renamed');
    assert.ok(read(otherPath).includes('gamma'), 'import and call renamed');
  });

  test('lists history and undoes the rename', async function () {
    this.timeout(120_000);
    const listed = await changeTool('skein_list_change_history', { limit: 10 });
    assert.ok(listed.total >= 1);
    assert.strictEqual(listed.undoable, firstHistoryId);

    const undone = await changeTool('skein_undo_change', { historyId: firstHistoryId });
    assert.strictEqual(undone.applied, true, JSON.stringify(undone));
    assert.ok(read(appPath).includes('alpha'));
    assert.ok(read(otherPath).includes('alpha'));
    assert.strictEqual(undone.history.kind, 'undo');
    assert.strictEqual(undone.history.undoTargetId, firstHistoryId);
  });

  test('re-applies the undone rename', async function () {
    this.timeout(120_000);
    const redone = await changeTool('skein_redo_change', {});
    assert.strictEqual(redone.applied, true, JSON.stringify(redone));
    assert.ok(read(appPath).includes('gamma'));
    assert.strictEqual(redone.history.kind, 'redo');
  });

  test('reports a conflict and keeps the later edit', async function () {
    this.timeout(120_000);
    const conflicting = read(appPath).replace('gamma', 'delta');
    fs.writeFileSync(appPath, conflicting, 'utf8');

    const result = await changeTool('skein_undo_change', {});
    assert.strictEqual(result.applied, false);
    assert.strictEqual(result.reason, 'conflict');
    assert.ok(Array.isArray(result.conflicts) && result.conflicts.length > 0);
    assert.ok(String(result.conflicts[0].path).replaceAll('\\', '/').endsWith('src/app.ts'));
    assert.ok(String(result.conflicts[0].hunk).includes('<<<<<<<'));
    assert.strictEqual(read(appPath), conflicting, 'the user edit must survive');
  });

  test('refuses a plan whose code changed after planning', async function () {
    this.timeout(120_000);
    const planned = await changeTool('skein_plan_change', {
      kind: 'rename',
      path: appPath,
      name: 'delta',
      line: 0,
      newName: 'epsilon',
    });
    assert.strictEqual(planned.applied, true, JSON.stringify(planned));
    fs.appendFileSync(appPath, '// edited after planning\n', 'utf8');

    const applied = await changeTool('skein_apply_change', { planId: planned.plan.planId });
    assert.strictEqual(applied.applied, false);
    assert.strictEqual(applied.reason, 'stale-plan');
    assert.ok(read(appPath).includes('delta'));
  });

  test('leaves the user Git HEAD, index and branch untouched', async function () {
    assert.strictEqual(git(['rev-parse', 'HEAD']).trim(), userHead);
    assert.strictEqual(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), userBranch);
    assert.strictEqual(indexDigest(), userIndex);
    assert.ok(!git(['ls-files']).split('\n').some((file) => file.startsWith('.skein/')));
  });

  test('writes the before/after snapshots into the internal repository', async function () {
    const gitDir = path.join(root, '.skein', 'history', 'repo.git');
    assert.ok(fs.existsSync(path.join(gitDir, 'HEAD')), 'internal repository exists');
    const log = execFileSync(
      'git',
      ['--git-dir', gitDir, '--work-tree', root, 'log', '--format=%s'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.ok(log.includes('before'), 'a before snapshot is recorded');
    assert.ok(log.includes('after'), 'an after snapshot is recorded');
    const index = JSON.parse(
      fs.readFileSync(path.join(root, '.skein', 'history', 'index.json'), 'utf8'),
    );
    assert.ok(index.entries.length >= 3, 'rename, undo and redo history entries');
  });
});
