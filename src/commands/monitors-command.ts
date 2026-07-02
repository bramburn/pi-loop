import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { MonitorEntry } from "../types.js";

interface MonitorManagerLike {
  list(): MonitorEntry[];
  get(id: string): MonitorEntry | undefined;
  stop(id: string): Promise<boolean>;
  delete(id: string): Promise<boolean>;
}

export interface MonitorsCommandOptions {
  pi: ExtensionAPI;
  getMonitorManager: () => MonitorManagerLike;
  updateWidget: () => void;
}

export function registerMonitorsCommand(options: MonitorsCommandOptions): void {
  const { pi, getMonitorManager, updateWidget } = options;

  async function viewMonitors(ui: ExtensionUIContext) {
    const monitors = getMonitorManager().list();
    if (monitors.length === 0) {
      await ui.select("No monitors running", ["< Back"]);
      return;
    }

    const choices = monitors.map((m) => {
      const icon = m.status === "running" ? ">" : m.status === "completed" ? "ok" : "x";
      const age = Date.now() - m.startedAt;
      const ageStr = formatRemaining(age);
      return `${icon} #${m.id} [${m.status}] ${m.command.slice(0, 50)} — ${m.outputLines} lines (${ageStr})`;
    });
    choices.push("< Back");

    const selected = await ui.select("Monitors", choices);
    if (!selected || selected === "< Back") return;

    const match = selected.match(/#(\d+)/);
    if (!match) return viewMonitors(ui);

    const monitor = getMonitorManager().get(match[1]);
    if (!monitor) return viewMonitors(ui);

    const actions = ["x Delete"];
    if (monitor.status === "running") actions.unshift("- Stop");
    actions.push("< Back");

    const action = await ui.select(
      `#${monitor.id}: ${monitor.command}\nStatus: ${monitor.status}\nOutput: ${monitor.outputLines} lines`,
      actions,
    );

    if (!action || action === "< Back") return viewMonitors(ui);

    if (action === "- Stop") {
      const stopped = await getMonitorManager().stop(monitor.id);
      updateWidget();
      ui.notify(stopped ? `Monitor #${monitor.id} stopped` : `Monitor #${monitor.id} could not be stopped`, "info");
    } else if (action === "x Delete") {
      const deleted = await getMonitorManager().delete(monitor.id);
      updateWidget();
      ui.notify(deleted ? `Monitor #${monitor.id} deleted` : `Monitor #${monitor.id} not found`, "info");
    }

    return viewMonitors(ui);
  }

  pi.registerCommand("monitors", {
    description: "List and manage running monitors: /monitors",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      return viewMonitors(ctx.ui);
    },
  });
}

function formatRemaining(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}
