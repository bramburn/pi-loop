import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TaskScope = "memory" | "session" | "project";
export type SortOrder = "id" | "status" | "recent" | "oldest";
export type AutoClearMode = "never" | "on_list_complete" | "on_task_complete";
export type HiddenAt = "top" | "bottom";

export interface TasksConfig {
  taskScope: TaskScope;
  sortOrder: SortOrder;
  maxVisible: number;
  showAll: boolean;
  hiddenAt: HiddenAt;
  autoClearCompleted: AutoClearMode;
}

export const DEFAULT_TASKS_CONFIG: TasksConfig = {
  taskScope: "session",
  sortOrder: "id",
  maxVisible: 10,
  showAll: false,
  hiddenAt: "bottom",
  autoClearCompleted: "on_list_complete",
};

const CONFIG_DIR = ".pi";
const CONFIG_FILE = "tasks-config.json";

function resolveConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR, CONFIG_FILE);
}

export function loadTasksConfig(cwd: string): TasksConfig {
  const path = resolveConfigPath(cwd);
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TasksConfig>;
    return { ...DEFAULT_TASKS_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_TASKS_CONFIG };
  }
}

export function saveTasksConfig(cwd: string, config: TasksConfig): void {
  const dir = join(cwd, CONFIG_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, CONFIG_FILE);
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

export function updateTasksConfig(cwd: string, partial: Partial<TasksConfig>): TasksConfig {
  const current = loadTasksConfig(cwd);
  const next = { ...current, ...partial };
  saveTasksConfig(cwd, next);
  return next;
}
