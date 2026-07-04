import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/task-store.js";

describe("TaskStore dependency management", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("addBlocks: adds target to this task's blocks and to target's blockedBy (bidirectional)", () => {
    const a = store.create("a", "desc");
    const b = store.create("b", "desc");
    store.addBlocks(a.id, [b.id]);

    expect(store.get(a.id)!.blocks).toContain(b.id);
    expect(store.get(b.id)!.blockedBy).toContain(a.id);
  });

  it("addBlockedBy: adds blocker to this task's blockedBy and to blocker's blocks (bidirectional)", () => {
    const a = store.create("a", "desc");
    const b = store.create("b", "desc");
    store.addBlockedBy(b.id, [a.id]);

    expect(store.get(b.id)!.blockedBy).toContain(a.id);
    expect(store.get(a.id)!.blocks).toContain(b.id);
  });

  it("removeBlocks: removes target from this task's blocks and from target's blockedBy", () => {
    const a = store.create("a", "desc");
    const b = store.create("b", "desc");
    store.addBlocks(a.id, [b.id]);
    store.removeBlocks(a.id, [b.id]);

    expect(store.get(a.id)!.blocks).not.toContain(b.id);
    expect(store.get(b.id)!.blockedBy).not.toContain(a.id);
  });

  it("removeBlockedBy: removes blocker from this task's blockedBy and from blocker's blocks", () => {
    const a = store.create("a", "desc");
    const b = store.create("b", "desc");
    store.addBlockedBy(b.id, [a.id]);
    store.removeBlockedBy(b.id, [a.id]);

    expect(store.get(b.id)!.blockedBy).not.toContain(a.id);
    expect(store.get(a.id)!.blocks).not.toContain(b.id);
  });

  it("self-dependency: addBlocks returns selfDependency warning, no edge added", () => {
    const a = store.create("a", "desc");
    const result = store.addBlocks(a.id, [a.id]);

    expect(result.warnings.selfDependency).toBe(true);
    expect(store.get(a.id)!.blocks).not.toContain(a.id);
  });

  it("self-dependency: addBlockedBy returns selfDependency warning, no edge added", () => {
    const a = store.create("a", "desc");
    const result = store.addBlockedBy(a.id, [a.id]);

    expect(result.warnings.selfDependency).toBe(true);
    expect(store.get(a.id)!.blockedBy).not.toContain(a.id);
  });

  it("dangling reference: returns danglingReference warning, valid edges still added", () => {
    const a = store.create("a", "desc");
    const result = store.addBlocks(a.id, ["999"]);

    expect(result.warnings.danglingReference).toEqual(["999"]);
    expect(store.get(a.id)!.blocks).toHaveLength(0); // dangling not added
  });

  it("cycle detection: A→B then B→A is rejected with cycle warning", () => {
    const a = store.create("a", "desc");
    const b = store.create("b", "desc");
    store.addBlocks(a.id, [b.id]);

    const result = store.addBlocks(b.id, [a.id]); // B blocks A would cycle
    expect(result.warnings.cycle).toBe(true);
    // A still blocks B
    expect(store.get(a.id)!.blocks).toContain(b.id);
    // B does not block A
    expect(store.get(b.id)!.blocks).not.toContain(a.id);
  });

  it("transitive cycle detection: A→B→C then C→A is rejected", () => {
    const a = store.create("a", "desc");
    const b = store.create("b", "desc");
    const c = store.create("c", "desc");
    store.addBlocks(a.id, [b.id]);
    store.addBlocks(b.id, [c.id]);

    const result = store.addBlocks(c.id, [a.id]);
    expect(result.warnings.cycle).toBe(true);
    expect(store.get(c.id)!.blocks).not.toContain(a.id);
  });

  it("getWithDependencies: returns entry + open blockers (non-completed)", () => {
    const a = store.create("a", "desc");
    const b = store.create("b", "desc");
    const c = store.create("c", "desc");
    // a is blocked by b and c
    store.addBlockedBy(a.id, [b.id, c.id]);
    store.complete(b.id); // b is done — not an open blocker

    const { entry, openBlockers } = store.getWithDependencies(a.id);
    expect(entry?.id).toBe(a.id);
    expect(openBlockers).toHaveLength(1);
    expect(openBlockers[0].id).toBe(c.id);
  });

  it("delete cleans up dependency edges pointing to the deleted task", () => {
    const a = store.create("a", "desc");
    const b = store.create("b", "desc");
    store.addBlocks(a.id, [b.id]);
    store.delete(b.id);

    expect(store.get(a.id)!.blocks).not.toContain(b.id);
  });

  it("create: accepts activeForm, owner, agentType, metadata", () => {
    const t = store.create("task", "desc", { foo: "bar" }, {
      activeForm: "Working on it",
      owner: "agent-1",
      agentType: "general-purpose",
    });

    expect(t.activeForm).toBe("Working on it");
    expect(t.owner).toBe("agent-1");
    expect(t.agentType).toBe("general-purpose");
    expect(t.metadata).toEqual({ foo: "bar" });
    expect(t.blocks).toEqual([]);
    expect(t.blockedBy).toEqual([]);
  });

  it("updateDetails: updates activeForm, owner, agentType", () => {
    const t = store.create("task", "desc");
    store.updateDetails(t.id, {
      activeForm: "Running tests",
      owner: "agent-2",
    });

    expect(store.get(t.id)!.activeForm).toBe("Running tests");
    expect(store.get(t.id)!.owner).toBe("agent-2");
  });

  it("updateDetails: shallow-merges metadata, null deletes keys", () => {
    const t = store.create("task", "desc", { a: "1", b: "2" });
    store.updateDetails(t.id, { metadata: { b: null, c: "3" } });

    const meta = store.get(t.id)!.metadata;
    expect(meta.a).toBe("1");
    expect(meta.b).toBeUndefined();
    expect(meta.c).toBe("3");
  });
});

describe("TaskStore (in-memory)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("creates tasks with auto-incrementing IDs", () => {
    const t1 = store.create("one", "desc one");
    const t2 = store.create("two", "desc two");

    expect(t1.id).toBe("1");
    expect(t2.id).toBe("2");
    expect(t1.status).toBe("pending");
  });

  it("starts tasks explicitly", () => {
    store.create("task", "desc");
    const entry = store.start("1");

    expect(entry?.status).toBe("in_progress");
  });

  it("completes tasks explicitly and stamps completedAt", () => {
    store.create("task", "desc");
    store.start("1");
    const entry = store.complete("1");

    expect(entry?.status).toBe("completed");
    expect(typeof entry?.completedAt).toBe("number");
  });

  it("reopens tasks explicitly and preserves completedAt", () => {
    store.create("task", "desc");
    store.start("1");
    store.complete("1");
    const completedAt = store.get("1")?.completedAt;

    const entry = store.reopen("1");
    expect(entry?.status).toBe("pending");
    expect(entry?.completedAt).toBe(completedAt);
  });

  it("updates task details explicitly", () => {
    store.create("old", "old desc");
    const entry = store.updateDetails("1", { subject: "new", description: "new desc" });

    expect(entry?.subject).toBe("new");
    expect(entry?.description).toBe("new desc");
    expect(entry?.status).toBe("pending");
  });

  it("returns undefined for missing lifecycle/detail updates", () => {
    expect(store.start("999")).toBeUndefined();
    expect(store.complete("999")).toBeUndefined();
    expect(store.reopen("999")).toBeUndefined();
    expect(store.updateDetails("999", { subject: "missing" })).toBeUndefined();
  });

  it("prunes completed tasks only", () => {
    store.create("done", "d1");
    store.create("active", "d2");
    store.complete("1");
    store.start("2");

    expect(store.pruneCompleted()).toBe(1);
    expect(store.list()).toHaveLength(1);
    expect(store.get("1")).toBeUndefined();
    expect(store.get("2")?.status).toBe("in_progress");
  });
});

describe("TaskStore (file-backed)", () => {
  const testListId = `test-tasks-${Date.now()}`;
  const tasksDir = join(homedir(), ".pi", "tasks");
  const filePath = join(tasksDir, `${testListId}.json`);

  afterEach(() => {
    rmSync(filePath, { force: true });
    rmSync(filePath + ".lock", { force: true });
    rmSync(filePath + ".tmp", { force: true });
  });

  it("persists explicit lifecycle and detail updates", () => {
    const store1 = new TaskStore(testListId);
    store1.create("task", "desc");
    store1.start("1");
    store1.updateDetails("1", { subject: "updated" });

    const store2 = new TaskStore(testListId);
    expect(store2.get("1")?.status).toBe("in_progress");
    expect(store2.get("1")?.subject).toBe("updated");
  });

  it("refreshes reads only when the backing file changes", () => {
    const store1 = new TaskStore(testListId);
    const store2 = new TaskStore(testListId);

    store1.create("first", "desc");
    expect(store2.list()).toHaveLength(1);

    store1.create("second", "desc");
    expect(store2.list()).toHaveLength(2);
    expect(store2.get("2")?.subject).toBe("second");
  });

  it("preserves monotonic ids after prune", () => {
    const store1 = new TaskStore(testListId);
    store1.create("done", "desc");
    store1.complete("1");
    store1.pruneCompleted();

    const next = store1.create("next", "desc");
    expect(next.id).toBe("2");
  });
});
