import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatLastTransitionLines } from "../loop-format.js";
import type { LoopEntry, Trigger, WorkflowDefinition } from "../types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { validateWorkflowDefinition, type WorkflowTransitionFailure } from "../workflow-reducer.js";
import { textResult } from "./tool-result.js";

interface WorkflowStoreLike {
  get(id: string): LoopEntry | undefined;
  create(trigger: Trigger, prompt: string, opts: {
    recurring: boolean;
    maxFires?: number;
    dynamic?: Partial<NonNullable<LoopEntry["dynamic"]>>;
    workflow?: WorkflowDefinition;
  }): LoopEntry;
  pause(id: string): LoopEntry | undefined;
  transitionWorkflow(id: string, input: { outcome: string; evidence?: string; activeTaskId?: string }): {
    entry?: LoopEntry;
    applied: boolean;
    error?: string;
    failure?: WorkflowTransitionFailure;
    terminal?: "completed" | "paused";
  };
  setWorkflowActiveTask(id: string, taskId?: string): LoopEntry | undefined;
  delete(id: string): boolean;
}

interface TriggerSystemLike {
  add(entry: LoopEntry): void;
  remove(id: string): void;
}

export interface WorkflowToolsOptions {
  pi: ExtensionAPI;
  getStore: () => WorkflowStoreLike;
  getTriggerSystem: () => TriggerSystemLike;
  updateWidget: () => void;
  onDynamicLoopActivated?: (entry: LoopEntry) => void;
  createWorkflowTask?: (entry: LoopEntry) => Promise<string | undefined>;
  completeWorkflowTask?: (taskId: string) => Promise<boolean>;
}

function parseWorkflowDefinition(input: string): { definition?: WorkflowDefinition; error?: string } {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Workflow definition must be a JSON object" };
    }
    const definition = parsed as WorkflowDefinition;
    const validationError = validateWorkflowDefinition(definition);
    return validationError ? { error: validationError } : { definition };
  } catch {
    return { error: "Workflow definition must be valid JSON" };
  }
}

const WORKFLOW_DEFINITION_EXAMPLE =
  '{"version":1,"initialState":"investigate","states":{"investigate":{"prompt":"Investigate the issue.","on":{"found":"done"}},"done":{"prompt":"Report completion.","terminal":"completed"}}}';

function formatWorkflowDefinitionError(error: string | undefined): string {
  return `Workflow definition rejected: ${error ?? "unknown validation error"}\n` +
    "Required fields: version: 1, initialState, and states.\n" +
    `Example definition:\n${WORKFLOW_DEFINITION_EXAMPLE}\n` +
    "Next: correct the JSON and call WorkflowCreate again.";
}

export function formatWorkflowSummary(entry: LoopEntry, heading: string, failure?: WorkflowTransitionFailure): string {
  const workflow = entry.workflow!;
  const state = workflow.definition.states[workflow.currentState];
  const outcomeEntries = Object.entries(state?.on ?? {});
  const unavailableOutcomes = failure?.code === "target_exhausted"
    ? outcomeEntries.filter(([, target]) => target === failure.targetState).map(([outcome]) => outcome)
    : [];
  const outcomes = outcomeEntries
    .filter(([outcome]) => !unavailableOutcomes.includes(outcome))
    .map(([outcome]) => outcome);
  let message = `${heading}\nGoal: ${entry.prompt}\nCurrent state: ${workflow.currentState}`;
  if (workflow.lastTransition) message += `\n${formatLastTransitionLines(workflow.lastTransition).join("\n")}`;
  if (state?.prompt) message += `\nInstruction: ${state.prompt}`;
  if (workflow.activeTaskId) {
    message += `\nActive task: #${workflow.activeTaskId}`;
  } else if (state?.task) {
    message += "\nTask: no task was created for this state";
  } else {
    message += "\nTask: none configured for this state";
  }

  if (failure?.code === "target_exhausted") {
    message += `\nUnavailable outcome${unavailableOutcomes.length === 1 ? "" : "s"}: ${unavailableOutcomes.join(", ")} — target state "${failure.targetState}" exhausted its ${failure.maxAttempts} attempt limit.`;
  }
  if (state?.terminal) return `${message}\nTerminal: ${state.terminal}`;
  if (outcomeEntries.length === 0) return `${message}\nNeeds attention: this state has no declared outcomes, so it cannot advance.`;
  if (outcomes.length === 0) {
    return `${message}\nBlocked: all declared outcomes are unavailable. Pause this workflow with LoopDelete action="pause", or abandon it with LoopDelete.`;
  }

  return `${message}\nChoose outcome: ${outcomes.join(", ")}\nNext: WorkflowTransition({ id: "${entry.id}", outcome: "${outcomes[0]}", evidence: "..." })`;
}

export function registerWorkflowTools(options: WorkflowToolsOptions): void {
  const {
    pi,
    getStore,
    getTriggerSystem,
    updateWidget,
    onDynamicLoopActivated,
    createWorkflowTask,
    completeWorkflowTask,
  } = options;

  pi.registerTool({
    name: "WorkflowCreate",
    label: "WorkflowCreate",
    renderCall: renderToolCall("Workflow", (args) => `create · ${String(toolArg(args, "goal") ?? "workflow").slice(0, 56)}`),
    renderResult: renderToolResult,
    description: `Create an opt-in task-driven workflow loop from a JSON state definition.

Use this when work has named phases and explicit outcomes, such as investigate → fix → validate. Use LoopCreate for ordinary scheduled/event work and TaskCreate for a normal flat backlog.

The definition requires version: 1, a non-terminal initialState, and states. Each state has a prompt, optional task: {subject, description} (a tracked task created when the state is entered and completed on transition), an optional on outcome-to-state map, optional maxAttempts, and an optional terminal value of completed or paused. Terminal states are final and cannot be resumed.`,
    promptGuidelines: [
      "Use WorkflowCreate only for explicit multi-phase work with stable named outcomes; ordinary reminders, polling, and task backlogs should remain loops or tasks.",
      "Pass `definition` as valid JSON with a non-terminal initialState. Give each non-terminal state a concise prompt and explicit outcome names.",
      "Each non-terminal state may declare `task: {subject, description}`; the runtime creates a tracked task when the state is entered and completes it when you transition out.",
      "Model rework with outcome cycles and bound re-entry with maxAttempts.",
      "After each workflow wake, call WorkflowTransition with the workflow `id` and one declared `outcome`; include concise `evidence`.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "Overall workflow goal" }),
      definition: Type.String({ description: "Workflow JSON: version, initialState, and named states" }),
      maxFires: Type.Optional(Type.Number({ description: "Maximum workflow wakes before automatic expiry (default: 30)", default: 30 })),
    }),
    async execute(_toolCallId, params) {
      const parsed = parseWorkflowDefinition(params.definition);
      if (!parsed.definition) {
        const message = formatWorkflowDefinitionError(parsed.error);
        return textResult(message, {
          kind: "workflow",
          action: "create",
          tone: "error",
          summary: "Workflow definition rejected",
          expanded: [parsed.error ?? "unknown validation error", "Expand the tool result for a valid definition skeleton."],
        });
      }

      let entry = getStore().create({ type: "dynamic" }, params.goal, {
        recurring: true,
        maxFires: params.maxFires ?? 30,
        dynamic: { goal: params.goal, state: parsed.definition.initialState, iteration: 0 },
        workflow: parsed.definition,
      });
      const taskId = await createWorkflowTask?.(entry);
      if (taskId) entry = getStore().setWorkflowActiveTask(entry.id, taskId) ?? entry;
      getTriggerSystem().add(entry);
      updateWidget();
      onDynamicLoopActivated?.(entry);
      return textResult(
        `${formatWorkflowSummary(entry, `Workflow #${entry.id} created — ${entry.status}`)}\nWake: the state instruction will be delivered when the agent becomes idle.`,
        {
          kind: "workflow",
          action: "create",
          tone: "success",
          summary: `Workflow #${entry.id} active · ${parsed.definition.initialState}${taskId ? ` · task #${taskId}` : ""}`,
          expanded: [
            `Goal: ${entry.prompt}`,
            `State: ${parsed.definition.initialState}`,
            `Outcome: ${Object.keys(parsed.definition.states[parsed.definition.initialState]?.on ?? {}).join(", ") || "none"}`,
            "Wake: delivered when the agent becomes idle",
          ],
        },
      );
    },
  });

  pi.registerTool({
    name: "WorkflowTransition",
    label: "WorkflowTransition",
    renderCall: renderToolCall("Workflow", (args) => `transition · #${String(toolArg(args, "id") ?? "?")} → ${String(toolArg(args, "outcome") ?? "?")}`),
    renderResult: renderToolResult,
    description: "Advance a workflow using one declared outcome. Call exactly once after its current state; pass id, outcome, and concise evidence.",
    promptGuidelines: [
      "WorkflowTransition uses `id`, not `loopId`.",
      "Use an exact declared outcome and include evidence. Inspect LoopList when the current state is unclear.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Workflow loop ID" }),
      outcome: Type.String({ description: "Declared outcome for the current workflow state" }),
      evidence: Type.Optional(Type.String({ description: "Concise evidence supporting this transition" })),
      activeTaskId: Type.Optional(Type.String({ description: "Optional task ID now active in the destination state" })),
    }),
    async execute(_toolCallId, params) {
      const store = getStore();
      const sourceTaskId = store.get(params.id)?.workflow?.activeTaskId;
      const result = store.transitionWorkflow(params.id, params);
      if (!result.applied || !result.entry) {
        const current = store.get(params.id);
        if (current?.workflow) {
          const error = result.error ?? "unknown transition error";
          return textResult(
            `Workflow #${params.id} did not transition\nReason: ${error}\n${formatWorkflowSummary(current, `Workflow #${params.id} remains — ${current.status}`, result.failure)}`,
            { kind: "workflow", action: "transition", tone: "error", summary: `Workflow #${params.id} remains in ${current.workflow.currentState}`, expanded: [error] },
          );
        }
        return textResult(result.error ?? `Workflow loop #${params.id} did not transition`);
      }

      const entry = result.entry;
      getTriggerSystem().remove(entry.id);
      const sourceTaskClosed = sourceTaskId ? await completeWorkflowTask?.(sourceTaskId) : undefined;
      if (result.terminal === "completed") {
        store.delete(entry.id);
        updateWidget();
        return textResult(
          `Workflow #${entry.id} completed and deleted\nFinal transition: ${entry.workflow?.lastTransition?.from ?? "?"} → ${entry.workflow?.currentState ?? "?"}\nNext: no further workflow transition is needed.`,
          {
            kind: "workflow", action: "transition", tone: "success",
            summary: `Workflow #${entry.id} completed${sourceTaskClosed ? ` · task #${sourceTaskId} closed` : ""}`,
            expanded: [
              `Final transition: ${entry.workflow?.lastTransition?.from ?? "?"} → ${entry.workflow?.currentState ?? "?"}`,
              sourceTaskId ? `Source task #${sourceTaskId}: ${sourceTaskClosed ? "completed" : "not completed"}` : "Source task: none",
            ],
          },
        );
      }
      if (result.terminal === "paused") {
        store.pause(entry.id);
        updateWidget();
        return textResult(
          `Workflow #${entry.id} paused\nFinal state: ${entry.workflow?.currentState ?? "?"}\nNext: inspect it with LoopList. Terminal workflow states cannot be resumed; delete the loop when it is no longer needed.`,
          {
            kind: "workflow", action: "transition", tone: "warning",
            summary: `Workflow #${entry.id} paused · ${entry.workflow?.currentState ?? "?"}`,
            expanded: [
              sourceTaskId ? `Source task #${sourceTaskId}: ${sourceTaskClosed ? "completed" : "not completed"}` : "Source task: none",
              "Inspect LoopList before deleting this terminal workflow.",
            ],
          },
        );
      }

      const taskId = await createWorkflowTask?.(entry);
      const updatedEntry = taskId ? store.setWorkflowActiveTask(entry.id, taskId) ?? entry : entry;
      getTriggerSystem().add(updatedEntry);
      updateWidget();
      const from = updatedEntry.workflow?.lastTransition?.from ?? "?";
      const to = updatedEntry.workflow?.currentState ?? "?";
      return textResult(
        `Workflow #${updatedEntry.id} advanced: ${from} → ${to}\n${formatWorkflowSummary(updatedEntry, `Workflow #${updatedEntry.id} — ${updatedEntry.status}`)}`,
        {
          kind: "workflow", action: "transition", tone: "success",
          summary: `Workflow #${updatedEntry.id} · ${from} → ${to}${taskId ? ` · task #${taskId}` : ""}`,
          expanded: [
            `Instruction: ${updatedEntry.workflow?.definition.states[to]?.prompt ?? ""}`,
            `Outcome: ${Object.keys(updatedEntry.workflow?.definition.states[to]?.on ?? {}).join(", ") || "none"}`,
            sourceTaskId ? `Source task #${sourceTaskId}: ${sourceTaskClosed ? "completed" : "not completed"}` : "Source task: none",
          ],
        },
      );
    },
  });
}
