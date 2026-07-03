import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emitNativeTaskEvent } from "../runtime/task-events.js";
import { TaskStore } from "../task-store.js";

export interface TaskBacklogResult {
  created: boolean;
  entry?: { id: string };
}

export interface NativeTaskToolsOptions {
  pi: ExtensionAPI;
  taskStore: TaskStore;
  evaluateTaskBacklog: (taskStore: TaskStore, pendingCount: number) => Promise<TaskBacklogResult>;
  updateWidget: () => void;
}

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

export function registerNativeTaskTools(options: NativeTaskToolsOptions): void {
  const { pi, taskStore, evaluateTaskBacklog, updateWidget } = options;

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Create a task for tracking work across turns. Use when you need to track progress on complex multi-step tasks or turn a broad user goal into a concrete backlog.

Fields:
- subject: brief actionable title
- description: detailed requirements and done condition`,
    promptGuidelines: [
      "Use TaskCreate to track complex multi-step work across turns.",
      "When the user gives a broad goal, use multiple TaskCreate calls to decompose it into a small backlog of concrete tasks rather than one oversized task.",
      "If the user supplies a shared goal or meta-goal, preserve it explicitly using the user's wording and tie each created task back to that goal in its description.",
      "If several tasks share one goal, keep subjects short and put the shared goal in the first sentence of each description or as an equivalent explicit framing.",
      "Prefer 2-5 tasks that separate investigation, implementation, validation, and reporting or commit-prep when those phases are distinct.",
      "When the user asks to break work into tasks, create the backlog directly and do not pivot to loops, monitors, or other automation unless the user also asked for ongoing automation.",
      "Make each `subject` a short verb-object action.",
      "Make each `description` include the expected artifact, outcome, or done condition so another turn can pick the task up cleanly.",
      "Break work into small, independently completable tasks. A task should be finishable in one focused session — if a task would take multiple turns, split it further.",
      "TaskCreate accepts `subject` and `description` parameters only — do not invent extra fields unless the schema explicitly adds them.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "Brief actionable title for the task (max 80 chars)", maxLength: 80 }),
      description: Type.String({ description: "Detailed description of what needs to be done" }),
    }),
    async execute(_toolCallId, params) {
      const subject = params.subject.slice(0, 80);
      const entry = taskStore.create(subject, params.description);
      emitNativeTaskEvent(pi, "tasks:created", entry, undefined, {
        suppressIfPiTasks: true,
        piTasksAvailable: false,
      });
      const backlog = await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
      updateWidget();

      const autoLoopMsg = backlog.created && backlog.entry
        ? `\nBacklog worker loop #${backlog.entry.id} created`
        : "";
      return Promise.resolve(textResult(`Task #${entry.id} created: ${entry.subject}${autoLoopMsg}`));
    },
  });

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: "List all tasks with status. Use to check progress and find available work.",
    parameters: Type.Object({}),
    execute() {
      const tasks = taskStore.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks."));

      const lines: string[] = [];
      const statuses: Record<"pending" | "in_progress" | "completed", number> = {
        pending: 0,
        in_progress: 0,
        completed: 0,
      };
      for (const t of tasks) {
        statuses[t.status]++;
        const icon = t.status === "completed" ? "ok" : t.status === "in_progress" ? ">" : "*";
        lines.push(`${icon} #${t.id} [${t.status}] ${t.subject.slice(0, 80)}`);
      }
      lines.unshift(`${tasks.length} tasks (${statuses.pending} pending, ${statuses.in_progress} in progress, ${statuses.completed} done)`);
      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Update task status, details, metadata, and dependency edges. Set status to "in_progress" before starting work, "completed" when done.

Statuses: pending → in_progress → completed
Parameters: id (required), status, subject, description, activeForm, owner, agentType, metadata, addBlocks, addBlockedBy, removeBlocks, removeBlockedBy

Metadata: shallow merge — existing keys are preserved; set a key to null to delete it.
Dependency edges: addBlocks adds task IDs this task blocks; addBlockedBy adds task IDs that block this task. Bidirectional — both sides of the edge are updated. Cycles, self-dependency, and dangling references produce warnings in the response.`,
    promptGuidelines: [
      "TaskUpdate uses parameter `id`, not `taskId`.",
      "Accepted parameters: `id` (required), `status`, `subject`, `description`, `activeForm`, `owner`, `agentType`, `metadata`, `addBlocks`, `addBlockedBy`, `removeBlocks`, `removeBlockedBy`.",
      "Metadata: shallow merge. Set a key to null to delete it from metadata.",
      "Dependency edges: addBlocks/addBlockedBy are bidirectional — both sides of the edge update. Cycles and self-dependency are rejected with warnings.",
      "When validation fails with 'must have required properties id', you passed `taskId` instead of `id`. Correct silently and retry.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to update" }),
      status: Type.Optional(Type.String({ description: "New status", enum: ["pending", "in_progress", "completed"] })),
      subject: Type.Optional(Type.String({ description: "New title" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      activeForm: Type.Optional(Type.String({ description: "Present-continuous text for the active spinner (e.g. 'Running tests')" })),
      owner: Type.Optional(Type.String({ description: "Agent or owner name" })),
      agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution (e.g. 'general-purpose')" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
      addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task blocks (bidirectional — target's blockedBy is also updated)" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task (bidirectional — blocker's blocks is also updated)" })),
      removeBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs to unblock" })),
      removeBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs to remove as blockers" })),
    }),
    async execute(_toolCallId, params) {
      const { id, status, subject, description, activeForm, owner, agentType, metadata, addBlocks, addBlockedBy, removeBlocks, removeBlockedBy } = params;
      let entry = taskStore.get(id);
      if (!entry) return Promise.resolve(textResult(`Task #${id} not found`));

      const previousStatus = entry.status;
      if (status === "in_progress") {
        entry = taskStore.start(id);
        if (entry) emitNativeTaskEvent(pi, "tasks:started", entry, previousStatus, {
          suppressIfPiTasks: true,
          piTasksAvailable: false,
        });
      } else if (status === "completed") {
        entry = taskStore.complete(id);
        if (entry) emitNativeTaskEvent(pi, "tasks:completed", entry, previousStatus, {
          suppressIfPiTasks: true,
          piTasksAvailable: false,
        });
      } else if (status === "pending") {
        entry = taskStore.reopen(id);
        if (entry) emitNativeTaskEvent(pi, "tasks:reopened", entry, previousStatus, {
          suppressIfPiTasks: true,
          piTasksAvailable: false,
        });
      }

      const hasDetailUpdate = subject !== undefined || description !== undefined ||
        activeForm !== undefined || owner !== undefined || agentType !== undefined || metadata !== undefined;
      if (hasDetailUpdate) {
        entry = taskStore.updateDetails(id, { subject, description, activeForm, owner, agentType, metadata });
        if (entry) emitNativeTaskEvent(pi, "tasks:updated", entry, previousStatus, {
          suppressIfPiTasks: true,
          piTasksAvailable: false,
        });
      }

      const warnings: string[] = [];
      if (addBlocks?.length) {
        const r = taskStore.addBlocks(id, addBlocks);
        if (r.warnings.selfDependency) warnings.push("warning: self-dependency");
        if (r.warnings.cycle) warnings.push("warning: cycle detected");
        if (r.warnings.danglingReference?.length) {
          warnings.push(`warning: non-existent tasks: #${r.warnings.danglingReference.join(", #")}`);
        }
      }
      if (addBlockedBy?.length) {
        const r = taskStore.addBlockedBy(id, addBlockedBy);
        if (r.warnings.selfDependency) warnings.push("warning: self-dependency");
        if (r.warnings.cycle) warnings.push("warning: cycle detected");
        if (r.warnings.danglingReference?.length) {
          warnings.push(`warning: non-existent tasks: #${r.warnings.danglingReference.join(", #")}`);
        }
      }
      if (removeBlocks?.length) taskStore.removeBlocks(id, removeBlocks);
      if (removeBlockedBy?.length) taskStore.removeBlockedBy(id, removeBlockedBy);

      if (!entry) return Promise.resolve(textResult(`Task #${id} not found`));
      updateWidget();
      const backlog = await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
      const statusMsg = status ? ` → ${status}` : "";
      const autoLoopMsg = backlog.created && backlog.entry
        ? `\nBacklog worker loop #${backlog.entry.id} created`
        : "";
      const warningsMsg = warnings.length > 0 ? `\n${warnings.join("; ")}` : "";
      return Promise.resolve(textResult(`Task #${id} updated${statusMsg}${warningsMsg}${autoLoopMsg}`));
    },
  });

  pi.registerTool({
    name: "TaskDelete",
    label: "TaskDelete",
    description: "Delete a task by ID. Use for cleaning up completed or irrelevant tasks.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to delete" }),
    }),
    async execute(_toolCallId, params) {
      const existing = taskStore.get(params.id);
      const deleted = taskStore.delete(params.id);
      updateWidget();
      if (deleted) {
        if (existing) emitNativeTaskEvent(pi, "tasks:deleted", existing, existing.status, {
          suppressIfPiTasks: true,
          piTasksAvailable: false,
        });
        await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
        return Promise.resolve(textResult(`Task #${params.id} deleted`));
      }
      return Promise.resolve(textResult(`Task #${params.id} not found`));
    },
  });

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Get full details for a specific task: id, subject, status, owner, activeForm, description, createdAt, updatedAt, completedAt, blocks, blockedBy (all edges), and metadata as JSON.

Shows all dependency edges including completed blockers. Use to inspect a task's full state.`,
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to retrieve" }),
    }),
    async execute(_toolCallId, params) {
      const { entry, openBlockers } = taskStore.getWithDependencies(params.id);
      if (!entry) return Promise.resolve(textResult(`Task #${params.id} not found`));

      const lines: string[] = [];
      lines.push(`Task #${entry.id}: ${entry.subject}`);
      lines.push(`Status: ${entry.status}`);
      if (entry.owner) lines.push(`Owner: ${entry.owner}`);
      if (entry.activeForm) lines.push(`Active form: ${entry.activeForm}`);
      lines.push("");
      lines.push(entry.description);

      if (entry.blocks.length > 0) {
        lines.push(`Blocks: ${entry.blocks.map((b) => `#${b}`).join(", ")}`);
      }
      if (entry.blockedBy.length > 0) {
        const allBlockers = entry.blockedBy.map((b) => `#${b}`);
        const openBlockerIds = new Set(openBlockers.map((t) => t.id));
        const allBlockerLines = allBlockers.map((b) => {
          const id = b.slice(1);
          return openBlockerIds.has(id) ? b : `${b} (completed)`;
        });
        lines.push(`Blocked by: ${allBlockerLines.join(", ")}`);
      }

      const metaKeys = Object.keys(entry.metadata);
      if (metaKeys.length > 0) {
        lines.push("");
        lines.push("Metadata:");
        lines.push(JSON.stringify(entry.metadata, null, 2));
      }

      lines.push("");
      lines.push(`Created: ${new Date(entry.createdAt).toISOString()}`);
      lines.push(`Updated: ${new Date(entry.updatedAt).toISOString()}`);
      if (entry.completedAt) {
        lines.push(`Completed: ${new Date(entry.completedAt).toISOString()}`);
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  pi.registerTool({
    name: "TaskPrune",
    label: "TaskPrune",
    description: `Bulk-delete all completed tasks. Use to clear a backlog of done work without calling TaskDelete once per task.

Pending and in-progress tasks are not affected. The git commit hook also calls this internally after a successful commit.`,
    parameters: Type.Object({
      reason: Type.Optional(Type.String({
        description: "Reason for pruning (logged in the events). Default: manual",
        enum: ["manual", "git_commit", "zero_pending_cleanup"],
        default: "manual",
      })),
    }),
    async execute(_toolCallId, params) {
      const reason = params.reason ?? "manual";
      const before = taskStore.list().length;
      taskStore.pruneCompleted();
      const after = taskStore.list().length;
      updateWidget();
      const removed = before - after;
      await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
      return Promise.resolve(textResult(`Pruned ${removed} completed task(s) (${after} remain; reason: ${reason})`));
    },
  });
}
