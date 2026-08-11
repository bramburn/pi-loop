import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createCoordinator,
  type ReducerEffect,
  type ReducerEvent,
  type ReducerHandler,
} from "../coordinator.js";
import { formatLastTransitionLines, formatTrigger } from "../loop-format.js";
import {
  type NotificationReducerEvent,
  type NotificationReducerState,
  type ReducerNotification,
  reduceNotificationState,
} from "../notification-reducer.js";
import type { DynamicLoopState, LoopPriority, Trigger, WorkflowRunState } from "../types.js";
import { getWorkflowOutcomeAvailability } from "../workflow-reducer.js";

export interface LoopFireEvent {
  loopId: string;
  prompt: string;
  trigger: Trigger | string;
  timestamp: number;
  readOnly?: boolean;
  recurring?: boolean;
  persistent?: boolean;
  autoTask?: boolean;
  taskBacklog?: boolean;
  priority?: LoopPriority;
  dynamic?: DynamicLoopState;
  workflow?: WorkflowRunState;
}

export interface PendingNotification extends LoopFireEvent {
  key: string;
  message: string;
  fireCount?: number;
  firstFireAt?: number;
  lastFireAt?: number;
}

export interface MonitorStartedEvent {
  monitorId: string;
  command: string;
  description?: string;
  timestamp: number;
}

export interface NotificationRuntimeOptions {
  pi: ExtensionAPI;
  hasPendingTasks: () => Promise<number>;
  cleanDoneTasks: () => Promise<void>;
  getHasPendingMessages: () => boolean;
  getFlushThresholds: () => { defer: number; normal: number; urgent: number; critical: number };
  debug?: (...args: unknown[]) => void;
}

export interface NotificationRuntime {
  syncRuntimeState(options?: { agentRunning?: boolean; hasPendingMessages?: boolean }): void;
  queueOrDeliverNotification(data: LoopFireEvent): Promise<void>;
  queueOrDeliverMonitorStarted(data: MonitorStartedEvent): Promise<void>;
  discardMonitorStarted(monitorId: string): void;
  flushPendingNotifications(options?: { ignorePendingMessages?: boolean }): Promise<void>;
  dispatchUrgentFlush(): Promise<void>;
  clear(reason: "session_shutdown" | "session_switch"): void;
}

export function createNotificationRuntime(options: NotificationRuntimeOptions): NotificationRuntime {
  const { pi, hasPendingTasks, cleanDoneTasks, getHasPendingMessages, getFlushThresholds, debug } = options;

  let notificationState: NotificationReducerState = {
    notificationsByKey: {},
    agentRunning: false,
    hasPendingMessages: false,
  };
  let flushPromise: Promise<void> | undefined;

  type NotificationDispatchResult = {
    kind: "delivery";
    delivered: boolean;
  };

  const notificationReducerHandler: ReducerHandler = (incoming: ReducerEvent) => {
    const result = reduceNotificationState(notificationState, incoming as NotificationReducerEvent);
    notificationState = result.state;
    return result.effects;
  };

  const notificationCoordinator = createCoordinator<NotificationDispatchResult>({
    reducers: [notificationReducerHandler],
    effectHandlers: {
      REQUEST_NOTIFICATION_FLUSH: () => {},
      DELIVER_NOTIFICATION: async (effect: ReducerEffect) => ({
        kind: "delivery",
        delivered: await deliverNotification(
          (effect.payload as { notification: ReducerNotification }).notification,
        ),
      }),
    },
  });

  function applyNotificationEvent(event: NotificationReducerEvent) {
    const result = reduceNotificationState(notificationState, event);
    notificationState = result.state;
    return result;
  }

  function syncRuntimeState(options?: { agentRunning?: boolean; hasPendingMessages?: boolean }) {
    applyNotificationEvent({
      type: "NOTIFICATION_RUNTIME_UPDATED",
      at: Date.now(),
      source: "system",
      entityType: "notification",
      payload: {
        agentRunning: options?.agentRunning ?? notificationState.agentRunning,
        hasPendingMessages: options?.hasPendingMessages ?? getHasPendingMessages(),
      },
    });
  }

  function buildLoopFireMessage(data: LoopFireEvent): string {
    const triggerInfo = formatTrigger(data.trigger, "notification");

    const loopId = data.loopId || "?";
    const prompt = data.prompt || "loop fired";
    const constraint = data.readOnly
      ? "\n\nREAD-ONLY MODE — use only read tools (Read, TaskList, LoopList, MonitorList, etc.). No file writes, shell execution, or destructive changes."
      : "";

    if (data.workflow) {
      const state = data.workflow.definition.states[data.workflow.currentState];
      const availability = getWorkflowOutcomeAvailability(data.workflow);
      const outcomes = availability.available;
      const attempt = data.workflow.attemptsByState[data.workflow.currentState] ?? 1;
      const attemptLabel = state?.maxAttempts ? `${attempt}/${state.maxAttempts}` : String(attempt);
      const lines = [
        `[pi-loop] Loop #${loopId} fired (workflow).${constraint}`,
        `Goal: ${data.prompt || data.workflow.definition.initialState}`,
        `State: ${data.workflow.currentState}`,
        `Attempt: ${attemptLabel}`,
      ];
      if (data.workflow.lastTransition) {
        lines.push(...formatLastTransitionLines(data.workflow.lastTransition));
      }
      if (state?.prompt) lines.push(`State instructions: ${state.prompt}`);
      if (data.workflow.activeTaskId) {
        lines.push(
          `Active task: #${data.workflow.activeTaskId}`,
          `State task lifecycle: Task #${data.workflow.activeTaskId} is workflow-owned. Claim it before work and retain the returned claimId. Do not complete or close it with TaskUpdate; call WorkflowTransition with claimId: "<returned claimId>". WorkflowTransition settles this attempt and creates the next linked task.`,
        );
      }
      if (outcomes.length > 0) lines.push(`Allowed outcomes: ${outcomes.join(", ")}`);
      if (availability.unavailable.length > 0) {
        lines.push(`Unavailable outcomes: ${availability.unavailable.map((item) => item.outcome).join(", ")} (attempt limit reached)`);
      }
      if (state?.terminal) {
        lines.push(`Terminal: ${state.terminal} — this workflow state is terminal; no transition is needed.`);
      } else {
        lines.push(
          `Workflow lifecycle: Loop #${loopId} is an opt-in state controller. Do not call LoopDelete after this state.`,
          "Before ending this turn, call WorkflowTransition exactly once with id, one allowed outcome, evidence, and the returned claimId when an active task exists. WorkflowTransition does not accept activeTaskId. Terminal outcomes complete or pause the workflow automatically.",
        );
      }
      return lines.join("\n");
    }

    if (data.dynamic || (typeof data.trigger !== "string" && data.trigger?.type === "dynamic")) {
      const dynamic = data.dynamic;
      const lines = [
        `[pi-loop] Loop #${loopId} fired (dynamic).${constraint}`,
        `Goal: ${dynamic?.goal ?? prompt}`,
        `Iteration: ${dynamic?.iteration ?? 0}`,
      ];
      if (dynamic?.state) lines.push(`State: ${dynamic.state}`);
      if (dynamic?.metrics) lines.push(`Metrics: ${dynamic.metrics}`);
      if (dynamic?.doneCriteria) lines.push(`Done criteria: ${dynamic.doneCriteria}`);
      lines.push(
        `Loop lifecycle: Loop #${loopId} is the persistent controller for the overall goal. Do not call LoopDelete after this iteration.`,
        "Before ending this turn, call LoopUpdate exactly once: use status=\"completed\" only when the overall goal and done criteria are satisfied; use status=\"continue\" when any work remains, with state/metrics and optional nextInterval; use status=\"paused\" only when genuinely blocked. Omit nextInterval for an idle-driven rewake.",
      );
      return lines.join("\n");
    }

    const lifecycle = data.taskBacklog
      ? `Backlog lifecycle: Loop #${loopId} adopts unfinished tasks and re-wakes after this turn while work and its fire budget remain. Do not call LoopDelete; when no unfinished tasks remain, report that and end this iteration.`
      : (data.persistent ?? data.recurring)
        ? `Loop lifecycle: Loop #${loopId} is recurring and remains active after this iteration. Do not call LoopDelete or pause it merely because this run finished, found no changes, or has no immediate work. Stop it only when the user or the loop prompt explicitly requires cancellation.`
        : `Loop lifecycle: Loop #${loopId} is a one-shot wake and cleanup is automatic. Do not call LoopDelete.`;

    return [
      `[pi-loop] Loop #${loopId} fired (${triggerInfo}).${constraint}`,
      prompt,
      lifecycle,
    ].join("\n");
  }

  function buildPendingNotification(data: LoopFireEvent): PendingNotification {
    // Use timestamp-in-key for ALL fires so each fire of a recurring loop gets a
    // unique queue entry. fireCount is tracked on the notification itself for
    // the agent to observe.
    const key = `loop:${data.loopId}:${data.timestamp}`;
    return {
      ...data,
      key,
      fireCount: 1,
      firstFireAt: data.timestamp,
      lastFireAt: data.timestamp,
      message: buildLoopFireMessage(data),
    };
  }

  function buildMonitorStartedNotification(data: MonitorStartedEvent): PendingNotification {
    const label = data.description ?? data.command.slice(0, 80);
    return {
      loopId: `monitor:${data.monitorId}`,
      prompt: label,
      trigger: { type: "event", source: "monitor:started" },
      timestamp: data.timestamp,
      key: `monitor:${data.monitorId}:started`,
      message: [
        `[pi-loop] Monitor #${data.monitorId} started: ${label}`,
        "The session is idle. Use MonitorList to inspect its current status or buffered output if needed.",
      ].join("\n"),
    };
  }

  async function deliverNotification(notification: ReducerNotification): Promise<boolean> {
    if (notification.autoTask) {
      const pending = await hasPendingTasks();
      if (pending === 0) {
        debug?.(`loop:fire #${notification.loopId} — no pending tasks at delivery time, dropping wake`);
        await cleanDoneTasks();
        return false;
      }
    }

    const fireCount = notification.fireCount ?? 1;
    const firstFireAt = notification.firstFireAt ?? notification.timestamp;
    let message = notification.message;
    if (fireCount > 1) {
      const firstDate = new Date(firstFireAt).toISOString();
      message = `[pi-loop] Loop #${notification.loopId} fired ${fireCount}× since ${firstDate}\n\n${message}`;
    }
    if (notification.priority && notification.priority !== "normal") {
      message = `[Priority: ${notification.priority}] ${message}`;
    }

    // Do NOT set agentRunning=true here. The agent's running state is
    // tracked strictly by agent_start / agent_end events; setting it during
    // delivery would prevent the drain-all loop in flushPendingNotifications
    // from delivering subsequent queued notifications (the G-46 regression
    // test exposes this — sends two loop fires in quick succession, then a
    // single agent_end, and expects both notifications to be delivered).
    // The original implementation added this syncRuntimeState call as a
    // defensive measure, but it broke drain-all behavior; the G-39 fix in
    // commit e3d6cf9 removed the exit-after-success pattern but couldn't
    // work fully until this spurious agentRunning setting was also removed.
    pi.sendMessage({
      customType: "pi-loop",
      content: message,
      display: false,
      details: {
        loopId: notification.loopId,
        trigger: notification.trigger,
        recurring: notification.recurring,
        persistent: notification.persistent,
        readOnly: notification.readOnly,
        autoTask: notification.autoTask,
        taskBacklog: notification.taskBacklog,
        fireCount,
        firstFireAt,
        lastFireAt: notification.lastFireAt ?? notification.timestamp,
        priority: notification.priority,
        dynamic: notification.dynamic,
        workflow: notification.workflow,
        timestamp: notification.timestamp,
      },
    }, {
      deliverAs: "steer",
      triggerTurn: true,
    });
    return true;
  }

  async function flushPendingNotifications(options?: { ignorePendingMessages?: boolean }): Promise<void> {
    if (flushPromise) return flushPromise;

    flushPromise = (async () => {
      syncRuntimeState({ hasPendingMessages: getHasPendingMessages() });

      // Drain the queue: each dispatch delivers at most one notification
      // (the oldest, FIFO order), so loop until the queue is empty or the
      // agent starts running again. Recurring-loop fires with distinct
      // timestamps coexist as separate queue entries (see G-46); the
      // previous "deliver one then exit" behavior short-circuited when
      // multiple fires were buffered, which the G-46 regression test
      // exposed.
      while (true) {
        // Drain the queue. The reducer's NOTIFICATION_FLUSH_REQUESTED handler
        // emits at most one DELIVER_NOTIFICATION effect per dispatch (the
        // oldest queue entry, FIFO); we loop until the queue is empty.
        // The original design (commit e3d6cf9) used an empty-queue guard
        // here; the refactor in c6ed147 introduced an exit-after-success
        // pattern that broke the G-46 regression test. Restoring the
        // empty-queue guard lifts the drain-all behavior the test expects.
        if (Object.keys(notificationState.notificationsByKey).length === 0) return;
        const results = await notificationCoordinator.dispatch({
          type: "NOTIFICATION_FLUSH_REQUESTED",
          at: Date.now(),
          source: "system",
          entityType: "notification",
          payload: { ignorePendingMessages: options?.ignorePendingMessages },
        });
        const delivery = results.find((result) => result.kind === "delivery");
        if (!delivery) return;            // defensive: no delivery effect, queue empty
        if (!delivery.delivered) continue; // dropped (e.g. autoTask w/ 0 pending) → try next
      }
    })().finally(() => {
      flushPromise = undefined;
    });

    return flushPromise;
  }

  async function queueOrDeliverNotification(data: LoopFireEvent): Promise<void> {
    const notification = buildPendingNotification(data);
    applyNotificationEvent({
      type: "NOTIFICATION_QUEUED",
      at: notification.timestamp,
      source: "system",
      entityType: "notification",
      entityId: notification.key,
      payload: { notification },
    });
    await flushPendingNotifications();
  }

  async function dispatchUrgentFlush(): Promise<void> {
    const thresholds = getFlushThresholds();
    const results = await notificationCoordinator.dispatch({
      type: "REQUEST_URGENT_FLUSH",
      at: Date.now(),
      source: "system",
      entityType: "notification",
      payload: { thresholds },
    });
    void results; // all effects are handled by the coordinator's DELIVER_NOTIFICATION handler
  }

  async function queueOrDeliverMonitorStarted(data: MonitorStartedEvent): Promise<void> {
    const notification = buildMonitorStartedNotification(data);
    await notificationCoordinator.dispatch({
      type: "NOTIFICATION_QUEUED",
      at: notification.timestamp,
      source: "monitor",
      entityType: "notification",
      entityId: notification.key,
      payload: { notification },
    });
  }

  function discardMonitorStarted(monitorId: string): void {
    const key = `monitor:${monitorId}:started`;
    applyNotificationEvent({
      type: "NOTIFICATION_DROPPED",
      at: Date.now(),
      source: "monitor",
      entityType: "notification",
      entityId: key,
      payload: { key, reason: "superseded" },
    });
  }

  function clear(reason: "session_shutdown" | "session_switch") {
    syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    applyNotificationEvent({
      type: "NOTIFICATION_CLEARED",
      at: Date.now(),
      source: "session",
      entityType: "notification",
      payload: { reason },
    });
  }

  return {
    syncRuntimeState,
    queueOrDeliverNotification,
    queueOrDeliverMonitorStarted,
    discardMonitorStarted,
    flushPendingNotifications,
    dispatchUrgentFlush,
    clear,
  };
}
