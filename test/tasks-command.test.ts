import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTasksCommand } from "../src/commands/tasks-command.js";
import type { TaskStore } from "../src/task-store.js";
import type { TaskEntry } from "../src/task-types.js";

function makeTask(id: string, status: "pending" | "in_progress" | "completed" | "closed", subject = `task ${id}`): TaskEntry {
  return { id, subject, status, createdAt: Date.now(), updatedAt: Date.now() };
}

interface UiMock {
  select: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
}

function makeUi(): UiMock {
  return {
    select: vi.fn(),
    input: vi.fn(),
    notify: vi.fn(),
    confirm: vi.fn(async () => false),
  };
}

function makeTaskStore(tasks: TaskEntry[] = []) {
  const map = new Map<string, TaskEntry>();
  for (const t of tasks) map.set(t.id, { ...t });
  const listeners = new Set<() => void>();
  return {
    list: () => Array.from(map.values()),
    pendingCount: () => Array.from(map.values()).filter((t) => t.status === "pending" || t.status === "in_progress").length,
    create: vi.fn((subject: string, description: string) => {
      const entry: TaskEntry = {
        id: String(map.size + 1),
        subject,
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        description,
      } as TaskEntry;
      map.set(entry.id, entry);
      listeners.forEach((l) => l());
      return entry;
    }),
    get: vi.fn((id: string) => map.get(id)),
    start: vi.fn((id: string) => {
      const t = map.get(id);
      if (!t) return undefined;
      const next = { ...t, status: "in_progress" as const };
      map.set(id, next);
      listeners.forEach((l) => l());
      return next;
    }),
    complete: vi.fn((id: string) => {
      const t = map.get(id);
      if (!t) return undefined;
      const next = { ...t, status: "completed" as const };
      map.set(id, next);
      listeners.forEach((l) => l());
      return next;
    }),
    close: vi.fn((id: string) => {
      const t = map.get(id);
      if (!t) return undefined;
      const next = { ...t, status: "closed" as const };
      map.set(id, next);
      listeners.forEach((l) => l());
      return next;
    }),
    reopen: vi.fn((id: string) => {
      const t = map.get(id);
      if (!t) return undefined;
      const next = { ...t, status: "pending" as const };
      map.set(id, next);
      listeners.forEach((l) => l());
      return next;
    }),
    delete: vi.fn((id: string) => {
      const existed = map.delete(id);
      listeners.forEach((l) => l());
      return existed;
    }),
    onChange: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as TaskStore;
}

describe("registerTasksCommand (/tasks)", () => {
  let ui: UiMock;
  let pi: { registerCommand: ReturnType<typeof vi.fn>; events: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> } };
  let commandHandler: ((args: string, ctx: { ui: UiMock }) => Promise<void>) | undefined;
  let taskStore: ReturnType<typeof makeTaskStore>;
  let updateWidget: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ui = makeUi();
    const handlers = new Map<string, Array<(data: unknown) => void>>();
    pi = {
      registerCommand: vi.fn((name: string, def: { description: string; handler: (args: string, ctx: { ui: UiMock }) => Promise<void> }) => {
        if (name === "tasks") commandHandler = def.handler;
      }),
      events: {
        on: vi.fn((event: string, handler: (data: unknown) => void) => {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
          return () => {};
        }),
        emit: vi.fn((event: string, data: unknown) => {
          for (const h of handlers.get(event) ?? []) h(data);
        }),
      },
    };
    taskStore = makeTaskStore();
    updateWidget = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    commandHandler = undefined;
  });

  function register(): void {
    registerTasksCommand({
      pi: pi as never,
      getNativeTaskStore: () => taskStore as never,
      evaluateTaskBacklog: vi.fn(async () => ({ created: false })),
      updateWidget,
    });
  }

  it("registers the tasks command with a description", () => {
    register();
    expect(pi.registerCommand).toHaveBeenCalledWith("tasks", expect.objectContaining({
      description: expect.any(String),
      handler: expect.any(Function),
    }));
  });

  it("short-circuits when no native task store is available (pi-tasks active)", async () => {
    registerTasksCommand({
      pi: pi as never,
      getNativeTaskStore: () => undefined,
      evaluateTaskBacklog: vi.fn(async () => ({ created: false })),
      updateWidget,
    });
    // Re-register to capture the handler with undefined store
    commandHandler = undefined;
    const handlers = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls;
    // Find the last tasks registration
    for (const call of handlers) {
      if (call[0] === "tasks") {
        commandHandler = (call[1] as { handler: typeof commandHandler }).handler ?? undefined;
      }
    }
    if (!commandHandler) throw new Error("handler not registered");
    await commandHandler("", { ui });
    expect(ui.notify).toHaveBeenCalledWith("Native tasks are unavailable while pi-tasks is active", "warning");
  });

  it("creates a task when /tasks <subject> is passed", async () => {
    register();
    if (!commandHandler) throw new Error("no handler");
    await commandHandler("write tests for the widget", { ui });
    expect(taskStore.create).toHaveBeenCalledWith("write tests for the widget", "write tests for the widget");
    expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Task #\d+ created/), "info");
  });

  it("uses description = subject when /tasks <subject> is passed (description arg)", async () => {
    register();
    if (!commandHandler) throw new Error("no handler");
    await commandHandler("specific subject", { ui });
    expect(taskStore.create).toHaveBeenCalledWith("specific subject", "specific subject");
  });

  it("truncates long subjects to 80 chars", async () => {
    register();
    if (!commandHandler) throw new Error("no handler");
    const longSubject = "a".repeat(200);
    await commandHandler(longSubject, { ui });
    const call = (taskStore.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0].length).toBe(80);
    expect(call[1]).toBe(longSubject); // full description preserved
  });

  it("opens the interactive task viewer when /tasks has no args", async () => {
    taskStore = makeTaskStore([makeTask("1", "pending")]);
    register();
    if (!commandHandler) throw new Error("no handler");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    expect(ui.select).toHaveBeenCalledWith("Tasks", expect.arrayContaining(["+ Create task", "< Back"]));
  });

  it("shows empty viewer when no tasks exist", async () => {
    taskStore = makeTaskStore([]);
    register();
    if (!commandHandler) throw new Error("no handler");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    const call = (ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toContain("+ Create task");
    expect(call[1]).toContain("< Back");
  });

  it("creates a new task when user picks '+ Create task' from the menu", async () => {
    register();
    if (!commandHandler) throw new Error("no handler");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("+ Create task");
    (ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("new task");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    expect(ui.input).toHaveBeenCalledWith("Task subject");
    expect(taskStore.create).toHaveBeenCalledWith("new task", "new task");
  });

  it("uses default description (= subject) when user provides empty description", async () => {
    register();
    if (!commandHandler) throw new Error("no handler");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("+ Create task");
    (ui.input as ReturnType<typeof vi.fn>).mockImplementation(async (label: string) => {
      if (label === "Task subject") return "another task";
      return ""; // empty description
    });
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    expect(taskStore.create).toHaveBeenCalledWith("another task", "another task");
  });

  it("returns to the viewer when '+ Create task' is cancelled (no subject)", async () => {
    register();
    if (!commandHandler) throw new Error("no handler");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("+ Create task");
    (ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined); // user cancelled
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    expect(taskStore.create).not.toHaveBeenCalled();
  });

  it("notifies when backlog worker loop is created", async () => {
    registerTasksCommand({
      pi: pi as never,
      getNativeTaskStore: () => taskStore as never,
      evaluateTaskBacklog: vi.fn(async () => ({ created: true, entry: { id: "99" } })),
      updateWidget,
    });
    if (!commandHandler) throw new Error("no handler");
    await commandHandler("new task", { ui });
    expect(ui.notify).toHaveBeenCalledWith("Backlog worker loop #99 created", "info");
  });

  it("renders task rows in the viewer with status icons", async () => {
    taskStore = makeTaskStore([
      makeTask("1", "pending"),
      makeTask("2", "in_progress"),
      makeTask("3", "completed"),
      makeTask("4", "closed"),
    ]);
    register();
    if (!commandHandler) throw new Error("no handler");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    const options = (ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(options.some((o) => o.includes("#1") && o.includes("[pending]"))).toBe(true);
    expect(options.some((o) => o.includes("#2") && o.includes("[in_progress]"))).toBe(true);
    expect(options.some((o) => o.includes("#3") && o.includes("[completed]"))).toBe(true);
    expect(options.some((o) => o.includes("#4") && o.includes("[closed]"))).toBe(true);
  });

  it("shows pending task actions (Start, Complete, Close)", async () => {
    taskStore = makeTaskStore([makeTask("1", "pending")]);
    register();
    if (!commandHandler) throw new Error("no handler");
    // First call: select the task row
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("> #1 [pending] task 1");
    // Second call: action menu
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    const secondCall = (ui.select as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[1]).toContain("> Start");
    expect(secondCall[1]).toContain("ok Complete");
    expect(secondCall[1]).toContain("x Close without completing");
  });

  it("starts a pending task", async () => {
    taskStore = makeTaskStore([makeTask("1", "pending")]);
    register();
    if (!commandHandler) throw new Error("no handler");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("> #1 [pending] task 1");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("> Start");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    expect(taskStore.start).toHaveBeenCalledWith("1");
    expect(updateWidget).toHaveBeenCalled();
  });

  it("completes a task", async () => {
    taskStore = makeTaskStore([makeTask("1", "in_progress")]);
    register();
    if (!commandHandler) throw new Error("no handler");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("> #1 [in_progress] task 1");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("ok Complete");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    expect(taskStore.complete).toHaveBeenCalledWith("1", undefined);
  });

  it("closes a task without completing", async () => {
    taskStore = makeTaskStore([makeTask("1", "in_progress")]);
    register();
    if (!commandHandler) throw new Error("no handler");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("> #1 [in_progress] task 1");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("x Close without completing");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    expect(taskStore.close).toHaveBeenCalledWith("1", undefined);
  });

  it("deletes a task", async () => {
    taskStore = makeTaskStore([makeTask("1", "pending")]);
    register();
    if (!commandHandler) throw new Error("no handler");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("> #1 [pending] task 1");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("x Delete");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    expect(taskStore.delete).toHaveBeenCalledWith("1", undefined);
  });

  it("reopens a closed task", async () => {
    taskStore = makeTaskStore([makeTask("1", "closed")]);
    register();
    if (!commandHandler) throw new Error("no handler");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("> #1 [closed] task 1");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("* Reopen");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    expect(taskStore.reopen).toHaveBeenCalledWith("1");
  });

  it("notifies warning when an operation is rejected (returns undefined from store)", async () => {
    taskStore = makeTaskStore([makeTask("1", "pending")]);
    (taskStore.start as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    register();
    if (!commandHandler) throw new Error("no handler");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("> #1 [pending] task 1");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("> Start");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await commandHandler("", { ui });
    expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/unchanged: operation rejected/), "warning");
  });
});
