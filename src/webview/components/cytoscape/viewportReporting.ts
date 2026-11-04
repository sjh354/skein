/**
 * Publishes viewport and node-placement changes back to the extension.
 *
 * Cytoscape reports a background drag as `pan` only; without it a panned
 * viewport never reaches `.skein/state.json` and a restart restores the wrong
 * position. Programmatic moves (a remote focus, a resize re-centre) still need
 * publishing, but must not be recorded as user actions, so the caller decides
 * whether the change came from the user.
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

export interface ViewportReportHooks {
    /** Called with whether a human caused the change. */
    onChange(userInitiated: boolean): void;
    /** True while the app is moving the viewport on the user's behalf. */
    isProgrammatic(): boolean;
}

export function registerViewportReporting(cy: cytoscape.Core, hooks: ViewportReportHooks): void {
    const reportChange = (): void => hooks.onChange(!hooks.isProgrammatic());
    // A zero-delta pan (a repaint) must not count as a move. Compare against the
    // previous pan event rather than the last published layout, which lags the
    // debounce and would make a repaint look like a user pan.
    let lastPan = { ...cy.pan() };
    cy.on("zoom", reportChange);
    cy.on("pan", () => {
        const pan = cy.pan();
        const unchanged = lastPan.x === pan.x && lastPan.y === pan.y;
        lastPan = { x: pan.x, y: pan.y };
        if (!unchanged) reportChange();
    });
    cy.on("dragfree", "node", reportChange);
}
