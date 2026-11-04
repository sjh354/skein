/**
 * Publishes the graph view state to `.skein/state.json` and executes view
 * commands handed over by `CommandBridgeService` (DESIGN 10).
 *
 * The extension is the only writer of the state file, so two processes never
 * edit it at once. Human interactions stamp `lastUserActionAt`; a queued
 * command older than that is rejected instead of moving the screen under the
 * user (DESIGN 10.2). Writes are merged per extension window under a lock, so
 * two windows on the same folder no longer erase each other.
 */

import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { CallGraphWebviewCommand } from "../../shared/callgraph-types";
import {
    EMPTY_VIEW_SNAPSHOT,
    SKEIN_STATE_SCHEMA_VERSION,
    ensureSkeinWorkspace,
    isCommandStale,
    isCommandSupersededByUser,
    mergeViewState,
    normalizeAreaKey,
    pruneWindowSnapshotsInFile,
    readViewState,
    type SkeinCommandRequest,
    type SkeinCommandResult,
    type SkeinFilterType,
    type SkeinViewSnapshot,
    type SkeinViewState,
    type SkeinWindowView,
} from "../../shared/viewState";

/**
 * A webview that stops reporting the end of an interaction (crash, reload)
 * must not keep rejecting commands forever.
 */
const INTERACTION_SAFETY_MS = 3_000;

export interface ViewStateHost {
    /** Current view mode, file, selection and filters. */
    read(): { snapshot: SkeinViewSnapshot; graphVersion: number };
    controlSurface?(action: SkeinCommandRequest["command"]): Promise<true | string>;
    select(nodeId: string): Promise<boolean>;
    setDepth(depth: number): Promise<boolean>;
    openFile(path: string, line?: number, character?: number): Promise<boolean>;
    setFilter(filterType: SkeinFilterType, value: string, visible: boolean): Promise<boolean>;
    setExpandAll(expandAll: boolean): Promise<boolean>;
    /** False when the node is not in the graph currently rendered. */
    hasNode?(nodeId: string): boolean;
}

export interface ViewStateServiceOptions {
    root: string;
    logger: { debug(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void };
    host: ViewStateHost;
    /** Called once with the previous session's view, before the first publish. */
    onRestore?: (snapshot: SkeinViewSnapshot, graphVersion: number) => void;
    pollIntervalMs?: number;
}

export class ViewStateService implements vscode.Disposable {
    private window: SkeinWindowView;
    private workspaceRoot: string;
    private readonly windowId = randomUUID();
    private lastPublished = "";
    private timer: ReturnType<typeof setInterval> | null = null;
    private writing = false;
    private disposed = false;
    /** True while the renderer reports an ongoing pan, zoom or node drag. */
    private userInteracting = false;
    private interactionTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly options: ViewStateServiceOptions) {
        this.workspaceRoot = options.root;
        this.window = {
            ...EMPTY_VIEW_SNAPSHOT,
            windowId: this.windowId,
            updatedAt: 0,
            lastUserActionAt: 0,
            graphVersion: 0,
        };
    }

    async start(): Promise<void> {
        await ensureSkeinWorkspace(this.workspaceRoot);
        await pruneWindowSnapshotsInFile(this.workspaceRoot);
        const restored = await readViewState(this.workspaceRoot);
        const previous = restored ? this.previousWindow(restored) : undefined;
        if (restored && previous && restored.workspaceRoot === normalizeAreaKey(this.workspaceRoot)) {
            this.window = {
                ...this.toSnapshot(previous),
                windowId: this.windowId,
                updatedAt: 0,
                lastUserActionAt: previous.lastUserActionAt,
                graphVersion: previous.graphVersion,
            };
            this.options.onRestore?.(this.toSnapshot(previous), previous.graphVersion);
        }
        this.publishOnce().catch((err: unknown) => this.logError("initial publish", err));
        this.timer = setInterval(
            () => void this.tick(),
            this.options.pollIntervalMs ?? 500,
        );
        this.timer.unref?.();
    }

    /** Switches the area whose state file this service owns (multi-root). */
    async setRoot(root: string): Promise<void> {
        if (normalizeAreaKey(root) === normalizeAreaKey(this.workspaceRoot)) return;
        await this.persistState();
        this.workspaceRoot = root;
        await ensureSkeinWorkspace(root);
        const restored = await readViewState(root);
        const previous = restored ? this.previousWindow(restored) : undefined;
        this.window = previous
            ? {
                  ...this.toSnapshot(previous),
                  windowId: this.windowId,
                  updatedAt: 0,
                  lastUserActionAt: previous.lastUserActionAt,
                  graphVersion: previous.graphVersion,
              }
            : {
                  ...EMPTY_VIEW_SNAPSHOT,
                  windowId: this.windowId,
                  updatedAt: 0,
                  lastUserActionAt: 0,
                  graphVersion: 0,
              };
        this.lastPublished = "";
        if (previous) this.options.onRestore?.(this.toSnapshot(previous), previous.graphVersion);
        await this.persistState();
    }

    /** A human moved the view; queued agent commands that predate this are dropped. */
    markUserAction(): void {
        this.window.lastUserActionAt = Date.now();
        this.publishOnce().catch((err: unknown) => this.logError("user action publish", err));
    }

    /** Reflects graph interactions in the shared state. */
    observeWebviewCommand(command: CallGraphWebviewCommand): void {
        switch (command.command) {
            case "callGraphSelectionChanged":
                this.window.selection = command.nodeId
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
                this.window.callGraph = { ...this.window.callGraph, depth: command.depth };
                this.markUserAction();
                break;
            case "callGraphLayoutChanged":
                this.window.layout = command.layout;
                if (command.userInitiated) this.markUserAction();
                else this.publishOnce().catch((err: unknown) => this.logError("layout publish", err));
                break;
            case "callGraphUserInteraction":
                this.setUserInteracting(command.active);
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
        if (this.interactionTimer !== null) clearTimeout(this.interactionTimer);
        this.interactionTimer = null;
    }

    /**
     * Tracks an ongoing pan, zoom or node drag. While it lasts, a queued command
     * would move the screen under the user, so it is rejected (DESIGN 10.2).
     * The heartbeat refreshes `lastUserActionAt`, and the safety timer drops a
     * stale `active` if the webview never reports the end.
     */
    private setUserInteracting(active: boolean): void {
        if (this.interactionTimer !== null) {
            clearTimeout(this.interactionTimer);
            this.interactionTimer = null;
        }
        this.userInteracting = active;
        if (!active) return;
        this.window.lastUserActionAt = Date.now();
        this.interactionTimer = setTimeout(() => {
            this.interactionTimer = null;
            this.userInteracting = false;
        }, INTERACTION_SAFETY_MS);
        this.interactionTimer.unref?.();
    }

    private async tick(): Promise<void> {
        if (this.disposed || this.writing) return;
        this.writing = true;
        try {
            this.refreshFromHost();
            await this.publishOnce();
        } catch (err: unknown) {
            this.logError("poll", err);
        } finally {
            this.writing = false;
        }
    }

    /** Window id used by the command bridge to route MCP commands. */
    getWindowId(): string {
        return this.windowId;
    }

    /** Last published snapshot, including the selection restored from disk. */
    getSnapshot(): SkeinViewSnapshot {
        return this.toSnapshot(this.window);
    }

    /** Executes one view command and persists the resulting state. */
    async handleCommand(request: SkeinCommandRequest): Promise<SkeinCommandResult> {
        this.refreshFromHost();
        const base = { id: request.id, completedAt: Date.now() };
        if (this.userInteracting || isCommandSupersededByUser(request, this.window)) {
            return { ...base, status: "rejected", reason: "user-action-superseded" };
        }
        if (isCommandStale(request, this.window)) {
            return { ...base, status: "rejected", reason: "stale-graph-version" };
        }

        try {
            const outcome = await this.runCommand(request);
            if (outcome !== true) {
                return { ...base, status: "rejected", reason: outcome, completedAt: Date.now() };
            }
            if (this.userInteracting || isCommandSupersededByUser(request, this.window)) {
                return { ...base, status: "rejected", reason: "user-action-superseded", completedAt: Date.now() };
            }
            this.refreshFromHost();
            // The webview reports the selection asynchronously; keep the applied
            // node in the result so the caller sees what it selected. A report
            // that already arrived carries path/name, so only fill the gap.
            if ((request.command.action === "select" || request.command.action === "focus")
                && this.window.mode === "callgraph"
                && this.window.selection === undefined) {
                this.window.selection = { nodeId: request.command.nodeId };
            }
            await this.persistState();
            return {
                ...base,
                status: "applied",
                completedAt: Date.now(),
                state: this.currentStateView(),
            };
        } catch (err: unknown) {
            return {
                ...base,
                status: "error",
                reason: err instanceof Error ? err.message : String(err),
                completedAt: Date.now(),
            };
        }
    }

    private async runCommand(request: SkeinCommandRequest): Promise<true | string> {
        const action = request.command;
        if (["search", "set_expanded", "set_architecture"].includes(action.action)
            || ((action.action === "select" || action.action === "focus") && this.window.mode !== "callgraph")) {
            return this.options.host.controlSurface?.(action) ?? "view-not-available";
        }
        switch (action.action) {
            case "select":
                if (this.window.mode !== "callgraph") return "view-not-available";
                // A node id from an older graph (or a typo) must not be reported as
                // applied: the webview would silently ignore it.
                if (this.options.host.hasNode && !this.options.host.hasNode(action.nodeId)) {
                    return "node-not-found";
                }
                return (await this.options.host.select(action.nodeId)) ? true : "view-not-available";
            case "focus":
                if (this.window.mode !== "callgraph") return "view-not-available";
                // `focus` re-centres the rendered graph; it must not re-query the
                // neighbourhood (that would replace the graph under the user).
                // The renderer applies the move and acknowledges it, so an
                // unknown id is reported instead of silently ignored.
                if (this.options.host.hasNode && !this.options.host.hasNode(action.nodeId)) {
                    return "node-not-found";
                }
                return this.options.host.controlSurface
                    ? this.options.host.controlSurface(action)
                    : "view-not-available";
            case "set_depth":
                if (this.window.mode !== "callgraph") return "view-not-available";
                return (await this.options.host.setDepth(action.depth)) ? true : "view-not-available";
            case "open_file":
                return (await this.options.host.openFile(action.path, action.line, action.character))
                    ? true
                    : "view-not-available";
            case "set_filter":
                this.setHiddenFilter(action.filterType, action.value, !action.visible);
                return (await this.options.host.setFilter(action.filterType, action.value, action.visible))
                    ? true
                    : "view-not-available";
            case "set_expand_all":
                this.window.expandAll = action.expandAll;
                return (await this.options.host.setExpandAll(action.expandAll))
                    ? true
                    : "view-not-available";
            default:
                return "view-not-available";
        }
    }

    private setHiddenFilter(filterType: SkeinFilterType, value: string, hidden: boolean): void {
        const filters = this.window.hiddenFilters.filter(
            (filter) => !(filter.filterType === filterType && filter.value === value),
        );
        if (hidden) filters.push({ filterType, value });
        this.window.hiddenFilters = filters;
    }

    private refreshFromHost(): void {
        const { snapshot, graphVersion } = this.options.host.read();
        this.window.mode = snapshot.mode;
        this.window.expandAll = snapshot.expandAll;
        this.window.graphVersion = graphVersion;
        if (snapshot.filePath !== undefined) this.window.filePath = snapshot.filePath;
        else delete this.window.filePath;
        if (snapshot.layout !== undefined) this.window.layout = snapshot.layout;
        this.window.views = snapshot.views;
        this.window.surface = snapshot.surface;
        // The dependency graph shares this file but has no call-graph state to
        // report. Keep the last call-graph snapshot instead of erasing it, so a
        // restart can restore depth, filters and selection and an agent can see
        // them before the call-graph tab is reopened.
        if (snapshot.mode === "callgraph") {
            this.window.hiddenFilters = snapshot.hiddenFilters;
            if (snapshot.selection !== undefined) this.window.selection = snapshot.selection;
            else delete this.window.selection;
            if (snapshot.callGraph !== undefined) this.window.callGraph = snapshot.callGraph;
            else delete this.window.callGraph;
        }
    }

    private async publishOnce(): Promise<void> {
        if (this.disposed) return;
        this.refreshFromHost();
        const signature = JSON.stringify({
            snapshot: this.toSnapshot(this.window),
            graphVersion: this.window.graphVersion,
            lastUserActionAt: this.window.lastUserActionAt,
        });
        if (signature === this.lastPublished) return;
        await this.persistState();
        this.lastPublished = signature;
    }

    private async persistState(): Promise<void> {
        if (this.disposed) return;
        const merged = await mergeViewState(this.workspaceRoot, {
            workspaceRoot: this.workspaceRoot,
            windowId: this.windowId,
            snapshot: this.toSnapshot(this.window),
            graphVersion: this.window.graphVersion,
            lastUserActionAt: this.window.lastUserActionAt,
        });
        this.window.updatedAt = merged.updatedAt;
    }

    /** The previous session's window snapshot, preferring the last writer. */
    private previousWindow(state: SkeinViewState): SkeinWindowView | undefined {
        return state.windows[state.activeWindowId] ?? Object.values(state.windows)[0];
    }

    private toSnapshot(window: SkeinWindowView): SkeinViewSnapshot {
        const snapshot: SkeinViewSnapshot = {
            mode: window.mode,
            hiddenFilters: window.hiddenFilters.map((filter) => ({ ...filter })),
            expandAll: window.expandAll,
        };
        if (window.filePath !== undefined) snapshot.filePath = window.filePath;
        if (window.selection !== undefined) snapshot.selection = { ...window.selection };
        if (window.callGraph !== undefined) snapshot.callGraph = { ...window.callGraph };
        if (window.layout !== undefined) snapshot.layout = window.layout;
        if (window.views !== undefined) snapshot.views = window.views;
        if (window.surface !== undefined) snapshot.surface = window.surface;
        return snapshot;
    }

    private currentStateView(): SkeinViewState {
        const window = { ...this.window };
        return {
            ...window,
            schemaVersion: SKEIN_STATE_SCHEMA_VERSION,
            workspaceRoot: normalizeAreaKey(this.workspaceRoot),
            activeWindowId: this.windowId,
            windows: { [this.windowId]: window },
        };
    }

    private logError(what: string, err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger.warn(`[ViewState] ${what} failed: ${message}`);
    }
}
