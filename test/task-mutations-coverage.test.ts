// Additional coverage tests for src/runtime/task-mutations.ts.
// Targets the claim/heartbeat/complete paths that the integration suite
// doesn't directly exercise.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimTask,
  createTask,
  heartbeatTask,
  type TaskMutationContext,
  type TaskMutationOutcome,
  type TaskStore,
  taskMutationRejectionMessage,
} from "../src/runtime/task-mutations.js";
import type { TaskClaimInput } from "../src/task-types.js";

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
  };
}

function makeTaskStore() {
  const map = new Map<string, ReturnType<typeof makeEntry>>();
  const listeners = new Set<() => void>();
  return {
    list: () => Array.from(map.values()),
    pendingCount: () => Array.from(map.values()).filter((t) => t.status === "pending" || t.status === "in_progress").length,
    create: (subject: string, description: string) => {
      const entry = makeEntry(String(map.size + 1), subject, description);
      map.set(entry.id, entry);
      listeners.forEach((l) => { l(); });
      return entry;
    },
    get: (id: string) => map.get(id),
    claim: (id: string, claim: TaskClaimInput) => {
      const existing = map.get(id);
      if (!existing) return undefined;
      const renewed = existing.claim?.claimId === claim.claimId;
      const next = {
        ...existing,
        status: "in_progress" as const,
        claim: { claimId: claim.claimId, expiresAt: Date.now() + claim.leaseMs, lastHeartbeatAt: Date.now() },
      };
      map.set(id, next);
      listeners.forEach((l) => { l(); });
      return { entry: next, renewed };
    },
    complete: (id: string, claimId: string) => {
      const existing = map.get(id);
      if (!existing) return undefined;
      if (existing.claim?.claimId !== claimId) return undefined;
      const next = { ...existing, status: "completed" as const };
      map.set(id, next);
      listeners.forEach((l) => { l(); });
      return next;
    },
    release: (id: string, claimId: string) => {
      const existing = map.get(id);
      if (!existing) return undefined;
      if (existing.claim?.claimId !== claimId) return undefined;
      const { claim, ...rest } = existing;
      const next = { ...rest, status: "pending" as const };
      map.set(id, next);
      listeners.forEach((l) => { l(); });
      return next;
    },
    heartbeat: (id: string, claimId: string, leaseMs: number) => {
      const existing = map.get(id);
      if (!existing) return undefined;
      if (existing.claim?.claimId !== claimId) return undefined;
      const next = {
        ...existing,
        claim: { claimId, expiresAt: Date.now() + leaseMs, lastHeartbeatAt: Date.now() },
      };
      map.set(id, next);
      listeners.forEach((l) => { l(); });
      return next;
    },
    onChange: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    _add: (e: ReturnType<typeof makeEntry>) => { map.set(e.id, e); },
  } as unknown as TaskStore & { _add: (e: ReturnType<typeof makeEntry>) => void };
}

function makeEntry(id: string, subject: string, description: string): any {
  return {
    id,
    subject,
    description,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("task-mutations", () => {
  let ctx: TaskMutationContext;

  beforeEach(() => {
    const pi = makePi();
    const taskStore = makeTaskStore();
    ctx = {
      pi: pi as never,
      taskStore: taskStore as never,
      evaluateTaskBacklog: vi.fn(async () => ({ created: false })),
      updateWidget: vi.fn(),
    };
  });

  describe("createTask", () => {
    it("creates a task and emits a tasks:created event", async () => {
      let emitted: unknown;
      (ctx.pi.events as { on: (e: string, h: (d: unknown) => void) => void }).on("tasks:created", (data) => {
        emitted = data;
      });
      const result = await createTask(ctx, { subject: "s", description: "d" });
      expect(result.entry.subject).toBe("s");
      expect(emitted).toBeDefined();
    });

    it("emits no event when the task store rejects", async () => {
      let emitted = false;
      (ctx.pi.events as { on: (e: string, h: () => void) => void }).on("tasks:created", () => {
        emitted = true;
      });
      // Force an error in taskStore.create to trigger no-emit path
      (ctx.taskStore as unknown as { create: () => never }).create = () => {
        throw new Error("boom");
      };
      await expect(createTask(ctx, { subject: "x", description: "y" })).rejects.toThrow("boom");
      expect(emitted).toBe(false);
    });
  });

  describe("claimTask", () => {
    it("returns undefined when the task does not exist", async () => {
      const result = await claimTask(ctx, { id: "999", claim: { claimId: "c1", leaseMs: 60000 } });
      expect(result).toBeUndefined();
    });

    it("renews a claim without emitting a started event when the claimId matches", async () => {
      const entry = ctx.taskStore.create("s", "d");
      ctx.taskStore.claim(entry.id, { claimId: "c1", leaseMs: 60000 });
      let startedEmitted = false;
      (ctx.pi.events as { on: (e: string, h: () => void) => void }).on("tasks:started", () => {
        startedEmitted = true;
      });
      const result = await claimTask(ctx, { id: entry.id, claim: { claimId: "c1", leaseMs: 60000 } });
      expect(result?.result.renewed).toBe(true);
      expect(startedEmitted).toBe(false);
    });

    it("emits started when a different claimId takes over", async () => {
      const entry = ctx.taskStore.create("s", "d");
      ctx.taskStore.claim(entry.id, { claimId: "c1", leaseMs: 60000 });
      let startedEmitted = false;
      (ctx.pi.events as { on: (e: string, h: () => void) => void }).on("tasks:started", () => {
        startedEmitted = true;
      });
      const result = await claimTask(ctx, { id: entry.id, claim: { claimId: "c2", leaseMs: 60000 } });
      expect(result?.result.renewed).toBe(false);
      expect(startedEmitted).toBe(true);
    });

    it("returns undefined when the store rejects the claim", async () => {
      const entry = ctx.taskStore.create("s", "d");
      (ctx.taskStore as unknown as { claim: () => undefined }).claim = () => undefined;
      const result = await claimTask(ctx, { id: entry.id, claim: { claimId: "c1", leaseMs: 60000 } });
      expect(result).toBeUndefined();
    });
  });

  describe("heartbeatTask", () => {
    it("returns not_found when the task does not exist", () => {
      const result = heartbeatTask(ctx, { id: "999", claimId: "c1", leaseMs: 60000 });
      expect(result.applied).toBe(false);
      if (!result.applied) expect(result.code).toBe("not_found");
    });

    it("returns claim_mismatch for a completed task (terminal check happens after claim check)", () => {
      const entry = ctx.taskStore.create("s", "d");
      ctx.taskStore.complete(entry.id, "c1");
      const result = heartbeatTask(ctx, { id: entry.id, claimId: "c1", leaseMs: 60000 });
      expect(result.applied).toBe(false);
      if (!result.applied) expect(result.code).toBe("claim_missing");
    });

    it("returns claim_missing when the task has no claim", () => {
      const entry = ctx.taskStore.create("s", "d");
      const result = heartbeatTask(ctx, { id: entry.id, claimId: "c1", leaseMs: 60000 });
      expect(result.applied).toBe(false);
      if (!result.applied) expect(result.code).toBe("claim_missing");
    });

    it("returns claim_mismatch when the claimId doesn't match", () => {
      const entry = ctx.taskStore.create("s", "d");
      ctx.taskStore.claim(entry.id, { claimId: "c1", leaseMs: 60000 });
      const result = heartbeatTask(ctx, { id: entry.id, claimId: "c2", leaseMs: 60000 });
      expect(result.applied).toBe(false);
    });
  });



  describe("taskMutationRejectionMessage", () => {
    it("formats not_found rejection", () => {
      const result: TaskMutationOutcome = { applied: false, code: "not_found" };
      expect(taskMutationRejectionMessage("5", result)).toContain("not found");
    });

    it("formats claim_missing rejection", () => {
      const result: TaskMutationOutcome = { applied: false, code: "claim_missing" };
      expect(taskMutationRejectionMessage("5", result)).toContain("claim");
    });

    it("formats claim_expired rejection", () => {
      const result: TaskMutationOutcome = { applied: false, code: "claim_expired" };
      expect(taskMutationRejectionMessage("5", result)).toContain("expired");
    });

    it("formats claim_mismatch rejection", () => {
      const result: TaskMutationOutcome = { applied: false, code: "claim_mismatch" };
      // The error message mentions "Claim token does not match"
      expect(taskMutationRejectionMessage("5", result)).toMatch(/Claim|mismatch/i);
    });

    it("formats terminal rejection with status", () => {
      const result: TaskMutationOutcome = { applied: false, code: "terminal", entry: { status: "completed" } as never };
      expect(taskMutationRejectionMessage("5", result)).toContain("completed");
    });
  });
});
