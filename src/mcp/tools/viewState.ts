/**
 * MCP tools for the shared graph view state (DESIGN 10).
 *
 * These run in the MCP server process: they read `.skein/state.json` written by
 * the VS Code extension and queue commands in `.skein/commands/`. No worker or
 * re-analysis is involved, so an agent sees exactly the tab the user sees and
 * its commands are rejected once the user has moved on.
 */

import { z } from "zod/v4";
import { isPathWithinRoot } from "../../shared/pathSecurity";
import {
    COMMAND_RESULT_POLL_MS,
    COMMAND_RESULT_TIMEOUT_MS,
    createCommandId,
    deleteCommandFiles,
    readCommandResult,
    readViewState,
    summarizeWindows,
    writeCommandRequest,
    type SkeinCommandRequest,
    type SkeinCommandResult,
    type SkeinFilterType,
    type SkeinViewAction,
    type SkeinViewState,
    type SkeinWindowSummary,
} from "../../shared/viewState";

export const GetViewStateSchema = z.object({});

export type GetViewStateParams = z.infer<typeof GetViewStateSchema>;

export interface GetViewStateResult {
    /** False when the extension has not written a state file for this workspace yet. */
    available: boolean;
    reason?: "state-file-missing" | "workspace-not-configured";
    /** The active window's snapshot (top-level fields are kept for compatibility). */
    state?: Omit<SkeinViewState, "windows">;
    /** Other VS Code windows that published state for the same folder. */
    windows?: SkeinWindowSummary[];
}

const ActionSchema = z.enum([
    "search",
    "set_expanded",
    "set_architecture",
    "select",
    "focus",
    "set_depth",
    "open_file",
    "set_filter",
    "set_expand_all",
]);

export const ControlViewSchema = z.object({
    action: ActionSchema.describe(
        "search: search the rendered view; set_expanded: expand/collapse one file graph node or architecture group; set_architecture: change architecture view/unit/folder/minImports (one navigation level per call); select: highlight a node; focus: re-centre the graph on it; set_depth: re-query at 1-5; open_file: open a file at a line; set_filter: hide/show a node type or folder; set_expand_all: expand or collapse the dependency graph.",
    ),
    query: z.string().max(256).optional().describe("Search the current rendered view; empty clears the search. Results are in state.surface.search."),
    expanded: z.boolean().optional().describe("Target expansion for set_expanded."),
    view: z.enum(["graph", "matrix"]).optional(),
    unit: z.string().max(256).optional(),
    folder: z.string().max(256).optional(),
    minImports: z.number().int().min(1).optional(),
    nodeId: z.string().min(1).optional().describe("Call graph node id, as returned by get_view_state or query_call_graph."),
    depth: z.number().int().min(1).max(5).optional().describe("Traversal depth for set_depth."),
    path: z.string().min(1).optional().describe("Absolute file path for open_file."),
    line: z.number().int().min(0).optional().describe("0-based line for open_file."),
    character: z.number().int().min(0).optional().describe("0-based column for open_file."),
    filterType: z.enum(["nodeType", "folder", "edgeType"]).optional().describe("What set_filter toggles."),
    value: z.string().optional().describe("Node type or folder id for set_filter."),
    visible: z.boolean().optional().describe("Target visibility for set_filter."),
    expandAll: z.boolean().optional().describe("Target state for set_expand_all."),
    graphVersion: z
        .number()
        .int()
        .optional()
        .describe("Pin the command to the graphVersion you read; the command is rejected if the graph has changed."),
    windowId: z
        .string()
        .min(1)
        .optional()
        .describe("Target VS Code window from get_view_state; defaults to the most recent writer."),
    timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(10_000)
        .optional()
        .describe(`How long to wait for the extension (default ${COMMAND_RESULT_TIMEOUT_MS} ms).`),
});

export type ControlViewParams = z.infer<typeof ControlViewSchema>;

export interface ControlViewResult {
    /** True only when the extension applied the command. */
    applied: boolean;
    status: SkeinCommandResult["status"];
    reason?: string;
    /** Window the command was sent to (absent when no state file existed). */
    windowId?: string;
    state?: SkeinViewState;
}

function buildAction(params: ControlViewParams): SkeinViewAction | string {
    switch (params.action) {
        case "search":
            return params.query === undefined ? "search requires query" : { action: "search", query: params.query };
        case "set_expanded":
            return !params.nodeId || params.expanded === undefined ? "set_expanded requires nodeId and expanded" : { action: "set_expanded", nodeId: params.nodeId, expanded: params.expanded };
        case "set_architecture":
            return { action: "set_architecture", view: params.view, unit: params.unit, folder: params.folder, minImports: params.minImports };
        case "select":
        case "focus":
            return params.nodeId ? { action: params.action, nodeId: params.nodeId } : `${params.action} requires nodeId`;
        case "set_depth":
            return params.depth === undefined ? "set_depth requires depth" : { action: "set_depth", depth: params.depth };
        case "open_file": {
            if (!params.path) return "open_file requires path";
            const action: SkeinViewAction = { action: "open_file", path: params.path };
            if (params.line !== undefined) action.line = params.line;
            if (params.character !== undefined) action.character = params.character;
            return action;
        }
        case "set_filter": {
            if (!params.filterType) return "set_filter requires filterType";
            if (params.value === undefined) return "set_filter requires value";
            if (params.visible === undefined) return "set_filter requires visible";
            return {
                action: "set_filter",
                filterType: params.filterType as SkeinFilterType,
                value: params.value,
                visible: params.visible,
            };
        }
        case "set_expand_all":
            return params.expandAll === undefined
                ? "set_expand_all requires expandAll"
                : { action: "set_expand_all", expandAll: params.expandAll };
        default:
            return `unsupported action: ${params.action as string}`;
    }
}

/** Reads the view the extension last published. */
export async function executeGetViewState(rootDir: string | undefined): Promise<GetViewStateResult> {
    if (!rootDir) return { available: false, reason: "workspace-not-configured" };
    const state = await readViewState(rootDir);
    if (!state) return { available: false, reason: "state-file-missing" };
    const { windows, ...active } = state;
    void windows;
    return { available: true, state: active, windows: summarizeWindows(state) };
}

/** Queues a command and waits for the extension to apply it. */
export async function executeControlView(
    rootDir: string | undefined,
    params: ControlViewParams,
): Promise<ControlViewResult> {
    if (!rootDir) {
        return { applied: false, status: "error", reason: "workspace-not-configured" };
    }
    const action = buildAction(params);
    if (typeof action === "string") {
        return { applied: false, status: "error", reason: action };
    }
    if (action.action === "open_file" && !isPathWithinRoot(action.path, rootDir)) {
        return { applied: false, status: "error", reason: "path-outside-workspace" };
    }

    const state = await readViewState(rootDir);
    if (params.windowId && state && !state.windows[params.windowId]) {
        return { applied: false, status: "error", reason: "window-not-found", windowId: params.windowId };
    }
    const targetWindowId = params.windowId ?? state?.activeWindowId;

    const request: SkeinCommandRequest = {
        id: createCommandId(),
        createdAt: Date.now(),
        command: action,
    };
    if (params.graphVersion !== undefined) request.graphVersion = params.graphVersion;
    if (targetWindowId !== undefined) request.targetWindowId = targetWindowId;

    await writeCommandRequest(rootDir, request);

    const timeoutMs = params.timeoutMs ?? COMMAND_RESULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    try {
        /* eslint-disable no-await-in-loop -- the result is polled until it appears */
        for (;;) {
            const result = await readCommandResult(rootDir, request.id);
            if (result) {
                return {
                    applied: result.status === "applied",
                    status: result.status,
                    reason: result.reason,
                    windowId: targetWindowId,
                    state: result.state,
                };
            }
            if (Date.now() >= deadline) {
                return {
                    applied: false,
                    status: "error",
                    reason: "extension-not-responding",
                    windowId: targetWindowId,
                };
            }
            await new Promise((resolve) => setTimeout(resolve, COMMAND_RESULT_POLL_MS));
        }
        /* eslint-enable no-await-in-loop */
    } finally {
        await deleteCommandFiles(rootDir, request.id);
    }
}
