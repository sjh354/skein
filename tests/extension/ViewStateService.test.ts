import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewStateService } from '../../src/extension/services/ViewStateService';
import { CommandBridgeService } from '../../src/extension/services/CommandBridgeService';
import {
  createCommandId,
  deleteCommandRequest,
  listCommandRequests,
  readCommandResult,
  readViewState,
  SKEIN_STATE_SCHEMA_VERSION,
  writeCommandRequest,
  writeViewState,
  type SkeinViewSnapshot,
} from '../../src/shared/viewState';

vi.mock('vscode', () => ({}));

const logger = { debug: vi.fn(), warn: vi.fn() };

function snapshot(overrides: Partial<SkeinViewSnapshot> = {}): SkeinViewSnapshot {
  return {
    mode: 'callgraph',
    filePath: '/workspace/src/app.ts',
    hiddenFilters: [],
    expandAll: false,
    callGraph: { rootSymbolId: 'root', depth: 1 },
    ...overrides,
  };
}

async function waitFor<T>(read: () => Promise<T | null | undefined>, message: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${message}`);
}

describe('ViewStateService', () => {
  let root: string;
  let host: {
    read: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    setDepth: ReturnType<typeof vi.fn>;
    openFile: ReturnType<typeof vi.fn>;
    setFilter: ReturnType<typeof vi.fn>;
    setExpandAll: ReturnType<typeof vi.fn>;
    hasNode: ReturnType<typeof vi.fn>;
    controlSurface: ReturnType<typeof vi.fn>;
  };
  let service: ViewStateService;
  let bridge: CommandBridgeService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'skein-view-service-'));
    host = {
      read: vi.fn(() => ({ snapshot: snapshot(), graphVersion: 4 })),
      select: vi.fn(async () => true),
      focus: vi.fn(async () => true),
      setDepth: vi.fn(async () => true),
      openFile: vi.fn(async () => true),
      setFilter: vi.fn(async () => true),
      setExpandAll: vi.fn(async () => true),
      hasNode: vi.fn(() => true),
      controlSurface: vi.fn(async () => true),
    };
    service = new ViewStateService({ root, logger, host, pollIntervalMs: 10 });
    await service.start();
    bridge = new CommandBridgeService({
      root,
      logger,
      windowId: () => service.getWindowId(),
      view: service,
      change: { handleRequest: async (request) => ({ id: request.id, status: 'rejected', reason: 'change-not-used', completedAt: Date.now() }) },
      pollIntervalMs: 10,
    });
    await bridge.start();
  });

  afterEach(async () => {
    bridge.dispose();
    service.dispose();
    // Let an in-flight poll finish before removing the directory.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('publishes the host view to .skein/state.json', async () => {
    const state = await waitFor(() => readViewState(root), 'published state');
    expect(state.mode).toBe('callgraph');
    expect(state.graphVersion).toBe(4);
    expect(state.selection).toBeUndefined();
    expect(await import('node:fs/promises').then((fs) => fs.stat(path.join(root, '.skein', '.gitignore'))))
      .toBeTruthy();
  });

  it('applies a queued command and writes the result', async () => {
    const request = {
      id: createCommandId(),
      createdAt: Date.now(),
      command: { action: 'select' as const, nodeId: 'n1' },
    };
    await writeCommandRequest(root, request);

    const result = await waitFor(() => readCommandResult(root, request.id), 'command result');
    expect(result.status).toBe('applied');
    expect(host.select).toHaveBeenCalledWith('n1');
    expect(result.state?.mode).toBe('callgraph');
  });

  it('rejects a command queued before the user acted', async () => {
    service.markUserAction();
    await waitFor(
      () => readViewState(root).then((state) => (state && state.lastUserActionAt > 0 ? state : null)),
      'user action stamp',
    );

    const request = {
      id: createCommandId(),
      createdAt: Date.now() - 1_000,
      command: { action: 'select' as const, nodeId: 'n1' },
    };
    await writeCommandRequest(root, request);

    const result = await waitFor(() => readCommandResult(root, request.id), 'rejection result');
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('user-action-superseded');
    expect(host.select).not.toHaveBeenCalled();
  });

  it('rejects a command pinned to an older graph version', async () => {
    const request = {
      id: createCommandId(),
      createdAt: Date.now(),
      graphVersion: 3,
      command: { action: 'set_depth' as const, depth: 3 },
    };
    await writeCommandRequest(root, request);

    const result = await waitFor(() => readCommandResult(root, request.id), 'stale result');
    expect(result.reason).toBe('stale-graph-version');
    expect(host.setDepth).not.toHaveBeenCalled();
  });

  it('rejects call-graph depth commands while another view mode is showing', async () => {
    host.read.mockReturnValue({ snapshot: snapshot({ mode: 'file' }), graphVersion: 4 });
    await waitFor(
      () => readViewState(root).then((state) => (state?.mode === 'file' ? state : null)),
      'file mode state',
    );

    const request = {
      id: createCommandId(),
      createdAt: Date.now(),
      command: { action: 'set_depth' as const, depth: 2 },
    };
    await writeCommandRequest(root, request);

    const result = await waitFor(() => readCommandResult(root, request.id), 'not available result');
    expect(result.reason).toBe('view-not-available');
    expect(host.select).not.toHaveBeenCalled();
  });

  it('rejects selecting a node that is not in the current graph', async () => {
    host.hasNode.mockReturnValue(false);
    const request = {
      id: createCommandId(),
      createdAt: Date.now(),
      command: { action: 'select' as const, nodeId: 'stale-node' },
    };
    await writeCommandRequest(root, request);

    const result = await waitFor(() => readCommandResult(root, request.id), 'node-not-found result');
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('node-not-found');
    expect(host.select).not.toHaveBeenCalled();
  });

  it('keeps the restored call-graph snapshot while another view mode is showing', async () => {
    service.dispose();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeViewState(root, {
      schemaVersion: SKEIN_STATE_SCHEMA_VERSION,
      workspaceRoot: root,
      updatedAt: 1,
      lastUserActionAt: 0,
      graphVersion: 9,
      mode: 'callgraph',
      filePath: '/workspace/src/app.ts',
      hiddenFilters: [{ filterType: 'nodeType', value: 'function' }],
      expandAll: false,
      callGraph: { rootSymbolId: 'root', depth: 3 },
      selection: { nodeId: 'root' },
    });
    host.read.mockReturnValue({
      snapshot: snapshot({ mode: 'file', filePath: '/workspace/src/app.ts', hiddenFilters: [] }),
      graphVersion: 0,
    });
    service = new ViewStateService({ root, logger, host, pollIntervalMs: 10, onRestore: vi.fn() });
    await service.start();

    const state = await waitFor(
      () => readViewState(root).then((value) => (value?.mode === 'file' ? value : null)),
      'published file-mode state',
    );
    expect(state.callGraph).toEqual({ rootSymbolId: 'root', depth: 3 });
    expect(state.hiddenFilters).toEqual([{ filterType: 'nodeType', value: 'function' }]);
    expect(state.selection).toEqual({ nodeId: 'root' });
  });

  it('restores the previous session view once', async () => {
    service.dispose();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeViewState(root, {
      schemaVersion: SKEIN_STATE_SCHEMA_VERSION,
      workspaceRoot: root,
      updatedAt: 1,
      lastUserActionAt: 0,
      graphVersion: 9,
      mode: 'callgraph',
      hiddenFilters: [{ filterType: 'folder', value: 'src' }],
      expandAll: false,
      callGraph: { depth: 3 },
    });
    const onRestore = vi.fn();
    service = new ViewStateService({ root, logger, host, pollIntervalMs: 10, onRestore });
    await service.start();

    expect(onRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'callgraph',
        hiddenFilters: [{ filterType: 'folder', value: 'src' }],
      }),
      9,
    );
  });

  it('publishes the call-graph layout reported by the webview', async () => {
    service.observeWebviewCommand({
      command: 'callGraphLayoutChanged',
      layout: {
        positions: { n1: { x: 12, y: 34 } },
        zoom: 1.5,
        pan: { x: -5, y: 6 },
        rootSymbolId: 'root',
      },
      userInitiated: true,
    });

    const state = await waitFor(
      () => readViewState(root).then((value) => (value?.layout ? value : null)),
      'layout publication',
    );
    expect(state.layout).toEqual({
      positions: { n1: { x: 12, y: 34 } },
      zoom: 1.5,
      pan: { x: -5, y: 6 },
      rootSymbolId: 'root',
    });
  });

  it('leaves commands targeted at another window for that window', async () => {
    const published = await waitFor(() => readViewState(root), 'published state');
    const request = {
      id: createCommandId(),
      createdAt: Date.now(),
      targetWindowId: 'another-window',
      command: { action: 'select' as const, nodeId: 'n1' },
    };
    await writeCommandRequest(root, request);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readCommandResult(root, request.id)).toBeNull();
    expect(host.select).not.toHaveBeenCalled();
    expect((await listCommandRequests(root)).map((item) => item.id)).toContain(request.id);
    expect(published.activeWindowId).not.toBe('another-window');
    await deleteCommandRequest(root, request.id);
  });

  it('drops a request it cannot parse and keeps polling', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, '.skein', 'commands', 'broken.request.json'), '{}', 'utf8');
    const state = await waitFor(() => readViewState(root), 'state after malformed request');
    expect(state.graphVersion).toBe(4);
    expect(await listCommandRequests(root)).toEqual([]);
  });
  it('routes non-callgraph selection to the renderer and preserves the last callgraph selection', async () => {
    host.read.mockReturnValue({ snapshot: snapshot({ mode: 'file', views: { file: { nodeId: 'file-node' } } }), graphVersion: 4 });
    const result = await service.handleCommand({ id: createCommandId(), createdAt: Date.now(), command: { action: 'select', nodeId: 'file-node' } });
    expect(result.status).toBe('applied');
    expect(host.controlSurface).toHaveBeenCalledWith({ action: 'select', nodeId: 'file-node' });
    expect(host.select).not.toHaveBeenCalled();
    expect(result.state?.views?.file?.nodeId).toBe('file-node');
  });

  it('rejects an in-flight renderer command if a real user acts before it completes', async () => {
    host.read.mockReturnValue({ snapshot: snapshot({ mode: 'file' }), graphVersion: 4 });
    host.controlSurface.mockImplementation(async () => { service.markUserAction(); return true; });
    const result = await service.handleCommand({ id: createCommandId(), createdAt: Date.now() - 1000, command: { action: 'search', query: 'core' } });
    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('user-action-superseded');
  });

});
