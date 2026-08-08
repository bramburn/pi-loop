/**
 * Escape dialog — modal that appears when the user presses Escape during
 * a long-running operation (e.g. loop firing, monitor startup, backlog
 * worker spawn).
 *
 * Per ADR-004: returns "continue" | "skip" | "cancel". Headless mode
 * returns "continue" as the safe default.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type EscapeDialogResult = "continue" | "skip" | "cancel";

export interface EscapeDialogOptions {
  operationLabel: string;
  /** Optional second-line detail (e.g. "Loop #5 fired 12s ago"). */
  detail?: string;
}

const OPTIONS: Array<{ label: string; value: EscapeDialogResult; description: string }> = [
  {
    label: "Cancel the operation",
    value: "cancel",
    description: "Stop the operation and clean up any resources.",
  },
  {
    label: "Skip this iteration",
    value: "skip",
    description: "Mark the current fire as resolved; the loop continues next time.",
  },
  {
    label: "Continue working",
    value: "continue",
    description: "Resume the operation. The default for Escape.",
  },
];

export async function showEscapeDialog(
  ctx: ExtensionContext,
  options: EscapeDialogOptions,
): Promise<EscapeDialogResult> {
  if (!ctx.hasUI) return "continue";

  return await ctx.ui.custom<EscapeDialogResult>(
    (tui, theme, _keybindings, done) => createComponent(tui, theme, options, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "70%", minWidth: 50, maxHeight: "60%" },
    },
  );
}

function createComponent(
  tui: TUI,
  theme: Theme,
  options: EscapeDialogOptions,
  done: (result: EscapeDialogResult) => void,
): Component {
  const wasHardwareCursorShown = tui.getShowHardwareCursor();
  tui.setShowHardwareCursor(false);

  // Default selection: "continue" (the safe default for Escape).
  let selectedIndex = 2;

  const component: Component & { dispose?(): void } = {
    dispose() {
      tui.setShowHardwareCursor(wasHardwareCursorShown);
    },
    invalidate(): void {},
    render(width: number): string[] {
      const innerWidth = Math.max(40, Math.min(width - 4, 64));
      const horiz = "─".repeat(innerWidth);
      const lines: string[] = [];

      lines.push(theme.fg("accent", `┌${horiz}┐`));
      lines.push(borderedLine(theme, innerWidth,
        theme.bold(" Operation interrupted by Escape") + theme.fg("muted", "  (continue = default)"),
      ));
      lines.push(borderedLine(theme, innerWidth,
        theme.fg("muted", " Operation: ") + truncateToWidth(options.operationLabel, innerWidth - 12),
      ));
      if (options.detail) {
        lines.push(borderedLine(theme, innerWidth,
          theme.fg("muted", " Detail: ") + truncateToWidth(options.detail, innerWidth - 10),
        ));
      }
      lines.push(theme.fg("accent", `├${horiz}┤`));

      OPTIONS.forEach((opt, i) => {
        const isSelected = i === selectedIndex;
        const marker = isSelected ? theme.fg("accent", "▸ ") : "  ";
        const labelText = isSelected ? theme.fg("warning", opt.label) : opt.label;
        lines.push(borderedLine(theme, innerWidth, marker + truncateToWidth(labelText, innerWidth - 4)));
        if (isSelected) {
          lines.push(borderedLine(theme, innerWidth,
            "    " + theme.fg("dim", truncateToWidth(opt.description, innerWidth - 6)),
          ));
        }
      });

      lines.push(theme.fg("accent", `├${horiz}┤`));
      lines.push(borderedLine(theme, innerWidth,
        theme.fg("dim", " ↑↓ navigate · Enter select · Esc = continue working"),
      ));
      lines.push(theme.fg("accent", `└${horiz}┘`));

      return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width, "…") : l));
    },
    handleInput(data: string): void {
      if (matchesKey(data, "up")) {
        selectedIndex = (selectedIndex - 1 + OPTIONS.length) % OPTIONS.length;
        tui.requestRender();
        return;
      }
      if (matchesKey(data, "down")) {
        selectedIndex = (selectedIndex + 1) % OPTIONS.length;
        tui.requestRender();
        return;
      }
      if (matchesKey(data, "enter")) {
        done(OPTIONS[selectedIndex]!.value);
        return;
      }
      if (matchesKey(data, "escape")) {
        done("continue");
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
