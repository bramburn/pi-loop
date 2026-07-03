import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AutoClearMode, HiddenAt, SortOrder, TaskScope, TasksConfig } from "../tasks-config.js";
import { DEFAULT_TASKS_CONFIG } from "../tasks-config.js";

export interface SettingsMenuOptions {
  cwd: string;
  ui: ExtensionUIContext;
  onSave: (config: TasksConfig) => void;
  loadConfig?: (cwd: string) => TasksConfig;
  saveConfig?: (cwd: string, config: TasksConfig) => void;
}

type SettingKey = keyof TasksConfig;

const SCOPE_OPTIONS: TaskScope[] = ["memory", "session", "project"];
const SORT_OPTIONS: SortOrder[] = ["id", "status", "recent", "oldest"];
const AUTOCLEAR_OPTIONS: AutoClearMode[] = ["never", "on_list_complete", "on_task_complete"];
const HIDDENAT_OPTIONS: HiddenAt[] = ["top", "bottom"];

function formatValue(key: SettingKey, value: unknown): string {
  if (key === "taskScope") {
    const labels: Record<TaskScope, string> = {
      memory: "memory (lost on session end)",
      session: "session (isolated per terminal)",
      project: "project (shared across sessions)",
    };
    return labels[value as TaskScope] ?? String(value);
  }
  if (key === "sortOrder") {
    const labels: Record<SortOrder, string> = {
      id: "id (creation order)",
      status: "status (completed → active → pending)",
      recent: "recent (most recently updated)",
      oldest: "oldest (least recently updated)",
    };
    return labels[value as SortOrder] ?? String(value);
  }
  if (key === "autoClearCompleted") {
    const labels: Record<AutoClearMode, string> = {
      never: "never (keep until manually cleared)",
      on_list_complete: "on_list_complete (after all tasks done)",
      on_task_complete: "on_task_complete (per task, after idle turns)",
    };
    return labels[value as AutoClearMode] ?? String(value);
  }
  if (key === "hiddenAt") {
    return value === "top" ? "top (completed fold away)" : "bottom (completed at bottom)";
  }
  return String(value);
}

function settingLabel(key: SettingKey): string {
  const labels: Record<SettingKey, string> = {
    taskScope: "Task storage",
    sortOrder: "Widget sort order",
    maxVisible: "Max visible tasks",
    showAll: "Show all tasks",
    hiddenAt: "Overflow hidden at",
    autoClearCompleted: "Auto-clear completed",
  };
  return labels[key] ?? key;
}

function nextValue(key: SettingKey, current: unknown): unknown {
  if (key === "taskScope") {
    const opts = SCOPE_OPTIONS;
    return opts[(opts.indexOf(current as TaskScope) + 1) % opts.length];
  }
  if (key === "sortOrder") {
    const opts = SORT_OPTIONS;
    return opts[(opts.indexOf(current as SortOrder) + 1) % opts.length];
  }
  if (key === "autoClearCompleted") {
    const opts = AUTOCLEAR_OPTIONS;
    return opts[(opts.indexOf(current as AutoClearMode) + 1) % opts.length];
  }
  if (key === "hiddenAt") {
    const opts = HIDDENAT_OPTIONS;
    return opts[(opts.indexOf(current as HiddenAt) + 1) % opts.length];
  }
  if (key === "maxVisible") {
    const cur = current as number;
    const steps = [5, 10, 20, 50, 100];
    const idx = steps.indexOf(cur);
    return steps[(idx + 1) % steps.length];
  }
  if (key === "showAll") {
    return !(current as boolean);
  }
  return current;
}

export async function openSettingsMenu(options: SettingsMenuOptions): Promise<void> {
  const { cwd, ui, onSave, loadConfig, saveConfig } = options;
  const _loadConfig = loadConfig ?? loadTasksConfig;
  const _saveConfig = saveConfig ?? saveTasksConfig;

  let config: TasksConfig;
  try {
    config = _loadConfig(cwd);
  } catch {
    config = { ...DEFAULT_TASKS_CONFIG };
  }

  const KEYS: SettingKey[] = [
    "taskScope", "sortOrder", "maxVisible", "showAll", "hiddenAt", "autoClearCompleted",
  ];

  while (true) {
    const choices = KEYS.map((key) => {
      const current = (config as Record<string, unknown>)[key] as unknown;
      const value = formatValue(key, current);
      return `${settingLabel(key)}: ${value}`;
    });
    choices.push("< Back");

    const selected = await ui.select("Tasks › Settings", choices);
    if (!selected || selected === "< Back") break;

    const idx = choices.indexOf(selected);
    if (idx < 0 || idx >= KEYS.length) break;

    const key = KEYS[idx];
    const newValue = nextValue(key, (config as Record<string, unknown>)[key]);
    (config as Record<string, unknown>)[key] = newValue;

    // Save immediately
    _saveConfig(cwd, config);
    onSave(config);

    const pretty = formatValue(key, newValue);
    await ui.notify(`${settingLabel(key)} → ${pretty}`, "info");
  }
}
