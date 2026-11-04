/**
 * Publishes viewport, node-placement and interaction changes back to the
 * extension.
 *
 * Cytoscape reports a background drag as `pan` only; without it a panned
 * viewport never reaches `.skein/state.json` and a restart restores the wrong
 * position. Programmatic moves (a remote focus, a resize re-centre) still need
 * publishing, but must not be recorded as user actions, so the caller decides
 * whether the change came from the user.
 *
 * Interaction state is published separately and earlier than the layout: the
 * extension rejects commands while the user is panning, zooming or dragging,
 * and a command created mid-drag must not be applied when the drag ends.
 */

import type cytoscape from "cytoscape";

/**
 * Centring on one symbol should not slam the canvas to the maximum zoom
 * (`fit` on a single node always does), so the fitted level is capped here.
 */
export const MAX_FOCUS_ZOOM = 2;

/** Zoom level a focus may apply; never more than {@link MAX_FOCUS_ZOOM}. */
export function focusZoomFor(fittedZoom: number): number {
    return Math.min(fittedZoom, MAX_FOCUS_ZOOM);
}

/** The interaction is considered over after this long without an event. */
export const INTERACTION_IDLE_MS = 250;
/** Heartbeat interval while an interaction keeps producing events. */
const INTERACTION_HEARTBEAT_MS = 200;

export interface ViewportReportHooks {
    /** Called with whether a human caused the layout change. */
    onChange(userInitiated: boolean): void;
    /** True while the app is moving the viewport on the user's behalf. */
    isProgrammatic(): boolean;
    /** Called when an interaction starts, repeats (throttled) and ends. */
    onInteraction?(active: boolean): void;
}

/** Returns a cleanup function that stops the pending idle timer. */
export function registerViewportReporting(cy: cytoscape.Core, hooks: ViewportReportHooks): () => void {
    const reportChange = (): void => hooks.onChange(!hooks.isProgrammatic());
    // A zero-delta pan (a repaint) must not count as a move. Compare against the
    // previous pan event rather than the last published layout, which lags the
    // debounce and would make a repaint look like a user pan.
    let lastPan = { ...cy.pan() };
    let interacting = false;
    let lastHeartbeatAt = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const noteInteraction = (): void => {
        if (hooks.isProgrammatic()) return;
        const now = Date.now();
        if (!interacting || now - lastHeartbeatAt >= INTERACTION_HEARTBEAT_MS) {
            interacting = true;
            lastHeartbeatAt = now;
            hooks.onInteraction?.(true);
        }
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimer = null;
            interacting = false;
            hooks.onInteraction?.(false);
        }, INTERACTION_IDLE_MS);
    };

    cy.on("zoom", () => {
        noteInteraction();
        reportChange();
    });
    cy.on("pan", () => {
        const pan = cy.pan();
        const unchanged = lastPan.x === pan.x && lastPan.y === pan.y;
        lastPan = { x: pan.x, y: pan.y };
        if (unchanged) return;
        noteInteraction();
        reportChange();
    });
    cy.on("grab", "node", noteInteraction);
    cy.on("drag", "node", noteInteraction);
    cy.on("dragfree", "node", reportChange);

    return () => {
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = null;
    };
}
