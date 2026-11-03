/**
 * E2E verification of DESIGN 13.2 step 5 — interruption recovery.
 *
 * `scripts/verify-change.mjs` writes a task left in `applying` after phase 1.
 * A fresh extension host must classify it as recovery and must not apply or
 * roll back anything on its own.
 */

import { before, test } from 'mocha';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'sjh354.skein';

let root = '';
let appPath = '';
let taskPath = '';

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
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

suite('Change recovery (step 5, phase 2)', () => {
  before(async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} should be installed`);
    if (!extension.isActive) await extension.activate();
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, 'A workspace folder is required');
    root = folders[0].uri.fsPath;
    assert.strictEqual(path.basename(root), 'change-sandbox');
    appPath = path.join(root, 'src', 'app.ts');
    taskPath = path.join(root, '.skein', 'history', 'tasks', 'plan-interrupted.json');
  });

  test('classifies the interrupted task instead of applying it again', async function () {
    this.timeout(60_000);
    const before = fs.readFileSync(appPath, 'utf8');
    const task = await waitFor(() => {
      const parsed = readJson<{ status?: string; reason?: string }>(taskPath);
      return parsed.status === 'recovery' ? parsed : null;
    }, 'interrupted task recovery');
    assert.strictEqual(task.reason, 'interrupted-after');
    assert.strictEqual(fs.readFileSync(appPath, 'utf8'), before, 'recovery must not edit files');
  });

  test('does not add the interrupted task to the change history', async function () {
    const index = readJson<{ entries: Array<{ planId: string }> }>(
      path.join(root, '.skein', 'history', 'index.json'),
    );
    assert.ok(
      !index.entries.some((entry) => entry.planId === 'plan-interrupted'),
      'an interrupted task is not a completed history entry',
    );
    assert.ok(index.entries.length >= 3, 'earlier history entries are preserved');
  });
});
