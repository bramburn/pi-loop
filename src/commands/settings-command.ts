import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type PiLoopSettings,
  saveSettings,
} from "../settings.js";

/**
 * /loop-settings — open the unified settings TUI editor.
 *
 * Replaces the v1.x tasks-only settings menu (`src/ui/settings-menu.ts`).
 * Edits every field in `.pi/pi-loop-settings.json` and saves immediately.
 */
export interface SettingsCommandOptions {
  pi: ExtensionAPI;
  getCwd: () => string;
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
    default:
      return current;
  }
}

export function registerSettingsCommand(options: SettingsCommandOptions): void {
  const { pi, getCwd, load = loadSettings, save = saveSettings } = options;

  pi.registerCommand("loop-settings", {
    description: "Open the unified pi-loop settings TUI editor (loopScope, taskScope, debug, autoClear, sortOrder, hiddenAt, maxVisible, showAll, taskThreshold).",
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
        choices.push("< Back");

        const selected = await ui.select("Settings", choices);
        if (!selected || selected === "< Back") return;

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
