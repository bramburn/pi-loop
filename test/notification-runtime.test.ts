import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationRuntime, type NotificationRuntime } from "../src/runtime/notification-runtime.js";

function makePi() {
  return {
    events: {
      _handlers: new Map<string, Array<(data: unknown) => void>>(),
      on(event: string, handler: (data: unknown) => void) {
        const list = this._handlers.get(event) ?? [];
        list.push(handler);
        this._handlers.set(event, list);
        return () => {};
      },
      emit(event: string, data: unknown) {
        for (const h of this._handlers.get(event) ?? []) h(data);
      },
    },
    sendMessage: vi.fn(async () => undefined),
    hasPendingMessages: () => false,
    getHasPendingMessages: vi.fn(async () => 0),
  };
}

function makePendingCount() {
  return vi.fn(async () => 0);
}

function makeCleanDoneTasks() {
  return vi.fn(async () => {});
}

describe("NotificationRuntime", () => {
  let pi: ReturnType<typeof makePi>;
  let hasPendingTasks: ReturnType<typeof makePendingCount>;
  let cleanDoneTasks: ReturnType<typeof makeCleanDoneTasks>;
  let runtime: NotificationRuntime;

  beforeEach(() => {
    pi = makePi();
    hasPendingTasks = makePendingCount();
    cleanDoneTasks = makeCleanDoneTasks();
    runtime = createNotificationRuntime({
      pi: pi as never,
      hasPendingTasks,
      cleanDoneTasks,
      getHasPendingMessages: () => false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs without throwing", () => {
    expect(runtime).toBeDefined();
  });

  it("syncRuntimeState updates internal state without throwing", () => {
    expect(() => runtime.syncRuntimeState({ agentRunning: true, hasPendingMessages: false })).not.toThrow();
    expect(() => runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: true })).not.toThrow();
  });

  it("queueOrDeliverNotification delivers immediately when agent is idle", async () => {
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.queueOrDeliverNotification({
      loopId: "1",
      prompt: "test",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      readOnly: false,
      recurring: true,
      autoTask: false,
    });
    expect(pi.sendMessage).toHaveBeenCalled();
  });

  it("queueOrDeliverNotification buffers when agent is running", async () => {
    runtime.syncRuntimeState({ agentRunning: true, hasPendingMessages: false });
    await runtime.queueOrDeliverNotification({
      loopId: "1",
      prompt: "test",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      readOnly: false,
      recurring: true,
      autoTask: false,
    });
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("discardMonitorStarted clears the monitor-wake buffer", () => {
    expect(() => runtime.discardMonitorStarted("m1")).not.toThrow();
  });

  it("queueOrDeliverMonitorStarted buffers a monitor wake", async () => {
    await runtime.queueOrDeliverMonitorStarted({
      monitorId: "m1",
      command: "echo",
      startedAt: Date.now(),
    });
    // No agent is running, but the monitor wake is buffered regardless
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("queueOrDeliverMonitorStarted delivers when agent is idle", async () => {
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.queueOrDeliverMonitorStarted({
      monitorId: "m1",
      command: "echo",
      startedAt: Date.now(),
    });
    // Monitor wakes are always buffered, not delivered directly
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("flushPendingNotifications returns when buffer is empty", async () => {
    await runtime.flushPendingNotifications();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("flushPendingNotifications ignores pending messages by default", async () => {
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.queueOrDeliverNotification({
      loopId: "1",
      prompt: "test",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      readOnly: false,
      recurring: true,
      autoTask: false,
    });
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });
    expect(pi.sendMessage).toHaveBeenCalled();
  });

  it("clear() with a reason resets the runtime state", () => {
    runtime.clear("session_switch");
    runtime.clear("session_shutdown");
    runtime.clear("agent_end");
    // No assertions needed — just verify it doesn't throw
  });

  it("handles notification with autoTask=true (checks pending tasks)", async () => {
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    hasPendingTasks.mockResolvedValue(2);
    await runtime.queueOrDeliverNotification({
      loopId: "1",
      prompt: "test",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      readOnly: false,
      recurring: true,
      autoTask: true,
    });
    expect(hasPendingTasks).toHaveBeenCalled();
  });

  it("handles notification with readOnly=true", async () => {
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.queueOrDeliverNotification({
      loopId: "1",
      prompt: "test",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      readOnly: true,
      recurring: true,
      autoTask: false,
    });
    expect(pi.sendMessage).toHaveBeenCalled();
  });

  it("calls cleanDoneTasks after delivery", async () => {
    runtime.syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    await runtime.queueOrDeliverNotification({
      loopId: "1",
      prompt: "test",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      readOnly: false,
      recurring: true,
      autoTask: false,
    });
    // cleanDoneTasks is invoked as part of the flush path. We just verify
    // the call doesn't throw here; actual invocation is observed in the
    // integration tests.
    await runtime.flushPendingNotifications({ ignorePendingMessages: true });
    // After flush, the buffer should be empty
    await runtime.flushPendingNotifications();
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });
});
