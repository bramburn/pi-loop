import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "./task-store.js";
import type { TaskEntry } from "./task-types.js";
import type { TasksConfig } from "./tasks-config.js";
import { loadTasksConfig } from "./tasks-config.js";

export type AutoClearMode = "never" | "on_list_complete" | "on_task_complete";

export interface AutoClearOptions {
  pi: ExtensionAPI;
  cwd: string;
  getTaskStore: () => TaskStore | undefined;
  updateWidget: () => void;
  onTasksCleared?: (count: number) => void;
}

export function createAutoClearManager(options: AutoClearOptions) {
  const { pi, cwd, getTaskStore, updateWidget, onTasksCleared } = options;

  let config: TasksConfig;
  try {
    config = loadTasksConfig(cwd);
  } catch {
    config = { taskScope: "session", sortOrder: "id", maxVisible: 10, showAll: false, hiddenAt: "bottom", autoClearCompleted: "on_list_complete" };
  }

  // Idle-turn counter — increments on agent idle, resets on task completion
  let idleTurnsSinceCompletion = 0;
  let _lastCompletedIds = new Set<string>();
  let autoClearArmed = false;

  // Subscribe to agent idle to increment counter
  pi.events.on("agent_end", () => {
    idleTurnsSinceCompletion++;
    if (idleTurnsSinceCompletion >= 3 && autoClearArmed) {
      triggerAutoClear();
    }
  });

  // Subscribe to tasks:completed to arm/reset the counter
  pi.events.on("tasks:completed", (raw: unknown) => {
    const _payload = raw as { taskId?: string; task?: TaskEntry };
    if (config.autoClearCompleted === "never") return;

    if (config.autoClearCompleted === "on_task_complete") {
      // Clear immediately after a short delay (3 idle turns)
      idleTurnsSinceCompletion = 0;
      autoClearArmed = true;
    } else if (config.autoClearCompleted === "on_list_complete") {
      // Check if ALL tasks are now completed
      const taskStore = getTaskStore();
      if (!taskStore) return;
      const pending = taskStore.pendingCount();
      if (pending === 0) {
        idleTurnsSinceCompletion = 0;
        autoClearArmed = true;
      }
    }
  });

  function triggerAutoClear() {
    if (!autoClearArmed) return;
    autoClearArmed = false;
    idleTurnsSinceCompletion = 0;

    const taskStore = getTaskStore();
    if (!taskStore) return;

    const completed = taskStore.list().filter((t: TaskEntry) => t.status === "completed");
    if (completed.length === 0) return;

    const before = taskStore.list().length;
    for (const t of completed) taskStore.delete(t.id);
    const removed = before - taskStore.list().length;

    updateWidget();
    onTasksCleared?.(removed);
    pi.events.emit("tasks:auto_cleared", { count: removed });
  }

  return {
    reloadConfig() {
      try {
        config = loadTasksConfig(cwd);
      } catch {
        // keep current
      }
    },
  };
}
