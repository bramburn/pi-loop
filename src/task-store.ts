import { homedir } from "node:os";
import { join } from "node:path";
import { ReducerBackedStore } from "./reducer-backed-store.js";
import { reduceTaskState, type TaskReducerEvent, type TaskReducerState } from "./task-reducer.js";
import type { TaskEntry, TaskStoreData } from "./task-types.js";

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const MAX_TASKS = 200;

export interface TaskWarnings {
  selfDependency?: boolean;
  danglingReference?: string[];
  cycle?: boolean;
}

export class TaskStore extends ReducerBackedStore<TaskEntry, TaskReducerState, TaskReducerEvent, TaskStoreData> {
  constructor(listIdOrPath?: string) {
    super(
      {
        baseDir: TASKS_DIR,
        reduce: (state, event) => reduceTaskState(state, event),
        toReducerState: (nextId, entries) => ({ nextId, tasksById: Object.fromEntries(entries.entries()) }),
        fromReducerState: (state) => ({ nextId: state.nextId, entries: new Map(Object.entries(state.tasksById)) }),
        serialize: (nextId, entries) => ({ nextId, tasks: Array.from(entries.values()) }),
        deserialize: (data) => ({ nextId: data.nextId, entries: new Map(data.tasks.map((t) => [t.id, t])) }),
      },
      listIdOrPath,
    );
  }

  create(
    subject: string,
    description: string,
    metadata?: Record<string, unknown>,
    extra?: { activeForm?: string; owner?: string; agentType?: string },
  ): TaskEntry {
    return this.withLock(() => {
      if (this.entries.size >= MAX_TASKS) {
        throw new Error(`Maximum of ${MAX_TASKS} tasks reached. Delete some before creating new ones.`);
      }
      const now = Date.now();
      this.applyReducerEvent({
        type: "TASK_CREATED",
        at: now,
        source: "tool",
        entityType: "task",
        payload: { subject, description, metadata, ...extra },
      });
      return this.entries.get(String(this.nextId - 1))!;
    });
  }

  start(id: string): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      this.applyReducerEvent({
        type: "TASK_STARTED",
        at: Date.now(),
        source: "tool",
        entityType: "task",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  complete(id: string): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      this.applyReducerEvent({
        type: "TASK_COMPLETED",
        at: Date.now(),
        source: "tool",
        entityType: "task",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  reopen(id: string): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      this.applyReducerEvent({
        type: "TASK_REOPENED",
        at: Date.now(),
        source: "tool",
        entityType: "task",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  updateDetails(
    id: string,
    fields: {
      subject?: string;
      description?: string;
      activeForm?: string;
      owner?: string;
      agentType?: string;
      metadata?: Record<string, unknown>;
    },
  ): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      if (
        fields.subject === undefined &&
        fields.description === undefined &&
        fields.activeForm === undefined &&
        fields.owner === undefined &&
        fields.agentType === undefined &&
        fields.metadata === undefined
      ) {
        return entry;
      }
      this.applyReducerEvent({
        type: "TASK_UPDATED",
        at: Date.now(),
        source: "tool",
        entityType: "task",
        entityId: id,
        payload: { id, ...fields },
      });
      return this.entries.get(id);
    });
  }

  /**
   * Add blocking relationships: this task blocks `targetIds`.
   * Bidirectional: adds targetId to this task's blocks AND targetId's blockedBy.
   * Returns warnings for cycles, self-dependency, or dangling references.
   */
  addBlocks(id: string, targetIds: string[]): { entry: TaskEntry | undefined; warnings: TaskWarnings } {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return { entry: undefined, warnings: {} };

      const dangling: string[] = [];
      let hasSelfDep = false;
      for (const tid of targetIds) {
        if (tid === id) hasSelfDep = true;
        else if (!this.entries.has(tid)) dangling.push(tid);
      }

      // Filter valid targets (not dangling, not self)
      const validIds = targetIds.filter((t) => t !== id && !dangling.includes(t));
      const validAndNoCycle = validIds.filter((tid) => !this._wouldCreateCycle(id, tid));

      const now = Date.now();

      // Apply valid, non-cycling edges
      if (validAndNoCycle.length > 0) {
        // A.blocks ← targetIds
        this.applyReducerEvent({
          type: "TASK_UPDATED", at: now, source: "tool", entityType: "task", entityId: id,
          payload: { id, addBlocks: validAndNoCycle },
        });
        // For each target: target.blockedBy ← id
        for (const tid of validAndNoCycle) {
          this.applyReducerEvent({
            type: "TASK_UPDATED", at: now, source: "tool", entityType: "task", entityId: tid,
            payload: { id: tid, addBlockedBy: [id] },
          });
        }
      }

      const _hasWarnings = dangling.length > 0 || hasSelfDep || validAndNoCycle.length < validIds.length;
      return {
        entry: this.entries.get(id),
        warnings: {
          ...(hasSelfDep ? { selfDependency: true } : {}),
          ...(dangling.length > 0 ? { danglingReference: dangling } : {}),
          ...(validAndNoCycle.length < validIds.length ? { cycle: true } : {}),
        },
      };
    });
  }

  /**
   * Remove blocking relationships: this task no longer blocks `targetIds`.
   */
  removeBlocks(id: string, targetIds: string[]): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      const now = Date.now();
      // Remove from this task's blocks
      this.applyReducerEvent({
        type: "TASK_UPDATED", at: now, source: "tool", entityType: "task", entityId: id,
        payload: { id, removeBlocks: targetIds },
      });
      // Remove from each target's blockedBy
      for (const tid of targetIds) {
        this.applyReducerEvent({
          type: "TASK_UPDATED", at: now, source: "tool", entityType: "task", entityId: tid,
          payload: { id: tid, removeBlockedBy: [id] },
        });
      }
      return this.entries.get(id);
    });
  }

  /**
   * Add blocked-by relationships: this task is blocked by `blockerIds`.
   * Bidirectional: adds blockerId to this task's blockedBy AND blockerId's blocks.
   * Returns warnings for cycles, self-dependency, or dangling references.
   */
  addBlockedBy(id: string, blockerIds: string[]): { entry: TaskEntry | undefined; warnings: TaskWarnings } {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return { entry: undefined, warnings: {} };

      const dangling: string[] = [];
      let hasSelfDep = false;
      for (const tid of blockerIds) {
        if (tid === id) hasSelfDep = true;
        else if (!this.entries.has(tid)) dangling.push(tid);
      }

      const validIds = blockerIds.filter((t) => t !== id && !dangling.includes(t));
      const validAndNoCycle = validIds.filter((tid) => !this._wouldCreateCycle(tid, id));

      const now = Date.now();

      if (validAndNoCycle.length > 0) {
        // B.blockedBy ← blockers
        this.applyReducerEvent({
          type: "TASK_UPDATED", at: now, source: "tool", entityType: "task", entityId: id,
          payload: { id, addBlockedBy: validAndNoCycle },
        });
        // For each blocker: blocker.blocks ← id
        for (const tid of validAndNoCycle) {
          this.applyReducerEvent({
            type: "TASK_UPDATED", at: now, source: "tool", entityType: "task", entityId: tid,
            payload: { id: tid, addBlocks: [id] },
          });
        }
      }

      return {
        entry: this.entries.get(id),
        warnings: {
          ...(hasSelfDep ? { selfDependency: true } : {}),
          ...(dangling.length > 0 ? { danglingReference: dangling } : {}),
          ...(validAndNoCycle.length < validIds.length ? { cycle: true } : {}),
        },
      };
    });
  }

  /**
   * Remove blocked-by relationships: this task is no longer blocked by `blockerIds`.
   */
  removeBlockedBy(id: string, blockerIds: string[]): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      const now = Date.now();
      // Remove from this task's blockedBy
      this.applyReducerEvent({
        type: "TASK_UPDATED", at: now, source: "tool", entityType: "task", entityId: id,
        payload: { id, removeBlockedBy: blockerIds },
      });
      // Remove from each blocker's blocks
      for (const tid of blockerIds) {
        this.applyReducerEvent({
          type: "TASK_UPDATED", at: now, source: "tool", entityType: "task", entityId: tid,
          payload: { id: tid, removeBlocks: [id] },
        });
      }
      return this.entries.get(id);
    });
  }

  /** Returns true if adding edge from `from` to `to` (from blocks to) would create a cycle. */
  private _wouldCreateCycle(from: string, to: string): boolean {
    // Check if `to` already blocks `from` (directly or transitively)
    const visited = new Set<string>();
    const stack = [to];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === from) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const task = this.entries.get(current);
      if (task) stack.push(...task.blocks);
    }
    return false;
  }

  /**
   * Get a task with its open (non-completed) blockers included.
   */
  getWithDependencies(id: string): { entry: TaskEntry | undefined; openBlockers: TaskEntry[] } {
    const entry = this.entries.get(id);
    if (!entry) return { entry: undefined, openBlockers: [] };
    const openBlockers: TaskEntry[] = [];
    for (const blockerId of entry.blockedBy) {
      const blocker = this.entries.get(blockerId);
      if (blocker && blocker.status !== "completed") openBlockers.push(blocker);
    }
    return { entry, openBlockers };
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.entries.has(id)) return false;
      this.applyReducerEvent({
        type: "TASK_DELETED",
        at: Date.now(),
        source: "tool",
        entityType: "task",
        entityId: id,
        payload: { id },
      });
      return true;
    });
  }

  pendingCount(): number {
    let count = 0;
    for (const t of this.entries.values()) {
      if (t.status === "pending" || t.status === "in_progress") count++;
    }
    return count;
  }

  pruneCompleted(): number {
    return this.withLock(() => {
      const before = this.entries.size;
      this.applyReducerEvent({
        type: "TASKS_PRUNED",
        at: Date.now(),
        source: "system",
        entityType: "task",
        payload: { reason: "manual" },
      });
      return before - this.entries.size;
    });
  }
}
