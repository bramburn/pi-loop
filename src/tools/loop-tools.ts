import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatTrigger } from "../loop-format.js";
import { parseInterval } from "../loop-parse.js";
import type { LoopEntry, LoopIsolation, LoopPriority, LoopSubAgentConfig, Trigger } from "../types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { displayRows, textResult } from "./tool-result.js";
import { formatWorkflowSummary } from "./workflow-tools.js";

interface LoopStoreLike {
  list(): LoopEntry[];
  get(id: string): LoopEntry | undefined;
  create(trigger: Trigger, prompt: string, opts: {
    recurring: boolean;
    autoTask?: boolean;
    taskBacklog?: boolean;
    readOnly?: boolean;
    maxFires?: number;
    priority?: LoopPriority;
    dynamic?: Partial<NonNullable<LoopEntry["dynamic"]>>;
    isolation?: LoopIsolation;
    goal?: string;
    successCriteria?: string;
    failureCriteria?: string;
    stateFile?: string;
    subAgent?: LoopSubAgentConfig;
  }): LoopEntry;
  updateConfig(id: string, partial: {
    isolation?: LoopIsolation;
    goal?: string;
    successCriteria?: string;
    failureCriteria?: string;
    stateFile?: string;
    subAgent?: LoopSubAgentConfig;
    maxFires?: number;
    priority?: LoopPriority;
  }): LoopEntry | undefined;
  pause(id: string): LoopEntry | undefined;
  resume(id: string): LoopEntry | undefined;
  continueDynamic(
    id: string,
    fields: { prompt?: string; dynamic: Partial<NonNullable<LoopEntry["dynamic"]>> },
    expected?: { status: LoopEntry["status"]; iteration: number; updatedAt: number },
  ): LoopEntry | undefined;
  stopDynamic(
    id: string,
    status: "completed" | "paused",
    expected: { status: LoopEntry["status"]; iteration: number; updatedAt: number },
  ): boolean;
  getDeletionTombstone(id: string): { reason: string; pendingCount?: number } | undefined;
  delete(id: string): boolean;
}

interface TriggerSystemLike {
  add(entry: LoopEntry): void;
  remove(id: string): void;
}

interface SchedulerLike {
  nextFire(id: string): number | undefined;
}

interface MonitorLike {
  id: string;
  status: string;
}

interface MonitorManagerLike {
  get(id: string): MonitorLike | undefined;
}

export interface LoopToolsOptions {
  pi: ExtensionAPI;
  getStore: () => LoopStoreLike;
  getTriggerSystem: () => TriggerSystemLike;
  getScheduler: () => SchedulerLike;
  getMonitorManager: () => MonitorManagerLike;
  updateWidget: () => void;
  maybeBootstrapTaskLoop: (entry: LoopEntry) => Promise<boolean>;
  isTaskSystemReady: () => boolean;
  onDynamicLoopActivated?: (entry: LoopEntry) => void;
}

function validateTrigger(trigger: Trigger): string | null {
  if (trigger.type === "cron") {
    const parts = trigger.schedule.trim().split(/\s+/);
    if (parts.length !== 5) {
      return `Invalid cron trigger. Expected 5 fields, got ${parts.length}: "${trigger.schedule}". Use formats like "5m", "1h", "0 9 * * 1-5", or set triggerType to "event" for event sources.`;
    }
  } else if (trigger.type === "event") {
    if (!trigger.source || trigger.source.trim().length === 0) {
      return "Invalid event trigger. Event source must be non-empty (e.g., \"tool_execution_start\").";
    }
  } else if (trigger.type === "hybrid") {
    const cronParts = trigger.cron.trim().split(/\s+/);
    if (cronParts.length !== 5) {
      return `Invalid hybrid trigger. Cron part must have 5 fields, got ${cronParts.length}: "${trigger.cron}".`;
    }
    if (!trigger.event.source || trigger.event.source.trim().length === 0) {
      return "Invalid hybrid trigger. Event source must be non-empty (e.g., \"tool_execution_start\").";
    }
  }
  return null;
}

function inferTriggerType(input: string): "cron" | "event" | "hybrid" {
  if (input.includes("hybrid") || (input.includes("cron") && input.includes("event"))) return "hybrid";
  if (/^\d+\s*[smhd]$/i.test(input.trim())) return "cron";
  if (/^(\*|\d+)/.test(input.trim()) && input.trim().split(/\s+/).length === 5) return "cron";
  return "event";
}

function formatRemaining(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

function parseDelayMs(input: string): number | undefined {
  const match = input.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return undefined;
  const value = Number.parseInt(match[1] ?? "", 10);
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000;
  const delayMs = value * multiplier;
  if (!Number.isSafeInteger(delayMs) || delayMs <= 0 || delayMs > 7 * 24 * 60 * 60 * 1000) return undefined;
  return delayMs;
}

interface LoopUpdateParams {
  id: string;
  status: "continue" | "completed" | "paused";
  state?: string;
  metrics?: string;
  doneCriteria?: string;
  nextInterval?: string;
  prompt?: string;
}

function resolveNextWakeAt(nextInterval?: string): { nextWakeAt?: number; error?: string } {
  if (!nextInterval) return { nextWakeAt: undefined };
  const parsedDelayMs = parseDelayMs(nextInterval);
  if (!parsedDelayMs) return { error: `Invalid nextInterval "${nextInterval}". Use formats like 3m, 30s, or 1h.` };
  return { nextWakeAt: Date.now() + parsedDelayMs };
}


function formatDynamicUpdateResult(id: string, iteration: number | undefined, nextWakeAt: number | undefined, resumed: boolean): string {
  const mode = nextWakeAt === undefined
    ? "Next wake: when idle"
    : `Next wake: ${formatRemaining(Math.max(0, nextWakeAt - Date.now()))}`;
  return `Dynamic loop #${id} ${resumed ? "resumed and updated" : "updated"}\n` +
    `Iteration: ${iteration ?? "?"}` +
    `\n${mode}`;
}

function formatDeletionTombstone(id: string, tombstone: { reason: string; pendingCount?: number }): string {
  const detail = tombstone.pendingCount === undefined ? "" : ` (pending: ${tombstone.pendingCount})`;
  return `Loop #${id} already auto-deleted: ${tombstone.reason}${detail}`;
}

function continueDynamicLoop(
  params: LoopUpdateParams,
  entry: LoopEntry & { dynamic: NonNullable<LoopEntry["dynamic"]> },
  store: LoopStoreLike,
  triggerSystem: TriggerSystemLike,
): { applied: boolean; message: string } {
  const { nextWakeAt, error } = resolveNextWakeAt(params.nextInterval);
  if (error) return { applied: false, message: error };
  if (nextWakeAt !== undefined && nextWakeAt > entry.expiresAt) {
    return { applied: false, message: `nextInterval exceeds loop #${params.id}'s remaining lifetime.` };
  }

  const resumed = entry.status === "paused";
  const updated = store.continueDynamic(params.id, {
    prompt: params.prompt,
    dynamic: {
      goal: params.prompt ?? entry.dynamic.goal,
      state: params.state,
      metrics: params.metrics,
      doneCriteria: params.doneCriteria,
      iteration: (entry.dynamic.iteration ?? 0) + 1,
      nextWakeAt,
      awaitingUpdate: false,
      lastUpdatedAt: Date.now(),
    },
  }, {
    status: entry.status,
    iteration: entry.dynamic.iteration ?? 0,
    updatedAt: entry.updatedAt,
  });
  if (!updated) {
    return { applied: false, message: `Loop #${params.id} changed while the update was applied; inspect LoopList and retry.` };
  }
  triggerSystem.remove(params.id);
  triggerSystem.add(updated);
  return { applied: true, message: formatDynamicUpdateResult(params.id, updated.dynamic?.iteration, nextWakeAt, resumed) };
}

function stopDynamicLoop(
  params: LoopUpdateParams,
  entry: LoopEntry & { dynamic: NonNullable<LoopEntry["dynamic"]> },
  store: LoopStoreLike,
  triggerSystem: TriggerSystemLike,
): { applied: boolean; message: string } {
  const status = params.status === "completed" ? "completed" : "paused";
  const applied = store.stopDynamic(params.id, status, {
    status: entry.status,
    iteration: entry.dynamic.iteration ?? 0,
    updatedAt: entry.updatedAt,
  });
  if (!applied) {
    return { applied: false, message: `Loop #${params.id} changed while the update was applied; inspect LoopList and retry.` };
  }
  triggerSystem.remove(params.id);
  return {
    applied: true,
    message: status === "completed" ? `Dynamic loop #${params.id} completed and deleted` : `Dynamic loop #${params.id} paused`,
  };
}

export function registerLoopTools(options: LoopToolsOptions): void {
  const {
    pi,
    getStore,
    getTriggerSystem,
    getScheduler,
    getMonitorManager,
    updateWidget,
    maybeBootstrapTaskLoop,
    isTaskSystemReady,
    onDynamicLoopActivated,
  } = options;

  pi.registerTool({
    name: "LoopCreate",
    label: "LoopCreate",
    renderCall: renderToolCall("Loop", (args) => `create · ${String(toolArg(args, "prompt") ?? "scheduled work").slice(0, 56)}`),
    renderResult: renderToolResult,
    description: `Create a persistent cron, event, hybrid, or idle-driven loop for recurring checks, reminders, event reactions, or task-backlog processing.

## When to Use
- Set up a recurring check (e.g. poll a build every 5m, run a health probe every hour).
- React to a specific pi event source (e.g. \`tool_execution_start\`, \`tasks:created\`, \`monitor:done\`).
- Adopt a task backlog until it drains (use \`trigger: "tasks:created"\`, \`taskBacklog: true\`, \`recurring: true\`).
- Drive an idle-paced continuation (use \`trigger: "idle"\` with \`triggerType: "idle"\`).
- Run a long-running autonomous task across multiple sessions (use \`isolation: "sub-agent"\`).

## When NOT to Use
- For one-off work or shell sleep/while loops — finish inline instead.
- After a normal fire, an unchanged check, or one completed iteration — a completed iteration, unchanged result, or temporarily empty check is not a reason to delete the loop. Recurring loops persist; dynamic loops advance through LoopUpdate.
- For taskBacklog loops — do not instruct the agent to delete the loop; pi-loop auto-deletes it when the pending count reaches zero.`,
    promptGuidelines: [
      "Prefer event triggers over cron; use triggerType `idle` with trigger `idle` for agent-paced continuation.",
      "Always set maxFires on polling loops and readOnly for observation-only work.",
      "For autonomous backlogs use event `tasks:created`, recurring true, taskBacklog true, and bounded maxFires. It adopts unfinished tasks until terminal. Do not use autoTask.",
      "Recurring loops are persistent controllers. Do not delete a loop after a normal fire, an unchanged check, or one completed iteration; only ask the user to delete via /loop's View-loops menu when the user explicitly asks to cancel or the loop's stated stop condition is satisfied.",
      "For taskBacklog loops, do not instruct the agent to delete the loop; pi-loop auto-deletes it when the pending count reaches zero.",
      "Report the created loop ID to the user.",
    ],
    parameters: Type.Object({
      trigger: Type.String({ description: "Cron expression (e.g., '5m', '1h', '0 9 * * 1-5'), event source (e.g., 'tool_execution_start'), hybrid spec, or literal 'idle' with triggerType='idle'" }),
      prompt: Type.String({ description: "Prompt to run when the loop fires" }),
      recurring: Type.Optional(Type.Boolean({ description: "Whether loop repeats (default: true)", default: true })),
      autoTask: Type.Optional(Type.Boolean({ description: "Auto-create pi-tasks task on fire", default: false })),
      taskBacklog: Type.Optional(Type.Boolean({ description: "Mark as a task-backlog worker loop that auto-deletes when pending tasks reach zero", default: false })),
      triggerType: Type.Optional(Type.String({ description: "cron, event, hybrid, or idle (cron/event inferred from trigger string if omitted)", enum: ["cron", "event", "hybrid", "idle"] })),
      debounceMs: Type.Optional(Type.Number({ description: "Debounce for hybrid triggers (default: 30000)", default: 30000 })),
      readOnly: Type.Optional(Type.Boolean({ description: "Restrict the agent to read-only tools when this loop fires (default: false)", default: false })),
      maxFires: Type.Optional(Type.Integer({ description: "Auto-stop after N fires. Prevents infinite token burn on polling loops.", minimum: 1 })),
      priority: Type.Optional(Type.Union(
        [
          Type.Literal("defer"),
          Type.Literal("normal"),
          Type.Literal("urgent"),
          Type.Literal("critical"),
        ],
        {
          description: "Delivery priority: defer, normal, urgent, critical (default: normal). Defer notifications are held until all higher-priority notifications are delivered.",
          default: "normal",
        },
      )),
      isolation: Type.Optional(Type.Union([Type.Literal("in-process"), Type.Literal("sub-agent")], {
        description: "Execution mode. 'in-process' (default) injects each fire as a turn in the parent session. 'sub-agent' spawns a fresh child pi session with its own context window; only a one-line summary enters the parent.",
        default: "in-process",
      })),
      goal: Type.Optional(Type.String({ description: "Free-text description of the loop's purpose (sub-agent loops only). Surface-only; not evaluated by the runtime.", maxLength: 1000 })),
      successCriteria: Type.Optional(Type.String({ description: "Regex matched against the child's result.md; iteration is 'succeeded_by_criteria' when matched (sub-agent loops only).", maxLength: 2000 })),
      failureCriteria: Type.Optional(Type.String({ description: "Regex matched against the child's result.md; iteration is 'failed_by_criteria' when matched (sub-agent loops only).", maxLength: 2000 })),
      stateFile: Type.Optional(Type.String({ description: "Relative path to a JSON file the child reads/writes for cross-iteration state (sub-agent loops only).", maxLength: 1000 })),
      subAgentModel: Type.Optional(Type.String({ description: "Model for the sub-agent child (sub-agent loops only)." })),
      subAgentMaxTokens: Type.Optional(Type.Integer({ description: "Cumulative token budget across all iterations of this sub-agent loop. Loop is paused when reached.", minimum: 1 })),
      subAgentMaxIterations: Type.Optional(Type.Integer({ description: "Max iterations for this sub-agent loop. Loop is paused when reached.", minimum: 1 })),
      subAgentIterationTimeoutMs: Type.Optional(Type.Integer({ description: "Wall-clock timeout for one child iteration, in ms. Default 600,000 (10 min).", minimum: 1 })),
    }),
    async execute(_toolCallId, params) {
      const { trigger: triggerInput, prompt, recurring, autoTask, taskBacklog, triggerType, debounceMs, readOnly, maxFires, priority,
        isolation, goal, successCriteria, failureCriteria, stateFile,
        subAgentModel, subAgentMaxTokens, subAgentMaxIterations, subAgentIterationTimeoutMs } = params;

      let trigger: Trigger;
      const inferred = triggerType ?? inferTriggerType(triggerInput);

      if (inferred === "idle") {
        if (triggerInput.trim().toLowerCase() !== "idle") {
          const message = 'Idle loops require trigger "idle" with triggerType "idle".';
          return Promise.resolve(textResult(message, {
            kind: "loop",
            action: "create",
            tone: "error",
            summary: "Idle loop was not created",
            expanded: [message],
          }));
        }
        trigger = { type: "dynamic" };
      } else if (inferred === "cron") {
        const parsed = parseInterval(triggerInput);
        trigger = { type: "cron", schedule: parsed.cron };
      } else if (inferred === "event") {
        trigger = { type: "event", source: triggerInput };
      } else {
        const cronPart = triggerInput.match(/cron:?\s*(\S+)/)?.[1] || triggerInput;
        const eventPart = triggerInput.match(/event:?\s*(\S+)/)?.[1];
        const parsed = parseInterval(cronPart);
        trigger = {
          type: "hybrid",
          cron: parsed.cron,
          event: { source: eventPart || "tool_execution_start" },
          debounceMs: debounceMs ?? 30000,
        };
      }

      const validationError = validateTrigger(trigger);
      if (validationError) {
        return Promise.resolve(textResult(validationError, {
          kind: "loop",
          action: "create",
          tone: "error",
          summary: "Loop was not created",
          expanded: [validationError],
        }));
      }
      let backlogEventSource: string | undefined;
      if (trigger.type === "event") backlogEventSource = trigger.source;
      else if (trigger.type === "hybrid") backlogEventSource = trigger.event.source;
      let backlogError: string | undefined;
      if (taskBacklog && recurring === false) backlogError = "taskBacklog loops must be recurring.";
      else if (taskBacklog && backlogEventSource !== "tasks:created") {
        backlogError = 'taskBacklog loops require a "tasks:created" event trigger.';
      }
      if (backlogError) {
        return Promise.resolve(textResult(backlogError, {
          kind: "loop",
          action: "create",
          tone: "error",
          summary: "Backlog loop was not created",
          expanded: [backlogError],
        }));
      }

      // Build the subAgent sub-object only when at least one field is set.
      const subAgentOpts: LoopSubAgentConfig = {};
      if (subAgentModel) subAgentOpts.model = subAgentModel;
      if (subAgentMaxTokens !== undefined) subAgentOpts.maxTokens = subAgentMaxTokens;
      if (subAgentMaxIterations !== undefined) subAgentOpts.maxIterations = subAgentMaxIterations;
      if (subAgentIterationTimeoutMs !== undefined) subAgentOpts.iterationTimeoutMs = subAgentIterationTimeoutMs;
      const hasSubAgent = Object.keys(subAgentOpts).length > 0;
      if (isolation === "sub-agent" && (goal || successCriteria || failureCriteria || stateFile)) {
        // These fields are sub-agent-only; valid even with no subAgent overrides.
      } else if (isolation !== "sub-agent" && (goal || successCriteria || failureCriteria || stateFile || hasSubAgent)) {
        return Promise.resolve(textResult(
          "goal, successCriteria, failureCriteria, stateFile, and subAgent.* fields require isolation: 'sub-agent'.",
          {
            kind: "loop", action: "create", tone: "error",
            summary: "Sub-agent fields used without isolation: 'sub-agent'",
            expanded: ["Set `isolation: 'sub-agent'` or drop the sub-agent-only fields."],
          },
        ));
      }

      const entry = getStore().create(trigger, prompt, {
        recurring: taskBacklog ? true : recurring ?? (inferred !== "event"),
        autoTask,
        taskBacklog,
        readOnly,
        maxFires: maxFires ?? (taskBacklog ? 25 : undefined),
        priority: priority ?? "normal",
        dynamic: trigger.type === "dynamic"
          ? { goal: prompt, iteration: 0 }
          : undefined,
        isolation: isolation ?? "in-process",
        ...(goal !== undefined ? { goal } : {}),
        ...(successCriteria !== undefined ? { successCriteria } : {}),
        ...(failureCriteria !== undefined ? { failureCriteria } : {}),
        ...(stateFile !== undefined ? { stateFile } : {}),
        ...(hasSubAgent ? { subAgent: subAgentOpts } : {}),
      });

      getTriggerSystem().add(entry);
      if (trigger.type === "dynamic") onDynamicLoopActivated?.(entry);

      if (trigger.type === "event" && trigger.source === "monitor:done" && trigger.filter) {
        try {
          const filterObj = JSON.parse(trigger.filter);
          const monitorId = filterObj.monitorId as string | undefined;
          if (monitorId) {
            const monitor = getMonitorManager().get(monitorId);
            if (monitor && monitor.status !== "running") {
              getTriggerSystem().remove(entry.id);
              getStore().delete(entry.id);
            }
          }
        } catch {
          // ignore malformed monitor filter; loop remains registered
        }
      }

      const bootstrapped = await maybeBootstrapTaskLoop(entry);
      updateWidget();

      const triggerDesc = trigger.type === "dynamic" ? "idle-driven" : formatTrigger(trigger, "create");
      const isolationDesc = entry.isolation === "sub-agent" ? " (sub-agent mode)" : "";

      return Promise.resolve(textResult(
        `Loop #${entry.id} created: ${entry.prompt.slice(0, 60)}\n` +
        `Trigger: ${triggerDesc}\n` +
        `Recurring: ${entry.recurring}\n` +
        (entry.isolation === "sub-agent" ? `Mode: sub-agent${isolationDesc}\n` : "") +
        (entry.goal ? `Goal: ${entry.goal}\n` : "") +
        (trigger.type === "dynamic" ? "Wake: when idle (first wake queued now)\n" : "") +
        (entry.autoTask ? "Auto-create task: enabled\n" : "") +
        (entry.taskBacklog ? "Backlog worker: enabled\n" : "") +
        (bootstrapped ? "Backlog: initial wake queued for existing pending tasks\n" : "") +
        (isTaskSystemReady() ? "" : "Task system: not ready yet — autoTask may not fire until native fallback or pi-tasks becomes available\n") +
        `ID: ${entry.id} (persists until explicitly canceled or a configured stop condition is met)`,
        {
          kind: "loop",
          action: "create",
          tone: "success",
          summary: `Loop #${entry.id} active · ${triggerDesc}${isolationDesc}`,
          expanded: [
            `Goal: ${entry.prompt}`,
            `Trigger: ${triggerDesc}`,
            entry.isolation === "sub-agent" ? "Mode: sub-agent (each fire spawns a child process)" : "Mode: in-process",
            entry.autoTask ? "Auto-task: enabled" : "Auto-task: off",
          ],
        },
      ));
    },
  });

  pi.registerTool({
    name: "LoopList",
    label: "LoopList",
    renderCall: renderToolCall("Loop", () => "status"),
    renderResult: renderToolResult,
    description: `List all stored loops with their IDs, statuses, triggers, and next-fire times.

## When to Use
- Before creating a new loop, to avoid duplicates.
- To find a loop ID for LoopPause, LoopResume, LoopUpdate, LoopInspect, or for a user-driven deletion via the /loop command.
- After a process restart, to confirm which loops survived and which need /loop-activate.

## When NOT to Use
- To inspect a sub-agent loop's last iteration — use LoopInspect instead, which returns the structured summary from the result-store.
- To read the full result of a sub-agent iteration — open \`.pi/loops/sub-agent-results/<id>/iter-*/result.json\` directly.`,
    parameters: Type.Object({}),
    execute() {
      const loops = getStore().list();
      if (loops.length === 0) {
        return Promise.resolve(textResult("No loops configured. Use LoopCreate to set up a schedule.", {
          kind: "loop", action: "list", tone: "info", summary: "No loops", expanded: ["Use LoopCreate to set up a schedule."],
        }));
      }

      const lines: string[] = [];
      for (const entry of loops) {
        const triggerDesc = formatTrigger(entry.trigger, "list");

        const nextFire = entry.trigger.type === "cron" || entry.trigger.type === "hybrid" || entry.dynamic?.nextWakeAt !== undefined ? getScheduler().nextFire(entry.id) : undefined;
        const statusIcon = entry.status === "active" ? "*" : entry.status === "paused" ? "-" : "x";
        let line = `${statusIcon} #${entry.id} [${entry.status}] ${entry.prompt.slice(0, 60)}`;
        line += ` (${triggerDesc})`;
        if (nextFire) {
          const remaining = Math.max(0, nextFire - Date.now());
          line += ` next: ${formatRemaining(remaining)}`;
        }
        if (entry.status === "active") {
          line += ` age: ${formatRemaining(Math.max(0, Date.now() - entry.createdAt))}`;
        }
        if (entry.autoTask) line += " [auto-task]";
        if (entry.taskBacklog) line += " [backlog-worker]";
        if (entry.workflow) {
          line += ` [workflow:${entry.workflow.currentState}]`;
          lines.push(formatWorkflowSummary(entry, line));
        } else {
          lines.push(line);
        }
      }

      return Promise.resolve(textResult(lines.join("\n"), {
        kind: "loop",
        action: "list",
        tone: "info",
        summary: `${loops.length} loop${loops.length === 1 ? "" : "s"} · ${loops.filter((entry) => entry.status === "active").length} active`,
        expanded: displayRows(lines),
      }));
    },
  });

  pi.registerTool({
    name: "LoopUpdate",
    label: "LoopUpdate",
    renderCall: renderToolCall("Loop", (args) => `update · #${String(toolArg(args, "id") ?? "?")} · ${String(toolArg(args, "status") ?? "continue")}`),
    renderResult: renderToolResult,
    description: `Update progress for a dynamic loop.

## When to Use
- After each dynamic-loop wake, exactly once. Mark \`status: "continue"\` with new state/metrics and an optional \`nextInterval\` whenever any work remains.
- When the dynamic loop's overall goal and done criteria are satisfied, mark \`status: "completed"\` — the loop is removed automatically.
- When the dynamic loop is genuinely blocked and cannot make progress, mark \`status: "paused"\`.

## When NOT to Use
- For cron, event, hybrid, or taskBacklog loops — they are not dynamic; LoopUpdate will reject them.
- For workflow-owned loops — use WorkflowTransition instead.
- To finish one step of a multi-step goal — use \`status: "continue"\` and let the next wake fire. Use \`status: "completed"\` only when the overall goal and done criteria are satisfied.`,
    parameters: Type.Object({
      id: Type.String({ description: "Dynamic loop ID to update" }),
      status: Type.String({ description: "continue, completed, or paused", enum: ["continue", "completed", "paused"] }),
      state: Type.Optional(Type.String({ description: "Current progress/state summary" })),
      metrics: Type.Optional(Type.String({ description: "Current metrics/check results" })),
      doneCriteria: Type.Optional(Type.String({ description: "Definition of done for the dynamic loop" })),
      nextInterval: Type.Optional(Type.String({ description: "When to wake next, e.g. 3m, 30s, 1h" })),
      prompt: Type.Optional(Type.String({ description: "Optional updated goal/prompt text" })),
    }),
    execute(_toolCallId, params: LoopUpdateParams) {
      const store = getStore();
      const triggerSystem = getTriggerSystem();
      const entry = store.get(params.id);
      if (!entry) {
        return Promise.resolve(textResult(`Loop #${params.id} not found`, {
          kind: "loop", action: "update", tone: "error", summary: `Loop #${params.id} not found`, expanded: ["Use LoopList to find valid loop IDs."],
        }));
      }
      if (entry.workflow) {
        const message = `Loop #${params.id} is workflow-owned. Use WorkflowTransition for state changes, or ask the user to delete it via /loop's View-loops menu.`;
        return Promise.resolve(textResult(message, {
          kind: "loop", action: "update", tone: "error", summary: `Loop #${params.id} update rejected`, expanded: [message],
        }));
      }
      if (entry.trigger.type !== "dynamic" || !entry.dynamic) {
        return Promise.resolve(textResult(`Loop #${params.id} is not a dynamic loop`, {
          kind: "loop", action: "update", tone: "error", summary: `Loop #${params.id} is not dynamic`, expanded: ["Use LoopUpdate only for dynamic loops."],
        }));
      }

      const dynamicEntry = entry as LoopEntry & { dynamic: NonNullable<LoopEntry["dynamic"]> };
      const outcome = params.status === "continue"
        ? continueDynamicLoop(params, dynamicEntry, store, triggerSystem)
        : stopDynamicLoop(params, dynamicEntry, store, triggerSystem);
      if (!outcome.applied) {
        return Promise.resolve(textResult(outcome.message, {
          kind: "loop", action: "update", tone: "error", summary: `Loop #${params.id} update rejected`, expanded: [outcome.message],
        }));
      }
      const message = outcome.message;
      updateWidget();
      const tone = params.status === "paused" ? "warning" : "success";
      const summary = params.status === "completed"
        ? `Loop #${params.id} completed`
        : params.status === "paused"
          ? `Loop #${params.id} paused`
          : `Loop #${params.id} updated`;
      return Promise.resolve(textResult(message, {
        kind: "loop",
        action: "update",
        tone,
        summary,
        expanded: params.status === "continue"
          ? [`State: ${params.state ?? entry.dynamic.state ?? "unchanged"}`, `Next wake: ${params.nextInterval ?? "when idle"}`]
          : [],
      }));
    },
  });

  pi.registerTool({
    name: "LoopPause",
    label: "LoopPause",
    renderCall: renderToolCall("Loop", (args) => `pause · #${String(toolArg(args, "id") ?? "?")}`),
    renderResult: renderToolResult,
    description: `Pause a loop by its ID. Pausing preserves the loop's history, trigger, and ID.

## When to Use
- The user explicitly asks to halt a loop.
- The loop's stated stop condition is satisfied and you want to keep the record for later.
- You need to change the loop's trigger or prompt and want to stop it firing mid-edit.
- The environment is broken (e.g. a target service is down) and you want to suspend without losing the schedule.

## When NOT to Use
- After a normal loop fire, an unchanged check, an empty iteration, or one step of a dynamic goal. Recurring loops remain active across iterations; dynamic loops use LoopUpdate.
- For dynamic loops mid-iteration — use LoopUpdate with \`status: "paused"\` instead.
- For one-time work — the loop should not have been created in the first place.
- Pausing is reversible: use LoopResume to make the loop active again.`,
    promptGuidelines: [
      "Pausing is reversible. Use LoopResume to make a paused loop active again.",
      "Pausing does not write to the session bindings file; that remains /loop-activate's job.",
      "Pausing tears down the trigger subscription so the loop will not fire until resumed.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Loop ID to pause" }),
    }),
    execute(_toolCallId, params) {
      const { id } = params;
      const entry = getStore().pause(id);
      if (!entry) {
        const tombstone = getStore().getDeletionTombstone(id);
        if (tombstone) {
          const msg = formatDeletionTombstone(id, tombstone);
          return Promise.resolve(textResult(msg, {
            kind: "loop", action: "pause", tone: "warning", summary: `Loop #${id} was already removed`, expanded: [msg],
          }));
        }
        return Promise.resolve(textResult(`Loop #${id} not found`, {
          kind: "loop", action: "pause", tone: "error", summary: `Loop #${id} not found`, expanded: ["Use LoopList to find valid loop IDs."],
        }));
      }
      getTriggerSystem().remove(id);
      updateWidget();
      return Promise.resolve(textResult(`Loop #${id} paused`, {
        kind: "loop", action: "pause", tone: "warning", summary: `Loop #${id} paused`, expanded: ["Use LoopList to inspect paused loops."],
      }));
    },
  });

  pi.registerTool({
    name: "LoopResume",
    label: "LoopResume",
    renderCall: renderToolCall("Loop", (args) => `resume · #${String(toolArg(args, "id") ?? "?")}`),
    renderResult: renderToolResult,
    description: `Resume a paused loop by its ID. Resuming flips status to "active" and re-arms the trigger.

## When to Use
- The user asks to make a previously paused loop active again.
- After a fix to the loop's prompt, trigger, or environment that made the user pause it.
- The blocked condition that triggered the pause has been resolved.

## When NOT to Use
- For a loop that was deleted — recreate it via LoopCreate or the /loop command.
- For cross-session re-arming after a process restart — this tool does NOT write to the session bindings file. Use /loop-activate <id> instead.`,
    promptGuidelines: [
      "Resuming is the inverse of pausing; use LoopPause to halt an active loop.",
      "Resuming does not write to the session bindings file; for that, use /loop-activate <id>.",
      "Resuming re-adds the loop to the trigger system so subscriptions (event sources, cron timers) are re-armed.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Loop ID to resume" }),
    }),
    execute(_toolCallId, params) {
      const { id } = params;
      const before = getStore().get(id);
      if (!before) {
        const tombstone = getStore().getDeletionTombstone(id);
        if (tombstone) {
          const msg = formatDeletionTombstone(id, tombstone);
          return Promise.resolve(textResult(msg, {
            kind: "loop", action: "resume", tone: "warning", summary: `Loop #${id} was already removed`, expanded: [msg],
          }));
        }
        return Promise.resolve(textResult(`Loop #${id} not found`, {
          kind: "loop", action: "resume", tone: "error", summary: `Loop #${id} not found`, expanded: ["Use LoopList to find valid loop IDs."],
        }));
      }
      const resumed = getStore().resume(id) ?? before;
      getTriggerSystem().add(resumed);
      if (resumed.trigger.type === "dynamic") onDynamicLoopActivated?.(resumed);
      updateWidget();
      const tone = resumed.status === "active" ? "success" : "warning";
      const summary = resumed.status === "active"
        ? `Loop #${id} resumed`
        : `Loop #${id} already active`;
      return Promise.resolve(textResult(`Loop #${id} resumed`, {
        kind: "loop", action: "resume", tone, summary, expanded: [`Status: ${resumed.status}`],
      }));
    },
  });

  // LoopInspect (v2.5+) — returns a structured summary of a loop's last
  // iteration. For sub-agent loops, the result-store has the full picture
  // (tokens, cost, status, preview). For in-process loops, the last
  // fireCount / updatedAt is returned instead. The optional iterId picks a
  // specific iteration; default is the most recent.
  pi.registerTool({
    name: "LoopInspect",
    label: "LoopInspect",
    renderCall: renderToolCall("Loop", (args) => `inspect · #${String(toolArg(args, "loopId") ?? "?")}${toolArg(args, "iterId") !== undefined ? ` iter-${String(toolArg(args, "iterId"))}` : ""}`),
    renderResult: renderToolResult,
    description: `Inspect a loop's latest iteration. Returns a structured summary so the agent can reason about its own loop runs without opening files.

## When to Use
- After a sub-agent loop completes, to read the outcome (status, tokens, cost, preview, error) before deciding what to do next.
- To inspect a specific iteration — pass \`iterId\`; default is the most recent.
- To inspect an in-process loop's last fireCount and updatedAt (limited summary).

## When NOT to Use
- For live state of all loops — use LoopList.
- To read a sub-agent's full result file — open \`.pi/loops/sub-agent-results/<id>/iter-*/result.json\` directly. The tool only returns a structured summary.`,
    promptGuidelines: [
      "Use LoopInspect after a sub-agent loop completes to read the outcome before deciding what to do next.",
      "For in-process loops, the iteration summary is intentionally minimal; use LoopList for live state.",
    ],
    parameters: Type.Object({
      loopId: Type.String({ description: "Loop ID to inspect" }),
      iterId: Type.Optional(Type.Integer({ description: "Iteration number (default: most recent)", minimum: 0 })),
    }),
    execute(_toolCallId, params) {
      const { loopId } = params;
      const entry = getStore().get(loopId);
      if (!entry) {
        return Promise.resolve(textResult(`Loop #${loopId} not found`, {
          kind: "loop", action: "inspect", tone: "error", summary: `Loop #${loopId} not found`, expanded: ["Use LoopList to find valid loop IDs."],
        }));
      }
      const summary: Record<string, unknown> = {
        loop: {
          id: entry.id,
          status: entry.status,
          isolation: entry.isolation ?? "in-process",
          priority: entry.priority ?? "normal",
          goal: entry.goal,
          successCriteria: entry.successCriteria,
          failureCriteria: entry.failureCriteria,
          stateFile: entry.stateFile,
          cumulativeTokens: entry.cumulativeTokens ?? 0,
          cumulativeCostUsd: entry.cumulativeCostUsd ?? 0,
          iterCount: entry.iterCount ?? 0,
          consecutiveFailures: entry.consecutiveFailures ?? 0,
        },
        iteration: entry.isolation === "sub-agent"
          ? "(read .pi/loops/sub-agent-results/<id>/iter-*/result.json directly — file paths are returned by the wake; no in-memory summary yet)"
          : {
              iterId: entry.fireCount ?? 0,
              status: "succeeded",
              startedAt: new Date(entry.updatedAt).toISOString(),
              finishedAt: new Date(entry.updatedAt).toISOString(),
              durationMs: 0,
              tokens: { in: 0, out: 0, total: 0 },
              costUsd: 0,
            },
      };
      return Promise.resolve(textResult(JSON.stringify(summary, null, 2), {
        kind: "loop", action: "inspect", tone: "info",
        summary: `Loop #${loopId} inspected`,
        expanded: [
          `Status: ${entry.status}`,
          `Mode: ${entry.isolation ?? "in-process"}`,
          `Iters: ${entry.iterCount ?? 0}`,
        ],
      }));
    },
  });
}
