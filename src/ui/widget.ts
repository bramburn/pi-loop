import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { MonitorManager } from "../monitor-manager.js";
import type { LoopStore } from "../store.js";

interface TaskSummary {
  count: number;
  focusText?: string;
}

export class LoopWidget {
  private uiCtx: ExtensionUIContext | undefined;
  private tui: TUI | undefined;
  private widgetRegistered = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private taskSummaryProvider: (() => TaskSummary) | undefined;

  constructor(
    private store: LoopStore,
    private monitorManager: MonitorManager,
  ) {}

  setUICtx(ctx: ExtensionUIContext) {
    this.uiCtx = ctx;
  }

  setStore(store: LoopStore) {
    this.store = store;
  }

  setTaskSummaryProvider(provider: (() => TaskSummary) | undefined) {
    this.taskSummaryProvider = provider;
  }

  update() {
    if (!this.uiCtx) return;

    const taskSummary = this.taskSummaryProvider?.() ?? { count: 0 };
    const hasContent = this.store.list().some(l => l.status === "active") || this.monitorManager.list().length > 0 || taskSummary.count > 0;
    if (hasContent && !this.interval) {
      this.interval = setInterval(() => this.update(), 5000);
    }
    if (!hasContent && this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("loops", (tui: TUI, theme: Theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} } as Component & { dispose?(): void };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      (this.tui as any).requestRender();
    }
  }

  private renderWidget(tui: TUI, _theme: Theme): string[] {
    const loops = this.store.list().filter(l => l.status === "active");
    const monitors = this.monitorManager.list();
    const taskSummary = this.taskSummaryProvider?.() ?? { count: 0 };
    const w = tui.terminal.columns;
    const trunc = (line: string) => truncateToWidth(line, w);

    if (loops.length === 0 && monitors.length === 0 && taskSummary.count === 0) {
      return [trunc("none")];
    }

    const parts: string[] = [];
    if (loops.length > 0) parts.push(formatCount(loops.length, "loop"));
    if (monitors.length > 0) parts.push(formatCount(monitors.length, "monitor"));
    if (taskSummary.count > 0) parts.push(formatCount(taskSummary.count, "task"));

    let line = parts.join(" · ");
    if (taskSummary.focusText) line += ` | ${taskSummary.focusText}`;
    return [trunc(line)];
  }

  dispose() {
    if (this.interval) { clearInterval(this.interval); this.interval = undefined; }
    if (this.uiCtx) this.uiCtx.setWidget("loops", undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
