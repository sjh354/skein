/**
 * Rendered-surface state of the dependency graph views (file, list, symbol,
 * architecture) for the shared view state (DESIGN 10): what each surface last
 * reported, which node is selected there, and the surface commands waiting for
 * the renderer's acknowledgement. GraphProvider forwards the webview messages;
 * ViewStateService reads the result through `getViewStateSnapshot`.
 */

import { randomUUID } from "node:crypto";
import type {
  SkeinSelection,
  SkeinSurfaceState,
  SkeinViewAction,
  SkeinViewMode,
  SkeinViewSelections,
  SkeinViewSnapshot,
} from "@/shared/viewState";

/** The renderer answers a surface command within this time or it is reported as not responding. */
const SURFACE_COMMAND_TIMEOUT_MS = 2_000;

export interface SurfaceStateReport {
  mode: SkeinViewMode;
  state: SkeinSurfaceState;
  selection?: SkeinSelection;
  userInitiated?: boolean;
}

export class SurfaceStateService {
  private states: Partial<Record<SkeinViewMode, SkeinSurfaceState>> = {};
  private selections: SkeinViewSelections = {};
  private readonly pending = new Map<string, (result: true | string) => void>();
  private userActionObserver?: () => void;

  setUserActionObserver(observer: () => void): void {
    this.userActionObserver = observer;
  }

  state(mode: SkeinViewMode): SkeinSurfaceState | undefined {
    return this.states[mode];
  }

  selection(mode: keyof SkeinViewSelections): SkeinSelection | undefined {
    return this.selections[mode];
  }

  /** Per-view selections for the published snapshot. */
  views(): SkeinViewSelections {
    return { ...this.selections };
  }

  /** The previous session's selections and surface, from state.json. */
  restore(snapshot: SkeinViewSnapshot): void {
    this.selections = { ...snapshot.views };
    if (snapshot.surface) this.states[snapshot.mode] = snapshot.surface;
  }

  /** A surface reported its rendered state after a render or a user action. */
  record(report: SurfaceStateReport): void {
    this.states[report.mode] = report.state;
    if (report.mode !== "callgraph") {
      if (report.selection) this.selections[report.mode] = report.selection;
      else delete this.selections[report.mode];
    }
    if (report.userInitiated) this.userActionObserver?.();
  }

  /**
   * Sends a command to the renderer and waits for its acknowledgement, so a
   * dropped message or an unknown node is reported instead of counted as done.
   */
  async control(
    post: (message: unknown) => Thenable<boolean>,
    mode: SkeinViewMode,
    action: SkeinViewAction,
  ): Promise<true | string> {
    const id = randomUUID();
    return new Promise<true | string>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve("view-not-responding");
      }, SURFACE_COMMAND_TIMEOUT_MS);
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(result);
      });
      void post({ command: "surfaceCommand", mode, id, action }).then(
        (delivered) => {
          if (!delivered) this.pending.get(id)?.("view-not-available");
        },
        () => this.pending.get(id)?.("view-not-available"),
      );
    });
  }

  /** The renderer acknowledged (or rejected) a surface command. */
  settle(id: string, reason?: string): void {
    this.pending.get(id)?.(reason ?? true);
  }

  dispose(): void {
    for (const settle of this.pending.values()) settle("view-not-available");
  }
}
