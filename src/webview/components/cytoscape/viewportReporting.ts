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

export interface ViewportReportHooks {
    /** Called with whether a human caused the change. */
    onChange(userInitiated: boolean): void;
    /** True while the app is moving the viewport on the user's behalf. */
    isProgrammatic(): boolean;
    /** True when a `pan` event carried no movement (a repaint, not a drag). */
    isPanUnchanged(): boolean;
}

export function registerViewportReporting(cy: cytoscape.Core, hooks: ViewportReportHooks): void {
    const reportChange = (): void => hooks.onChange(!hooks.isProgrammatic());
    cy.on("zoom", reportChange);
    cy.on("pan", () => {
        if (hooks.isPanUnchanged()) return;
        reportChange();
    });
    cy.on("dragfree", "node", reportChange);
}
