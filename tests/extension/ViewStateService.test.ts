import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewStateService } from '../../src/extension/services/ViewStateService';
import {
  createCommandId,
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
  };
  let service: ViewStateService;

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
    };
    service = new ViewStateService({ root, logger, host, pollIntervalMs: 10 });
    await service.start();
  });

  afterEach(async () => {
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

  it('rejects view commands while another view mode is showing', async () => {
    host.read.mockReturnValue({ snapshot: snapshot({ mode: 'file' }), graphVersion: 4 });
    await waitFor(
      () => readViewState(root).then((state) => (state?.mode === 'file' ? state : null)),
      'file mode state',
    );

    const request = {
      id: createCommandId(),
      createdAt: Date.now(),
      command: { action: 'select' as const, nodeId: 'n1' },
    };
    await writeCommandRequest(root, request);

    const result = await waitFor(() => readCommandResult(root, request.id), 'not available result');
    expect(result.reason).toBe('view-not-available');
    expect(host.select).not.toHaveBeenCalled();
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
    );
  });

  it('drops a request it cannot parse and keeps polling', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, '.skein', 'commands', 'broken.request.json'), '{}', 'utf8');
    const state = await waitFor(() => readViewState(root), 'state after malformed request');
    expect(state.graphVersion).toBe(4);
    expect(await listCommandRequests(root)).toEqual([]);
  });
});
