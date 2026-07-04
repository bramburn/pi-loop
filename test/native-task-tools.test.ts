import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { type NativeTaskToolsOptions, registerNativeTaskTools } from "../src/tools/native-task-tools.js";
import { createMockPi } from "./helpers/mock-pi.js";

function setup(backlog: NativeTaskToolsOptions["evaluateTaskBacklog"] = vi.fn(async () => ({ created: false }))) {
  const { pi, toolMap, emittedEvents } = createMockPi();
  const taskStore = new TaskStore();
  registerNativeTaskTools({ pi, taskStore, evaluateTaskBacklog: backlog, updateWidget: vi.fn() });
  const tool = (name: string) => toolMap.get(name)!;
  const text = async (name: string, args: any) => (await tool(name).execute!("t", args)).content[0].text as string;
  return { taskStore, tool, text, emittedEvents };
}

describe("TaskCreate", () => {
  it("creates a task and emits tasks:created", async () => {
    const { taskStore, text, emittedEvents } = setup();
    const out = await text("TaskCreate", { subject: "Fix bug", description: "the details" });
    expect(out).toBe("Task #1 created: Fix bug");
    expect(taskStore.get("1")?.subject).toBe("Fix bug");
    expect(emittedEvents.some((e) => e.name === "tasks:created" && e.payload.taskId === "1")).toBe(true);
  });

  it("appends a backlog-worker note when one is created", async () => {
    const { text } = setup(vi.fn(async () => ({ created: true, entry: { id: "9" } })));
    const out = await text("TaskCreate", { subject: "x", description: "y" });
    expect(out).toContain("Backlog worker loop #9 created");
  });
});

describe("TaskList", () => {
  it("reports no tasks when empty", async () => {
    const { text } = setup();
    expect(await text("TaskList", {})).toBe("No tasks.");
  });

  it("summarizes status counts", async () => {
    const { taskStore, text } = setup();
    taskStore.create("a", "d");
    const t2 = taskStore.create("b", "d");
    taskStore.start(t2.id);
    const out = await text("TaskList", {});
    expect(out).toContain("2 tasks (1 pending, 1 in progress, 0 done)");
    expect(out).toContain("#1");
    expect(out).toContain("[in_progress]");
  });

  it("shows blockedBy dependency in list rows", async () => {
    const { taskStore, text } = setup();
    taskStore.create("a", "d");
    taskStore.create("b", "d");
    taskStore.addBlockedBy("1", ["2"]);
    const out = await text("TaskList", {});
    expect(out).toContain("[blocked by #2]");
  });

  it("sortOrder=id (default) sorts by id", async () => {
    const { taskStore, text } = setup();
    taskStore.create("z", "d");
    taskStore.create("a", "d");
    const out = await text("TaskList", { sortOrder: "id" });
    const idx1 = out.indexOf("#1");
    const idx2 = out.indexOf("#2");
    expect(idx1).toBeLessThan(idx2); // id order
  });

  it("sortOrder=status groups completed first", async () => {
    const { taskStore, text } = setup();
    taskStore.create("a", "d");
    taskStore.create("b", "d");
    taskStore.complete("1");
    const out = await text("TaskList", { sortOrder: "status" });
    const idx1 = out.indexOf("#1");
    const idx2 = out.indexOf("#2");
    expect(idx1).toBeLessThan(idx2); // completed first
  });

  it("sortOrder=recent puts newest first (distinct from id order)", async () => {
    const { taskStore, text } = setup();
    taskStore.create("a", "d"); // #1
    taskStore.create("b", "d"); // #2
    taskStore.complete("1"); // #1 updated more recently than #2
    const out = await text("TaskList", { sortOrder: "recent" });
    // #1 completed more recently → appears before #2
    expect(out.indexOf("#1")).toBeLessThan(out.indexOf("#2"));
  });

  it("TaskCreate accepts activeForm, owner, agentType, metadata", async () => {
    const { taskStore, text } = setup();
    const out = await text("TaskCreate", {
      subject: "Run tests",
      description: "Full test suite",
      activeForm: "Running tests",
      owner: "agent-1",
      agentType: "general-purpose",
      metadata: { priority: "high" },
    });
    expect(out).toContain("Task #1 created: Run tests");
    expect(taskStore.get("1")!.activeForm).toBe("Running tests");
    expect(taskStore.get("1")!.owner).toBe("agent-1");
    expect(taskStore.get("1")!.agentType).toBe("general-purpose");
    expect(taskStore.get("1")!.metadata).toEqual({ priority: "high" });
  });
});

describe("TaskGet", () => {
  it("returns not found for unknown id", async () => {
    const { text } = setup();
    expect(await text("TaskGet", { id: "99" })).toBe("Task #99 not found");
  });

  it("shows id, subject, status, description, timestamps", async () => {
    const { taskStore, text } = setup();
    const t = taskStore.create("Design the flux capacitor", "Build it in the DeLorean");
    const out = await text("TaskGet", { id: t.id });
    expect(out).toContain(`Task #${t.id}: Design the flux capacitor`);
    expect(out).toContain("Status: pending");
    expect(out).toContain("Build it in the DeLorean");
    expect(out).toContain("Created:");
    expect(out).toContain("Updated:");
  });

  it("shows owner and activeForm when set", async () => {
    const { taskStore, text } = setup();
    const t = taskStore.create("Run tests", "desc", {}, { owner: "agent-1", activeForm: "Running tests" });
    const out = await text("TaskGet", { id: t.id });
    expect(out).toContain("Owner: agent-1");
    expect(out).toContain("Active form: Running tests");
  });

  it("shows blocks and blockedBy dependency edges", async () => {
    const { taskStore, text } = setup();
    const a = taskStore.create("a", "desc");
    const b = taskStore.create("b", "desc");
    const c = taskStore.create("c", "desc");
    // a is blocked by b and c (b and c both block a)
    taskStore.addBlockedBy(a.id, [b.id, c.id]);
    // b blocks c (separate dependency chain)
    taskStore.addBlocks(b.id, [c.id]);
    const out = await text("TaskGet", { id: a.id });
    expect(out).toContain("Blocked by: #2, #3");
    // b.blocks = [#a, #c] (from both addBlockedBy(a,[b]) and addBlocks(b,[c]))
    const bOut = await text("TaskGet", { id: b.id });
    expect(bOut).toMatch(/Blocks: #1, #3/);
  });

  it("marks completed blockers as (completed) in blockedBy", async () => {
    const { taskStore, text } = setup();
    const a = taskStore.create("a", "desc");
    const b = taskStore.create("b", "desc");
    taskStore.addBlockedBy(a.id, [b.id]);
    taskStore.complete(b.id);
    const out = await text("TaskGet", { id: a.id });
    expect(out).toContain("#2 (completed)");
  });

  it("shows metadata as JSON", async () => {
    const { taskStore, text } = setup();
    const t = taskStore.create("t", "desc", { priority: "high", tags: ["bug", "auth"] });
    const out = await text("TaskGet", { id: t.id });
    expect(out).toContain('"priority": "high"');
    expect(out).toContain('"tags"');
    expect(out).toContain("Metadata:");
  });
});

describe("TaskUpdate", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
    h.taskStore.create("subject", "desc");
  });

  it("transitions status through the lifecycle and emits task events", async () => {
    expect(await h.text("TaskUpdate", { id: "1", status: "in_progress" })).toContain("→ in_progress");
    expect(h.taskStore.get("1")?.status).toBe("in_progress");
    expect(await h.text("TaskUpdate", { id: "1", status: "completed" })).toContain("→ completed");
    expect(h.taskStore.get("1")?.status).toBe("completed");
    expect(await h.text("TaskUpdate", { id: "1", status: "pending" })).toContain("→ pending");
    expect(h.taskStore.get("1")?.status).toBe("pending");

    expect(h.emittedEvents.some((e) => e.name === "tasks:started" && e.payload.taskId === "1")).toBe(true);
    expect(h.emittedEvents.some((e) => e.name === "tasks:completed" && e.payload.taskId === "1")).toBe(true);
    expect(h.emittedEvents.some((e) => e.name === "tasks:reopened" && e.payload.taskId === "1")).toBe(true);
  });

  it("updates subject/description and emits tasks:updated", async () => {
    await h.text("TaskUpdate", { id: "1", subject: "renamed" });
    expect(h.taskStore.get("1")?.subject).toBe("renamed");
    expect(h.emittedEvents.some((e) => e.name === "tasks:updated" && e.payload.taskId === "1")).toBe(true);
  });

  it("reports not found for an unknown id", async () => {
    expect(await h.text("TaskUpdate", { id: "99", status: "completed" })).toBe("Task #99 not found");
  });

  it("documents the taskId→id correction in its guidelines", () => {
    const guidelines = (h.tool("TaskUpdate") as any).promptGuidelines as string[];
    expect(guidelines.some((g) => g.includes("`id`, not `taskId`"))).toBe(true);
  });

  it("updates activeForm and owner", async () => {
    const { taskStore, text } = setup();
    const t = taskStore.create("task", "desc");
    const out = await text("TaskUpdate", {
      id: t.id, activeForm: "Running tests", owner: "agent-1",
    });
    expect(out).toContain("updated");
    expect(taskStore.get(t.id)!.activeForm).toBe("Running tests");
    expect(taskStore.get(t.id)!.owner).toBe("agent-1");
  });

  it("shallow-merges metadata; null deletes a key", async () => {
    const { taskStore, text } = setup();
    const t = taskStore.create("task", "desc", { a: "1", b: "2" });
    await text("TaskUpdate", { id: t.id, metadata: { b: null, c: "3" } });
    const meta = taskStore.get(t.id)!.metadata;
    expect(meta.a).toBe("1");
    expect(meta.b).toBeUndefined();
    expect(meta.c).toBe("3");
  });

  it("addBlocks: adds bidirectional edge and returns warning for dangling refs", async () => {
    const { taskStore, text } = setup();
    const a = taskStore.create("a", "desc");
    const b = taskStore.create("b", "desc");
    const out = await text("TaskUpdate", { id: a.id, addBlocks: [b.id, "999"] });
    expect(out).toContain("updated");
    expect(taskStore.get(a.id)!.blocks).toContain(b.id);
    expect(taskStore.get(b.id)!.blockedBy).toContain(a.id); // bidirectional
    expect(out).toContain("warning: non-existent tasks: #999");
  });

  it("addBlockedBy: adds bidirectional edge and returns warning for self-dep", async () => {
    const { taskStore, text } = setup();
    const a = taskStore.create("a", "desc");
    const b = taskStore.create("b", "desc");
    const out = await text("TaskUpdate", { id: a.id, addBlockedBy: [b.id, a.id] });
    expect(out).toContain("updated");
    expect(taskStore.get(a.id)!.blockedBy).toContain(b.id);
    expect(taskStore.get(b.id)!.blocks).toContain(a.id); // bidirectional
    expect(out).toContain("warning: self-dependency");
  });

  it("addBlocks: warns on cycle", async () => {
    const { taskStore, text } = setup();
    const a = taskStore.create("a", "desc");
    const b = taskStore.create("b", "desc");
    taskStore.addBlocks(a.id, [b.id]); // a blocks b
    const out = await text("TaskUpdate", { id: b.id, addBlocks: [a.id] }); // b blocks a = cycle
    expect(out).toContain("warning: cycle detected");
    expect(taskStore.get(b.id)!.blocks).not.toContain(a.id); // cycle edge not added
  });

  it("removeBlocks: removes the edge from both sides", async () => {
    const { taskStore, text } = setup();
    const a = taskStore.create("a", "desc");
    const b = taskStore.create("b", "desc");
    taskStore.addBlocks(a.id, [b.id]);
    await text("TaskUpdate", { id: a.id, removeBlocks: [b.id] });
    expect(taskStore.get(a.id)!.blocks).not.toContain(b.id);
    expect(taskStore.get(b.id)!.blockedBy).not.toContain(a.id);
  });
});

describe("TaskDelete", () => {
  it("deletes an existing task and emits tasks:deleted", async () => {
    const h = setup();
    h.taskStore.create("a", "d");
    expect(await h.text("TaskDelete", { id: "1" })).toBe("Task #1 deleted");
    expect(h.taskStore.get("1")).toBeUndefined();
    expect(h.emittedEvents.some((e) => e.name === "tasks:deleted" && e.payload.taskId === "1")).toBe(true);
  });

  it("reports not found for an unknown id", async () => {
    const h = setup();
    expect(await h.text("TaskDelete", { id: "5" })).toBe("Task #5 not found");
  });
});

describe("TaskPrune", () => {
  it("removes all completed tasks and reports the count", async () => {
    const h = setup();
    h.taskStore.create("a", "d");
    h.taskStore.create("b", "d");
    h.taskStore.create("c", "d");
    h.taskStore.start("2");
    h.taskStore.complete("2");
    h.taskStore.start("3");
    h.taskStore.complete("3");
    const out = await h.text("TaskPrune", {});
    expect(out).toMatch(/Pruned 2 completed task/);
    expect(h.taskStore.get("2")).toBeUndefined();
    expect(h.taskStore.get("3")).toBeUndefined();
    expect(h.taskStore.get("1")).toBeDefined();
  });

  it("reports zero when no completed tasks exist", async () => {
    const h = setup();
    h.taskStore.create("a", "d");
    const out = await h.text("TaskPrune", {});
    expect(out).toMatch(/Pruned 0 completed task/);
    expect(h.taskStore.get("1")).toBeDefined();
  });

  it("includes the reason in the result message", async () => {
    const h = setup();
    h.taskStore.create("a", "d");
    h.taskStore.complete("1");
    const out = await h.text("TaskPrune", { reason: "git_commit" });
    expect(out).toContain("reason: git_commit");
  });
});
