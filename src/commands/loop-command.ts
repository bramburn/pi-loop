import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { formatTrigger } from "../loop-format.js";
import { isValidCronExpression, parseInterval } from "../loop-parse.js";
import type { BindingsStore } from "../runtime/bindings-store.js";
import { resolveLoopStorePath } from "../runtime/scope.js";
import type { DynamicLoopState, LoopEntry, LoopPriority, Trigger } from "../types.js";
import { isTerminalWorkflowRun } from "../workflow-reducer.js";
import { type LoopStoreLike as EditLoopStoreLike, type TriggerSystemLike as EditTriggerSystemLike, editLoopInteractive } from "./loop-edit-command.js";

interface LoopStoreLike extends EditLoopStoreLike {
  list(): LoopEntry[];
  get(id: string): LoopEntry | undefined;
  create(trigger: Trigger, prompt: string, options: {
    recurring: boolean;
    autoTask?: boolean;
    taskBacklog?: boolean;
    readOnly?: boolean;
    maxFires?: number;
    priority?: LoopPriority;
    dynamic?: Partial<DynamicLoopState>;
  }): LoopEntry;
  pause(id: string): LoopEntry | undefined;
  resume(id: string): LoopEntry | undefined;
  delete(id: string): boolean;
  promote(id: string, sharedStorePath: string): { ok: boolean; sharedEntry?: LoopEntry; error?: string };
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
  maybeBootstrapTaskLoop?: (entry: LoopEntry) => Promise<boolean>;
  onDynamicLoopActivated?: (entry: LoopEntry) => void;
}

type LoopCommandRoute =
  | { type: "menu" }
  | { type: "event"; source: string; prompt: string }
  | { type: "cron"; interval: string; prompt: string; notifyEvery: boolean }
  | { type: "invalid-cron"; interval: string }
  | { type: "missing-interval-prompt" }
  | { type: "dynamic"; goal: string };

function parseLoopCommandRoute(input: string): LoopCommandRoute {
  const trimmed = input.trim();
  if (!trimmed) return { type: "menu" };

  const eventMatch = trimmed.match(/^(?:event|when)\s+(\S+)\s+(.+)$/i);
  if (eventMatch?.[1] && eventMatch[2]) {
    return { type: "event", source: eventMatch[1], prompt: eventMatch[2].trim() };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length > 5) {
    const interval = parts.slice(0, 5).join(" ");
    const cronShaped = parts.slice(0, 5).every((part) => /^[\d*/,-]+$/.test(part));
    if (cronShaped) {
      if (!isValidCronExpression(interval)) return { type: "invalid-cron", interval };
      return { type: "cron", interval, prompt: parts.slice(5).join(" "), notifyEvery: false };
    }
  }

  const intervalMatch = trimmed.match(/^(\d+\s*[smhdS]\b)/i);
  if (intervalMatch) {
    const interval = intervalMatch[1] ?? intervalMatch[0];
    const prompt = trimmed.slice(intervalMatch[0].length).trim();
    if (!prompt) return { type: "missing-interval-prompt" };
    return { type: "cron", interval, prompt, notifyEvery: true };
  }

  return { type: "dynamic", goal: trimmed };
}

export function registerLoopCommand(options: LoopCommandOptions): void {
  const { pi, getStore, getTriggerSystem, getBindingsStore, updateWidget, maybeBootstrapTaskLoop, onDynamicLoopActivated } = options;

  function createCronLoop(ui: ExtensionUIContext, interval: string, prompt: string, notifyEvery: boolean) {
    let entry: LoopEntry | undefined;
    try {
      const parsed = parseInterval(interval);
      const trigger: Trigger = { type: "cron", schedule: parsed.cron };
      entry = getStore().create(trigger, prompt, { recurring: true });
      getTriggerSystem().add(entry);
      getBindingsStore().add(entry.id);
      updateWidget();
      const cadence = notifyEvery ? `every ${parsed.description}` : parsed.description;
      ui.notify(`Loop #${entry.id} created: ${cadence} — ${prompt.slice(0, 50)}`, "info");
    } catch (err: unknown) {
      if (entry) {
        getTriggerSystem().remove(entry.id);
        getStore().delete(entry.id);
        updateWidget();
      }
      ui.notify((err as Error).message, "error");
    }
  }

  async function scheduleLoop(ui: ExtensionUIContext, prompt?: string) {
    const p = prompt || await ui.input("Prompt (what should the agent check?)");
    if (!p) return;

    const interval = await ui.input("Interval (e.g., 5m, 2h, 1d)");
    if (!interval) return;

    createCronLoop(ui, interval, p, true);
  }

  async function eventLoop(ui: ExtensionUIContext, prompt?: string, sourceOverride?: string) {
    const p = prompt || await ui.input("Prompt");
    if (!p) return;

    const source = sourceOverride || await ui.input("Pi event source (e.g., tool_execution_start, before_agent_start)");
    if (!source) return;

    const trigger: Trigger = { type: "event", source };
    const taskBacklog = source === "tasks:created";
    const entry = getStore().create(trigger, p, {
      recurring: true,
      taskBacklog,
      maxFires: taskBacklog ? 25 : undefined,
    });
    getTriggerSystem().add(entry);
    getBindingsStore().add(entry.id);
    updateWidget();
    const bootstrapped = taskBacklog ? await maybeBootstrapTaskLoop?.(entry) : false;
    const adoption = taskBacklog
      ? `; adopts unfinished tasks${bootstrapped ? " (initial wake queued)" : ""}`
      : "";
    ui.notify(`Event loop #${entry.id} created: fires on "${source}"${adoption}`, "info");
  }

  function dynamicLoop(ui: ExtensionUIContext, goal: string) {
    const trigger: Trigger = { type: "dynamic" };
    const entry = getStore().create(trigger, goal, {
      recurring: true,
      maxFires: 20,
      dynamic: { goal, iteration: 0 },
    });
    getTriggerSystem().add(entry);
    getBindingsStore().add(entry.id);
    updateWidget();
    ui.notify(`Dynamic loop #${entry.id} created — ${goal.slice(0, 50)}`, "info");
    onDynamicLoopActivated?.(entry);
  }

  async function viewLoops(ui: ExtensionUIContext) {
    const loops = getStore().list();
    if (loops.length === 0) {
      await ui.select("No loops configured", ["< Back"]);
      return;
    }

    const choices = loops.map((l) => {
      const icon = l.status === "active" ? "*" : l.status === "paused" ? "-" : "x";
      return `${icon} #${l.id} [${l.status}] ${l.prompt.slice(0, 50)} (${formatTrigger(l.trigger, "command")})`;
    });
    choices.push("< Back");

    const selected = await ui.select("Loops", choices);
    if (!selected || selected === "< Back") return;

    const match = selected.match(/#(\d+)/);
    if (match?.[1]) {
      const entry = getStore().get(match[1]);
      if (entry) {
        const actions = ["Edit", "+ Promote to shared", "x Delete"];
        if (entry.status === "active") actions.splice(2, 0, "- Pause");
        else if (entry.status === "paused" && !isTerminalWorkflowRun(entry.workflow)) actions.splice(2, 0, "* Resume");
        actions.push("< Back");

        const action = await ui.select(
          `#${entry.id}: ${entry.prompt}\nTrigger: ${JSON.stringify(entry.trigger)}`,
          actions,
        );

        if (action === "Edit") {
          await editLoopInteractive(
            ui,
            getStore() as EditLoopStoreLike,
            getTriggerSystem() as EditTriggerSystemLike,
            entry,
            updateWidget,
          );
        } else if (action === "+ Promote to shared") {
          const cwd = process.cwd();
          const sharedStorePath = resolveLoopStorePath({ loopScope: "shared", cwd }) ?? "";
          getTriggerSystem().remove(entry.id);
          const result = getStore().promote(entry.id, sharedStorePath);
          if (result.ok) {
            getBindingsStore().remove(entry.id);
            updateWidget();
            ui.notify(`Loop #${entry.id} promoted to shared store`, "info");
          } else {
            ui.notify(result.error ?? "Promote failed", "error");
          }
        } else if (action === "x Delete") {
          if (entry.workflow?.activeTaskId) {
            ui.notify(`Workflow #${entry.id} has active task #${entry.workflow.activeTaskId}; claim the task first, then retry Delete from this menu.`, "warning");
            return viewLoops(ui);
          }
          getTriggerSystem().remove(entry.id);
          getBindingsStore().remove(entry.id);
          getStore().delete(entry.id);
          updateWidget();
          ui.notify(`Loop #${entry.id} deleted`, "info");
        } else if (action === "- Pause") {
          getStore().pause(entry.id);
          getTriggerSystem().remove(entry.id);
          updateWidget();
          ui.notify(`Loop #${entry.id} paused`, "info");
        } else if (action === "* Resume") {
          const resumed = getStore().resume(entry.id);
          if (!resumed) return viewLoops(ui);
          getTriggerSystem().add(resumed);
          getBindingsStore().add(entry.id);
          updateWidget();
          ui.notify(`Loop #${entry.id} resumed`, "info");
          if (resumed.trigger.type === "dynamic") onDynamicLoopActivated?.(resumed);
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
    description: "Create a loop. Use /loop [interval] [prompt] for scheduled loops, /loop event <source> <prompt> for event loops, or /loop <goal> for a dynamic goal loop.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;
      const route = parseLoopCommandRoute(args);

      if (route.type === "menu") {
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

      if (route.type === "event") return eventLoop(ui, route.prompt, route.source);
      if (route.type === "cron") return createCronLoop(ui, route.interval, route.prompt, route.notifyEvery);
      if (route.type === "invalid-cron") {
        ui.notify(`Invalid cron expression: ${route.interval}`, "error");
        return;
      }
      if (route.type === "missing-interval-prompt") {
        ui.notify("Provide a prompt after the interval, e.g., /loop 5m check the deploy", "warning");
        return;
      }
      return dynamicLoop(ui, route.goal);
    },
  });

  pi.registerCommand("loop-activate", {
    description: "Activate a stored loop in this session so it fires here. Usage: /loop-activate <id> (or no args for the picker)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const ui = ctx.ui;

      if (!trimmed) {
        const loops = getStore().list();
        if (loops.length === 0) {
          ui.notify("No stored loops to activate. Use /loop to create one first.", "info");
          return;
        }

        const pending = new Set(getBindingsStore().list());
        const formatRow = (l: LoopEntry) => {
          const bound = pending.has(l.id);
          const icon = bound ? "[x]" : "[ ]";
          const triggerDesc = l.trigger.type === "cron"
            ? `cron: ${l.trigger.schedule}`
            : l.trigger.type === "event"
              ? `event: ${l.trigger.source}`
              : l.trigger.type === "hybrid"
                ? `hybrid: ${l.trigger.cron}`
                : "dynamic";
          return `${icon} #${l.id} [${l.status}] ${l.prompt.slice(0, 50)} (${triggerDesc})`;
        };

        while (true) {
          const choices = loops.map(formatRow);
        choices.unshift("[ Select all ]");
          choices.push("< OK>", "< Cancel>");
          const selected = await ui.select("Arm loops for this session", choices);
          if (!selected || selected === "< Cancel>") return;

          if (selected === "[ Select all ]") {
            for (const l of loops) pending.add(l.id);
          } else if (selected === "< OK>") {
            const current = new Set(getBindingsStore().list());
            for (const id of pending) {
              if (!current.has(id)) {
                getBindingsStore().add(id);
                const loop = getStore().get(id);
                if (loop && loop.status === "active") {
                  getTriggerSystem().add(loop);
                }
              }
            }
            for (const id of current) {
              if (!pending.has(id)) {
                getBindingsStore().remove(id);
                getTriggerSystem().remove(id);
              }
            }
            const armed = pending.size;
            ui.notify(
              `${armed} loop${armed === 1 ? "" : "s"} bound to this session`,
              "info",
            );
            updateWidget();
            return;
          }

          const match = selected.match(/#(\d+)/);
          if (match) {
            const id = match[1];
            if (pending.has(id)) pending.delete(id);
            else pending.add(id);
          }
        }
      }

      const id = trimmed.split(/\s+/)[0];
      if (!id || !/^\d+$/.test(id)) {
        ui.notify(`Expected a numeric loop ID, got "${id}". Try /loop-activate <id>.`, "error");
        return;
      }
      const ok = await rearmLoop(ui, id);
      if (ok) getBindingsStore().add(id);
    },
  });

  async function rearmLoop(ui: ExtensionUIContext, id: string): Promise<boolean> {
    const before = getStore().get(id);
    if (!before) {
      ui.notify(`Loop #${id} not found in the store. Use /loop to create it first.`, "error");
      return false;
    }
    const entry = getStore().resume(id) ?? before;
    getTriggerSystem().add(entry);
    updateWidget();
    const transitioned = before.status !== entry.status;
    const tag = transitioned ? "resumed" : "re-armed";
    ui.notify(`Loop #${entry.id} ${tag} (status: ${entry.status})`, "info");
    return true;
  }
}
