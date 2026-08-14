import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTrigger } from "../loop-format.js";
import type { MonitorEntry } from "../types.js";

export interface RenderTaskSummary {
  count: number;
  focusText?: string;
}

export interface RenderLoopEntry {
  id: string;
  status: "active" | "paused";
  prompt: string;
  recurring: boolean;
  trigger: Parameters<typeof formatTrigger>[0];
  scope?: "project" | "session" | "shared";
  autoTask?: boolean;
  taskBacklog?: boolean;
  dynamic?: { goal: string; iteration: number } | null;
}

export interface RenderWidgetState {
  loops: RenderLoopEntry[];
  monitors: MonitorEntry[];
  tasks: RenderTaskSummary;
  firingLoopId?: string;
  firedAt?: number;
  /** Override "now" for deterministic tests. */
  now?: number;
}

const FIRING_FLASH_MS = 5000;

/** Clamp an arbitrary line to a target visible width. Pure helper exported for
 *  testability. Floors the target at 20 columns. */
export function clampStatusLine(line: string, maxWidth: number): string {
  const target = Math.max(20, Math.floor(maxWidth));
  if (visibleWidth(line) <= target) return line;
  return truncateToWidth(line, target, "…");
}

export function renderWidgetLines(state: RenderWidgetState, theme: Theme, width: number): string[] {
  const safeWidth = Math.max(20, Math.floor(width));
  const now = state.now ?? Date.now();

  const visibleLoops = state.loops.filter(isStatusVisibleLoop);
  const visibleMonitors = state.monitors.filter((m) => m.status === "running" || m.status === "error");

  if (visibleLoops.length === 0 && visibleMonitors.length === 0 && state.tasks.count === 0) {
    return [];
  }

  const lines: string[] = [];

  // Header
  const headerParts: string[] = [];
  if (visibleLoops.length > 0) headerParts.push(formatCount(visibleLoops.length, "loop"));
  if (visibleMonitors.length > 0) headerParts.push(formatCount(visibleMonitors.length, "monitor"));
  if (state.tasks.count > 0) headerParts.push(formatCount(state.tasks.count, "task"));
  lines.push(
    `${theme.fg("accent", theme.bold("pi-loop"))} ${theme.fg("dim", "·")} ${theme.fg("muted", headerParts.join(" · "))}`,
  );

  // Loop rows
  for (let i = 0; i < visibleLoops.length; i++) {
    const loop = visibleLoops[i]!;
    const isLast = i === visibleLoops.length - 1 && visibleMonitors.length === 0 && state.tasks.count === 0;
    lines.push(renderLoopRow(loop, theme, safeWidth, state, now, isLast));
  }

  // Monitor rows
  for (let i = 0; i < visibleMonitors.length; i++) {
    const monitor = visibleMonitors[i]!;
    const isLast = i === visibleMonitors.length - 1 && state.tasks.count === 0;
    lines.push(renderMonitorRow(monitor, theme, safeWidth, now, isLast));
  }

  // Task row (compact — single line)
  if (state.tasks.count > 0) {
    const focusText = state.tasks.focusText ? `: ${state.tasks.focusText}` : "";
    const taskText = `${formatCount(state.tasks.count, "task")}${focusText}`;
    lines.push(
      `${theme.fg("dim", "└─")} ${theme.fg("muted", truncateToWidth(taskText, safeWidth - 6))}`,
    );
  }

  return lines.map((l) => clampLine(l, safeWidth));
}

function renderLoopRow(
  loop: RenderLoopEntry,
  theme: Theme,
  width: number,
  state: RenderWidgetState,
  now: number,
  isLast: boolean,
): string {
  const icon = loop.status === "active" ? "*" : "-";
  const statusColor = loop.status === "active" ? "accent" : "muted";
  const triggerDesc = formatTrigger(loop.trigger, "list");
  const badges: string[] = [];
  if (loop.scope === "shared") badges.push("shared");
  if (loop.autoTask) badges.push("auto-task");
  if (loop.taskBacklog) badges.push("backlog");
  if (loop.dynamic) badges.push(`iter:${loop.dynamic.iteration}`);

  // Firing flash: shows "→ firing (Ns ago)" if this loop fired within the window
  let firingSuffix = "";
  if (state.firingLoopId === loop.id && state.firedAt !== undefined) {
    const elapsed = now - state.firedAt;
    if (elapsed >= 0 && elapsed < FIRING_FLASH_MS) {
      const secs = Math.max(0, Math.floor(elapsed / 1000));
      firingSuffix = ` ${theme.fg("warning", `→ firing (${secs}s ago)`)}`;
    }
  }

  const innerWidth = width - 6; // "  ├─ " prefix
  const promptPart = theme.fg("text", truncateToWidth(loop.prompt, Math.max(8, innerWidth - 30)));
  const branch = theme.fg("dim", isLast ? "└─" : "├─");
  const header = `${theme.fg(statusColor, `${icon} #${loop.id}`)} [${theme.fg(statusColor, loop.status)}]`;
  const meta = theme.fg("dim", `(${triggerDesc}${badges.length ? " · " + badges.join(" · ") : ""})`);

  return `  ${branch} ${header} ${promptPart} ${meta}${firingSuffix}`;
}

function renderMonitorRow(monitor: MonitorEntry, theme: Theme, width: number, now: number, isLast: boolean): string {
  const icon = monitor.status === "running" ? ">" : "x";
  const statusColor = monitor.status === "running" ? "accent" : "error";
  const age = Math.max(0, Math.floor((now - monitor.startedAt) / 1000));
  const ageStr = formatDuration(age);

  const innerWidth = width - 6;
  const branch = theme.fg("dim", isLast ? "└─" : "├─");
  const header = `${theme.fg(statusColor, `${icon} #${monitor.id}`)} [${theme.fg(statusColor, monitor.status)}]`;
  const promptPart = theme.fg("text", truncateToWidth(monitor.command, Math.max(8, innerWidth - 30)));
  const meta = theme.fg("dim", `(${monitor.outputLines} lines, ${ageStr})`);

  return `  ${branch} ${header} ${promptPart} ${meta}`;
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function isStatusVisibleLoop(loop: RenderLoopEntry): boolean {
  if (loop.status !== "active") return false;
  if (loop.recurring) return true;
  if (typeof loop.trigger === "string") return true;
  return !(loop.trigger.type === "event" && loop.trigger.source === "monitor:done");
}

function clampLine(line: string, maxWidth: number): string {
  return visibleWidth(line) > maxWidth ? truncateToWidth(line, maxWidth, "…") : line;
}
