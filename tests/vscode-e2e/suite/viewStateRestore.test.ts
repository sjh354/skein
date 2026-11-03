/**
 * E2E verification of DESIGN 13.2 step 4 — restart restore.
 *
 * Runs in a separate VS Code launch after `viewState.test.ts` left depth 3, a
 * hidden node type and a selection in `tests/fixtures/.skein/state.json`.
 * `scripts/verify-viewstate.mjs` orchestrates the two launches.
 */

import { before, test } from 'mocha';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getContextKey, openCallGraphFor, sleep } from './_helpers';

const EXTENSION_ID = 'sjh354.skein';

let workspaceRoot = '';
let marker: any;

function statePath(): string {
  return path.join(workspaceRoot, '.skein', 'state.json');
}

function markerPath(): string {
  return path.join(workspaceRoot, '.skein', 'verify-expected.json');
}

async function readPublishedState(): Promise<any | null> {
  try {
    return JSON.parse(await fs.promises.readFile(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

async function waitForPublished<T>(
  predicate: (state: any) => T | null | undefined,
  label: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = await readPublishedState();
    if (last) {
      const value = predicate(last);
      if (value !== null && value !== undefined && value !== false) return value;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}. Last state: ${JSON.stringify(last)}`);
}

function hasFilter(state: any, filterType: string, value: string): boolean {
  return (state?.hiddenFilters ?? []).some(
    (filter: any) => filter.filterType === filterType && filter.value === value,
  );
}

suite('View State restore after restart (step 4, phase 2)', () => {
  before(async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} should be installed`);
    if (!extension.isActive) await extension.activate();
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, 'A workspace folder is required');
    workspaceRoot = folders[0].uri.fsPath;
    marker = JSON.parse(await fs.promises.readFile(markerPath(), 'utf8'));
    assert.strictEqual(marker.workspaceRoot, workspaceRoot, 'marker workspace');
  });

  test('Restored call-graph state is published before reopening', async function () {
    this.timeout(60_000);
    const state = await waitForPublished(
      (s) =>
        s.updatedAt > marker.updatedAt &&
        s.callGraph?.depth === marker.depth &&
        hasFilter(s, 'nodeType', 'function') &&
        s.selection?.nodeId === marker.rootId
          ? s
          : null,
      'restored state in the published snapshot',
    );
    assert.strictEqual(state.schemaVersion, 1);
    assert.strictEqual(state.workspaceRoot, workspaceRoot);
    console.log(
      `[viewstate][restore] before reopening: mode=${state.mode} depth=${state.callGraph.depth} ` +
        `filters=${JSON.stringify(state.hiddenFilters)} selection=${state.selection.nodeId}`,
    );
    // Known gap for the next step: the analysis version restarts at 0.
    console.log(`[viewstate][known-gap] graphVersion after restart=${state.graphVersion} (phase 1 was ${marker.graphVersion})`);
  });

  test('Reopened call graph restores depth, filters and selection', async function () {
    this.timeout(150_000);
    await openCallGraphFor('symbols', 'functions.ts');
    const state = await waitForPublished(
      (s) =>
        s.mode === 'callgraph' &&
        s.callGraph?.depth === marker.depth &&
        hasFilter(s, 'nodeType', 'function') &&
        s.selection?.nodeId === marker.rootId
          ? s
          : null,
      'restored depth, filter and selection',
    );
    const nodeCount = (await getContextKey<number>('skein.callGraphNodeCount')) ?? 0;
    assert.ok(nodeCount > 0, 'the graph rendered nodes after restart');
    console.log(
      `[viewstate][restore] reopened: depth=${state.callGraph.depth} filters=${JSON.stringify(state.hiddenFilters)} ` +
        `selection=${state.selection.nodeId} nodes=${nodeCount} graphVersion=${state.graphVersion}`,
    );
    console.log('[viewstate][known-gap] node positions and viewport zoom are not persisted (not in state.json)');
  });
});
