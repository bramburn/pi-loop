import { homedir } from "node:os";
import { join } from "node:path";
import { type LoopReducerEvent, type LoopReducerState, reduceLoopState } from "./loop-reducer.js";
import { ReducerBackedStore } from "./reducer-backed-store.js";
import type { DynamicLoopState, LoopDeletionTombstone, LoopDeletionTombstoneInput, LoopEntry, LoopPriority, LoopStoreData, Trigger, WorkflowDefinition, WorkflowTerminalStatus } from "./types.js";
import { isTerminalWorkflowRun, transitionWorkflowRun, validateWorkflowDefinition, type WorkflowTransitionFailure, type WorkflowTransitionInput } from "./workflow-reducer.js";

const LOOPS_DIR = join(homedir(), ".pi", "loops");
const MAX_LOOPS = 25;
const TOMBSTONE_TTL_MS = 10 * 60 * 1000;

function triggerEquals(a: Trigger, b: Trigger): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "cron" && b.type === "cron") return a.schedule === b.schedule;
  if (a.type === "event" && b.type === "event") return a.source === b.source && a.filter === b.filter;
  if (a.type === "hybrid" && b.type === "hybrid") {
    return a.cron === b.cron && a.event.source === b.event.source && a.event.filter === b.event.filter && a.debounceMs === b.debounceMs;
  }
  if (a.type === "dynamic" && b.type === "dynamic") return true;
  return false;
}

export class LoopStore extends ReducerBackedStore<LoopEntry, LoopReducerState, LoopReducerEvent, LoopStoreData> {
  private tombstones = new Map<string, LoopDeletionTombstone>();

  constructor(listIdOrPath?: string) {
    super(
      {
        baseDir: LOOPS_DIR,
        reduce: (state, event) => reduceLoopState(state, event),
        toReducerState: (nextId, entries) => ({ nextId, loopsById: Object.fromEntries(entries.entries()) }),
        fromReducerState: (state) => ({ nextId: state.nextId, entries: new Map(Object.entries(state.loopsById)) }),
        serialize: (nextId, entries) => ({ nextId, loops: Array.from(entries.values()) }),
        deserialize: (data) => ({ nextId: data.nextId, entries: new Map(data.loops.map((l) => [l.id, l])) }),
      },
      listIdOrPath,
    );
  }

  create(trigger: Trigger, prompt: string, opts: { recurring: boolean; autoTask?: boolean; taskBacklog?: boolean; readOnly?: boolean; maxFires?: number; priority?: LoopPriority; dynamic?: Partial<DynamicLoopState>; workflow?: WorkflowDefinition }): LoopEntry {
    return this.withLock(() => {
      if (this.entries.size >= MAX_LOOPS) {
        throw new Error(`Maximum of ${MAX_LOOPS} loops reached. Delete some before creating new ones.`);
      }
      if (opts.workflow) {
        if (trigger.type !== "dynamic") throw new Error("Workflow loops require a dynamic trigger.");
        const validationError = validateWorkflowDefinition(opts.workflow);
        if (validationError) throw new Error(`Invalid workflow: ${validationError}`);
      }
      const now = Date.now();
      this.applyReducerEvent({
        type: "LOOP_CREATED",
        at: now,
        source: "tool",
        entityType: "loop",
        payload: {
          prompt,
          trigger,
          recurring: opts.recurring,
          autoTask: opts.autoTask,
          taskBacklog: opts.taskBacklog,
          readOnly: opts.readOnly,
          maxFires: opts.maxFires,
          priority: opts.priority,
          dynamic: opts.dynamic,
          workflow: opts.workflow,
        },
      });
      return this.entries.get(String(this.nextId - 1))!;
    });
  }

  pause(id: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      this.applyReducerEvent({
        type: "LOOP_PAUSED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  resume(id: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || isTerminalWorkflowRun(entry.workflow)) return undefined;
      this.applyReducerEvent({
        type: "LOOP_RESUMED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      if (entry.trigger.type === "dynamic" && entry.dynamic?.awaitingUpdate) {
        this.applyReducerEvent({
          type: "LOOP_DYNAMIC_UPDATED",
          at: Date.now(),
          source: "tool",
          entityType: "loop",
          entityId: id,
          payload: {
            id,
            dynamic: {
              awaitingUpdate: false,
              lastUpdatedAt: Date.now(),
            },
          },
        });
      }
      return this.entries.get(id);
    });
  }

  fire(id: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      this.applyReducerEvent({
        type: "LOOP_FIRED",
        at: Date.now(),
        source: "system",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  updateMetadata(id: string, fields: { trigger?: Trigger; prompt?: string; taskBacklog?: boolean; priority?: LoopPriority; recurring?: boolean; maxFires?: number; readOnly?: boolean; autoTask?: boolean }): { entry: LoopEntry | undefined; changedFields: string[] } {
    return this.withLock(() => {
      const current = this.entries.get(id);
      if (!current) return { entry: undefined, changedFields: [] };

      const changedFields: string[] = [];
      const now = Date.now();

      if (fields.trigger !== undefined && !triggerEquals(current.trigger, fields.trigger)) {
        current.trigger = fields.trigger;
        changedFields.push("trigger");
      }
      if (fields.prompt !== undefined && fields.prompt !== current.prompt) {
        current.prompt = fields.prompt;
        changedFields.push("prompt");
      }
      if (fields.taskBacklog !== undefined && fields.taskBacklog !== current.taskBacklog) {
        current.taskBacklog = fields.taskBacklog;
        changedFields.push("taskBacklog");
      }
      if (fields.priority !== undefined && fields.priority !== current.priority) {
        current.priority = fields.priority;
        changedFields.push("priority");
      }
      if (fields.recurring !== undefined && fields.recurring !== current.recurring) {
        current.recurring = fields.recurring;
        changedFields.push("recurring");
      }
      if (fields.maxFires !== undefined && fields.maxFires !== current.maxFires) {
        current.maxFires = fields.maxFires;
        changedFields.push("maxFires");
      }
      if (fields.readOnly !== undefined && fields.readOnly !== current.readOnly) {
        current.readOnly = fields.readOnly;
        changedFields.push("readOnly");
      }
      if (fields.autoTask !== undefined && fields.autoTask !== current.autoTask) {
        current.autoTask = fields.autoTask;
        changedFields.push("autoTask");
      }
      if (changedFields.length > 0) {
        current.updatedAt = now;
      }

      return { entry: this.entries.get(id), changedFields };
    });
  }

  /**
   * Clear the optional maxFires cap on a loop. Returns true if the field was
   * previously set (and has now been removed); false if it was already unset
   * or the loop is missing. Used by the /loop-edit command when the user
   * explicitly empties the maxFires input — `updateMetadata` cannot signal
   * "set the field to undefined" because TS erases the key.
   */
  clearMaxFires(id: string): boolean {
    return this.withLock(() => {
      const current = this.entries.get(id);
      if (!current || current.maxFires === undefined) return false;
      delete current.maxFires;
      current.updatedAt = Date.now();
      return true;
    });
  }


  updateDynamic(id: string, fields: { prompt?: string; dynamic: Partial<DynamicLoopState> }): LoopEntry | undefined {
    return this.withLock(() => {
      if (!this.entries.has(id)) return undefined;
      this.applyReducerEvent({
        type: "LOOP_DYNAMIC_UPDATED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id, prompt: fields.prompt, dynamic: fields.dynamic },
      });
      return this.entries.get(id);
    });
  }

  continueDynamic(
    id: string,
    fields: { prompt?: string; dynamic: Partial<DynamicLoopState> },
    expected?: { status: LoopEntry["status"]; iteration: number; updatedAt: number },
  ): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (entry?.trigger.type !== "dynamic" || !entry.dynamic || entry.workflow) return undefined;
      if (expected && (
        entry.status !== expected.status
        || entry.dynamic.iteration !== expected.iteration
        || entry.updatedAt !== expected.updatedAt
      )) return undefined;
      const now = Date.now();
      if (entry.status === "paused") {
        this.applyReducerEvent({
          type: "LOOP_RESUMED",
          at: now,
          source: "tool",
          entityType: "loop",
          entityId: id,
          payload: { id },
        });
      }
      this.applyReducerEvent({
        type: "LOOP_DYNAMIC_UPDATED",
        at: now,
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id, prompt: fields.prompt, dynamic: fields.dynamic },
      });
      return this.entries.get(id);
    });
  }

  stopDynamic(
    id: string,
    status: "completed" | "paused",
    expected: { status: LoopEntry["status"]; iteration: number; updatedAt: number },
  ): boolean {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (entry?.trigger.type !== "dynamic" || !entry.dynamic || entry.workflow
        || entry.status !== expected.status
        || entry.dynamic.iteration !== expected.iteration
        || entry.updatedAt !== expected.updatedAt) return false;
      this.applyReducerEvent({
        type: status === "completed" ? "LOOP_DELETED" : "LOOP_PAUSED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return true;
    });
  }

  transitionWorkflow(
    id: string,
    input: WorkflowTransitionInput,
    expected?: { currentState: string; transitionSeq: number; activeTaskId?: string },
  ): { entry?: LoopEntry; applied: boolean; error?: string; failure?: WorkflowTransitionFailure; terminal?: WorkflowTerminalStatus } {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return { applied: false, error: `Loop #${id} not found` };
      if (!entry.workflow) return { applied: false, error: `Loop #${id} is not a workflow loop` };
      if (expected && (
        entry.workflow.currentState !== expected.currentState
        || entry.workflow.transitionSeq !== expected.transitionSeq
        || entry.workflow.activeTaskId !== expected.activeTaskId
      )) {
        return { applied: false, error: `Workflow #${id} changed; inspect LoopList and retry the transition.` };
      }

      const result = transitionWorkflowRun(entry.workflow, input, Date.now());
      if (!result.applied) {
        return { applied: false, error: result.error, failure: result.failure };
      }

      this.applyReducerEvent({
        type: "LOOP_WORKFLOW_TRANSITION",
        at: result.run.stateEnteredAt,
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: {
          id,
          outcome: input.outcome,
          evidence: input.evidence,
          activeTaskId: input.activeTaskId,
        },
      });
      return { entry: this.entries.get(id), applied: true, terminal: result.terminal };
    });
  }

  setWorkflowActiveTask(
    id: string,
    taskId?: string,
    expected?: { currentState: string; transitionSeq: number; activeTaskId?: string },
  ): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry?.workflow) return undefined;
      if (expected && (
        entry.workflow.currentState !== expected.currentState
        || entry.workflow.transitionSeq !== expected.transitionSeq
        || entry.workflow.activeTaskId !== expected.activeTaskId
      )) return undefined;
      this.applyReducerEvent({
        type: "LOOP_WORKFLOW_TASK_SET",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id, taskId },
      });
      return this.entries.get(id);
    });
  }

  getDeletionTombstone(id: string): LoopDeletionTombstone | undefined {
    const tombstone = this.tombstones.get(id);
    if (!tombstone) return undefined;
    if (Date.now() - tombstone.deletedAt <= TOMBSTONE_TTL_MS) return tombstone;
    this.tombstones.delete(id);
    return undefined;
  }

  recordDeletionTombstone(id: string, input: LoopDeletionTombstoneInput): LoopDeletionTombstone | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const tombstone: LoopDeletionTombstone = {
      id,
      reason: input.reason,
      pendingCount: input.pendingCount,
      deletedAt: Date.now(),
      prompt: entry.prompt,
    };
    this.tombstones.set(id, tombstone);
    return tombstone;
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.entries.has(id)) return false;
      this.applyReducerEvent({
        type: "LOOP_DELETED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return true;
    });
  }

  clearExpired(): number {
    return this.withLock(() => {
      const now = Date.now();
      let count = 0;
      for (const [id, entry] of [...this.entries.entries()]) {
        if (now < entry.expiresAt) continue;
        this.applyReducerEvent(entry.workflow
          ? {
              type: "LOOP_PAUSED",
              at: now,
              source: "system",
              entityType: "loop",
              entityId: id,
              payload: { id },
            }
          : {
              type: "LOOP_EXPIRED",
              at: now,
              source: "system",
              entityType: "loop",
              entityId: id,
              payload: { id, reason: "expires_at" },
            });
        count++;
      }
      return count;
    });
  }

  expireEventLoops(sessionStartedAt: number): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, entry] of [...this.entries.entries()]) {
        if (entry.status !== "active") continue;
        if (entry.trigger.type !== "event" && entry.trigger.type !== "hybrid") continue;
        const eventSource = entry.trigger.type === "event" ? entry.trigger.source : entry.trigger.event.source;
        if (entry.taskBacklog && eventSource === "tasks:created") continue;
        if (entry.createdAt >= sessionStartedAt) continue;
        this.applyReducerEvent({
          type: "LOOP_EXPIRED",
          at: sessionStartedAt,
          source: "session",
          entityType: "loop",
          entityId: id,
          payload: { id, reason: "resume_event_stale" },
        });
        count++;
      }
      return count;
    });
  }

  clearAll(options?: { preserveWorkflows?: boolean }): number {
    return this.withLock(() => {
      const entries = [...this.entries.values()];
      for (const entry of entries) {
        this.applyReducerEvent(options?.preserveWorkflows && entry.workflow
          ? {
              type: "LOOP_PAUSED",
              at: Date.now(),
              source: "system",
              entityType: "loop",
              entityId: entry.id,
              payload: { id: entry.id },
            }
          : {
              type: "LOOP_DELETED",
              at: Date.now(),
              source: "system",
              entityType: "loop",
              entityId: entry.id,
              payload: { id: entry.id },
            });
      }
      return entries.length;
    });
  }
}
