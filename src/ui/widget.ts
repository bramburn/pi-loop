import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { MonitorManager } from "../monitor-manager.js";
import type { LoopStore } from "../store.js";
import { type RenderWidgetState, renderWidgetLines } from "./widget-render.js";

/**
 * Above-editor widget showing live loop/monitor/task state.
 *
 * Replaces the v1.x single-line `setStatus("loops", ...)` surface with a
 * registered `Component` that renders into `aboveEditor` placement.
 *
 * Per ADR-001, the widget key is `"loops"` (preserves v1.x key for
 * downstream scripts). Per the v2.0 release decision, `setStatus` is no
 * longer called — the widget is the only surface.
 */
const WIDGET_KEY = "loops";

interface TaskSummary {
  count: number;
  focusText?: string;
  blockedByLines?: string[];
}

interface LoopWidgetComponentOptions {
  tui: TUI;
  theme: Parameters<typeof renderWidgetLines>[1];
  getState: () => RenderWidgetState;
}

class LoopWidgetComponent {
  constructor(private readonly options: LoopWidgetComponentOptions) {}

  update(): void {
    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    return renderWidgetLines(this.options.getState(), this.options.theme, width);
  }

  invalidate(): void {
    this.options.tui.requestRender();
  }
}

export class LoopWidget {
  private uiCtx: ExtensionUIContext | undefined;
  private taskSummaryProvider: (() => TaskSummary) | undefined;
  private firingLoopId: string | undefined;
  private firedAt: number | undefined;
  private tickerTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private store: LoopStore,
    private monitorManager: MonitorManager,
  ) {}

  setUICtx(ctx: ExtensionUIContext): void {
    this.uiCtx = ctx;
    this.registerComponent();
  }

  setStore(store: LoopStore): void {
    this.store = store;
    this.invalidate();
  }

  setTaskSummaryProvider(provider: (() => TaskSummary) | undefined): void {
    this.taskSummaryProvider = provider;
    this.invalidate();
  }

  /** Mark a loop as having fired. The widget renders the firing loop row
   *  with a "→ firing (Ns ago)" suffix for 5 seconds, refreshing every
   *  1s so the timestamp stays accurate. */
  setFiringStatus(loopId: string, _prompt: string): void {
    this.firingLoopId = loopId;
    this.firedAt = Date.now();
    this.invalidate();
    this.ensureTicker();
  }

  /** Start (or reset) the live ticker that repaints the widget at 1 Hz
   *  while a firing indicator is visible. Self-disables after
   *  FIRING_FLASH_MS of inactivity. */
  private ensureTicker(): void {
    if (this.tickerTimer) {
      // Already ticking; the new firing resets the flash window implicitly
      // (we re-check firedAt on every tick).
      return;
    }
    this.tickerTimer = setInterval(() => {
      const now = Date.now();
      if (this.firedAt === undefined || now - this.firedAt >= 5000) {
        this.stopTicker();
        this.invalidate(); // one last repaint to clear the firing indicator
        return;
      }
      this.invalidate();
    }, 1000);
    this.tickerTimer.unref?.();
  }

  private stopTicker(): void {
    if (this.tickerTimer) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = undefined;
    }
  }

  /** Trigger a widget re-render. Called after every store mutation. */
  update(): void {
    this.invalidate();
  }

  /** Clear the widget registration. Called on session shutdown. */
  dispose(): void {
    this.stopTicker();
    if (!this.uiCtx) return;
    this.uiCtx.setWidget(WIDGET_KEY, undefined);
  }

  /** Read-only snapshot of the state the widget renders. Used both by the
   *  component factory at render time and by tests. */
  private snapshotState(): RenderWidgetState {
    const taskSummary = this.taskSummaryProvider?.() ?? { count: 0 };
    return {
      loops: this.store.list().map((entry) => ({
        id: entry.id,
        status: entry.status === "active" ? "active" : "paused",
        prompt: entry.prompt,
        recurring: entry.recurring,
        trigger: entry.trigger,
        autoTask: entry.autoTask,
        taskBacklog: entry.taskBacklog,
        dynamic: entry.dynamic
          ? { goal: entry.dynamic.goal, iteration: entry.dynamic.iteration ?? 0 }
          : null,
      })),
      monitors: this.monitorManager.list(),
      tasks: { count: taskSummary.count, focusText: taskSummary.focusText },
      firingLoopId: this.firingLoopId,
      firedAt: this.firedAt,
    };
  }

  private invalidate(): void {
    // We don't hold a direct handle to the component — the factory captures
    // this via closures and re-reads state on every render. To trigger a
    // repaint, we re-register the same factory. The TUI diffs the output.
    if (!this.uiCtx) return;
    this.registerComponent();
  }

  private registerComponent(): void {
    if (!this.uiCtx) return;
    const factory = (tui: TUI, theme: Parameters<typeof renderWidgetLines>[1]): LoopWidgetComponent => {
      return new LoopWidgetComponent({
        tui,
        theme,
        getState: () => this.snapshotState(),
      });
    };
    this.uiCtx.setWidget(WIDGET_KEY, factory, { placement: "aboveEditor" });
  }
}

export { clampStatusLine } from "./widget-render.js";
