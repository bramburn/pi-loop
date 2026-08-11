import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, loadSettings, type PiLoopSettings } from "./settings.js";
import type { TaskStore } from "./task-store.js";
import type { TaskEntry } from "./task-types.js";

export type AutoClearMode = PiLoopSettings["autoClear"];

export interface AutoClearOptions {
  pi: ExtensionAPI;
  cwd: string;
  getTaskStore: () => TaskStore | undefined;
  updateWidget: () => void;
  onTasksCleared?: (count: number) => void;
}

export function createAutoClearManager(options: AutoClearOptions) {
  const { pi, cwd, getTaskStore, updateWidget, onTasksCleared } = options;

  let config: PiLoopSettings;
  try {
    config = loadSettings(cwd);
  } catch {
    config = { ...DEFAULT_SETTINGS };
  }

  let idleTurnsSinceCompletion = 0;
  let _lastCompletedIds = new Set<string>();
  let autoClearArmed = false;

  pi.events.on("agent_end", () => {
    idleTurnsSinceCompletion++;
    if (idleTurnsSinceCompletion >= 3 && autoClearArmed) {
      triggerAutoClear();
    }
  });

  pi.events.on("tasks:completed", (raw: unknown) => {
    const _payload = raw as { taskId?: string; task?: TaskEntry };
    if (config.autoClear === "never") return;

    if (config.autoClear === "on_task_complete") {
      idleTurnsSinceCompletion = 0;
      autoClearArmed = true;
    } else if (config.autoClear === "on_list_complete") {
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
        config = loadSettings(cwd);
      } catch {
        // keep current
      }
    },
  };
}
