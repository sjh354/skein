/**
 * Publishes the graph view state to `.skein/state.json` and applies view
 * commands queued there by the MCP server (DESIGN 10).
 *
 * The extension is the only writer of the state file, so two processes never
 * edit it at once. Human interactions stamp `lastUserActionAt`; a queued
 * command older than that is rejected instead of moving the screen under the
 * user (DESIGN 10.2).
 */

import * as vscode from "vscode";
import type { CallGraphWebviewCommand } from "../../shared/callgraph-types";
import {
    EMPTY_VIEW_SNAPSHOT,
    SKEIN_STATE_SCHEMA_VERSION,
    deleteCommandRequest,
    ensureSkeinWorkspace,
    isCommandStale,
    isCommandSupersededByUser,
    listCommandRequests,
    pruneCommandFiles,
    readViewState,
    writeCommandResult,
    writeViewState,
    type SkeinCommandRequest,
    type SkeinCommandResult,
    type SkeinFilterType,
    type SkeinViewSnapshot,
    type SkeinViewState,
} from "../../shared/viewState";

/** Commands and files the MCP server left behind by a crashed run are dropped after a day. */
const STALE_COMMAND_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ViewStateHost {
    /** Current view mode, file, selection and filters. */
    read(): { snapshot: SkeinViewSnapshot; graphVersion: number };
    select(nodeId: string): Promise<boolean>;
    focus(nodeId: string): Promise<boolean>;
    setDepth(depth: number): Promise<boolean>;
    openFile(path: string, line?: number, character?: number): Promise<boolean>;
    setFilter(filterType: SkeinFilterType, value: string, visible: boolean): Promise<boolean>;
    setExpandAll(expandAll: boolean): Promise<boolean>;
}

export interface ViewStateServiceOptions {
    root: string;
    logger: { debug(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void };
    host: ViewStateHost;
    /** Called once with the previous session's view, before the first publish. */
    onRestore?: (snapshot: SkeinViewSnapshot) => void;
    pollIntervalMs?: number;
}

export class ViewStateService implements vscode.Disposable {
    private state: SkeinViewState;
    private lastPublished = "";
    private timer: ReturnType<typeof setInterval> | null = null;
    private writing = false;
    private disposed = false;

    constructor(private readonly options: ViewStateServiceOptions) {
        this.state = {
            ...EMPTY_VIEW_SNAPSHOT,
            schemaVersion: SKEIN_STATE_SCHEMA_VERSION,
            workspaceRoot: options.root,
            updatedAt: 0,
            lastUserActionAt: 0,
            graphVersion: 0,
        };
    }

    async start(): Promise<void> {
        await ensureSkeinWorkspace(this.options.root);
        const restored = await readViewState(this.options.root);
        if (restored && restored.workspaceRoot === this.options.root) {
            this.state = {
                ...restored,
                graphVersion: 0,
                updatedAt: 0,
            };
            this.options.onRestore?.(restored);
        }
        await pruneCommandFiles(this.options.root, STALE_COMMAND_MAX_AGE_MS);
        this.publishOnce().catch((err: unknown) => this.logError("initial publish", err));
        this.timer = setInterval(
            () => void this.tick(),
            this.options.pollIntervalMs ?? 500,
        );
        this.timer.unref?.();
    }

    /** A human moved the view; queued agent commands that predate this are dropped. */
    markUserAction(): void {
        this.state.lastUserActionAt = Date.now();
        this.publishOnce().catch((err: unknown) => this.logError("user action publish", err));
    }

    /** Reflects graph interactions in the shared state. */
    observeWebviewCommand(command: CallGraphWebviewCommand): void {
        switch (command.command) {
            case "callGraphSelectionChanged":
                this.state.selection = command.nodeId
                    ? {
                          nodeId: command.nodeId,
                          path: command.path,
                          name: command.name,
                          startLine: command.startLine,
                      }
                    : undefined;
                if (command.userInitiated) this.markUserAction();
                break;
            case "callGraphFilterChanged":
                this.setHiddenFilter(command.filterType, command.value, !command.visible);
                this.markUserAction();
                break;
            case "callGraphDepthChanged":
                this.state.callGraph = { ...this.state.callGraph, depth: command.depth };
                this.markUserAction();
                break;
            case "callGraphOpenFile":
            case "callGraphSymbolFocus":
                this.markUserAction();
                break;
            default:
                break;
        }
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
    }

    private async tick(): Promise<void> {
        if (this.disposed || this.writing) return;
        this.writing = true;
        try {
            this.refreshFromHost();
            await this.processCommands();
            await this.publishOnce();
        } catch (err: unknown) {
            this.logError("poll", err);
        } finally {
            this.writing = false;
        }
    }

    private async processCommands(): Promise<void> {
        const requests = await listCommandRequests(this.options.root);
        if (requests.length === 0) return;
        /* eslint-disable no-await-in-loop -- commands are applied in order */
        for (const request of requests) {
            if (this.disposed) return;
            const result = await this.applyCommand(request);
            await writeCommandResult(this.options.root, result);
            await deleteCommandRequest(this.options.root, request.id);
            if (result.status === "applied") {
                this.state.updatedAt = Date.now();
                await this.persistState();
            }
        }
        /* eslint-enable no-await-in-loop */
    }

    private async applyCommand(request: SkeinCommandRequest): Promise<SkeinCommandResult> {
        const base = { id: request.id, completedAt: Date.now() };
        if (isCommandSupersededByUser(request, this.state)) {
            return { ...base, status: "rejected", reason: "user-action-superseded" };
        }
        if (isCommandStale(request, this.state)) {
            return { ...base, status: "rejected", reason: "stale-graph-version" };
        }

        try {
            const applied = await this.runCommand(request);
            if (!applied) {
                return { ...base, status: "rejected", reason: "view-not-available", completedAt: Date.now() };
            }
            this.refreshFromHost();
            // The webview reports the selection asynchronously; keep the applied
            // node in the result so the caller sees what it selected.
            if (request.command.action === "select") {
                this.state.selection = { nodeId: request.command.nodeId };
            }
            return { ...base, status: "applied", completedAt: Date.now(), state: { ...this.state } };
        } catch (err: unknown) {
            return {
                ...base,
                status: "error",
                reason: err instanceof Error ? err.message : String(err),
                completedAt: Date.now(),
            };
        }
    }

    private async runCommand(request: SkeinCommandRequest): Promise<boolean> {
        const action = request.command;
        switch (action.action) {
            case "select":
                if (this.state.mode !== "callgraph") return false;
                return this.options.host.select(action.nodeId);
            case "focus":
                if (this.state.mode !== "callgraph") return false;
                return this.options.host.focus(action.nodeId);
            case "set_depth":
                if (this.state.mode !== "callgraph") return false;
                return this.options.host.setDepth(action.depth);
            case "open_file":
                return this.options.host.openFile(action.path, action.line, action.character);
            case "set_filter":
                this.setHiddenFilter(action.filterType, action.value, !action.visible);
                return this.options.host.setFilter(action.filterType, action.value, action.visible);
            case "set_expand_all":
                this.state.expandAll = action.expandAll;
                return this.options.host.setExpandAll(action.expandAll);
            default:
                return false;
        }
    }

    private setHiddenFilter(filterType: SkeinFilterType, value: string, hidden: boolean): void {
        const filters = this.state.hiddenFilters.filter(
            (filter) => !(filter.filterType === filterType && filter.value === value),
        );
        if (hidden) filters.push({ filterType, value });
        this.state.hiddenFilters = filters;
    }

    private refreshFromHost(): void {
        const { snapshot, graphVersion } = this.options.host.read();
        this.state.mode = snapshot.mode;
        this.state.expandAll = snapshot.expandAll;
        this.state.hiddenFilters = snapshot.hiddenFilters;
        this.state.graphVersion = graphVersion;
        if (snapshot.filePath !== undefined) this.state.filePath = snapshot.filePath;
        else delete this.state.filePath;
        if (snapshot.selection !== undefined) this.state.selection = snapshot.selection;
        else delete this.state.selection;
        if (snapshot.callGraph !== undefined) this.state.callGraph = snapshot.callGraph;
        else delete this.state.callGraph;
    }

    private async publishOnce(): Promise<void> {
        if (this.disposed) return;
        this.refreshFromHost();
        const content = JSON.stringify(this.state);
        if (content === this.lastPublished) return;
        await this.persistState();
    }

    private async persistState(): Promise<void> {
        if (this.disposed) return;
        this.state.updatedAt = Date.now();
        const content = JSON.stringify(this.state);
        await writeViewState(this.options.root, this.state);
        this.lastPublished = content;
    }

    private logError(what: string, err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger.warn(`[ViewState] ${what} failed: ${message}`);
    }
}
