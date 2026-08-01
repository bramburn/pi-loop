import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  claimTask,
  createTask,
  deleteTask,
  heartbeatTask,
  type TaskBacklogResult,
  type TaskMutationContext,
  updateTask,
} from "../runtime/task-mutations.js";
import { TaskStore } from "../task-store.js";
import type { TaskStatus } from "../task-types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { displayRows, textResult } from "./tool-result.js";

export type { TaskBacklogResult };

export interface NativeTaskToolsOptions {
  pi: ExtensionAPI;
  taskStore: TaskStore;
  evaluateTaskBacklog: (taskStore: TaskStore, pendingCount: number) => Promise<TaskBacklogResult>;
  getTaskOwner: () => { sessionId: string; runtimeId: string };
  updateWidget: () => void;
}

function backlogSuffix(backlog: TaskBacklogResult): string {
  return backlog.created && backlog.entry
    ? `\nBacklog worker loop #${backlog.entry.id} created`
    : "";
}

export function registerNativeTaskTools(options: NativeTaskToolsOptions): void {
  const { pi, taskStore, evaluateTaskBacklog, getTaskOwner, updateWidget } = options;
  const mutationCtx: TaskMutationContext = { pi, taskStore, evaluateTaskBacklog, updateWidget };

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    renderCall: renderToolCall("Task", (args) => `create · ${String(toolArg(args, "subject") ?? "task").slice(0, 56)}`),
    renderResult: renderToolResult,
    description: "Create an independently completable task across turns, or decompose a broad user goal into a concrete backlog. Creating tasks does not start autonomous work. Use subject and description only.",
    promptGuidelines: [
      "When the user gives a broad goal, use multiple TaskCreate calls to decompose it into a small backlog of concrete tasks rather than one oversized task.",
      "If the user supplies a shared goal or meta-goal, preserve it explicitly using the user's wording and tie each created task back to that goal in its description.",
      "When the user asks to break work into tasks, create the backlog directly and do not pivot to loops, monitors, or other automation unless the user also asked for ongoing automation.",
      "Use short verb-object subjects; descriptions state the goal state, artifact, done condition, dependencies, and next task when chained.",
      "Use WorkflowCreate for named phases/outcomes and LoopCreate taskBacklog=true only when autonomous backlog processing was explicitly requested.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "Brief actionable title for the task" }),
      description: Type.String({ description: "Detailed description of what needs to be done" }),
    }),
    async execute(_toolCallId, params) {
      const { entry, backlog } = await createTask(mutationCtx, {
        subject: params.subject,
        description: params.description,
      });
      return textResult(`Task #${entry.id} created: ${entry.subject}${backlogSuffix(backlog)}`, {
        kind: "task",
        action: "create",
        tone: "success",
        summary: `Task #${entry.id} pending · ${entry.subject.slice(0, 56)}`,
        expanded: [
          `Description: ${entry.description}`,
          backlog.created && backlog.entry ? `Backlog worker: loop #${backlog.entry.id} created` : "Backlog worker: unchanged",
        ],
      });
    },
  });

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    renderCall: renderToolCall("Task", () => "status"),
    renderResult: renderToolResult,
    description: "List all tasks with status. Use to check progress and find available work.",
    parameters: Type.Object({}),
    execute() {
      const tasks = taskStore.list();
      if (tasks.length === 0) {
        return Promise.resolve(textResult("No tasks.", {
          kind: "task", action: "list", tone: "info", summary: "No tasks", expanded: ["Use TaskCreate for work that spans turns."],
        }));
      }

      const lines: string[] = [];
      const expanded: string[] = [];
      const statuses: Record<TaskStatus, number> = {
        pending: 0,
        in_progress: 0,
        completed: 0,
        closed: 0,
      };
      for (const t of tasks) {
        statuses[t.status]++;
        const icon = t.status === "completed" ? "ok" : t.status === "closed" ? "x" : t.status === "in_progress" ? ">" : "*";
        const row = `${icon} #${t.id} [${t.status}] ${t.subject.slice(0, 80)}`;
        const context = [
          t.description ? `    ${t.description.slice(0, 120)}` : undefined,
          t.claim
            ? `    claim ${t.claim.claimId} · owner ${t.claim.ownerSessionId}/${t.claim.ownerRuntimeId} · expires ${new Date(t.claim.leaseExpiresAt).toISOString()}`
            : undefined,
          t.workflow ? `    workflow #${t.workflow.loopId} · state ${t.workflow.stateId}` : undefined,
        ].filter((line): line is string => line !== undefined);
        lines.push(row, ...context);
        expanded.push(row, ...context);
      }
      lines.unshift(`${tasks.length} tasks (${statuses.pending} pending, ${statuses.in_progress} in progress, ${statuses.completed} done, ${statuses.closed} closed)`);
      return Promise.resolve(textResult(lines.join("\n"), {
        kind: "task",
        action: "list",
        tone: "info",
        summary: `${tasks.length} task${tasks.length === 1 ? "" : "s"} · ${statuses.pending} pending · ${statuses.in_progress} active`,
        expanded: displayRows(expanded),
      }));
    },
  });

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    renderCall: renderToolCall("Task", (args) => `get · #${String(toolArg(args, "id") ?? "?")}`),
    renderResult: renderToolResult,
    description: `Read full task context by ID: subject, untruncated description, status, timestamps, metadata, and workflow link.

Use when TaskList's excerpt is truncated or you need the complete goal-state and next-step text before starting a chained task. Read-only — does not change task state.`,
    promptGuidelines: [
      "TaskGet uses parameter `id`, not `taskId`.",
      "Read the full description before starting a task picked from a chain — it carries the goal state and the next task.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to read" }),
    }),
    execute(_toolCallId, params) {
      const t = taskStore.get(params.id);
      if (!t) {
        return Promise.resolve(textResult(`Task #${params.id} not found`, {
          kind: "task", action: "get", tone: "error", summary: `Task #${params.id} not found`, expanded: ["Use TaskList to find valid task IDs."],
        }));
      }
      const lines = [
        `Task #${t.id} [${t.status}] ${t.subject}`,
        `Description: ${t.description}`,
        `Created: ${new Date(t.createdAt).toISOString()}`,
      ];
      lines.push(`Revision: ${t.revision ?? 0}`);
      if (t.claim) {
        lines.push(`Claim: ${t.claim.claimId}`);
        lines.push(`Owner: ${t.claim.ownerSessionId}/${t.claim.ownerRuntimeId}`);
        lines.push(`Lease expires: ${new Date(t.claim.leaseExpiresAt).toISOString()}`);
      }
      if (t.completedAt) lines.push(`Completed: ${new Date(t.completedAt).toISOString()}`);
      if (t.reopenedAt) lines.push(`Reopened: ${new Date(t.reopenedAt).toISOString()}`);
      if (t.closedAt) lines.push(`Closed: ${new Date(t.closedAt).toISOString()}`);
      if (t.workflow) {
        lines.push(`workflow #${t.workflow.loopId} · state ${t.workflow.stateId} · transition ${t.workflow.transitionSeq}`);
      }
      if (t.metadata && Object.keys(t.metadata).length > 0) {
        lines.push(`Metadata: ${JSON.stringify(t.metadata)}`);
      }
      return Promise.resolve(textResult(lines.join("\n"), {
        kind: "task",
        action: "get",
        tone: "info",
        summary: `Task #${t.id} · ${t.status} · ${t.subject.slice(0, 40)}`,
        expanded: lines.slice(1),
      }));
    },
  });

  pi.registerTool({
    name: "TaskClaim",
    label: "TaskClaim",
    renderCall: renderToolCall("Task", (args) => `claim · #${String(toolArg(args, "id") ?? "?")}`),
    renderResult: renderToolResult,
    description: `Claim unfinished task work with renewable lease. Use before implementing a pending task or taking over abandoned in-progress work.

A live claim owned by another runtime fails closed. Expired claims may be taken over. Keep returned claimId and pass it to TaskHeartbeat and terminal TaskUpdate calls.`,
    promptGuidelines: [
      "Resume an in_progress task only through TaskClaim so live owners are not duplicated.",
      "TaskClaim uses parameter `id`; retain returned `claimId` for heartbeat and completion.",
      "Heartbeat long-running work before lease expiry. Takeover is allowed only after expiry.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to claim" }),
      leaseSeconds: Type.Optional(Type.Number({ description: "Lease duration in seconds", minimum: 60, maximum: 3600, default: 1800 })),
    }),
    async execute(_toolCallId, params) {
      const owner = getTaskOwner();
      const leaseMs = (params.leaseSeconds ?? 1800) * 1000;
      const claimed = await claimTask(mutationCtx, {
        id: params.id,
        claim: {
          ownerSessionId: owner.sessionId,
          ownerRuntimeId: owner.runtimeId,
          leaseMs,
        },
      });
      if (!claimed) {
        const existing = taskStore.get(params.id);
        const detail = existing?.claim
          ? `live claim ${existing.claim.claimId} owned by ${existing.claim.ownerSessionId}/${existing.claim.ownerRuntimeId} until ${new Date(existing.claim.leaseExpiresAt).toISOString()}`
          : existing ? `task status is ${existing.status}` : "task not found";
        return textResult(`Task #${params.id} not claimable: ${detail}`, {
          kind: "task", action: "claim", tone: "error", summary: `Task #${params.id} not claimable`, expanded: [detail],
        });
      }
      const { entry, claim, takenOver } = claimed.result;
      return textResult(`Task #${entry.id} claimed${takenOver ? " by takeover" : ""}\nclaimId: ${claim.claimId}\nleaseExpiresAt: ${new Date(claim.leaseExpiresAt).toISOString()}`, {
        kind: "task",
        action: "claim",
        tone: "success",
        summary: `Task #${entry.id} claimed${takenOver ? " · takeover" : ""}`,
        expanded: [
          `Claim: ${claim.claimId}`,
          `Owner: ${claim.ownerSessionId}/${claim.ownerRuntimeId}`,
          `Attempt: ${claim.attempt}`,
          `Lease expires: ${new Date(claim.leaseExpiresAt).toISOString()}`,
        ],
      });
    },
  });

  pi.registerTool({
    name: "TaskHeartbeat",
    label: "TaskHeartbeat",
    renderCall: renderToolCall("Task", (args) => `heartbeat · #${String(toolArg(args, "id") ?? "?")}`),
    renderResult: renderToolResult,
    description: "Renew a live task claim while work continues. Requires the exact claimId returned by TaskClaim.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID" }),
      claimId: Type.String({ description: "Claim token returned by TaskClaim" }),
      leaseSeconds: Type.Optional(Type.Number({ description: "Renewed lease duration in seconds", minimum: 60, maximum: 3600, default: 1800 })),
    }),
    execute(_toolCallId, params) {
      const entry = heartbeatTask(mutationCtx, {
        id: params.id,
        claimId: params.claimId,
        leaseMs: (params.leaseSeconds ?? 1800) * 1000,
      });
      if (!entry?.claim) {
        return Promise.resolve(textResult(`Task #${params.id} heartbeat rejected`, {
          kind: "task", action: "heartbeat", tone: "error", summary: `Task #${params.id} heartbeat rejected`, expanded: ["Claim is missing, expired/taken over, terminal, or token does not match."],
        }));
      }
      return Promise.resolve(textResult(`Task #${entry.id} lease renewed until ${new Date(entry.claim.leaseExpiresAt).toISOString()}`, {
        kind: "task", action: "heartbeat", tone: "success", summary: `Task #${entry.id} lease renewed`, expanded: [`Claim: ${entry.claim.claimId}`],
      }));
    },
  });

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    renderCall: renderToolCall("Task", (args) => `update · #${String(toolArg(args, "id") ?? "?")}`),
    renderResult: renderToolResult,
    description: `Update task status or details. Set status to "in_progress" before starting work, "completed" when done, or "closed" when work is intentionally abandoned without completion.

Statuses: pending → in_progress → completed | closed
Parameters: id (required), status, subject, description, claimId`,
    promptGuidelines: [
      "TaskUpdate uses parameter `id`, not `taskId`.",
      "Accepted parameters: `id` (required), `status`, `subject`, `description`, `claimId`.",
      "When a task has a claim, pass its exact `claimId` when completing or closing it.",
      "When validation fails with 'must have required properties id', you passed `taskId` instead of `id`. Correct silently and retry.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to update" }),
      status: Type.Optional(Type.String({ description: "New status", enum: ["pending", "in_progress", "completed", "closed"] })),
      subject: Type.Optional(Type.String({ description: "New title" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      claimId: Type.Optional(Type.String({ description: "Claim token required for completing or closing claimed work" })),
    }),
    async execute(_toolCallId, params) {
      const { id, status, subject, description, claimId } = params;
      const result = await updateTask(mutationCtx, {
        id,
        status: status as TaskStatus | undefined,
        subject,
        description,
        claimId,
      });
      if (!result) {
        const current = taskStore.get(id);
        const reason = current
          ? current.claim
            ? "Claim token does not match the live task owner."
            : `Transition from ${current.status} to ${status ?? current.status} is not allowed.`
          : "Use TaskList to find valid task IDs.";
        const message = current ? `Task #${id} update rejected: ${reason}` : `Task #${id} not found`;
        return textResult(message, {
          kind: "task", action: "update", tone: "error", summary: current ? `Task #${id} update rejected` : `Task #${id} not found`, expanded: [reason],
        });
      }
      const statusMsg = status ? ` → ${status}` : "";
      return textResult(`Task #${id} updated${statusMsg}${backlogSuffix(result.backlog)}`, {
        kind: "task",
        action: "update",
        tone: "success",
        summary: `Task #${id}${status ? ` → ${status}` : " updated"}`,
        expanded: [
          `Subject: ${result.entry.subject}`,
          `Status: ${result.entry.status}`,
          result.backlog.created && result.backlog.entry ? `Backlog worker: loop #${result.backlog.entry.id} created` : "Backlog worker: unchanged",
        ],
      });
    },
  });

  pi.registerTool({
    name: "TaskDelete",
    label: "TaskDelete",
    renderCall: renderToolCall("Task", (args) => `delete · #${String(toolArg(args, "id") ?? "?")}`),
    renderResult: renderToolResult,
    description: "Delete a task by ID. Use for cleaning up completed or irrelevant tasks.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to delete" }),
    }),
    async execute(_toolCallId, params) {
      const result = await deleteTask(mutationCtx, params.id);
      if (!result) {
        return textResult(`Task #${params.id} not found`, {
          kind: "task", action: "delete", tone: "error", summary: `Task #${params.id} not found`, expanded: ["Use TaskList to find valid task IDs."],
        });
      }
      return textResult(`Task #${params.id} deleted`, {
        kind: "task", action: "delete", tone: "success", summary: `Task #${params.id} deleted`, expanded: [],
      });
    },
  });
}
