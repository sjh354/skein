import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCommandId,
  deleteCommandFiles,
  isCommandStale,
  isCommandSupersededByUser,
  listCommandRequests,
  mergeViewState,
  parseCommandRequest,
  parseCommandResult,
  parseViewState,
  readCommandResult,
  readViewState,
  SKEIN_STATE_SCHEMA_VERSION,
  viewStatePath,
  writeCommandRequest,
  writeCommandResult,
  writeViewState,
  type SkeinCommandRequest,
  type SkeinViewState,
} from '../../src/shared/viewState';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'skein-view-state-'));
  roots.push(root);
  return root;
}

function state(overrides: Partial<SkeinViewState> = {}): SkeinViewState {
  return {
    schemaVersion: SKEIN_STATE_SCHEMA_VERSION,
    workspaceRoot: '/workspace',
    updatedAt: 100,
    lastUserActionAt: 0,
    graphVersion: 3,
    mode: 'callgraph',
    filePath: '/workspace/src/app.ts',
    hiddenFilters: [{ filterType: 'nodeType', value: 'variable' }],
    expandAll: false,
    selection: { nodeId: '/workspace/src/app.ts:main:10', name: 'main', startLine: 10 },
    callGraph: { rootSymbolId: '/workspace/src/app.ts:main:10', depth: 2 },
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('view state file', () => {
  it('round-trips through .skein/state.json', async () => {
    const root = await tempRoot();
    await writeViewState(root, state());

    const raw = await readFile(viewStatePath(root), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const parsed = await readViewState(root);
    expect(parsed).toMatchObject(state());
    expect(parsed?.activeWindowId).toBe('legacy');
    const { schemaVersion, workspaceRoot, ...windowState } = state();
    void schemaVersion;
    void workspaceRoot;
    expect(parsed?.windows.legacy).toMatchObject(windowState);
  });

  it('merges two windows instead of letting the last writer erase the other', async () => {
    const root = await tempRoot();
    await mergeViewState(root, {
      workspaceRoot: root,
      windowId: 'window-a',
      snapshot: { ...state(), mode: 'callgraph', selection: { nodeId: 'a' } },
      graphVersion: 4,
      lastUserActionAt: 0,
    });
    await mergeViewState(root, {
      workspaceRoot: root,
      windowId: 'window-b',
      snapshot: { ...state(), mode: 'file', selection: { nodeId: 'b' } },
      graphVersion: 5,
      lastUserActionAt: 0,
    });

    const parsed = await readViewState(root);
    expect(Object.keys(parsed?.windows ?? {}).sort()).toEqual(['window-a', 'window-b']);
    expect(parsed?.activeWindowId).toBe('window-b');
    expect(parsed?.mode).toBe('file');
    expect(parsed?.windows['window-a']).toMatchObject({ mode: 'callgraph', graphVersion: 4 });
    expect(parsed?.windows['window-b']).toMatchObject({ mode: 'file', graphVersion: 5 });
  });

  it('migrates a schema 1 state file to a legacy window', async () => {
    const root = await tempRoot();
    const legacy: Record<string, unknown> = { ...state(), schemaVersion: 1 };
    delete legacy.windowId;
    delete legacy.activeWindowId;
    delete legacy.windows;
    await mkdir(path.dirname(viewStatePath(root)), { recursive: true });
    await writeFile(viewStatePath(root), JSON.stringify(legacy), 'utf8');

    const parsed = await readViewState(root);
    expect(parsed?.schemaVersion).toBe(SKEIN_STATE_SCHEMA_VERSION);
    expect(parsed?.activeWindowId).toBe('legacy');
    expect(parsed?.windows.legacy.mode).toBe('callgraph');
    expect(parsed?.graphVersion).toBe(3);
  });

  it('returns null for a missing file, malformed JSON and an unknown schema', async () => {
    const root = await tempRoot();
    expect(await readViewState(root)).toBeNull();

    await writeViewState(root, state());
    await writeFile(viewStatePath(root), '{not json', 'utf8');
    expect(await readViewState(root)).toBeNull();

    await writeFile(
      viewStatePath(root),
      JSON.stringify({ ...state(), schemaVersion: SKEIN_STATE_SCHEMA_VERSION + 1 }),
      'utf8',
    );
    expect(await readViewState(root)).toBeNull();
  });

  it('rejects a state without a view mode', () => {
    expect(parseViewState(JSON.stringify({ ...state(), mode: 'toolbar' }))).toBeNull();
  });
});

describe('view command queue', () => {
  const request = (overrides: Partial<SkeinCommandRequest> = {}): SkeinCommandRequest => ({
    id: createCommandId(),
    createdAt: 50,
    command: { action: 'select', nodeId: '/workspace/src/app.ts:main:10' },
    ...overrides,
  });

  it('lists requests oldest first and ignores malformed entries', async () => {
    const root = await tempRoot();
    const older = request({ createdAt: 10 });
    const newer = request({ createdAt: 20 });
    await writeCommandRequest(root, newer);
    await writeCommandRequest(root, older);
    await writeFile(path.join(root, '.skein', 'commands', 'broken.request.json'), '{}', 'utf8');

    const listed = await listCommandRequests(root);
    expect(listed.map((item) => item.id)).toEqual([older.id, newer.id]);
  });

  it('round-trips a result and deletes both files', async () => {
    const root = await tempRoot();
    const pending = request();
    await writeCommandRequest(root, pending);
    await writeCommandResult(root, {
      id: pending.id,
      status: 'rejected',
      reason: 'user-action-superseded',
      completedAt: 60,
    });

    expect(await readCommandResult(root, pending.id)).toMatchObject({
      id: pending.id,
      status: 'rejected',
      reason: 'user-action-superseded',
    });

    await deleteCommandFiles(root, pending.id);
    expect(await readCommandResult(root, pending.id)).toBeNull();
    expect(await listCommandRequests(root)).toEqual([]);
  });

  it('ignores commands with unknown actions', () => {
    expect(
      parseCommandRequest(
        JSON.stringify({ id: 'x', createdAt: 1, command: { action: 'delete_repo' } }),
      ),
    ).toBeNull();
  });

  it('keeps a per-action result state', () => {
    const parsed = parseCommandResult(
      JSON.stringify({ id: 'x', status: 'applied', completedAt: 5, state: state() }),
    );
    expect(parsed?.state?.selection?.nodeId).toBe('/workspace/src/app.ts:main:10');
  });
});

describe('user priority and staleness', () => {
  it('drops a command queued before the user last acted', () => {
    const pending = {
      id: 'x',
      createdAt: 100,
      command: { action: 'select' as const, nodeId: 'n' },
    };
    expect(isCommandSupersededByUser(pending, state({ lastUserActionAt: 101 }))).toBe(true);
    expect(isCommandSupersededByUser(pending, state({ lastUserActionAt: 100 }))).toBe(false);
  });

  it('rejects a command pinned to an older graph version', () => {
    const pending = {
      id: 'x',
      createdAt: 100,
      graphVersion: 2,
      command: { action: 'select' as const, nodeId: 'n' },
    };
    expect(isCommandStale(pending, state({ graphVersion: 3 }))).toBe(true);
    expect(isCommandStale(pending, state({ graphVersion: 2 }))).toBe(false);
    expect(
      isCommandStale({ id: 'x', createdAt: 100, command: { action: 'select', nodeId: 'n' } }, state()),
    ).toBe(false);
  });
});

describe('extended surface state', () => {
  it('round-trips selections, bounded analysis and diagnostic references', () => {
    const surface = {
      nodeIds: ['group-1'], expandedNodeIds: ['group-1'],
      search: { query: 'core', matches: ['group-1'], total: 1 },
      architecture: { revision: 'r1', view: 'matrix', minImports: 2 },
      analysis: { revision: 'r1', nodes: 2, edges: 1, stale: true },
      diagnostics: { total: 1, truncated: false, items: [{ id: 'd1', kind: 'dependency', status: 'candidate' }] },
    };
    const parsed = parseViewState(JSON.stringify(state({ surface, views: { file: { nodeId: 'file' }, list: { nodeId: 'symbol' }, architecture: { nodeId: 'group-1' } } })));
    expect(parsed?.surface).toEqual(surface);
    expect(parsed?.views?.architecture?.nodeId).toBe('group-1');
  });
  it.each([
    { action: 'search', query: 'core' },
    { action: 'set_expanded', nodeId: 'group-1', expanded: false },
    { action: 'set_architecture', view: 'matrix', minImports: 2 },
  ])('round-trips the $action command', command => {
    const request = { id: 'extended', createdAt: 1, command };
    expect(parseCommandRequest(JSON.stringify(request))?.command).toEqual(command);
  });
  it('rejects malformed architecture controls', () => {
    expect(parseCommandRequest(JSON.stringify({ id: 'bad', createdAt: 1, command: { action: 'set_architecture', minImports: -1 } }))).toBeNull();
  });
});
