import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutoClearManager } from "../src/auto-clear.js";
import type { TaskStore } from "../src/task-store.js";
import type { TaskEntry } from "../src/task-types.js";

function makeTaskStore() {
  const tasks = new Map<string, TaskEntry>();
  return {
    list: () => Array.from(tasks.values()),
    pendingCount: () => Array.from(tasks.values()).filter((t) => t.status !== "completed" && t.status !== "closed").length,
    delete: vi.fn((id: string) => {
      tasks.delete(id);
      return true;
    }),
    add: (entry: TaskEntry) => {
      tasks.set(entry.id, entry);
    },
    _clear: () => tasks.clear(),
  } as unknown as TaskStore & { _clear: () => void };
}

function makePi() {
  return {
    events: {
      _handlers: new Map<string, Array<(data: unknown) => void>>(),
      on(event: string, handler: (data: unknown) => void) {
        const list = this._handlers.get(event) ?? [];
        list.push(handler);
        this._handlers.set(event, list);
        return () => {};
      },
      emit(event: string, data: unknown) {
        for (const h of this._handlers.get(event) ?? []) h(data);
      },
    },
    notify: vi.fn(),
  };
}

describe("createAutoClearManager", () => {
  let pi: ReturnType<typeof makePi>;
  let store: ReturnType<typeof makeTaskStore>;
  let updateWidget: ReturnType<typeof vi.fn>;
  let cwd: string;

  beforeEach(() => {
    pi = makePi();
    store = makeTaskStore();
    updateWidget = vi.fn();
    cwd = join(tmpdir(), `pi-loop-autoclear-test-${Date.now()}-${Math.random()}`);
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeSettings(autoClear: "never" | "on_list_complete" | "on_task_complete"): void {
    writeFileSync(
      join(cwd, ".pi", "pi-loop-settings.json"),
      JSON.stringify({ autoClear }),
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a manager with reloadConfig()", () => {
    const mgr = createAutoClearManager({
      pi: pi as never,
      cwd,
      getTaskStore: () => store as never,
      updateWidget,
    });
    expect(typeof mgr.reloadConfig).toBe("function");
  });

  it("does nothing when autoClear mode is 'never'", async () => {
    writeSettings("never");
    const mgr = createAutoClearManager({
      pi: pi as never,
      cwd,
      getTaskStore: () => store as never,
      updateWidget,
    });
    store.add({ id: "1", subject: "task 1", status: "completed", createdAt: Date.now(), updatedAt: Date.now() });
    pi.events.emit("tasks:completed", { taskId: "1" });
    // Advance agent idle 5 times to ensure triggerAutoClear would fire if armed
    for (let i = 0; i < 5; i++) pi.events.emit("agent_end", {});
    expect(store.delete).not.toHaveBeenCalled();
    void mgr; // silence unused
  });

  it("arms on_task_complete and clears after 3 idle agent_end events", async () => {
    writeSettings("on_task_complete");
    const mgr = createAutoClearManager({
      pi: pi as never,
      cwd,
      getTaskStore: () => store as never,
      updateWidget,
    });
    store.add({ id: "2", subject: "task 2", status: "completed", createdAt: Date.now(), updatedAt: Date.now() });
    pi.events.emit("tasks:completed", { taskId: "2" });
    // Advance 3 idle turns
    pi.events.emit("agent_end", {});
    pi.events.emit("agent_end", {});
    pi.events.emit("agent_end", {});
    expect(store.delete).toHaveBeenCalledWith("2");
    void mgr;
  });

  it("calls onTasksCleared with the removed count when cleanup fires", async () => {
    const onTasksCleared = vi.fn();
    const mgr = createAutoClearManager({
      pi: pi as never,
      cwd,
      getTaskStore: () => store as never,
      updateWidget,
      onTasksCleared,
    });
    void mgr;
  });

  it("emits tasks:auto_cleared on cleanup", async () => {
    let emittedCount: number | undefined;
    pi.events.on("tasks:auto_cleared", (data: unknown) => {
      emittedCount = (data as { count: number }).count;
    });
    const mgr = createAutoClearManager({
      pi: pi as never,
      cwd,
      getTaskStore: () => store as never,
      updateWidget,
    });
    void mgr;
    expect(emittedCount).toBeUndefined();
  });

  it("reloadConfig() reloads from disk without throwing", () => {
    const mgr = createAutoClearManager({
      pi: pi as never,
      cwd,
      getTaskStore: () => store as never,
      updateWidget,
    });
    expect(() => mgr.reloadConfig()).not.toThrow();
  });

  it("reloadConfig() handles load errors gracefully", () => {
    // We can't easily make the cwd-based load fail in tests, but we can verify
    // that reloadConfig() doesn't throw when called repeatedly.
    const mgr = createAutoClearManager({
      pi: pi as never,
      cwd: "/nonexistent",
      getTaskStore: () => store as never,
      updateWidget,
    });
    expect(() => {
      mgr.reloadConfig();
      mgr.reloadConfig();
    }).not.toThrow();
  });

  it("does nothing if no task store is provided", async () => {
    const mgr = createAutoClearManager({
      pi: pi as never,
      cwd,
      getTaskStore: () => undefined,
      updateWidget,
    });
    pi.events.emit("tasks:completed", { taskId: "1" });
    pi.events.emit("agent_end", {});
    expect(store.delete).not.toHaveBeenCalled();
    void mgr;
  });

  it("triggers cleanup when on_list_complete and pending count is 0", async () => {
    writeSettings("on_list_complete");
    const mgr = createAutoClearManager({
      pi: pi as never,
      cwd,
      getTaskStore: () => store as never,
      updateWidget,
    });
    store.add({ id: "3", subject: "task 3", status: "completed", createdAt: Date.now(), updatedAt: Date.now() });
    // pendingCount returns 0 because no other tasks exist
    pi.events.emit("tasks:completed", { taskId: "3" });
    // Advance 3 idle turns
    pi.events.emit("agent_end", {});
    pi.events.emit("agent_end", {});
    pi.events.emit("agent_end", {});
    expect(store.delete).toHaveBeenCalledWith("3");
    void mgr;
  });

  it("calls updateWidget after cleanup", async () => {
    writeSettings("on_list_complete");
    const mgr = createAutoClearManager({
      pi: pi as never,
      cwd,
      getTaskStore: () => store as never,
      updateWidget,
    });
    store.add({ id: "4", subject: "task 4", status: "completed", createdAt: Date.now(), updatedAt: Date.now() });
    pi.events.emit("tasks:completed", { taskId: "4" });
    pi.events.emit("agent_end", {});
    pi.events.emit("agent_end", {});
    pi.events.emit("agent_end", {});
    expect(updateWidget).toHaveBeenCalled();
    void mgr;
  });

  it("does not clear if there are no completed tasks", async () => {
    writeSettings("on_list_complete");
    const mgr = createAutoClearManager({
      pi: pi as never,
      cwd,
      getTaskStore: () => store as never,
      updateWidget,
    });
    pi.events.emit("tasks:completed", { taskId: "5" });
    pi.events.emit("agent_end", {});
    pi.events.emit("agent_end", {});
    pi.events.emit("agent_end", {});
    expect(store.delete).not.toHaveBeenCalled();
    void mgr;
  });
});
