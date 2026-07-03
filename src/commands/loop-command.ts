import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { parseInterval } from "../loop-parse.js";
import { BindingsStore } from "../runtime/bindings-store.js";
import type { LoopEntry, Trigger } from "../types.js";

interface LoopStoreLike {
  list(): LoopEntry[];
  get(id: string): LoopEntry | undefined;
  create(trigger: Trigger, prompt: string, options?: Partial<LoopEntry>): LoopEntry;
  pause(id: string): LoopEntry | undefined;
  resume(id: string): LoopEntry | undefined;
  delete(id: string): boolean;
}

interface TriggerSystemLike {
  add(entry: LoopEntry): void;
  remove(id: string): void;
}

export interface LoopCommandOptions {
  pi: ExtensionAPI;
  getStore: () => LoopStoreLike;
  getTriggerSystem: () => TriggerSystemLike;
  getBindingsStore: () => BindingsStore;
  updateWidget: () => void;
}

export function registerLoopCommand(options: LoopCommandOptions): void {
  const { pi, getStore, getTriggerSystem, getBindingsStore, updateWidget } = options;

  async function scheduleLoop(ui: ExtensionUIContext, prompt?: string) {
    const p = prompt || await ui.input("Prompt (what should the agent check?)");
    if (!p) return;

    const interval = await ui.input("Interval (e.g., 5m, 2h, 1d)");
    if (!interval) return;

    try {
      const parsed = parseInterval(interval);
      const trigger: Trigger = { type: "cron", schedule: parsed.cron };
      const entry = getStore().create(trigger, p, { recurring: true });
      getTriggerSystem().add(entry);
      updateWidget();
      ui.notify(`Loop #${entry.id} created: every ${parsed.description}`, "info");
    } catch (err: unknown) {
      ui.notify((err as Error).message, "error");
    }
  }

  async function eventLoop(ui: ExtensionUIContext, prompt?: string) {
    const p = prompt || await ui.input("Prompt");
    if (!p) return;

    const source = await ui.input("Pi event source (e.g., tool_execution_start, before_agent_start)");
    if (!source) return;

    const trigger: Trigger = { type: "event", source };
    const entry = getStore().create(trigger, p, { recurring: true });
    getTriggerSystem().add(entry);
    updateWidget();
    ui.notify(`Event loop #${entry.id} created: fires on "${source}"`, "info");
  }

  async function viewLoops(ui: ExtensionUIContext) {
    const loops = getStore().list();
    if (loops.length === 0) {
      await ui.select("No loops configured", ["< Back"]);
      return;
    }

    const choices = loops.map((l) => {
      const icon = l.status === "active" ? "*" : l.status === "paused" ? "-" : "x";
      const triggerDesc = l.trigger.type === "cron"
        ? `cron: ${l.trigger.schedule}`
        : l.trigger.type === "event"
          ? `event: ${l.trigger.source}`
          : `hybrid: ${l.trigger.cron} + event:${l.trigger.event.source} (${l.trigger.debounceMs}ms debounce)`;
      return `${icon} #${l.id} [${l.status}] ${l.prompt.slice(0, 50)} (${triggerDesc})`;
    });
    choices.push("< Back");

    const selected = await ui.select("Loops", choices);
    if (!selected || selected === "< Back") return;

    const match = selected.match(/#(\d+)/);
    if (match) {
      const entry = getStore().get(match[1]);
      if (entry) {
        const actions = ["x Delete"];
        if (entry.status === "active") actions.unshift("- Pause");
        else if (entry.status === "paused") actions.unshift("* Resume");
        actions.push("< Back");

        const action = await ui.select(
          `#${entry.id}: ${entry.prompt}\nTrigger: ${JSON.stringify(entry.trigger)}`,
          actions,
        );

        if (action === "x Delete") {
          getTriggerSystem().remove(entry.id);
          getStore().delete(entry.id);
          updateWidget();
          ui.notify(`Loop #${entry.id} deleted`, "info");
        } else if (action === "- Pause") {
          getStore().pause(entry.id);
          getTriggerSystem().remove(entry.id);
          updateWidget();
          ui.notify(`Loop #${entry.id} paused`, "info");
        } else if (action === "* Resume") {
          getStore().resume(entry.id);
          getTriggerSystem().add(entry);
          updateWidget();
          ui.notify(`Loop #${entry.id} resumed`, "info");
        }
      }
    }

    return viewLoops(ui);
  }

  async function settings(ui: ExtensionUIContext) {
    const loops = getStore().list();
    const active = loops.filter((l) => l.status === "active").length;
    ui.notify(`${active}/${loops.length} active loops (max 25)`, "info");
  }

  pi.registerCommand("loop", {
    description: "Create a repeating scheduled task: /loop [interval] [prompt]. E.g., /loop 5m check the deploy, /loop 30s am I still here",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const ui = ctx.ui;

      if (!trimmed) {
        const choice = await ui.select("Loop", [
          "Create scheduled loop",
          "Create event-triggered loop",
          "View loops",
          "Settings",
        ]);

        if (!choice) return;
        if (choice.startsWith("Create scheduled")) return scheduleLoop(ui);
        if (choice.startsWith("Create event")) return eventLoop(ui);
        if (choice.startsWith("View loops")) return viewLoops(ui);
        return settings(ui);
      }

      const intervalMatch = trimmed.match(/^(\d+\s*[smhdS]\b)/i);
      if (intervalMatch) {
        const interval = intervalMatch[1];
        const prompt = trimmed.slice(intervalMatch[0].length).trim();

        if (!prompt) {
          ui.notify("Provide a prompt after the interval, e.g., /loop 5m check the deploy", "warning");
          return;
        }

        try {
          const parsed = parseInterval(interval);
          const trigger: Trigger = { type: "cron", schedule: parsed.cron };
          const entry = getStore().create(trigger, prompt, { recurring: true });
          getTriggerSystem().add(entry);
          updateWidget();
          ui.notify(`Loop #${entry.id} created: every ${parsed.description} — ${prompt.slice(0, 50)}`, "info");
        } catch (err: unknown) {
          ui.notify((err as Error).message, "error");
        }
        return;
      }

      const choice = await ui.select("Loop mode", [
        `Scheduled: "${trimmed.slice(0, 50)}"`,
        `Event-triggered: "${trimmed.slice(0, 50)}"`,
      ]);

      if (!choice) return;
      if (choice.startsWith("Event")) return eventLoop(ui, trimmed);
      return scheduleLoop(ui, trimmed);
    },
  });

  pi.registerCommand("loop-resume", {
    description: "Re-arm a stored loop by ID, or open the governor to pick which loops this session arms. Usage: /loop-resume <id> | /loop-resume (no args)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const ui = ctx.ui;
      const bindings = getBindingsStore();

      if (!trimmed) {
        await openGovernor(ui, bindings);
        return;
      }

      const id = trimmed.split(/\s+/)[0];
      if (!/^\d+$/.test(id)) {
        ui.notify(`Expected a numeric loop ID, got "${id}". Try /loop-resume <id> or /loop-resume (no args) for the governor.`, "error");
        return;
      }
      await rearmLoopOneShot(ui, bindings, id);
    },
  });

  // ── One-shot: arm + bind a single loop in one call ──

  async function rearmLoopOneShot(ui: ExtensionUIContext, bindings: BindingsStore, id: string): Promise<void> {
    const before = getStore().get(id);
    if (!before) {
      ui.notify(`Loop #${id} not found in the store. Use /loop to create one first.`, "error");
      return;
    }
    const entry = getStore().resume(id) ?? before;
    getTriggerSystem().add(entry);
    bindings.add(id);
    updateWidget();
    ui.notify(`Loop #${entry.id} re-armed and bound to this session`, "info");
  }

  // ── Governor: pick which loops this session arms ──

  type Toggle = "arm" | "disarm";
  // Picker sentinels are prefixed with `< ` so they sort naturally to the
  // bottom of the row list (no numeric prefix to confuse with loop ids).
  const SENTINEL_OK = "< OK";
  const SENTINEL_CONTINUE = "< Continue";
  const SENTINEL_CANCEL = "< Cancel";

  async function openGovernor(ui: ExtensionUIContext, bindings: BindingsStore): Promise<void> {
    const loops = getStore().list();
    if (loops.length === 0) {
      ui.notify("No stored loops to bind. Use /loop to create one first.", "info");
      return;
    }

    // pending toggles: ids the user flipped while in the picker. The final
    // applied state for an id is (bindings.has(id) XOR pending.has(id)).
    const pending = new Map<string, Toggle>();
    let dirty = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = buildGovernorRows(loops, bindings, pending);
      const selected = await ui.select("Governor — toggle loops, then < OK / < Continue / < Cancel", [
        ...rows,
        SENTINEL_OK,
        SENTINEL_CONTINUE,
        SENTINEL_CANCEL,
      ]);

      if (!selected || selected === SENTINEL_CANCEL) {
        if (dirty) {
          ui.notify("Governor changes discarded.", "info");
        }
        return;
      }

      if (selected === SENTINEL_OK) {
        applyPending(ui, bindings, pending);
        if (pending.size > 0) dirty = true;
        return;
      }

      if (selected === SENTINEL_CONTINUE) {
        const diff = buildDiffSummary(loops, bindings, pending);
        const ok = await ui.confirm("Apply changes?", diff);
        if (ok) {
          applyPending(ui, bindings, pending);
          if (pending.size > 0) dirty = true;
          return;
        }
        // Cancel from the confirm returns to the picker; pending stays.
        continue;
      }

      // Otherwise it must be a loop row — toggle and refresh.
      const match = selected.match(/#(\d+)/);
      if (!match) continue;
      const id = match[1];
      const currentlyBound = bindings.has(id);
      const prev = pending.get(id);
      // No pending yet → decide toggle based on current bound state.
      // Pending exists → flip it (so user can correct a misclick).
      if (prev === undefined) {
        pending.set(id, currentlyBound ? "disarm" : "arm");
      } else if (prev === "arm") {
        pending.set(id, "disarm");
      } else {
        pending.delete(id);
      }
      dirty = true;
    }
  }

  function buildGovernorRows(
    loops: LoopEntry[],
    bindings: BindingsStore,
    pending: Map<string, Toggle>,
  ): string[] {
    return loops.map((l) => {
      const triggerDesc = l.trigger.type === "cron"
        ? `cron: ${l.trigger.schedule}`
        : l.trigger.type === "event"
          ? `event: ${l.trigger.source}`
          : `hybrid: ${l.trigger.cron} + event:${l.trigger.event.source} (${l.trigger.debounceMs}ms debounce)`;
      const finalBound = computeFinalBound(l.id, bindings, pending);
      const box = finalBound ? "[x]" : "[ ]";
      return `${box} #${l.id} [${l.status}] ${l.prompt.slice(0, 50)} (${triggerDesc})`;
    });
  }

  function computeFinalBound(id: string, bindings: BindingsStore, pending: Map<string, Toggle>): boolean {
    const current = bindings.has(id);
    const toggle = pending.get(id);
    if (toggle === undefined) return current;
    return toggle === "arm";
  }

  function buildDiffSummary(
    _loops: LoopEntry[],
    _bindings: BindingsStore,
    pending: Map<string, Toggle>,
  ): string {
    if (pending.size === 0) return "No changes.";
    const arm: string[] = [];
    const disarm: string[] = [];
    for (const [id, toggle] of pending) {
      if (toggle === "arm") arm.push(`#${id}`);
      else disarm.push(`#${id}`);
    }
    const lines: string[] = [];
    if (arm.length > 0) lines.push(`Arm: ${arm.join(", ")}`);
    if (disarm.length > 0) lines.push(`Disarm: ${disarm.join(", ")}`);
    return lines.join("\n");
  }

  function applyPending(
    ui: ExtensionUIContext,
    bindings: BindingsStore,
    pending: Map<string, Toggle>,
  ): void {
    if (pending.size === 0) {
      ui.notify("No changes to apply.", "info");
      return;
    }
    const armed: string[] = [];
    const disarmed: string[] = [];
    for (const [id, toggle] of pending) {
      const entry = getStore().get(id);
      if (!entry) continue;
      if (toggle === "arm") {
        bindings.add(id);
        getTriggerSystem().add(entry);
        armed.push(`#${id}`);
      } else {
        bindings.remove(id);
        getTriggerSystem().remove(id);
        disarmed.push(`#${id}`);
      }
    }
    pending.clear();
    updateWidget();
    const summary = [
      armed.length > 0 ? `Armed: ${armed.join(", ")}` : null,
      disarmed.length > 0 ? `Disarmed: ${disarmed.join(", ")}` : null,
    ].filter(Boolean).join(" · ");
    ui.notify(summary || "Governor applied.", "info");
  }
}
