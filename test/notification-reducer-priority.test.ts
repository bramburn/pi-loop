import { describe, expect, it } from "vitest";
import {
  type NotificationReducerEvent,
  type NotificationReducerState,
  type ReducerNotification,
  reduceNotificationState,
} from "../src/notification-reducer.js";
import { DEFAULT_FLUSH_THRESHOLDS } from "../src/settings.js";

function makeNotification(overrides: Partial<ReducerNotification> = {}): ReducerNotification {
  return {
    key: "loop:1",
    loopId: "1",
    message: "hello",
    timestamp: 100,
    trigger: { type: "cron", schedule: "*/5 * * * *" },
    recurring: true,
    ...overrides,
  };
}

function makeState(
  notifications: ReducerNotification[] = [],
  overrides: Partial<NotificationReducerState> = {},
): NotificationReducerState {
  return {
    notificationsByKey: Object.fromEntries(notifications.map((n) => [n.key, n])),
    agentRunning: false,
    hasPendingMessages: false,
    ...overrides,
  };
}

function apply(state: NotificationReducerState, event: NotificationReducerEvent) {
  return reduceNotificationState(state, event);
}

describe("priority — fireCount coalescing", () => {
  // buildPendingNotification adds fireCount/firstFireAt/lastFireAt before queuing.
  // These tests exercise the reducer's storage with that metadata present.

  it("first notification preserves fireCount/firstFireAt/lastFireAt from buildPendingNotification", () => {
    const n = makeNotification({ timestamp: 500, fireCount: 1, firstFireAt: 500, lastFireAt: 500 });
    const { state } = apply(makeState(), {
      type: "NOTIFICATION_QUEUED",
      at: 500,
      source: "system",
      entityType: "notification",
      entityId: n.key,
      payload: { notification: n },
    });
    const stored = state.notificationsByKey[n.key]!;
    expect(stored.fireCount).toBe(1);
    expect(stored.firstFireAt).toBe(500);
    expect(stored.lastFireAt).toBe(500);
  });

  it("coalesced notification increments fireCount", () => {
    // Same key = coalescing in the reducer.
    const first = makeNotification({ timestamp: 100, fireCount: 1, firstFireAt: 100, lastFireAt: 100 });
    const second = makeNotification({ timestamp: 200, fireCount: 1, firstFireAt: 200, lastFireAt: 200 });
    const { state } = apply(makeState([first]), {
      type: "NOTIFICATION_QUEUED",
      at: 200,
      source: "system",
      entityType: "notification",
      entityId: second.key,
      payload: { notification: second },
    });
    expect(state.notificationsByKey[first.key]!.fireCount).toBe(2);
    expect(state.notificationsByKey[first.key]!.firstFireAt).toBe(100); // preserved
    expect(state.notificationsByKey[first.key]!.lastFireAt).toBe(200);
  });

  it("coalesced notification preserves priority", () => {
    const first = makeNotification({ timestamp: 100, priority: "urgent", fireCount: 1, firstFireAt: 100, lastFireAt: 100 });
    const second = makeNotification({ timestamp: 200, priority: undefined, fireCount: 1, firstFireAt: 200, lastFireAt: 200 });
    const { state } = apply(makeState([first]), {
      type: "NOTIFICATION_QUEUED",
      at: 200,
      source: "system",
      entityType: "notification",
      entityId: second.key,
      payload: { notification: second },
    });
    expect(state.notificationsByKey[first.key]!.priority).toBe("urgent");
  });

  it("non-recurring fires (different key) do not coalesce", () => {
    const first = makeNotification({ key: "loop:1:100", recurring: false, timestamp: 100, fireCount: 1, firstFireAt: 100, lastFireAt: 100 });
    const second = makeNotification({ key: "loop:1:200", recurring: false, timestamp: 200, fireCount: 1, firstFireAt: 200, lastFireAt: 200 });
    const { state } = apply(makeState([first]), {
      type: "NOTIFICATION_QUEUED",
      at: 200,
      source: "system",
      entityType: "notification",
      entityId: second.key,
      payload: { notification: second },
    });
    expect(Object.keys(state.notificationsByKey)).toHaveLength(2);
    expect(state.notificationsByKey[first.key]!.fireCount).toBe(1);
    expect(state.notificationsByKey[second.key]!.fireCount).toBe(1);
  });
});

describe("priority — 4×4 priority matrix", () => {
  // Each combination: priority × age threshold = whether it force-flushes

  it("critical age=0 force-flushes immediately", () => {
    const now = Date.now();
    const n = makeNotification({ priority: "critical", timestamp: now, fireCount: 1, firstFireAt: now, lastFireAt: now });
    const { effects } = apply(makeState([n]), {
      type: "REQUEST_URGENT_FLUSH",
      at: now,
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]!.type).toBe("DELIVER_NOTIFICATION");
  });

  it("urgent past threshold force-flushes", () => {
    const now = 1_000_000;
    const n = makeNotification({ priority: "urgent", timestamp: now - 31_000, fireCount: 1, firstFireAt: now - 31_000, lastFireAt: now - 31_000 });
    const { effects } = apply(makeState([n]), {
      type: "REQUEST_URGENT_FLUSH",
      at: now,
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]!.type).toBe("DELIVER_NOTIFICATION");
  });

  it("urgent within threshold does not force-flush", () => {
    const now = 1_000_000;
    const n = makeNotification({ priority: "urgent", timestamp: now - 10_000, fireCount: 1, firstFireAt: now - 10_000, lastFireAt: now - 10_000 });
    const { effects } = apply(makeState([n]), {
      type: "REQUEST_URGENT_FLUSH",
      at: now,
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });
    expect(effects).toHaveLength(0);
  });

  it("normal past threshold force-flushes", () => {
    const now = 1_000_000;
    const n = makeNotification({ priority: "normal", timestamp: now - 301_000, fireCount: 1, firstFireAt: now - 301_000, lastFireAt: now - 301_000 });
    const { effects } = apply(makeState([n]), {
      type: "REQUEST_URGENT_FLUSH",
      at: now,
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]!.type).toBe("DELIVER_NOTIFICATION");
  });

  it("normal within threshold does not force-flush", () => {
    const now = 1_000_000;
    const n = makeNotification({ priority: "normal", timestamp: now - 60_000, fireCount: 1, firstFireAt: now - 60_000, lastFireAt: now - 60_000 });
    const { effects } = apply(makeState([n]), {
      type: "REQUEST_URGENT_FLUSH",
      at: now,
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });
    expect(effects).toHaveLength(0);
  });

  it("defer never force-flushes regardless of age", () => {
    const now = 1_000_000;
    const n = makeNotification({ priority: "defer", timestamp: now - 1_000_000_000, fireCount: 1, firstFireAt: now - 1_000_000_000, lastFireAt: now - 1_000_000_000 });
    const { effects } = apply(makeState([n]), {
      type: "REQUEST_URGENT_FLUSH",
      at: now,
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });
    expect(effects).toHaveLength(0);
  });

  it("missing priority defaults to normal", () => {
    const now = 1_000_000;
    const n = makeNotification({ priority: undefined, timestamp: now - 301_000, fireCount: 1, firstFireAt: now - 301_000, lastFireAt: now - 301_000 });
    const { effects } = apply(makeState([n]), {
      type: "REQUEST_URGENT_FLUSH",
      at: now,
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });
    expect(effects).toHaveLength(1);
  });

  it("agentRunning blocks urgent flush", () => {
    const n = makeNotification({ priority: "critical", timestamp: Date.now(), fireCount: 1, firstFireAt: Date.now(), lastFireAt: Date.now() });
    const { effects } = apply(makeState([n], { agentRunning: true }), {
      type: "REQUEST_URGENT_FLUSH",
      at: Date.now(),
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });
    expect(effects).toHaveLength(0);
  });
});

describe("priority — age force-flush ordering", () => {
  it("multiple eligible notifications sorted by priority first (critical → urgent → normal)", () => {
    const now = 1_000_000;
    const normal = makeNotification({ key: "n", loopId: "n", priority: "normal", timestamp: now - 400_000, fireCount: 1, firstFireAt: now - 400_000, lastFireAt: now - 400_000 });
    const urgent = makeNotification({ key: "u", loopId: "u", priority: "urgent", timestamp: now - 40_000, fireCount: 1, firstFireAt: now - 40_000, lastFireAt: now - 40_000 });
    const critical = makeNotification({ key: "c", loopId: "c", priority: "critical", timestamp: now - 1_000, fireCount: 1, firstFireAt: now - 1_000, lastFireAt: now - 1_000 });

    const { effects } = apply(makeState([normal, urgent, critical]), {
      type: "REQUEST_URGENT_FLUSH",
      at: now,
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });

    expect(effects).toHaveLength(3);
    // Critical first
    expect((effects[0]!.payload as { notification: ReducerNotification }).notification.loopId).toBe("c");
    // Urgent second
    expect((effects[1]!.payload as { notification: ReducerNotification }).notification.loopId).toBe("u");
    // Normal last
    expect((effects[2]!.payload as { notification: ReducerNotification }).notification.loopId).toBe("n");
  });

  it("same priority sorted by timestamp (FIFO within priority)", () => {
    const now = 1_000_000;
    const older = makeNotification({ key: "o", loopId: "o", priority: "urgent", timestamp: now - 100_000, fireCount: 1, firstFireAt: now - 100_000, lastFireAt: now - 100_000 });
    const newer = makeNotification({ key: "x", loopId: "x", priority: "urgent", timestamp: now - 50_000, fireCount: 1, firstFireAt: now - 50_000, lastFireAt: now - 50_000 });

    const { effects } = apply(makeState([newer, older]), {
      type: "REQUEST_URGENT_FLUSH",
      at: now,
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });

    expect(effects).toHaveLength(2);
    expect((effects[0]!.payload as { notification: ReducerNotification }).notification.loopId).toBe("o");
    expect((effects[1]!.payload as { notification: ReducerNotification }).notification.loopId).toBe("x");
  });
});

describe("priority — defer never preempts", () => {
  it("defer never preempted by critical notification being force-flushed", () => {
    const now = 1_000_000;
    const defer = makeNotification({ key: "d", loopId: "d", priority: "defer", timestamp: 100, fireCount: 1, firstFireAt: 100, lastFireAt: 100 });
    const critical = makeNotification({ key: "c", loopId: "c", priority: "critical", timestamp: now - 1_000, fireCount: 1, firstFireAt: now - 1_000, lastFireAt: now - 1_000 });

    const { state, effects } = apply(makeState([defer, critical]), {
      type: "REQUEST_URGENT_FLUSH",
      at: now,
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });

    // Only critical should be delivered; defer stays in queue
    expect(effects).toHaveLength(1);
    expect((effects[0]!.payload as { notification: ReducerNotification }).notification.loopId).toBe("c");
    expect(state.notificationsByKey.d).toBeDefined();
    expect(state.notificationsByKey.d!.priority).toBe("defer");
  });

  it("defer waits through multiple flush cycles", () => {
    const now = 1_000_000;
    const defer = makeNotification({ key: "d", loopId: "d", priority: "defer", timestamp: 100, fireCount: 1, firstFireAt: 100, lastFireAt: 100 });
    const urgent1 = makeNotification({ key: "u1", loopId: "u1", priority: "urgent", timestamp: now - 31_000, fireCount: 1, firstFireAt: now - 31_000, lastFireAt: now - 31_000 });
    const urgent2 = makeNotification({ key: "u2", loopId: "u2", priority: "urgent", timestamp: now - 31_000, fireCount: 1, firstFireAt: now - 31_000, lastFireAt: now - 31_000 });

    // First flush: urgent notifications force-flush
    const step1 = apply(makeState([defer, urgent1, urgent2]), {
      type: "REQUEST_URGENT_FLUSH",
      at: now,
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });
    expect(step1.effects).toHaveLength(2); // only urgents

    // Second flush (some time later): defer still waiting
    const step2 = apply(step1.state, {
      type: "REQUEST_URGENT_FLUSH",
      at: now + 100_000,
      source: "system",
      payload: { thresholds: DEFAULT_FLUSH_THRESHOLDS },
    });
    expect(step2.effects).toHaveLength(0); // defer still not eligible
  });

  it("defer is only delivered when explicitly flushed via NOTIFICATION_FLUSH_REQUESTED", () => {
    const defer = makeNotification({ key: "d", loopId: "d", priority: "defer", timestamp: 100, fireCount: 1, firstFireAt: 100, lastFireAt: 100 });
    // Normal flush (not urgent) should deliver defer when it's the oldest
    const { effects } = apply(makeState([defer]), {
      type: "NOTIFICATION_FLUSH_REQUESTED",
      at: 200,
      source: "system",
      payload: {},
    });
    expect(effects).toHaveLength(1);
    expect((effects[0]!.payload as { notification: ReducerNotification }).notification.loopId).toBe("d");
  });
});

describe("priority — normal flush skips defer when higher-priority exist (rec #2)", () => {
  // NOTIFICATION_FLUSH_REQUESTED must skip a defer-priority notification if
  // any non-defer notification is in the queue. Otherwise "drains naturally"
  // would let a defer block higher-priority items at agent_end.

  it("normal flush skips defer when higher-priority notifications exist", () => {
    const defer = makeNotification({ key: "d", loopId: "d", priority: "defer", timestamp: 100, fireCount: 1, firstFireAt: 100, lastFireAt: 100 });
    const critical = makeNotification({ key: "c", loopId: "c", priority: "critical", timestamp: 200, fireCount: 1, firstFireAt: 200, lastFireAt: 200 });
    const urgent = makeNotification({ key: "u", loopId: "u", priority: "urgent", timestamp: 300, fireCount: 1, firstFireAt: 300, lastFireAt: 300 });

    const { state, effects } = apply(makeState([defer, critical, urgent]), {
      type: "NOTIFICATION_FLUSH_REQUESTED",
      at: 1000,
      source: "system",
      payload: { ignorePendingMessages: true },
    });

    // Highest non-defer (critical, oldest) wins; defer stays in queue.
    expect(effects).toHaveLength(1);
    expect((effects[0]!.payload as { notification: ReducerNotification }).notification.loopId).toBe("c");
    expect(state.notificationsByKey.d).toBeDefined();
    expect(state.notificationsByKey.u).toBeDefined();
    expect(state.notificationsByKey.c).toBeUndefined();
  });

  it("normal flush delivers defer only when queue contains nothing else", () => {
    const defer = makeNotification({ key: "d", loopId: "d", priority: "defer", timestamp: 100, fireCount: 1, firstFireAt: 100, lastFireAt: 100 });
    const { effects } = apply(makeState([defer]), {
      type: "NOTIFICATION_FLUSH_REQUESTED",
      at: 200,
      source: "system",
      payload: {},
    });
    expect(effects).toHaveLength(1);
    expect((effects[0]!.payload as { notification: ReducerNotification }).notification.loopId).toBe("d");
  });

  it("normal flush FIFO within non-defer items", () => {
    const newer = makeNotification({ key: "n", loopId: "n", priority: "normal", timestamp: 200, fireCount: 1, firstFireAt: 200, lastFireAt: 200 });
    const older = makeNotification({ key: "o", loopId: "o", priority: "urgent", timestamp: 100, fireCount: 1, firstFireAt: 100, lastFireAt: 100 });

    const { effects } = apply(makeState([newer, older]), {
      type: "NOTIFICATION_FLUSH_REQUESTED",
      at: 300,
      source: "system",
      payload: {},
    });
    expect(effects).toHaveLength(1);
    expect((effects[0]!.payload as { notification: ReducerNotification }).notification.loopId).toBe("o");
  });
});
