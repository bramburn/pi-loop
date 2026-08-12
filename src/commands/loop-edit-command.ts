import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatTrigger } from "../loop-format.js";
import { isValidCronExpression, parseInterval } from "../loop-parse.js";
import { triggerEquals } from "../store.js";
import type { LoopEntry, LoopPriority, Trigger } from "../types.js";

const PRIORITY_OPTIONS: LoopPriority[] = ["defer", "normal", "urgent", "critical"];

interface LoopStoreLike {
  list(): LoopEntry[];
  get(id: string): LoopEntry | undefined;
  updateMetadata(id: string, fields: {
    trigger?: Trigger;
    prompt?: string;
    taskBacklog?: boolean;
    priority?: LoopPriority;
    recurring?: boolean;
    maxFires?: number;
    readOnly?: boolean;
    autoTask?: boolean;
  }): { entry: LoopEntry | undefined; changedFields: string[] };
  clearMaxFires(id: string): boolean;
}

interface TriggerSystemLike {
  add(entry: LoopEntry): void;
  remove(id: string): void;
}

export interface LoopEditCommandOptions {
  pi: ExtensionAPI;
  getStore: () => LoopStoreLike;
  getTriggerSystem: () => TriggerSystemLike;
  updateWidget: () => void;
}

interface EditableDraft {
  prompt: string;
  trigger: Trigger;
  priority: LoopPriority;
  recurring: boolean;
  maxFires: number | undefined;
  readOnly: boolean;
  autoTask: boolean;
}

function draftFromEntry(entry: LoopEntry): EditableDraft {
  return {
    prompt: entry.prompt,
    trigger: entry.trigger,
    priority: entry.priority ?? "normal",
    recurring: entry.recurring,
    maxFires: entry.maxFires,
    readOnly: entry.readOnly ?? false,
    autoTask: entry.autoTask ?? false,
  };
}

function entryFromDraft(draft: EditableDraft, entry: LoopEntry): Partial<LoopEntry> {
  const fields: Partial<LoopEntry> = {};
  if (draft.prompt !== entry.prompt) fields.prompt = draft.prompt;
  if (!triggerEquals(draft.trigger, entry.trigger)) fields.trigger = draft.trigger;
  if (draft.priority !== (entry.priority ?? "normal")) fields.priority = draft.priority;
  if (draft.recurring !== entry.recurring) fields.recurring = draft.recurring;
  if (draft.maxFires !== entry.maxFires) fields.maxFires = draft.maxFires;
  if (draft.readOnly !== (entry.readOnly ?? false)) fields.readOnly = draft.readOnly;
  if (draft.autoTask !== (entry.autoTask ?? false)) fields.autoTask = draft.autoTask;
  return fields;
}

function describeTrigger(trigger: Trigger): string {
  return formatTrigger(trigger, "command");
}

function summarizeDraft(draft: EditableDraft): string {
  const lines = [
    `prompt: ${truncate(draft.prompt, 60)}`,
    `trigger: ${describeTrigger(draft.trigger)}`,
    `priority: ${draft.priority}`,
    `recurring: ${draft.recurring}`,
    `maxFires: ${draft.maxFires ?? "(none)"}`,
    `readOnly: ${draft.readOnly}`,
    `autoTask: ${draft.autoTask}`,
  ];
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function parseTriggerInput(raw: string): Trigger | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const eventMatch = trimmed.match(/^event\s+(\S+)(?:\s+(.+))?$/i);
  if (eventMatch?.[1]) {
    const filter = eventMatch[2]?.trim();
    return { type: "event", source: eventMatch[1], filter: filter || undefined };
  }

  const cronMatch = trimmed.match(/^cron\s+(.+)$/i);
  if (cronMatch?.[1]) {
    const schedule = cronMatch[1].trim();
    if (!isValidCronExpression(schedule)) return null;
    return { type: "cron", schedule };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 5 && parts.every((p) => /^[\d*/,-]+$/.test(p))) {
    if (!isValidCronExpression(trimmed)) return null;
    return { type: "cron", schedule: trimmed };
  }

  try {
    const parsed = parseInterval(trimmed);
    return { type: "cron", schedule: parsed.cron };
  } catch {
    return null;
  }
}

async function editTrigger(
  ui: ExtensionCommandContext["ui"],
  current: Trigger,
): Promise<Trigger | undefined> {
  const currentDesc = describeTrigger(current);
  const raw = await ui.input(
    `Trigger (current: ${currentDesc})\nExamples: "5m", "1h", "0 9 * * 1-5", "event tool_execution_start"`,
  );
  if (raw === undefined || raw === null) return undefined;
  if (raw.trim() === "") return current;
  const parsed = parseTriggerInput(raw);
  if (!parsed) {
    ui.notify("Could not parse trigger. Use an interval (5m), cron (0 9 * * 1-5), or 'event <source>'.", "error");
    return undefined;
  }
  return parsed;
}

async function editPriority(
  ui: ExtensionCommandContext["ui"],
  current: LoopPriority,
): Promise<LoopPriority | undefined> {
  const choices = PRIORITY_OPTIONS.map((p) => `${p}${p === current ? " (current)" : ""}`);
  const choice = await ui.select("Priority", choices);
  if (!choice) return undefined;
  const idx = PRIORITY_OPTIONS.indexOf(choice.split(" ")[0] as LoopPriority);
  if (idx < 0) return undefined;
  return PRIORITY_OPTIONS[idx];
}

async function editMaxFires(
  ui: ExtensionCommandContext["ui"],
  current: number | undefined,
): Promise<number | undefined | null> {
  const raw = await ui.input(`maxFires (current: ${current ?? "(none)"})\nEnter a positive integer, or leave blank to clear.`);
  if (raw === undefined) return undefined;
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1 || String(n) !== trimmed) {
    ui.notify("maxFires must be a positive integer.", "error");
    return undefined;
  }
  return n;
}

async function pickLoop(
  ui: ExtensionCommandContext["ui"],
  store: LoopStoreLike,
): Promise<LoopEntry | undefined> {
  const all = store.list().filter((l) => l.status === "active" || l.status === "paused");
  if (all.length === 0) {
    await ui.select("No editable loops", ["< Back"]);
    return undefined;
  }
  const choices = all.map((l) => {
    const icon = l.status === "active" ? "*" : "-";
    return `${icon} #${l.id} [${l.status}] ${truncate(l.prompt, 50)} (${describeTrigger(l.trigger)})`;
  });
  choices.push("< Back");
  const choice = await ui.select("Edit loop", choices);
  if (!choice || choice === "< Back") return undefined;
  const match = choice.match(/#(\d+)/);
  if (!match?.[1]) return undefined;
  return store.get(match[1]);
}

export function registerLoopEditCommand(options: LoopEditCommandOptions): void {
  const { pi, getStore, getTriggerSystem, updateWidget } = options;

  pi.registerCommand("loop-edit", {
    description: "Pick a loop from a TUI list and edit its prompt, trigger, priority, recurring, maxFires, readOnly, or autoTask. Persists via LoopStore.updateMetadata and re-arms the trigger if needed.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;

      const entry = await pickLoop(ui, getStore());
      if (!entry) return;

      const draft: EditableDraft = draftFromEntry(entry);

      while (true) {
        const choices = [
          `prompt: ${truncate(draft.prompt, 40)}`,
          `trigger: ${truncate(describeTrigger(draft.trigger), 40)}`,
          `priority: ${draft.priority}`,
          `recurring: ${draft.recurring}`,
          `maxFires: ${draft.maxFires ?? "(none)"}`,
          `readOnly: ${draft.readOnly}`,
          `autoTask: ${draft.autoTask}`,
          "Save & Exit",
          "< Cancel",
        ];

        const choice = await ui.select(`Edit #${entry.id}\n${summarizeDraft(draft)}`, choices);
        if (!choice || choice === "< Cancel") {
          ui.notify("Edit cancelled", "info");
          return;
        }
        if (choice === "Save & Exit") break;

        if (choice.startsWith("prompt: ")) {
          const next = await ui.input(`Prompt (current: ${truncate(draft.prompt, 80)})`);
          if (next?.trim()) draft.prompt = next.trim();
        } else if (choice.startsWith("trigger: ")) {
          const next = await editTrigger(ui, draft.trigger);
          if (next) draft.trigger = next;
        } else if (choice.startsWith("priority: ")) {
          const next = await editPriority(ui, draft.priority);
          if (next) draft.priority = next;
        } else if (choice.startsWith("recurring: ")) {
          draft.recurring = !draft.recurring;
        } else if (choice.startsWith("maxFires: ")) {
          const next = await editMaxFires(ui, draft.maxFires);
          if (next === null) draft.maxFires = undefined;
          else if (next !== undefined) draft.maxFires = next;
        } else if (choice.startsWith("readOnly: ")) {
          draft.readOnly = !draft.readOnly;
        } else if (choice.startsWith("autoTask: ")) {
          draft.autoTask = !draft.autoTask;
        }
      }

      const fields = entryFromDraft(draft, entry);

      const result = getStore().updateMetadata(entry.id, fields);
      if (!result.entry) {
        ui.notify(`Loop #${entry.id} not found`, "error");
        return;
      }

      const wasMaxFiresCleared = draft.maxFires === undefined && entry.maxFires !== undefined;
      if (wasMaxFiresCleared) {
        const cleared = getStore().clearMaxFires(entry.id);
        if (cleared && !result.changedFields.includes("maxFires")) {
          result.changedFields.push("maxFires");
        }
      }

      const triggerChanged = result.changedFields.includes("trigger");
      if (triggerChanged && result.entry.status === "active") {
        try {
          getTriggerSystem().remove(result.entry.id);
          getTriggerSystem().add(result.entry);
        } catch {
          ui.notify(
            `Loop #${result.entry.id} saved, but the new trigger could not be activated. ` +
              `Pause and resume the loop to retry.`,
            "error",
          );
        }
      }

      updateWidget();
      ui.notify(
        `Loop #${result.entry.id} updated (${result.changedFields.join(", ") || "no changes"})`,
        "info",
      );
    },
  });
}