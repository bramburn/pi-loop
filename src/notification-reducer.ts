import { type UrgentFlushThresholds } from "./settings.js";
import type { DynamicLoopState, LoopPriority, WorkflowRunState } from "./types.js";

type ReducerSource = "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";

export type { UrgentFlushThresholds };

export interface ReducerNotification {
  key: string;
  loopId: string;
  message: string;
  timestamp: number;
  trigger: unknown;
  recurring?: boolean;
  persistent?: boolean;
  autoTask?: boolean;
  taskBacklog?: boolean;
  readOnly?: boolean;
  fireCount?: number;
  firstFireAt?: number;
  lastFireAt?: number;
  priority?: LoopPriority;
  dynamic?: DynamicLoopState;
  workflow?: WorkflowRunState;
}

export interface NotificationReducerState {
  notificationsByKey: Record<string, ReducerNotification>;
  agentRunning: boolean;
  hasPendingMessages: boolean;
}

export type NotificationReducerEvent =
  | {
    type: "NOTIFICATION_QUEUED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { notification: ReducerNotification };
  }
  | {
    type: "NOTIFICATION_DROPPED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: {
      key: string;
      reason: "zero_pending_tasks" | "session_switch" | "session_shutdown" | "superseded";
    };
  }
  | {
    type: "NOTIFICATION_CLEARED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { reason: "session_switch" | "session_shutdown" };
  }
  | {
    type: "NOTIFICATION_FLUSH_REQUESTED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { ignorePendingMessages?: boolean };
  }
  | {
    type: "NOTIFICATION_RUNTIME_UPDATED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { agentRunning: boolean; hasPendingMessages: boolean };
  }
  | {
    type: "REQUEST_URGENT_FLUSH";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { thresholds: UrgentFlushThresholds };
  };

export type NotificationReducerEffect =
  | {
    type: "REQUEST_NOTIFICATION_FLUSH";
    payload: Record<string, never>;
  }
  | {
    type: "DELIVER_NOTIFICATION";
    entityType: "notification";
    entityId: string;
    payload: { notification: ReducerNotification };
  };

export interface NotificationReduceResult {
  state: NotificationReducerState;
  effects: NotificationReducerEffect[];
}

function cloneState(state: NotificationReducerState): NotificationReducerState {
  return {
    notificationsByKey: { ...state.notificationsByKey },
    agentRunning: state.agentRunning,
    hasPendingMessages: state.hasPendingMessages,
  };
}

export function reduceNotificationState(
  state: NotificationReducerState,
  event: NotificationReducerEvent,
): NotificationReduceResult {
  if (event.type === "NOTIFICATION_QUEUED") {
    const next = cloneState(state);
    const incoming = event.payload.notification;
    const existing = next.notificationsByKey[incoming.key];
    if (existing) {
      // Coalesce: increment fireCount, preserve firstFireAt, update lastFireAt and message.
      // Create a new object so we don't mutate the original notification reference.
      next.notificationsByKey[incoming.key] = {
        ...existing,
        fireCount: (existing.fireCount ?? 1) + 1,
        firstFireAt: existing.firstFireAt ?? existing.timestamp,
        lastFireAt: incoming.timestamp,
        message: incoming.message,
        priority: incoming.priority ?? existing.priority,
      };
    } else {
      next.notificationsByKey[incoming.key] = incoming;
    }
    return {
      state: next,
      effects: [{ type: "REQUEST_NOTIFICATION_FLUSH", payload: {} }],
    };
  }

  if (event.type === "NOTIFICATION_DROPPED") {
    const next = cloneState(state);
    delete next.notificationsByKey[event.payload.key];
    return { state: next, effects: [] };
  }

  if (event.type === "NOTIFICATION_CLEARED") {
    return {
      state: {
        ...state,
        notificationsByKey: {},
      },
      effects: [],
    };
  }

  if (event.type === "NOTIFICATION_RUNTIME_UPDATED") {
    return {
      state: {
        ...state,
        agentRunning: event.payload.agentRunning,
        hasPendingMessages: event.payload.hasPendingMessages,
      },
      effects: [],
    };
  }

  if (event.type === "NOTIFICATION_FLUSH_REQUESTED") {
    if (state.agentRunning) return { state, effects: [] };
    if (!event.payload.ignorePendingMessages && state.hasPendingMessages) {
      return { state, effects: [] };
    }

    const queued = Object.values(state.notificationsByKey)
      .sort((left, right) => left.timestamp - right.timestamp);
    if (queued.length === 0) return { state, effects: [] };

    // Defer-priority notifications are shielded from priority inversion:
    // if any non-defer notification is queued, deliver the oldest of those
    // rather than a defer. This satisfies the ADR claim that defer "will not
    // be delivered until all higher-priority notifications are delivered".
    const nonDefer = queued.filter((n) => (n.priority ?? "normal") !== "defer");
    const nextNotification = nonDefer[0] ?? queued[0]!;

    const next = cloneState(state);
    delete next.notificationsByKey[nextNotification.key];
    return {
      state: next,
      effects: [{
        type: "DELIVER_NOTIFICATION",
        entityType: "notification",
        entityId: nextNotification.key,
        payload: { notification: nextNotification },
      }],
    };
  }

  // REQUEST_URGENT_FLUSH: scan all queued notifications and force-deliver any
  // that have sat in the queue longer than their priority threshold. Defer-priority
  // notifications are never force-flushed (they wait for explicit flush or age-out).
  if (event.type === "REQUEST_URGENT_FLUSH") {
    if (state.agentRunning) return { state, effects: [] };

    const { thresholds } = event.payload;
    const now = event.at;
    const queued = Object.values(state.notificationsByKey);
    const toForceFlush: ReducerNotification[] = [];

    for (const n of queued) {
      const priority = n.priority ?? "normal";
      const threshold = thresholds[priority];
      if (threshold === undefined) continue;
      if (priority === "defer") continue; // defer never preempts
      const age = now - n.timestamp;
      if (age >= threshold) {
        toForceFlush.push(n);
      }
    }

    if (toForceFlush.length === 0) return { state, effects: [] };

    // Sort by priority (ascending: critical → urgent → normal) then timestamp.
    // Defer notifications are filtered out above, so the only priorities
    // present are critical/urgent/normal — the sort key covers all three.
    const PRIORITY_ORDER: Record<Exclude<LoopPriority, "defer">, number> = {
      critical: 0,
      urgent: 1,
      normal: 2,
    };
    toForceFlush.sort((a, b) => {
      const pa = PRIORITY_ORDER[(a.priority ?? "normal") as Exclude<LoopPriority, "defer">];
      const pb = PRIORITY_ORDER[(b.priority ?? "normal") as Exclude<LoopPriority, "defer">];
      if (pa !== pb) return pa - pb;
      return a.timestamp - b.timestamp;
    });

    const next = cloneState(state);
    const effects: NotificationReducerEffect[] = [];
    for (const n of toForceFlush) {
      delete next.notificationsByKey[n.key];
      effects.push({
        type: "DELIVER_NOTIFICATION",
        entityType: "notification",
        entityId: n.key,
        payload: { notification: n },
      });
    }
    return { state: next, effects };
  }

  return { state, effects: [] };
}
