import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MonitorManager } from "../monitor-manager.js";
import type { LoopStore } from "../store.js";
import type { LoopEntry } from "../types.js";

// How long the firing flash is shown before reverting to the normal status line.
const FIRING_FLASH_MS = 5000;

// Maximum visible width for any single status line emitted by this widget.
// Defaults to a comfortable 120-column target; the widget clamps to this even
// when callers produce longer strings. Per ADR-001, this protects the TUI
// from overflowing on small terminals or pathological counts. The widget
// keeps the value settable via setMaxWidth() so tests can exercise widths
// down to 50.
const DEFAULT_MAX_WIDTH = 120;
const MIN_MAX_WIDTH = 20;

interface TaskSummary {
  count: number;
  focusText?: string;
  blockedByLines?: string[];
}

export function clampStatusLine(line: string, maxWidth: number): string {
  const target = Math.max(MIN_MAX_WIDTH, Math.floor(maxWidth));
  if (visibleWidth(line) <= target) return line;
  return truncateToWidth(line, target, "…");
}

export class LoopWidget {
  private uiCtx: ExtensionUIContext | undefined;
  private taskSummaryProvider: (() => TaskSummary) | undefined;
  private firingLoopId: string | undefined;
  private firingTimer: ReturnType<typeof setTimeout> | undefined;
  private maxWidth: number = DEFAULT_MAX_WIDTH;

  constructor(
    private store: LoopStore,
    private monitorManager: MonitorManager,
  ) {}

  setUICtx(ctx: ExtensionUIContext) {
    this.uiCtx = ctx;
  }

  /** Clamp emitted status lines to the given visible width. Defaults to
   *  DEFAULT_MAX_WIDTH (=120). Values below MIN_MAX_WIDTH are rounded up. */
  setMaxWidth(width: number): void {
    this.maxWidth = Math.max(MIN_MAX_WIDTH, Math.floor(width));
  }

  getMaxWidth(): number {
    return this.maxWidth;
  }

  setStore(store: LoopStore) {
    this.store = store;
  }

  setTaskSummaryProvider(provider: (() => TaskSummary) | undefined) {
    this.taskSummaryProvider = provider;
  }

  /** Show a short-lived "Loop #N → firing..." flash in the status bar, then
   *  revert to the normal loop/monitor summary after FIRING_FLASH_MS.
   *  Idempotent: calling again for the same loop resets the timer. */
  setFiringStatus(loopId: string, prompt: string): void {
    if (this.firingLoopId === loopId && this.firingTimer !== undefined) {
      clearTimeout(this.firingTimer);
    } else {
      this.firingLoopId = loopId;
    }
    if (!this.uiCtx) return;
    const firingLine = `Loop #${loopId} → firing: ${prompt}`;
    this.uiCtx.setStatus("loops", clampStatusLine(firingLine, this.maxWidth));
    this.firingTimer = setTimeout(() => {
      this.firingLoopId = undefined;
      this.firingTimer = undefined;
      this.update();
    }, FIRING_FLASH_MS);
  }

  /** Clear any in-flight firing flash. Called when the widget is disposed. */
  private clearFiringTimer(): void {
    if (this.firingTimer !== undefined) {
      clearTimeout(this.firingTimer);
      this.firingTimer = undefined;
      this.firingLoopId = undefined;
    }
  }

  update() {
    if (!this.uiCtx) return;
    // Never overwrite a live firing flash — let the 5s timer revert naturally.
    if (this.firingTimer !== undefined) return;
    const line = this.computeStatus();
    if (line === undefined) {
      this.uiCtx.setStatus("loops", undefined);
      return;
    }
    this.uiCtx.setStatus("loops", clampStatusLine(line, this.maxWidth));
  }

  private computeStatus(): string | undefined {
    const loops = this.store.list().filter(isStatusVisibleLoop);
    const monitors = this.monitorManager.list();
    const taskSummary = this.taskSummaryProvider?.() ?? { count: 0 };

    if (loops.length === 0 && monitors.length === 0 && taskSummary.count === 0) {
      return undefined;
    }

    const parts: string[] = [];
    if (loops.length > 0) parts.push(formatCount(loops.length, "loop"));
    if (monitors.length > 0) parts.push(formatCount(monitors.length, "monitor"));
    if (taskSummary.count > 0) parts.push(formatCount(taskSummary.count, "task"));

    let line = parts.join(" · ");
    if (taskSummary.focusText) line += ` | ${taskSummary.focusText}`;
    if (taskSummary.blockedByLines?.length) {
      line += taskSummary.blockedByLines.map((b) => ` › ${b}`).join("");
    }
    return line;
  }

  dispose() {
    this.clearFiringTimer();
    this.uiCtx?.setStatus("loops", undefined);
  }
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isStatusVisibleLoop(loop: LoopEntry): boolean {
  if (loop.status !== "active") return false;
  if (loop.recurring) return true;
  return !(loop.trigger.type === "event" && loop.trigger.source === "monitor:done");
}
