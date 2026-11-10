import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeControlView,
  executeGetViewState,
  type ControlViewParams,
} from '../../../src/mcp/tools/viewState';
import {
  parseCommandRequest,
  SKEIN_STATE_SCHEMA_VERSION,
  viewStatePath,
  writeCommandResult,
  type SkeinCommandRequest,
  type SkeinViewState,
} from '../../../src/shared/viewState';
import { writeJsonAtomic } from '../../../src/shared/atomicWrite';
import { readdir, readFile } from 'node:fs/promises';

/** Requests the MCP side queued, oldest first (what the extension's bridge reads). */
async function listRequests(dir: string): Promise<SkeinCommandRequest[]> {
  const commands = path.join(dir, '.skein', 'commands');
  let names: string[] = [];
  try {
    names = await readdir(commands);
  } catch {
    return [];
  }
  const requests: SkeinCommandRequest[] = [];
  for (const name of names.filter((n) => n.endsWith('.request.json')).sort()) {
    const request = parseCommandRequest(await readFile(path.join(commands, name), 'utf8'));
    if (request) requests.push(request);
  }
  return requests.sort((a, b) => a.createdAt - b.createdAt);
}

/** Plays the extension's publisher for a seeded state file. */
function writeState(dir: string, state: SkeinViewState): Promise<void> {
  return writeJsonAtomic(viewStatePath(dir), state);
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'skein-mcp-view-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const appliedState = (graphVersion = 7) => {
  const window = {
    windowId: 'w1',
    updatedAt: 1,
    lastUserActionAt: 0,
    graphVersion,
    mode: 'callgraph' as const,
    hiddenFilters: [],
    expandAll: false,
  };
  return {
    schemaVersion: SKEIN_STATE_SCHEMA_VERSION,
    workspaceRoot: root,
    ...window,
    activeWindowId: 'w1',
    windows: { w1: window },
  };
};

/** Plays the extension: picks up the first request and answers it. */
function answerNextRequest(status: 'applied' | 'rejected' = 'applied'): Promise<void> {
  return (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [request] = await listRequests(root);
      if (request) {
        await writeCommandResult(root, {
          id: request.id,
          status,
          reason: status === 'rejected' ? 'user-action-superseded' : undefined,
          completedAt: Date.now(),
          state: status === 'applied' ? appliedState() : undefined,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('no request was queued');
  })();
}

describe('skein_get_view_state', () => {
  it('reports an unconfigured workspace instead of guessing a root', async () => {
    expect(await executeGetViewState(undefined)).toEqual({
      available: false,
      reason: 'workspace-not-configured',
    });
  });

  it('reports a missing state file', async () => {
    expect(await executeGetViewState(root)).toEqual({
      available: false,
      reason: 'state-file-missing',
    });
  });

  it('returns the published view', async () => {
    await writeState(root, appliedState());
    const result = await executeGetViewState(root);
    expect(result.available).toBe(true);
    expect(result.state?.graphVersion).toBe(7);
    expect(result.state?.windows).toBeUndefined();
    expect(result.windows).toEqual([
      { windowId: 'w1', updatedAt: 1, lastUserActionAt: 0, mode: 'callgraph', graphVersion: 7 },
    ]);
  });

  it('omits the node position map from the response', async () => {
    const state = appliedState();
    const window = state.windows.w1 as Record<string, unknown>;
    window.layout = { positions: { n1: { x: 1, y: 2 }, n2: { x: 3, y: 4 } }, zoom: 1.5 };
    await writeState(root, state);
    const result = await executeGetViewState(root);
    expect(result.state?.layout).toEqual({ zoom: 1.5, positionCount: 2 });
  });
});

describe('skein_control_view', () => {
  it('returns the extension result', async () => {
    const answer = answerNextRequest('applied');
    const result = await executeControlView(root, {
      action: 'select',
      nodeId: 'n1',
      graphVersion: 7,
    });
    await answer;

    expect(result.applied).toBe(true);
    expect(result.status).toBe('applied');
    expect(result.state?.graphVersion).toBe(7);
  });

  it('passes a user-priority rejection through', async () => {
    const answer = answerNextRequest('rejected');
    const result = await executeControlView(root, { action: 'select', nodeId: 'n1' });
    await answer;

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('user-action-superseded');
  });

  it('fails when no extension answers', async () => {
    const result = await executeControlView(root, { action: 'select', nodeId: 'n1', timeoutMs: 100 });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('extension-not-responding');
  });

  it('targets the active window and rejects an unknown window id', async () => {
    await writeState(root, appliedState());
    const answer = (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const [request] = await listRequests(root);
        if (request) {
          expect(request.targetWindowId).toBe('w1');
          await writeCommandResult(root, {
            id: request.id,
            status: 'applied',
            completedAt: Date.now(),
            state: appliedState(),
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('no request was queued');
    })();

    const result = await executeControlView(root, { action: 'select', nodeId: 'n1' });
    await answer;
    expect(result.applied).toBe(true);
    expect(result.windowId).toBe('w1');

    const unknown = await executeControlView(root, {
      action: 'select',
      nodeId: 'n1',
      windowId: 'missing',
      timeoutMs: 100,
    });
    expect(unknown.applied).toBe(false);
    expect(unknown.reason).toBe('window-not-found');
    expect(await listRequests(root)).toEqual([]);
  });

  it('refuses to open a file outside the workspace', async () => {
    const outside = path.join(tmpdir(), 'skein-outside-file.ts');
    const result = await executeControlView(root, { action: 'open_file', path: outside });
    expect(result.status).toBe('error');
    expect(result.reason).toBe('path-outside-workspace');
    expect(await listRequests(root)).toEqual([]);
  });

  it('accepts a file from another published workspace folder', async () => {
    const otherRoot = await mkdtemp(path.join(tmpdir(), 'skein-mcp-other-'));
    await writeState(root, { ...appliedState(), workspaceRoots: [root, otherRoot] });
    const answer = answerNextRequest();
    const result = await executeControlView(root, {
      action: 'open_file',
      path: path.join(otherRoot, 'src', 'other.ts'),
    });
    await answer;
    expect(result.status).toBe('applied');
    await rm(otherRoot, { recursive: true, force: true });
  });

  it('queues a view mode change', async () => {
    await writeState(root, appliedState());
    const answer = answerNextRequest();
    const result = await executeControlView(root, { action: 'set_view_mode', viewMode: 'architecture' });
    await answer;
    expect(result.applied).toBe(true);
    expect(result.windowId).toBe('w1');
  });

  it.each<[string, ControlViewParams]>([
    ['select without nodeId', { action: 'select' }],
    ['set_depth without depth', { action: 'set_depth' }],
    ['open_file without path', { action: 'open_file' }],
    ['set_filter without visible', { action: 'set_filter', filterType: 'folder', value: 'src' }],
    ['set_expand_all without expandAll', { action: 'set_expand_all' }],
  ])('rejects invalid params: %s', async (_name, params) => {
    const result = await executeControlView(root, params);
    expect(result.status).toBe('error');
    expect(await listRequests(root)).toEqual([]);
  });
});

describe('extended view commands', () => {
  it.each<ControlViewParams>([
    { action: 'search', query: 'core' },
    { action: 'set_expanded', nodeId: 'group-1', expanded: false },
    { action: 'set_architecture', view: 'matrix', minImports: 2 },
  ])('queues $action through the window-targeted bridge', async params => {
    await writeState(root, appliedState());
    const answer = answerNextRequest();
    const result = await executeControlView(root, params);
    await answer;
    expect(result.applied).toBe(true);
    expect(result.windowId).toBe('w1');
  });
  it('does not enqueue incomplete expansion or search commands', async () => {
    expect((await executeControlView(root, { action: 'search' })).applied).toBe(false);
    expect((await executeControlView(root, { action: 'set_expanded', nodeId: 'n' })).applied).toBe(false);
    expect(await listRequests(root)).toEqual([]);
  });
});
