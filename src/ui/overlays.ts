/**
 * Loop list overlay — modal showing every loop + monitor + task.
 *
 * Per ADR-004: bound to Ctrl+Shift+L. Toggle 'a' switches between
 * "my loops" (bound by this session) and "all loops". Headless mode
 * returns undefined immediately.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTrigger } from "../loop-format.js";
import type { LoopEntry } from "../types.js";

export type LoopOverlayResult =
  | { action: "select"; loopId: string }
  | { action: "dismiss" };

export interface LoopOverlayOptions {
  loops: LoopEntry[];
  monitors: Array<{ id: string; command: string; status: string; outputLines: number; startedAt: number }>;
  tasks: { count: number; focusText?: string };
  /** Filter to loops bound by the current session. */
  myLoopIds: Set<string>;
  /** Display title for the overlay header. */
  title?: string;
}

/**
 * Show the loop list overlay. Returns the user's choice, or undefined in
 * headless mode.
 */
export async function showLoopListOverlay(
  ctx: ExtensionContext,
  options: LoopOverlayOptions,
): Promise<LoopOverlayResult | undefined> {
  if (!ctx.hasUI) return undefined;

  return await ctx.ui.custom<LoopOverlayResult>(
    (tui, theme, _keybindings, done) => createComponent(tui, theme, options, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        minWidth: 60,
        maxHeight: "80%",
      },
    },
  );
}

function createComponent(
  tui: TUI,
  theme: Theme,
  options: LoopOverlayOptions,
  done: (result: LoopOverlayResult) => void,
): Component {
  const wasHardwareCursorShown = tui.getShowHardwareCursor();
  tui.setShowHardwareCursor(false);

  let showAllLoops = false;
  let selectedIndex = 0;

  function visibleLoops(): LoopEntry[] {
    const all = options.loops.filter((l) => l.status === "active" || l.status === "paused");
    if (showAllLoops) return all;
    return all.filter((l) => options.myLoopIds.has(l.id));
  }

  const component: Component & { dispose?(): void } = {
    dispose() {
      tui.setShowHardwareCursor(wasHardwareCursorShown);
    },
    invalidate(): void {},
    render(width: number): string[] {
      const innerWidth = Math.max(40, Math.min(width - 4, 90));
      const loops = visibleLoops();
      const lines: string[] = [];
      const horizLine = "─".repeat(innerWidth);

      lines.push(theme.fg("accent", `┌${horizLine}┐`));

      // Header
      const headerLabel = showAllLoops ? "all loops" : "my loops";
      const headerParts = [
        `${loops.length} ${loops.length === 1 ? "loop" : "loops"}`,
        `${options.monitors.length} monitor${options.monitors.length === 1 ? "" : "s"}`,
        `${options.tasks.count} task${options.tasks.count === 1 ? "" : "s"}`,
      ].join(" · ");
      lines.push(borderedLine(theme, innerWidth, theme.bold(` Loops (${headerLabel})`) + theme.fg("muted", ` — ${headerParts}`)));
      lines.push(theme.fg("accent", `├${horizLine}┤`));

      if (loops.length === 0 && options.monitors.length === 0) {
        lines.push(borderedLine(theme, innerWidth, theme.fg("dim", " No active loops or monitors.")));
      }

      // Loop rows
      for (let i = 0; i < loops.length; i++) {
        const loop = loops[i]!;
        const isSelected = i === selectedIndex;
        const marker = isSelected ? theme.fg("accent", "▸ ") : "  ";
        const status = loop.status === "active" ? "*" : "-";
        const prompt = truncateToWidth(loop.prompt, innerWidth - 24);
        const triggerDesc = formatTrigger(loop.trigger, "list");
        const line = `${marker}${theme.fg(loop.status === "active" ? "accent" : "muted", status)} #${loop.id} ${theme.fg("text", prompt)} ${theme.fg("dim", `(${triggerDesc})`)}`;
        lines.push(borderedLine(theme, innerWidth, line));
      }

      // Monitor rows
      for (const monitor of options.monitors) {
        const icon = monitor.status === "running" ? ">" : "x";
        const cmd = truncateToWidth(monitor.command, innerWidth - 18);
        const line = `  ${theme.fg(monitor.status === "running" ? "accent" : "error", icon)} #${monitor.id} ${theme.fg("text", cmd)} ${theme.fg("dim", `(${monitor.outputLines} lines)`)}`;
        lines.push(borderedLine(theme, innerWidth, line));
      }

      // Footer
      lines.push(theme.fg("accent", `├${horizLine}┤`));
      const toggleHint = showAllLoops ? "show my" : "show all";
      const footerText = `↑↓ select · 'a' to ${toggleHint} · Enter to inspect · Esc dismiss`;
      lines.push(borderedLine(theme, innerWidth, theme.fg("dim", " " + footerText)));
      lines.push(theme.fg("accent", `└${horizLine}┘`));

      return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width, "…") : l));
    },
    handleInput(data: string): void {
      if (matchesKey(data, "up")) {
        const max = visibleLoops().length - 1;
        if (max >= 0) selectedIndex = Math.max(0, selectedIndex - 1);
        tui.requestRender();
        return;
      }
      if (matchesKey(data, "down")) {
        const max = visibleLoops().length - 1;
        if (max >= 0) selectedIndex = Math.min(max, selectedIndex + 1);
        tui.requestRender();
        return;
      }
      if (matchesKey(data, "a")) {
        showAllLoops = !showAllLoops;
        // Clamp selectedIndex so it doesn't point past the end of the
        // new (possibly shorter) visible list.
        const max = visibleLoops().length - 1;
        if (max < 0) selectedIndex = 0;
        else if (selectedIndex > max) selectedIndex = max;
        tui.requestRender();
        return;
      }
      if (matchesKey(data, "enter")) {
        const loops = visibleLoops();
        const sel = loops[selectedIndex];
        if (sel) done({ action: "select", loopId: sel.id });
        else done({ action: "dismiss" });
        return;
      }
      if (matchesKey(data, "escape")) {
        done({ action: "dismiss" });
        return;
      }
    },
  };
  return component;
}

function borderedLine(theme: Theme, innerWidth: number, content: string): string {
  const vis = visibleWidth(content);
  const fill = Math.max(0, innerWidth - vis);
  return theme.fg("accent", "│") + content + " ".repeat(fill) + theme.fg("accent", "│");
}
