import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveLoopStorePath } from "../runtime/scope.js";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type PiLoopSettings,
  saveSettings,
} from "../settings.js";
import { LoopStore } from "../store.js";

/**
 * Trigger system surface needed by the Shared loops sub-screen (promote
 * removes the source subscription before deleting the source entry; adopt
 * arms the local trigger after copying the entry). Mirrors the shape
 * consumed by `registerLoopTools` in `src/tools/loop-tools.ts`.
 */
export interface TriggerSystemLike {
  add(loop: { id: string; trigger: unknown; status: string }): void;
  remove(id: string): void;
}

/**
 * /loop-settings — open the unified settings TUI editor.
 *
 * Replaces the v1.x tasks-only settings menu (`src/ui/settings-menu.ts`).
 * Edits every field in `.pi/pi-loop-settings.json` and saves immediately.
 *
 * Adds a `Shared loops` sub-screen entry that lists project + shared loops
 * side-by-side with `Promote to shared` / `Adopt from shared` actions per
 * row (per Q2 = unified picker, resolved 2026-08-13).
 */
export interface SettingsCommandOptions {
  pi: ExtensionAPI;
  getCwd: () => string;
  /** Returns the project loop store. The sub-screen reads from it for promote. */
  getStore: () => LoopStore;
  /** Returns the trigger system. The sub-screen calls .remove() / .add() across the boundary. */
  getTriggerSystem: () => TriggerSystemLike;
  /** Optional override for tests. */
  load?: (cwd: string) => PiLoopSettings;
  save?: (cwd: string, settings: PiLoopSettings) => void;
}

type SettingKey = keyof PiLoopSettings;

const SCOPE_OPTIONS: PiLoopSettings["loopScope"][] = ["memory", "session", "project"];
const SORT_OPTIONS: PiLoopSettings["sortOrder"][] = ["id", "status", "recent", "oldest"];
const AUTOCLEAR_OPTIONS: PiLoopSettings["autoClear"][] = [
  "never",
  "on_list_complete",
  "on_task_complete",
];
const HIDDENAT_OPTIONS: PiLoopSettings["hiddenAt"][] = ["top", "bottom"];

const KEY_ORDER: SettingKey[] = [
  "loopScope",
  "taskScope",
  "debug",
  "autoClear",
  "sortOrder",
  "hiddenAt",
  "maxVisible",
  "showAll",
  "taskThreshold",
  "urgentFlushThresholds",
  "subAgent",
];

function formatValue(key: SettingKey, value: PiLoopSettings[SettingKey]): string {
  switch (key) {
    case "loopScope":
    case "taskScope":
      return value as string;
    case "sortOrder":
      return value as string;
    case "autoClear":
      return value as string;
    case "hiddenAt":
      return value === "top" ? "top (completed fold away)" : "bottom (completed at bottom)";
    case "debug":
    case "showAll":
      return value ? "true" : "false";
    case "maxVisible":
      return `${value}`;
    case "taskThreshold":
      return `${value}`;
    case "urgentFlushThresholds": {
      const t = value as PiLoopSettings["urgentFlushThresholds"];
      const fmt = (ms: number) =>
        ms >= 86_400_000 ? `${ms / 86_400_000}d`
        : ms >= 3_600_000 ? `${ms / 3_600_000}h`
        : ms >= 60_000 ? `${ms / 60_000}m`
        : `${ms / 1000}s`;
      return `defer:${fmt(t.defer)} normal:${fmt(t.normal)} urgent:${fmt(t.urgent)} critical:${fmt(t.critical)}`;
    }
    case "subAgent": {
      const v = value as PiLoopSettings["subAgent"];
      const cap = v?.activeIterationsMax ?? 4;
      const timeoutMin = Math.round((v?.defaultIterationTimeoutMs ?? 600_000) / 60_000);
      const iso = v?.defaultIsolation ?? "in-process";
      return `(edit JSON) iso=${iso} cap=${cap} timeout=${timeoutMin}m`;
    }
    default:
      return String(value);
  }
}

function settingLabel(key: SettingKey): string {
  const labels: Record<SettingKey, string> = {
    loopScope: "Loop storage",
    taskScope: "Task storage",
    debug: "Debug logging",
    autoClear: "Auto-clear completed",
    sortOrder: "Widget sort order",
    hiddenAt: "Overflow hidden at",
    maxVisible: "Max visible tasks",
    showAll: "Show all tasks",
    taskThreshold: "Backlog worker threshold",
    urgentFlushThresholds: "Priority aging thresholds",
    subAgent: "Sub-agent defaults",
  };
  return labels[key];
}

function nextValue(key: SettingKey, current: PiLoopSettings[SettingKey]): PiLoopSettings[SettingKey] {
  switch (key) {
    case "loopScope": {
      const idx = SCOPE_OPTIONS.indexOf(current as PiLoopSettings["loopScope"]);
      return SCOPE_OPTIONS[(idx + 1) % SCOPE_OPTIONS.length]!;
    }
    case "taskScope": {
      const idx = SCOPE_OPTIONS.indexOf(current as PiLoopSettings["taskScope"]);
      return SCOPE_OPTIONS[(idx + 1) % SCOPE_OPTIONS.length]!;
    }
    case "debug":
      return !current;
    case "autoClear": {
      const idx = AUTOCLEAR_OPTIONS.indexOf(current as PiLoopSettings["autoClear"]);
      return AUTOCLEAR_OPTIONS[(idx + 1) % AUTOCLEAR_OPTIONS.length]!;
    }
    case "sortOrder": {
      const idx = SORT_OPTIONS.indexOf(current as PiLoopSettings["sortOrder"]);
      return SORT_OPTIONS[(idx + 1) % SORT_OPTIONS.length]!;
    }
    case "hiddenAt": {
      const idx = HIDDENAT_OPTIONS.indexOf(current as PiLoopSettings["hiddenAt"]);
      return HIDDENAT_OPTIONS[(idx + 1) % HIDDENAT_OPTIONS.length]!;
    }
    case "maxVisible": {
      const steps = [5, 10, 20, 50, 100];
      const idx = steps.indexOf(current as number);
      return steps[(idx + 1) % steps.length]!;
    }
    case "showAll":
      return !current;
    case "taskThreshold": {
      const steps = [1, 3, 5, 10, 25];
      const idx = steps.indexOf(current as number);
      return steps[(idx + 1) % steps.length]!;
    }
    case "urgentFlushThresholds": {
      // Cycle the defer threshold; keep others
      const t = current as PiLoopSettings["urgentFlushThresholds"];
      const deferSteps = [3_600_000, 86_400_000, 604_800_000];
      const idx = deferSteps.indexOf(t.defer);
      return { ...t, defer: deferSteps[(idx + 1) % deferSteps.length]! };
    }
    case "subAgent": {
      // The subAgent block is configured via direct JSON editing. The
      // /loop-settings TUI shows a summary and the nextValue cycle is a
      // no-op (the user has to edit .pi/pi-loop-settings.json to change
      // individual subAgent fields).
      return current;
    }
    default:
      return current;
  }
}

export function registerSettingsCommand(options: SettingsCommandOptions): void {
  const { pi, getCwd, getStore, getTriggerSystem, load = loadSettings, save = saveSettings } = options;

  pi.registerCommand("loop-settings", {
    description: "Open the unified pi-loop settings TUI editor (loopScope, taskScope, debug, autoClear, sortOrder, hiddenAt, maxVisible, showAll, taskThreshold, urgentFlushThresholds). Also has a 'Shared loops' sub-screen for promoting/adopting cross-repo loops.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;
      let settings: PiLoopSettings;
      try {
        settings = load(getCwd());
      } catch {
        settings = { ...DEFAULT_SETTINGS };
      }

      while (true) {
        const choices = KEY_ORDER.map((key) => {
          const value = settings[key];
          return `${settingLabel(key)}: ${formatValue(key, value)}`;
        });
        choices.push("Shared loops: \u2192");
        choices.push("< Back");

        const selected = await ui.select("Settings", choices);
        if (!selected || selected === "< Back") return;
        if (selected === "Shared loops: \u2192") {
          await openSharedLoopsSubScreen(ui, getCwd, getStore, getTriggerSystem);
          continue;
        }

        const idx = choices.indexOf(selected);
        if (idx < 0 || idx >= KEY_ORDER.length) return;

        const key = KEY_ORDER[idx]!;
        const newValue = nextValue(key, settings[key]);
        settings = { ...settings, [key]: newValue };
        save(getCwd(), settings);
        ctx.ui.notify(`${settingLabel(key)} -> ${formatValue(key, newValue)}`, "info");
      }
    },
  });
}

/**
 * Shared loops sub-screen: list project + shared loops side-by-side with
 * `Promote to shared` / `Adopt from shared` actions per row. Per Q2 the
 * surface is a unified picker (no separate sub-screens).
 *
 * Promote is destructive per Q5: the source entry is removed from the
 * project store after the copy lands, and the source trigger is torn down
 * before the store mutation (matching the deletion ordering previously
 * encoded in the now-removed `LoopDelete` tool at `src/tools/loop-tools.ts`).
 *
 * Adopt is non-destructive: the shared entry is copied into the project
 * store, the local entry is armed via `triggerSystem.add()`, and the
 * shared entry remains (it's the source of truth).
 */
async function openSharedLoopsSubScreen(
  ui: ExtensionCommandContext["ui"],
  getCwd: () => string,
  getStore: () => LoopStore,
  getTriggerSystem: () => TriggerSystemLike,
): Promise<void> {
  const cwd = getCwd();
  const sharedStorePath = resolveLoopStorePath({ loopScope: "shared", cwd }) ?? "";
  const projectStore = getStore();
  const triggerSystem = getTriggerSystem();

  const projectLoops = projectStore.list();
  const sharedStore = new LoopStore(sharedStorePath);
  const sharedLoops = sharedStore.list();

  const projectHeader = `--- Project loops (${projectLoops.length}) ---`;
  const sharedHeader = `--- Shared loops (${sharedLoops.length}) ---`;

  const sections: string[] = [];
  if (projectLoops.length > 0) sections.push(projectHeader);
  for (const loop of projectLoops) {
    sections.push(`#${loop.id} ${truncateLoopPrompt(loop.prompt)} [${loop.status}]`);
  }
  if (sharedLoops.length > 0) sections.push(sharedHeader);
  for (const loop of sharedLoops) {
    sections.push(`#${loop.id} ${truncateLoopPrompt(loop.prompt)} [${loop.status}]`);
  }
  if (sections.length === 0) {
    sections.push("(no loops yet)");
  }
  sections.push("< Back");

  const selected = await ui.select("Shared loops", sections);
  if (!selected || selected === "< Back") return;

  const idMatch = selected.match(/^#(\d+)/);
  if (!idMatch) return;
  const id = idMatch[1]!;
  const isInProject = projectLoops.some((l) => l.id === id);
  const isInShared = sharedLoops.some((l) => l.id === id);

  if (isInProject && !isInShared) {
    const action = await ui.select(`Loop #${id} (project)`, ["Promote to shared", "< Cancel"]);
    if (action === "Promote to shared") {
      triggerSystem.remove(id);
      const result = projectStore.promote(id, sharedStorePath);
      if (result.ok) {
        ui.notify(`Loop #${id} promoted to shared store`, "info");
      } else {
        ui.notify(result.error ?? "Promote failed", "error");
      }
    }
  } else if (isInShared && !isInProject) {
    const action = await ui.select(`Loop #${id} (shared)`, ["Adopt from shared", "< Cancel"]);
    if (action === "Adopt from shared") {
      const sharedEntry = sharedStore.get(id);
      if (!sharedEntry) {
        ui.notify(`Loop #${id} not found in shared store`, "error");
        return;
      }
      const result = projectStore.adopt(sharedEntry);
      if (result.ok && result.entry) {
        const freshEntry = projectStore.get(id) ?? result.entry;
        triggerSystem.add(freshEntry);
        ui.notify(`Loop #${id} adopted from shared store`, "info");
      } else {
        ui.notify(result.error ?? "Adopt failed", "error");
      }
    }
  } else if (isInProject && isInShared) {
    ui.notify(`Loop #${id} exists in both project and shared stores; resolve the conflict manually`, "warning");
  }
}

function truncateLoopPrompt(s: string): string {
  return s.length <= 50 ? s : `${s.slice(0, 49)}\u2026`;
}
