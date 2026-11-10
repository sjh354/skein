import * as vscode from 'vscode';
import type { GraphProvider } from '../GraphProvider';
import type { VsCodeLogger } from '../extensionLogger';
import type { CallGraphViewService } from './CallGraphViewService';
import type { CommandCoordinator } from './CommandCoordinator';

interface CommandRegistrationServiceOptions {
  provider: GraphProvider;
  /** Read directly for the E2E observability counts. */
  callGraphViewService: CallGraphViewService;
  commandCoordinator: CommandCoordinator;
  logger: VsCodeLogger;
}

/**
 * Centralizes VS Code command registration to keep extension.ts lean
 * and ensure consistent error handling/logging.
 */
export class CommandRegistrationService {
  private readonly provider: GraphProvider;
  private readonly callGraphViewService: CallGraphViewService;
  private readonly commandCoordinator: CommandCoordinator;
  private readonly logger: VsCodeLogger;

  constructor(options: CommandRegistrationServiceOptions) {
    this.provider = options.provider;
    this.callGraphViewService = options.callGraphViewService;
    this.commandCoordinator = options.commandCoordinator;
    this.logger = options.logger;
  }

  registerAll(): vscode.Disposable[] {
    return [
      this.registerShowGraphCommand(),
      this.registerForceReindexCommand(),
      this.registerExpandAllCommand(),
      this.registerRefreshGraphCommand(),
      this.registerSetViewModeFileCommand(),
      this.registerSetViewModeListCommand(),
      this.registerSetViewModeSymbolCommand(),
      this.registerSetViewModeArchitectureCommand(),
      this.registerShowReverseDependenciesCommand(),
      this.registerHideReverseDependenciesCommand(),
      this.registerToggleUnusedFilterCommands(),
      this.registerShowIndexStatusCommand(),
      this.registerGetContextCommand(), // For E2E testing
      this.registerArchitectureControlsCommand(), // For E2E testing
    ];
  }

  private registerShowGraphCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('skein.showGraph', async (resource?: vscode.Uri) => {
      try {
        if (resource) {
          this.provider.showEditorGraph(resource);
        } else {
          await vscode.commands.executeCommand('skein.graphView.focus');
        }
      } catch (error) {
        this.handleCommandError('skein.showGraph', error, 'Skein: Could not focus the graph');
      }
    });
  }

  private registerToggleUnusedFilterCommands(): vscode.Disposable {
    const d1 = this.registerProviderCommand(
      'skein.enableUnusedFilter',
      async () => {
        await this.commandCoordinator.handleEnableUnusedFilter();
      },
      'Skein: Enable filter failed'
    );
    const d2 = this.registerProviderCommand(
      'skein.disableUnusedFilter',
      async () => {
        await this.commandCoordinator.handleDisableUnusedFilter();
      },
      'Skein: Disable filter failed'
    );
    return vscode.Disposable.from(d1, d2);
  }

  private registerForceReindexCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'skein.forceReindex',
      async () => {
        await this.commandCoordinator.handleForceReindex();
      },
      'Skein: Re-index failed'
    );
  }

  private registerExpandAllCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'skein.expandAllNodes',
      async () => {
        await this.commandCoordinator.handleExpandAll();
      },
      'Skein: Toggle expand all failed'
    );
  }

  private registerRefreshGraphCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'skein.refreshGraph',
      async () => {
        await this.commandCoordinator.handleRefreshGraph();
      },
      'Skein: Refresh failed'
    );
  }
  private registerSetViewModeFileCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'skein.setViewModeFile',
      async () => {
        await this.commandCoordinator.handleSetViewModeFile();
      },
      'Skein: Switch to file view failed'
    );
  }

  private registerSetViewModeListCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'skein.setViewModeList',
      async () => {
        await this.commandCoordinator.handleSetViewModeList();
      },
      'Skein: Switch to list view failed'
    );
  }

  private registerSetViewModeSymbolCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'skein.setViewModeSymbol',
      async () => {
        await this.commandCoordinator.handleSetViewModeSymbol();
      },
      'Skein: Switch to symbol view failed'
    );
  }

  private registerSetViewModeArchitectureCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'skein.setViewModeArchitecture',
      async () => {
        await this.commandCoordinator.handleSetViewModeArchitecture();
      },
      'Skein: Switch to architecture view failed'
    );
  }

  private registerShowReverseDependenciesCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'skein.showReverseDependencies',
      async () => {
        await this.commandCoordinator.handleShowReverseDependencies();
      },
      'Skein: Show reverse dependencies failed'
    );
  }

  private registerHideReverseDependenciesCommand(): vscode.Disposable {
    return this.registerProviderCommand(
      'skein.hideReverseDependencies',
      async () => {
        await this.commandCoordinator.handleHideReverseDependencies();
      },
      'Skein: Hide reverse dependencies failed'
    );
  }

  private registerShowIndexStatusCommand(): vscode.Disposable {
    return vscode.commands.registerCommand('skein.showIndexStatus', async () => {
      try {
        await this.commandCoordinator.handleShowIndexStatus();
      } catch (error) {
        this.handleCommandError(
          'skein.showIndexStatus',
          error,
          'Skein: Could not get index status'
        );
      }
    });
  }

  /**
   * Registers a test helper command to get context key values
   * This is needed for E2E testing as VS Code doesn't expose context keys directly
   */
  private registerGetContextCommand(): vscode.Disposable {
    const architecture = () => this.provider.getArchitectureE2EState();
    // Context keys are stored in VS Code's internal state, so GraphProvider tracks the ones tests read.
    const getters = new Map<string, () => unknown>([
      ['skein.viewMode', () => this.provider.getViewMode()],
      ['skein.reverseDependenciesVisible', () => this.provider.getReverseDependenciesVisible()],
      ['skein.callGraphRenderCount', () => this.callGraphViewService.getCallGraphRenderCount()],
      ['skein.callGraphNodeCount', () => this.callGraphViewService.getCallGraphNodeCount()],
      ['skein.callGraphEdgeCount', () => this.callGraphViewService.getCallGraphEdgeCount()],
      ['skein.callGraphCycleCount', () => this.callGraphViewService.getCallGraphCycleCount()],
      ['skein.fileGraphNodeMetadata', () => this.provider.getFileGraphNodeMetadata()],
      ['skein.fileGraphRoot', () => this.provider.getFileGraphRoot()],
      ['skein.architectureRenderCount', () => architecture()?.renderCount ?? 0],
      ['skein.architectureGroupCount', () => architecture()?.groupCount ?? 0],
      ['skein.architectureGroupEdgeCount', () => architecture()?.groupEdgeCount ?? 0],
      ['skein.architectureRevision', () => architecture()?.revision],
      ['skein.architectureBuildCount', () => architecture()?.buildCount ?? 0],
      ['skein.architectureCommunityMode', () => architecture()?.communityMode],
      ['skein.architectureStale', () => architecture()?.stale ?? false],
      ['skein.architectureOverlappingGroups', () => architecture()?.overlappingGroups ?? 0],
      ['skein.architectureOverflowingLabels', () => architecture()?.overflowingLabels ?? 0],
      ['skein.architecturePositions', () => architecture()?.positions],
      ['skein.architectureUnit', () => architecture()?.unit],
      ['skein.architectureFolder', () => architecture()?.folder],
      ['skein.architectureUnitLevel', () => architecture()?.unitLevel],
      ['skein.architectureGroupLevel', () => architecture()?.groupLevel],
      ['skein.architectureViolationEdges', () => architecture()?.violationEdges ?? 0],
      ['skein.architectureRulesPanel', () => architecture()?.rules ?? []],
      ['skein.architectureRoles', () => architecture()?.roles ?? []],
      ['skein.architectureResizeCount', () => architecture()?.resizeCount ?? 0],
      ['skein.architectureViewSize', () => architecture()?.viewSize],
      ['skein.architectureInteractionCount', () => architecture()?.interactionCount ?? 0],
      ['skein.architectureInteraction', () => architecture()?.interaction],
      ['skein.architectureDetailCount', () => architecture()?.detailCount ?? 0],
      ['skein.architectureDetail', () => architecture()?.detail],
      ['skein.architectureMatrixCount', () => architecture()?.matrixCount ?? 0],
      ['skein.architectureMatrix', () => architecture()?.matrix],
      ['skein.architectureRendered', () => architecture()?.rendered],
      ['skein.architectureDependentsGroupCount', () => architecture()?.dependents?.highlightedGroups ?? 0],
      ['skein.architectureDependents', () => architecture()?.dependents],
    ]);
    // Unknown keys return undefined.
    return vscode.commands.registerCommand('getContext', (key: string) => getters.get(key)?.());
  }

  /** E2E test helper: drives the architecture view's controls and clicks, which tests cannot reach in the webview. */
  private registerArchitectureControlsCommand(): vscode.Disposable {
    return vscode.commands.registerCommand(
      'skein.e2eArchitectureControls',
      (controls: Parameters<GraphProvider['setArchitectureControls']>[0]) => this.provider.setArchitectureControls(controls)
    );
  }

  private registerProviderCommand(
    commandId: string,
    handler: () => Promise<void>,
    errorMessage: string
  ): vscode.Disposable {
    return vscode.commands.registerCommand(commandId, async () => {
      try {
        await handler();
      } catch (error) {
        this.handleCommandError(commandId, error, errorMessage);
      }
    });
  }

  private handleCommandError(commandId: string, error: unknown, userMessage: string): void {
    this.logger.error(`${commandId} failed:`, error);
    vscode.window.showErrorMessage(userMessage);
  }
}
