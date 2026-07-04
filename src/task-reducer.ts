import type { TaskEntry } from "./task-types.js";

export interface TaskReducerState {
  nextId: number;
  tasksById: Record<string, TaskEntry>;
}

export type TaskReducerEvent =
  | {
    type: "TASK_CREATED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "task";
    entityId?: string;
    payload: {
      subject: string;
      description: string;
      activeForm?: string;
      owner?: string;
      agentType?: string;
      metadata?: Record<string, unknown>;
    };
  }
  | {
    type: "TASK_STARTED" | "TASK_COMPLETED" | "TASK_REOPENED" | "TASK_DELETED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "task";
    entityId?: string;
    payload: { id: string };
  }
  | {
    type: "TASK_UPDATED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "task";
    entityId?: string;
    payload: {
      id: string;
      subject?: string;
      description?: string;
      activeForm?: string;
      owner?: string;
      agentType?: string;
      metadata?: Record<string, unknown>;
      addBlocks?: string[];
      removeBlocks?: string[];
      addBlockedBy?: string[];
      removeBlockedBy?: string[];
    };
  }
  | {
    type: "TASKS_PRUNED";
    at: number;
    source: "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";
    entityType?: "task";
    entityId?: string;
    payload: {
      reason: "git_commit" | "zero_pending_cleanup" | "manual";
    };
  };

export type TaskReducerEffect =
  | {
    type: "PERSIST_TASK";
    entityType: "task";
    entityId: string;
    payload: { task: TaskEntry };
  }
  | {
    type: "DELETE_TASK";
    entityType: "task";
    entityId: string;
    payload: { id: string };
  };

export interface TaskReduceResult {
  state: TaskReducerState;
  effects: TaskReducerEffect[];
}

function cloneState(state: TaskReducerState): TaskReducerState {
  return {
    nextId: state.nextId,
    tasksById: { ...state.tasksById },
  };
}

export function reduceTaskState(state: TaskReducerState, event: TaskReducerEvent): TaskReduceResult {
  if (event.type === "TASK_CREATED") {
    const next = cloneState(state);
    const id = String(next.nextId++);
    const task: TaskEntry = {
      id,
      subject: event.payload.subject,
      description: event.payload.description,
      status: "pending",
      activeForm: event.payload.activeForm,
      owner: event.payload.owner,
      agentType: event.payload.agentType,
      metadata: event.payload.metadata ?? {},
      blocks: [],
      blockedBy: [],
      createdAt: event.at,
      updatedAt: event.at,
    };
    next.tasksById[id] = task;
    return {
      state: next,
      effects: [{ type: "PERSIST_TASK", entityType: "task", entityId: id, payload: { task } }],
    };
  }

  if (event.type === "TASKS_PRUNED") {
    const next = cloneState(state);
    const effects: TaskReducerEffect[] = [];
    for (const [id, task] of Object.entries(next.tasksById)) {
      if (task.status !== "completed") continue;
      delete next.tasksById[id];
      effects.push({ type: "DELETE_TASK", entityType: "task", entityId: id, payload: { id } });
    }
    return { state: next, effects };
  }

  const id = event.payload.id;
  const current = state.tasksById[id];
  if (!current) return { state, effects: [] };

  if (event.type === "TASK_DELETED") {
    const next = cloneState(state);
    // Clean up dependency edges pointing to the deleted task
    for (const t of Object.values(next.tasksById)) {
      t.blocks = (t.blocks ?? []).filter((b) => b !== id);
      t.blockedBy = (t.blockedBy ?? []).filter((b) => b !== id);
    }
    delete next.tasksById[id];
    return {
      state: next,
      effects: [{ type: "DELETE_TASK", entityType: "task", entityId: id, payload: { id } }],
    };
  }

  const next = cloneState(state);
  const task: TaskEntry = { ...current };

  if (event.type === "TASK_STARTED") {
    task.status = "in_progress";
    task.updatedAt = event.at;
  }

  if (event.type === "TASK_COMPLETED") {
    task.status = "completed";
    task.updatedAt = event.at;
    task.completedAt = event.at;
  }

  if (event.type === "TASK_REOPENED") {
    task.status = "pending";
    task.updatedAt = event.at;
    // `completedAt` is intentionally retained: it records the most recent
    // completion, not "is currently complete" (use `status` for that). A
    // reopened task keeps the timestamp of when it was last completed.
  }

  if (event.type === "TASK_UPDATED") {
    if (event.payload.subject !== undefined) task.subject = event.payload.subject;
    if (event.payload.description !== undefined) task.description = event.payload.description;
    if (event.payload.activeForm !== undefined) task.activeForm = event.payload.activeForm;
    if (event.payload.owner !== undefined) task.owner = event.payload.owner;
    if (event.payload.agentType !== undefined) task.agentType = event.payload.agentType;
    if (event.payload.metadata !== undefined) {
      Object.assign(task.metadata, event.payload.metadata);
      // null values in payload are intentional deletes
      for (const key of Object.keys(event.payload.metadata)) {
        if (event.payload.metadata[key] === null) delete task.metadata[key];
      }
    }
    if (event.payload.addBlocks) task.blocks = [...new Set([...task.blocks, ...event.payload.addBlocks])];
    if (event.payload.removeBlocks) task.blocks = task.blocks.filter((b) => !event.payload.removeBlocks!.includes(b));
    if (event.payload.addBlockedBy) task.blockedBy = [...new Set([...task.blockedBy, ...event.payload.addBlockedBy])];
    if (event.payload.removeBlockedBy) task.blockedBy = task.blockedBy.filter((b) => !event.payload.removeBlockedBy!.includes(b));
    task.updatedAt = event.at;
  }

  next.tasksById[id] = task;
  return {
    state: next,
    effects: [{ type: "PERSIST_TASK", entityType: "task", entityId: id, payload: { task } }],
  };
}
