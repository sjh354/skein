import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphProvider } from '../../src/extension/GraphProvider';
import type { VsCodeLogger } from '../../src/extension/extensionLogger';
import type { CallGraphViewService } from '../../src/extension/services/CallGraphViewService';
import type { CommandCoordinator } from '../../src/extension/services/CommandCoordinator';
import { CommandRegistrationService } from '../../src/extension/services/CommandRegistrationService';

vi.mock('vscode', () => {
  const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const executeCommand = vi.fn();
  const showInformationMessage = vi.fn();
  const showErrorMessage = vi.fn();
  const registerCommand = vi.fn((commandId: string, handler: (...args: unknown[]) => unknown) => {
    registeredHandlers.set(commandId, handler);
    return { dispose: vi.fn() };
  });

  return {
    commands: {
      registerCommand,
      executeCommand,
    },
    window: {
      showInformationMessage,
      showErrorMessage,
    },
    Disposable: {
      from: (...disposables: { dispose: () => unknown }[]) => ({
        dispose: () => disposables.forEach((d) => d.dispose()),
      }),
    },
    __mocks: {
      registeredHandlers,
      executeCommand,
      showInformationMessage,
      showErrorMessage,
      registerCommand,
    },
  };
});

import * as vscode from 'vscode';
const {
  registeredHandlers,
  executeCommand,
  showErrorMessage,
  registerCommand,
} = (vscode as unknown as { __mocks: {
  registeredHandlers: Map<string, (...args: unknown[]) => unknown>;
  executeCommand: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
} }).__mocks;

function createProviderMock(): GraphProvider {
  return {
    getViewMode: vi.fn().mockReturnValue('file'), // E2E test helper
    getReverseDependenciesVisible: vi.fn().mockReturnValue(false),
    showEditorGraph: vi.fn(),
    getFileGraphNodeMetadata: vi.fn().mockReturnValue({}),
    getFileGraphRoot: vi.fn().mockReturnValue(undefined),
    getArchitectureE2EState: vi.fn().mockReturnValue({
      buildCount: 2, renderCount: 3, groupCount: 20, groupEdgeCount: 6, revision: 'r1', communityMode: 'path', stale: true,
      overlappingGroups: 1, overflowingLabels: 2, positions: 'path:ui@0,0', resizeCount: 4, viewSize: { width: 320, height: 200 },
      interactionCount: 5, interaction: { highlightedGroups: 2 }, matrixCount: 6, matrix: { rows: 11 }, rendered: { headerHeightPx: 90 },
    }),
    setArchitectureControls: vi.fn(),
  } as unknown as GraphProvider;
}

function createCallGraphViewServiceMock(): CallGraphViewService {
  return {
    getCallGraphRenderCount: vi.fn().mockReturnValue(1),
    getCallGraphNodeCount: vi.fn().mockReturnValue(2),
    getCallGraphEdgeCount: vi.fn().mockReturnValue(3),
    getCallGraphCycleCount: vi.fn().mockReturnValue(4),
  } as unknown as CallGraphViewService;
}

function createCommandCoordinatorMock(): CommandCoordinator {
  return {
    handleForceReindex: vi.fn(),
    handleExpandAll: vi.fn(),
    handleRefreshGraph: vi.fn(),
    handleSetViewModeFile: vi.fn(),
    handleSetViewModeList: vi.fn(),
    handleSetViewModeSymbol: vi.fn(),
    handleSetViewModeArchitecture: vi.fn(),
    handleShowReverseDependencies: vi.fn(),
    handleHideReverseDependencies: vi.fn(),
    handleEnableUnusedFilter: vi.fn(),
    handleDisableUnusedFilter: vi.fn(),
    handleShowIndexStatus: vi.fn(),
  } as unknown as CommandCoordinator;
}

function createLoggerMock(): VsCodeLogger {
  return {
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    setLevel: vi.fn(),
    level: 'info',
    show: vi.fn(),
  } as unknown as VsCodeLogger;
}

describe('CommandRegistrationService', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    executeCommand.mockReset();
    showErrorMessage.mockReset();
    registerCommand.mockClear();
  });

  it('registers all Skein commands', () => {
    const provider = createProviderMock();
    const commandCoordinator = createCommandCoordinatorMock();
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ callGraphViewService: createCallGraphViewServiceMock(), provider, commandCoordinator, logger });

    const disposables = service.registerAll();

    expect(disposables).toHaveLength(14); // getContext is shared; filter commands share one disposable
    expect(registerCommand).toHaveBeenCalledTimes(15);
    expect(registeredHandlers.has('skein.showGraph')).toBe(true);
    expect(registeredHandlers.has('skein.forceReindex')).toBe(true);
    expect(registeredHandlers.has('skein.expandAllNodes')).toBe(true);
    expect(registeredHandlers.has('skein.refreshGraph')).toBe(true);
    expect(registeredHandlers.has('skein.toggleViewMode')).toBe(false);
    expect(registeredHandlers.has('skein.setViewModeFile')).toBe(true);
    expect(registeredHandlers.has('skein.setViewModeList')).toBe(true);
    expect(registeredHandlers.has('skein.setViewModeSymbol')).toBe(true);
    expect(registeredHandlers.has('skein.setViewModeArchitecture')).toBe(true);
    expect(registeredHandlers.has('getContext')).toBe(true); // E2E test helper
    expect(registeredHandlers.has('skein.showReverseDependencies')).toBe(true);
    expect(registeredHandlers.has('skein.hideReverseDependencies')).toBe(true);
    expect(registeredHandlers.has('skein.enableUnusedFilter')).toBe(true);
    expect(registeredHandlers.has('skein.disableUnusedFilter')).toBe(true);
    expect(registeredHandlers.has('skein.showIndexStatus')).toBe(true);
  });

  it('switches to the architecture view and exposes its E2E state through getContext', async () => {
    const provider = createProviderMock();
    const commandCoordinator = createCommandCoordinatorMock();
    const service = new CommandRegistrationService({ callGraphViewService: createCallGraphViewServiceMock(), provider, commandCoordinator, logger: createLoggerMock() });
    service.registerAll();

    await registeredHandlers.get('skein.setViewModeArchitecture')?.();
    expect(commandCoordinator.handleSetViewModeArchitecture).toHaveBeenCalled();

    const getContext = registeredHandlers.get('getContext')!;
    expect(await getContext('skein.viewMode')).toBe('file');
    expect(await getContext('skein.architectureRenderCount')).toBe(3);
    expect(await getContext('skein.architectureGroupCount')).toBe(20);
    expect(await getContext('skein.architectureGroupEdgeCount')).toBe(6);
    expect(await getContext('skein.architectureRevision')).toBe('r1');
    expect(await getContext('skein.architectureBuildCount')).toBe(2);
    expect(await getContext('skein.architectureCommunityMode')).toBe('path');
    expect(await getContext('skein.architectureStale')).toBe(true);
    expect(await getContext('skein.architectureOverlappingGroups')).toBe(1);
    expect(await getContext('skein.architectureOverflowingLabels')).toBe(2);
    expect(await getContext('skein.architecturePositions')).toBe('path:ui@0,0');
    expect(await getContext('skein.architectureResizeCount')).toBe(4);
    expect(await getContext('skein.architectureViewSize')).toEqual({ width: 320, height: 200 });
    expect(await getContext('skein.architectureInteractionCount')).toBe(5);
    expect(await getContext('skein.architectureInteraction')).toEqual({ highlightedGroups: 2 });
    expect(await getContext('skein.architectureMatrixCount')).toBe(6);
    expect(await getContext('skein.architectureMatrix')).toEqual({ rows: 11 });
    expect(await getContext('skein.architectureRendered')).toEqual({ headerHeightPx: 90 });

    await registeredHandlers.get('skein.e2eArchitectureControls')?.({ find: 'ui', minImports: 2 });
    expect(provider.setArchitectureControls).toHaveBeenCalledWith({ find: 'ui', minImports: 2 });
    expect(await getContext('skein.unknown')).toBeUndefined();
    expect(await getContext('skein.reverseDependenciesVisible')).toBe(false);
    expect([
      await getContext('skein.callGraphRenderCount'),
      await getContext('skein.callGraphNodeCount'),
      await getContext('skein.callGraphEdgeCount'),
      await getContext('skein.callGraphCycleCount'),
      await getContext('skein.fileGraphNodeMetadata'),
    ]).toEqual([1, 2, 3, 4, {}]);

    (provider.getArchitectureE2EState as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    expect(await getContext('skein.architectureRenderCount')).toBe(0);
    expect(await getContext('skein.architectureGroupCount')).toBe(0);
    expect(await getContext('skein.architectureGroupEdgeCount')).toBe(0);
    expect(await getContext('skein.architectureBuildCount')).toBe(0);
    expect(await getContext('skein.architectureStale')).toBe(false);
    expect(await getContext('skein.architectureResizeCount')).toBe(0);
    expect(await getContext('skein.architectureOverlappingGroups')).toBe(0);
    expect(await getContext('skein.architectureOverflowingLabels')).toBe(0);
    expect(await getContext('skein.architecturePositions')).toBeUndefined();
    expect(await getContext('skein.architectureViewSize')).toBeUndefined();
    expect(await getContext('skein.architectureInteractionCount')).toBe(0);
    expect(await getContext('skein.architectureInteraction')).toBeUndefined();
    expect(await getContext('skein.architectureMatrixCount')).toBe(0);
    expect(await getContext('skein.architectureMatrix')).toBeUndefined();
    expect(await getContext('skein.architectureRendered')).toBeUndefined();
  });

  it.each([
    ['skein.forceReindex', 'handleForceReindex'],
    ['skein.expandAllNodes', 'handleExpandAll'],
    ['skein.refreshGraph', 'handleRefreshGraph'],
    ['skein.setViewModeFile', 'handleSetViewModeFile'],
    ['skein.setViewModeList', 'handleSetViewModeList'],
    ['skein.setViewModeSymbol', 'handleSetViewModeSymbol'],
    ['skein.showReverseDependencies', 'handleShowReverseDependencies'],
    ['skein.hideReverseDependencies', 'handleHideReverseDependencies'],
    ['skein.enableUnusedFilter', 'handleEnableUnusedFilter'],
    ['skein.disableUnusedFilter', 'handleDisableUnusedFilter'],
    ['skein.showIndexStatus', 'handleShowIndexStatus'],
  ] as const)('%s runs CommandCoordinator.%s', async (commandId, handler) => {
    const commandCoordinator = createCommandCoordinatorMock();
    new CommandRegistrationService({ callGraphViewService: createCallGraphViewServiceMock(), provider: createProviderMock(), commandCoordinator, logger: createLoggerMock() }).registerAll();

    await registeredHandlers.get(commandId)?.();

    expect(commandCoordinator[handler]).toHaveBeenCalledOnce();
  });

  it('focuses the view when showGraph is executed', async () => {
    const provider = createProviderMock();
    const commandCoordinator = createCommandCoordinatorMock();
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ callGraphViewService: createCallGraphViewServiceMock(), provider, commandCoordinator, logger });

    service.registerAll();
    const handler = registeredHandlers.get('skein.showGraph');
    expect(handler).toBeDefined();

    await handler?.();
    expect(executeCommand).toHaveBeenCalledWith('skein.graphView.focus');
  });

  it('opens the graph in an editor tab on the file the title button came from', async () => {
    const provider = createProviderMock();
    new CommandRegistrationService({ callGraphViewService: createCallGraphViewServiceMock(), provider, commandCoordinator: createCommandCoordinatorMock(), logger: createLoggerMock() }).registerAll();
    const handler = registeredHandlers.get('skein.showGraph');
    const resource = { scheme: 'file', fsPath: '/workspace/src/api.ts' };

    await handler?.(resource);

    expect(provider.showEditorGraph).toHaveBeenCalledWith(resource);
    expect(executeCommand).not.toHaveBeenCalledWith('skein.graphView.focus');
  });

  it('executes provider commands and reports success', async () => {
    const provider = createProviderMock();
    const commandCoordinator = createCommandCoordinatorMock();
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ callGraphViewService: createCallGraphViewServiceMock(), provider, commandCoordinator, logger });

    service.registerAll();
    const forceReindexHandler = registeredHandlers.get('skein.forceReindex');
    expect(forceReindexHandler).toBeDefined();

    await forceReindexHandler?.();
    expect((commandCoordinator.handleForceReindex as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('logs and shows errors when commands fail', async () => {
    const provider = createProviderMock();
    const commandCoordinator = createCommandCoordinatorMock();
    (commandCoordinator.handleRefreshGraph as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ callGraphViewService: createCallGraphViewServiceMock(), provider, commandCoordinator, logger });

    service.registerAll();
    const refreshHandler = registeredHandlers.get('skein.refreshGraph');
    expect(refreshHandler).toBeDefined();

    await refreshHandler?.();
    expect(logger.error).toHaveBeenCalledWith(
      'skein.refreshGraph failed:',
      expect.any(Error)
    );
    expect(showErrorMessage).toHaveBeenCalledWith('Skein: Refresh failed');
  });

  it('shows indexer information when available', async () => {
    const provider = createProviderMock();
    const commandCoordinator = createCommandCoordinatorMock();
    const logger = createLoggerMock();
    const service = new CommandRegistrationService({ callGraphViewService: createCallGraphViewServiceMock(), provider, commandCoordinator, logger });

    service.registerAll();
    const handler = registeredHandlers.get('skein.showIndexStatus');
    expect(handler).toBeDefined();

    await handler?.();
    expect((commandCoordinator.handleShowIndexStatus as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

});
