/**
 * E2E verification of DESIGN 13.2 step 4 — shared view state and MCP round trip.
 *
 * Phase 1 (this file): opens a real call graph in VS Code, drives it through the
 * real `dist/mcpServer.mjs` stdio process, and checks the extension's published
 * `.skein/state.json` after every command. The restart phase lives in
 * `viewStateRestore.test.ts` and runs in a separate VS Code launch.
 *
 * The workspace is `tests/fixtures` (see runTests.js), so `.skein/` is written
 * there. `scripts/verify-viewstate.mjs` removes it before this phase starts.
 */

import { after, before, test } from 'mocha';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getContextKey, getProjectFile, openCallGraphFor, sleep, waitForViewMode } from './_helpers';
import { McpStdioClient } from './mcpStdioClient';

const EXTENSION_ID = 'sjh354.skein';

let workspaceRoot = '';
let mcp: McpStdioClient;
let serverPath = '';

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
  timeoutMs = 10_000,
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

async function waitForNodeCountAtLeast(minimum: number, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = (await getContextKey<number>('skein.callGraphNodeCount')) ?? 0;
  while (Date.now() < deadline) {
    if (count >= minimum) return count;
    await sleep(150);
    count = (await getContextKey<number>('skein.callGraphNodeCount')) ?? count;
  }
  throw new Error(`Node count stayed at ${count}, expected at least ${minimum}`);
}

function hasFilter(state: any, filterType: string, value: string): boolean {
  return (state?.hiddenFilters ?? []).some(
    (filter: any) => filter.filterType === filterType && filter.value === value,
  );
}

suite('View State MCP round trip (step 4, phase 1)', () => {
  before(async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} should be installed`);
    if (!extension.isActive) await extension.activate();
    serverPath = path.join(extension.extensionPath, 'dist', 'mcpServer.mjs');
    assert.ok(fs.existsSync(serverPath), `MCP bundle should exist at ${serverPath}`);
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, 'A workspace folder is required');
    workspaceRoot = folders[0].uri.fsPath;
  });

  after(async () => {
    await mcp?.close();
  });

  test('Publishes the call graph view to .skein/state.json', async function () {
    this.timeout(150_000);
    await openCallGraphFor('symbols', 'functions.ts');
    const state = await waitForPublished(
      (s) => (s.mode === 'callgraph' && typeof s.callGraph?.rootSymbolId === 'string' ? s : null),
      'call graph state publication',
    );
    assert.strictEqual(state.schemaVersion, 2, 'schemaVersion');
    assert.strictEqual(state.workspaceRoot, workspaceRoot, 'workspaceRoot');
    assert.ok(
      String(state.filePath).replaceAll('\\', '/').endsWith('symbols/functions.ts'),
      `filePath should be the opened fixture, got ${String(state.filePath)}`,
    );
    assert.strictEqual(state.callGraph.depth, 1, 'default depth');
    assert.ok(typeof state.graphVersion === 'number', 'graphVersion is published');
    assert.strictEqual(state.expandAll, false, 'expandAll default');
    console.log(
      `[viewstate] published root=${state.callGraph.rootSymbolId} depth=${state.callGraph.depth} graphVersion=${state.graphVersion}`,
    );
  });

  test('Publishes node positions and viewport layout', async function () {
    this.timeout(60_000);
    const state = await waitForPublished(
      (s) =>
        s.layout && Object.keys(s.layout.positions).length > 0 && typeof s.layout.zoom === 'number'
          ? s
          : null,
      'layout publication',
      20_000,
    );
    assert.ok(Object.keys(state.layout.positions).length > 0, 'positions');
    assert.ok(state.layout.rootSymbolId, 'layout records its root');
    assert.ok(typeof state.layout.zoom === 'number', 'zoom');
    console.log(
      `[viewstate] layout published: nodes=${Object.keys(state.layout.positions).length} zoom=${state.layout.zoom} root=${state.layout.rootSymbolId}`,
    );
  });

  test('MCP get_view_state mirrors the published state', async function () {
    this.timeout(60_000);
    mcp = new McpStdioClient(serverPath, workspaceRoot);
    await mcp.initialize();
    const published = await readPublishedState();
    const result = await mcp.callTool('skein_get_view_state');
    assert.strictEqual(result.isError, false, 'get_view_state should succeed');
    assert.strictEqual(result.data.available, true, 'state should be available');
    assert.strictEqual(result.data.state.mode, 'callgraph');
    assert.strictEqual(result.data.state.workspaceRoot, workspaceRoot);
    assert.strictEqual(
      result.data.state.callGraph?.rootSymbolId,
      published.callGraph?.rootSymbolId,
      'MCP should report the same root the extension published',
    );
    assert.strictEqual(result.data.state.graphVersion, published.graphVersion);
    assert.strictEqual(result.data.state.windows, undefined, 'window map is summarized');
    assert.ok(result.data.state.activeWindowId, 'active window id');
    assert.ok(
      Array.isArray(result.data.windows) && result.data.windows.length >= 1,
      'window summaries',
    );
    assert.ok(result.data.windows[0].windowId, 'window summary id');
  });

  test('select: agent command changes the selection and is published', async function () {
    this.timeout(60_000);
    // Use the id exactly as an agent receives it from the MCP tool.
    const view = await mcp.callTool('skein_get_view_state');
    const root = view.data.state.callGraph.rootSymbolId as string;
    const result = await mcp.callTool('skein_control_view', { action: 'select', nodeId: root });
    assert.strictEqual(result.isError, false, `select failed: ${JSON.stringify(result.data)}`);
    assert.strictEqual(result.data.applied, true, JSON.stringify(result.data));
    assert.strictEqual(result.data.status, 'applied');
    assert.strictEqual(result.data.state?.selection?.nodeId, root, 'result state selection');
    const state = await waitForPublished(
      (s) => (s.selection?.nodeId === root ? s : null),
      'selection publication',
    );
    assert.strictEqual(state.selection.nodeId, root);
    console.log(`[viewstate] select round trip ok: ${root}`);
  });

  test('set_depth: re-queries the graph, bumps graphVersion, restores depth', async function () {
    this.timeout(90_000);
    const before = await readPublishedState();
    const beforeVersion = before.graphVersion as number;
    const beforeCount = (await getContextKey<number>('skein.callGraphNodeCount')) ?? 0;

    const result = await mcp.callTool('skein_control_view', { action: 'set_depth', depth: 3 });
    assert.strictEqual(result.data.applied, true, JSON.stringify(result.data));
    assert.strictEqual(result.data.state?.callGraph?.depth, 3, 'result state depth');

    const state = await waitForPublished(
      (s) => (s.callGraph?.depth === 3 ? s : null),
      'depth publication',
    );
    assert.strictEqual(state.callGraph.depth, 3);
    assert.ok(
      state.graphVersion > beforeVersion,
      `depth change should re-query and bump graphVersion (${beforeVersion} → ${state.graphVersion})`,
    );
    await waitForNodeCountAtLeast(beforeCount);
    console.log(`[viewstate] set_depth 3 ok, graphVersion ${beforeVersion} → ${state.graphVersion}`);

    const back = await mcp.callTool('skein_control_view', { action: 'set_depth', depth: 1 });
    assert.strictEqual(back.data.applied, true);
    await waitForPublished((s) => (s.callGraph?.depth === 1 ? s : null), 'depth reset');
  });

  test('set_filter: hides and shows node types and edge types', async function () {
    this.timeout(60_000);
    const hideFunction = await mcp.callTool('skein_control_view', {
      action: 'set_filter',
      filterType: 'nodeType',
      value: 'function',
      visible: false,
    });
    assert.strictEqual(hideFunction.data.applied, true, JSON.stringify(hideFunction.data));
    let state = await waitForPublished(
      (s) => (hasFilter(s, 'nodeType', 'function') ? s : null),
      'nodeType filter publication',
    );
    assert.ok(hasFilter(state, 'nodeType', 'function'));

    const hideEdge = await mcp.callTool('skein_control_view', {
      action: 'set_filter',
      filterType: 'edgeType',
      value: 'outgoing',
      visible: false,
    });
    assert.strictEqual(hideEdge.data.applied, true, JSON.stringify(hideEdge.data));
    state = await waitForPublished(
      (s) => (hasFilter(s, 'edgeType', 'outgoing') ? s : null),
      'edgeType filter publication',
    );
    assert.ok(hasFilter(state, 'edgeType', 'outgoing'));

    for (const [filterType, value] of [
      ['nodeType', 'function'],
      ['edgeType', 'outgoing'],
    ] as const) {
      const show = await mcp.callTool('skein_control_view', {
        action: 'set_filter',
        filterType,
        value,
        visible: true,
      });
      assert.strictEqual(show.data.applied, true, JSON.stringify(show.data));
    }
    state = await waitForPublished(
      (s) => (hasFilter(s, 'nodeType', 'function') || hasFilter(s, 'edgeType', 'outgoing') ? null : s),
      'filter reset publication',
    );
    assert.strictEqual(state.hiddenFilters.length, 0, JSON.stringify(state.hiddenFilters));
  });

  test('open_file: opens the requested file at the requested line', async function () {
    this.timeout(60_000);
    const view = await mcp.callTool('skein_get_view_state');
    const filePath = view.data.state.filePath as string;
    const result = await mcp.callTool('skein_control_view', {
      action: 'open_file',
      path: filePath,
      line: 5,
      character: 2,
    });
    assert.strictEqual(result.data.applied, true, JSON.stringify(result.data));
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'an editor should be active');
    assert.strictEqual(editor.document.uri.fsPath, filePath);
    assert.strictEqual(editor.selection.active.line, 5);
    assert.strictEqual(editor.selection.active.character, 2);
  });

  test('stale graphVersion is rejected without changing the view', async function () {
    this.timeout(60_000);
    const before = await readPublishedState();
    const result = await mcp.callTool('skein_control_view', {
      action: 'set_depth',
      depth: 2,
      graphVersion: (before.graphVersion as number) + 1,
    });
    assert.strictEqual(result.data.applied, false, JSON.stringify(result.data));
    assert.strictEqual(result.data.status, 'rejected');
    assert.strictEqual(result.data.reason, 'stale-graph-version');
    const after = await readPublishedState();
    assert.strictEqual(after.callGraph.depth, before.callGraph.depth, 'depth must not move');
  });

  test('set_expand_all drives the dependency graph view', async function () {
    this.timeout(90_000);
    await vscode.commands.executeCommand('skein.setViewModeFile');
    await waitForViewMode('file');
    await waitForPublished((s) => (s.mode === 'file' ? s : null), 'file mode publication');

    const expand = await mcp.callTool('skein_control_view', { action: 'set_expand_all', expandAll: true });
    assert.strictEqual(expand.data.applied, true, JSON.stringify(expand.data));
    await waitForPublished((s) => (s.expandAll === true ? s : null), 'expandAll true');

    const collapse = await mcp.callTool('skein_control_view', { action: 'set_expand_all', expandAll: false });
    assert.strictEqual(collapse.data.applied, true, JSON.stringify(collapse.data));
    await waitForPublished((s) => (s.expandAll === false ? s : null), 'expandAll false');
  });

  test('file surface: search, select and individual collapse round-trip through MCP', async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand('skein.setViewModeFile');
    await waitForViewMode('file');
    const published = await waitForPublished(s => s.mode === 'file' && s.surface?.nodeIds?.length ? s : null, 'file surface nodes');
    const nodeId = published.surface.nodeIds[0];
    const selected = await mcp.callTool('skein_control_view', { action: 'select', nodeId });
    assert.strictEqual(selected.data.applied, true, JSON.stringify(selected.data));
    assert.strictEqual(selected.data.state.views.file.nodeId, nodeId);
    const searched = await mcp.callTool('skein_control_view', { action: 'search', query: path.basename(nodeId) });
    assert.strictEqual(searched.data.applied, true, JSON.stringify(searched.data));
    assert.ok(searched.data.state.surface.search.matches.includes(nodeId));
    const collapsed = await mcp.callTool('skein_control_view', { action: 'set_expanded', nodeId, expanded: false });
    assert.strictEqual(collapsed.data.applied, true, JSON.stringify(collapsed.data));
    assert.ok(!collapsed.data.state.surface.expandedNodeIds.includes(nodeId));
    const missing = await mcp.callTool('skein_control_view', { action: 'select', nodeId: 'missing-file-node' });
    assert.strictEqual(missing.data.reason, 'node-not-found');
  });

  test('unknown node id is rejected with node-not-found', async function () {
    this.timeout(60_000);
    await openCallGraphFor('symbols', 'functions.ts');
    await waitForPublished((s) => (s.mode === 'callgraph' ? s : null), 'call graph reopened');
    const result = await mcp.callTool('skein_control_view', {
      action: 'select',
      nodeId: 'missing.ts:noSuchSymbol:999999',
    });
    assert.strictEqual(result.data.applied, false, JSON.stringify(result.data));
    assert.strictEqual(result.data.status, 'rejected');
    assert.strictEqual(result.data.reason, 'node-not-found');
    console.log('[viewstate] select(missing node) rejected with node-not-found');
  });

  test('command times out when no extension is listening', async function () {
    this.timeout(90_000);
    const createdAt = Date.now();
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skein-e2e-noroot-'));
    const orphan = new McpStdioClient(serverPath, tempRoot);
    try {
      await orphan.initialize();
      const result = await orphan.callTool(
        'skein_control_view',
        { action: 'set_expand_all', expandAll: true, timeoutMs: 800 },
        30_000,
      );
      assert.strictEqual(result.data.applied, false, JSON.stringify(result.data));
      assert.strictEqual(result.data.status, 'error');
      assert.strictEqual(result.data.reason, 'extension-not-responding');
      const leftovers = await fs.promises
        .readdir(path.join(tempRoot, '.skein', 'commands'))
        .catch(() => [] as string[]);
      assert.ok(
        leftovers.every((name) => !name.startsWith(`${createdAt}`)),
        `no stale request files: ${leftovers.join(',')}`,
      );
    } finally {
      await orphan.close();
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('leaves depth, filter and selection for the restart phase', async function () {
    this.timeout(120_000);
    await openCallGraphFor('symbols', 'functions.ts');
    const published = await waitForPublished(
      (s) => (s.mode === 'callgraph' && s.callGraph?.rootSymbolId ? s : null),
      'call graph state before restart',
    );
    const rootId = published.callGraph.rootSymbolId as string;
    const filePath = published.filePath as string;

    assert.strictEqual((await mcp.callTool('skein_control_view', { action: 'set_depth', depth: 3 })).data.applied, true);
    assert.strictEqual(
      (
        await mcp.callTool('skein_control_view', {
          action: 'set_filter',
          filterType: 'nodeType',
          value: 'function',
          visible: false,
        })
      ).data.applied,
      true,
    );
    assert.strictEqual(
      (await mcp.callTool('skein_control_view', { action: 'select', nodeId: rootId })).data.applied,
      true,
    );

    const state = await waitForPublished(
      (s) =>
        s.callGraph?.depth === 3 &&
        hasFilter(s, 'nodeType', 'function') &&
        s.selection?.nodeId === rootId
          ? s
          : null,
      'state prepared for restart',
    );
    await fs.promises.mkdir(path.dirname(markerPath()), { recursive: true });
    await fs.promises.writeFile(
      markerPath(),
      `${JSON.stringify(
        {
          workspaceRoot,
          filePath,
          rootId,
          depth: 3,
          hiddenFilters: state.hiddenFilters,
          selection: state.selection,
          graphVersion: state.graphVersion,
          updatedAt: state.updatedAt,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    console.log(`[viewstate] restart baseline written: depth=3 root=${rootId}`);
  });
});
