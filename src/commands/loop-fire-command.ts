import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { formatTrigger } from "../loop-format.js";
import type { LoopEntry } from "../types.js";

interface LoopStoreLike {
  list(): LoopEntry[];
  get(id: string): LoopEntry | undefined;
}

export interface LoopFireCommandOptions {
  pi: ExtensionAPI;
  getStore: () => LoopStoreLike;
}

function rowLabel(l: LoopEntry): string {
  const icon = l.status === "active" ? "*" : "-";
  return `${icon} #${l.id} [${l.status}] ${l.prompt.slice(0, 50)} (${formatTrigger(l.trigger, "command")})`;
}

function extractId(selected: string): string | undefined {
  const match = selected.match(/#(\d+)/);
  return match?.[1];
}

function fireLoop(
  pi: ExtensionAPI,
  ui: ExtensionUIContext,
  entry: LoopEntry,
  isIdle: () => boolean,
): void {
  if (!entry.prompt?.trim()) {
    ui.notify(`Loop #${entry.id} has no prompt to fire.`, "error");
    return;
  }
  try {
    if (isIdle()) {
      pi.sendUserMessage(entry.prompt);
      ui.notify(`Loop #${entry.id} fired into chat.`, "info");
      return;
    }
    pi.sendUserMessage(entry.prompt, { deliverAs: "followUp" });
    ui.notify(`Agent busy — Loop #${entry.id} queued as follow-up.`, "info");
  } catch (err) {
    ui.notify(`Failed to fire Loop #${entry.id}: ${(err as Error).message}`, "error");
  }
}

export function registerLoopFireCommand(options: LoopFireCommandOptions): void {
  const { pi, getStore } = options;

  async function pickAndFire(ui: ExtensionUIContext, isIdle: () => boolean): Promise<void> {
    const loops = getStore().list();
    if (loops.length === 0) {
      ui.notify("No stored loops to fire. Use /loop to create one first.", "info");
      return;
    }
    const choices = loops.map(rowLabel);
    choices.push("< Cancel>");
    const selected = await ui.select("Fire loop into chat", choices);
    if (!selected || selected === "< Cancel>") return;
    const id = extractId(selected);
    if (!id) return;
    const entry = getStore().get(id);
    if (!entry) {
      ui.notify(`Loop #${id} not found.`, "error");
      return;
    }
    fireLoop(pi, ui, entry, isIdle);
  }

  pi.registerCommand("loop-fire", {
    description:
      "Fire a stored loop's prompt as a new user message. Usage: /loop-fire [id]. No args opens a picker over all stored loops (active and paused).",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const ui = ctx.ui;
      const isIdle = () => ctx.isIdle();

      if (!trimmed) return pickAndFire(ui, isIdle);

      const id = trimmed.split(/\s+/)[0];
      if (!id || !/^\d+$/.test(id)) {
        ui.notify(`Expected a numeric loop ID, got "${id}". Try /loop-fire <id>.`, "error");
        return;
      }
      const entry = getStore().get(id);
      if (!entry) {
        ui.notify(`Loop #${id} not found.`, "error");
        return;
      }
      fireLoop(pi, ui, entry, isIdle);
    },
  });
}
