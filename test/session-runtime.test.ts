import { afterEach, describe, expect, it, vi } from "vitest";
import { BindingsStore } from "../src/runtime/bindings-store.js";
import { registerSessionRuntimeHooks, type SessionRuntimeOptions } from "../src/runtime/session-runtime.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

function setup(overrides: Partial<SessionRuntimeOptions> = {}) {
  const { pi, extensionHandlers } = createMockPi();
  const scheduler = { nextFire: vi.fn(() => undefined), pump: vi.fn() };
  const bindingsStore = new BindingsStore(undefined, "memory");
  const triggerSystem = {
    start: vi.fn(),
    stop: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    wasRecentlyFired: vi.fn(() => false),
  };
  const options: SessionRuntimeOptions = {
    pi,
    getLoopScope: () => "memory", // skip session store recreation
    getPiLoopEnv: () => undefined,
    recreateSessionStore: vi.fn(),
    clearAllLoops: vi.fn(),
    getStore: () => ({ list: () => [], clearExpired: vi.fn(), expireEventLoops: vi.fn() }) as any,
    getScheduler: () => scheduler as any,
    getTriggerSystem: () => triggerSystem as any,
    getBindingsStore: () => bindingsStore,
    getLatestCtx: () => undefined,
    setLatestCtx: vi.fn(),
    setSessionId: vi.fn(),
    widget: { setUICtx: vi.fn(), update: vi.fn(), dispose: vi.fn() },
    notificationRuntime: {
      syncRuntimeState: vi.fn(),
      queueOrDeliverNotification: vi.fn(async () => {}),
      flushPendingNotifications: vi.fn(async () => {}),
      clear: vi.fn(),
    },
    flushPendingNotifications: vi.fn(async () => {}),
    cleanupTaskBacklogLoops: vi.fn(async () => 0),
    hasPendingTasks: vi.fn(async () => 0),
    cleanDoneTasks: vi.fn(async () => {}),
    ...overrides,
  };
  registerSessionRuntimeHooks(options);
  const drive = async (name: string) => {
    for (const handler of extensionHandlers.get(name) ?? []) await handler(null, createCtx());
  };
  return { scheduler, drive };
}

describe("session-runtime heartbeat lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("starts an unref'd heartbeat interval on turn_start", async () => {
    const unref = vi.fn();
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue({ unref } as any);

    const { drive } = setup();
    await drive("turn_start");

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(30000);
    expect(unref).toHaveBeenCalledTimes(1); // never keeps a `pi -p` process alive
  });

  it("is idempotent — does not start a second interval across turn boundaries", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue({ unref: vi.fn() } as any);

    const { drive } = setup();
    await drive("before_agent_start");
    await drive("turn_start");
    await drive("turn_start");

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the heartbeat on session_shutdown and disposes the widget", async () => {
    const timer = { unref: vi.fn() };
    vi.spyOn(global, "setInterval").mockReturnValue(timer as any);
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const disposeSpy = vi.fn();

    const { drive } = setup({ widget: { setUICtx: vi.fn(), update: vi.fn(), dispose: disposeSpy } });
    await drive("turn_start");
    await drive("session_shutdown");

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    // widget.dispose() clears the status bar so no stale state remains after session ends
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not leak an unhandled rejection when a heartbeat pump throws", async () => {
    vi.useFakeTimers();
    const scheduler = {
      nextFire: vi.fn(() => undefined),
      pump: vi.fn(() => {
        throw new Error("pump boom");
      }),
    };
    const { drive } = setup({ getScheduler: () => scheduler as any });

    // before_agent_start starts the heartbeat without itself calling pumpLoops.
    await drive("before_agent_start");
    // Fire one heartbeat tick → its pumpLoops() rejects. With the `.catch`, this
    // is swallowed; without it, vitest fails the test on the unhandled rejection.
    await vi.advanceTimersByTimeAsync(30000);

    expect(scheduler.pump).toHaveBeenCalled();
  });
});

describe("session-runtime per-session bindings filter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("arms only loops whose ids are in the bindings set", async () => {
    const { BindingsStore } = await import("../src/runtime/bindings-store.js");
    const bindingsStore = new BindingsStore(undefined, "memory");
    bindingsStore.add("1");

    const storedLoops = [
      { id: "1", status: "active", trigger: { type: "cron", schedule: "*/5 * * * *" } },
      { id: "2", status: "active", trigger: { type: "event", source: "x" } },
      { id: "3", status: "active", trigger: { type: "cron", schedule: "*/10 * * * *" } },
    ];
    const triggerSystem = {
      start: vi.fn(),
      stop: vi.fn(),
      add: vi.fn(),
      remove: vi.fn(),
      wasRecentlyFired: vi.fn(() => false),
    };
    const store = {
      list: () => storedLoops,
      clearExpired: vi.fn(),
      expireEventLoops: vi.fn(),
    };

    const { drive } = setup({
      getStore: () => store as any,
      getTriggerSystem: () => triggerSystem as any,
      getBindingsStore: () => bindingsStore,
    });

    await drive("before_agent_start");

    expect(triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(triggerSystem.add.mock.calls[0][0].id).toBe("1");
  });

  it("arms zero loops when bindings set is empty (strict-isolation default)", async () => {
    const { BindingsStore } = await import("../src/runtime/bindings-store.js");
    const bindingsStore = new BindingsStore(undefined, "memory");

    const storedLoops = [
      { id: "1", status: "active", trigger: { type: "cron", schedule: "*/5 * * * *" } },
      { id: "2", status: "active", trigger: { type: "event", source: "x" } },
    ];
    const triggerSystem = {
      start: vi.fn(),
      stop: vi.fn(),
      add: vi.fn(),
      remove: vi.fn(),
      wasRecentlyFired: vi.fn(() => false),
    };
    const store = {
      list: () => storedLoops,
      clearExpired: vi.fn(),
      expireEventLoops: vi.fn(),
    };

    const { drive } = setup({
      getStore: () => store as any,
      getTriggerSystem: () => triggerSystem as any,
      getBindingsStore: () => bindingsStore,
    });

    await drive("before_agent_start");

    expect(triggerSystem.add).not.toHaveBeenCalled();
    expect(triggerSystem.start).not.toHaveBeenCalled();
  });

  it("two sessions on the same repo arm disjoint subsets via independent bindings stores", async () => {
    const { BindingsStore } = await import("../src/runtime/bindings-store.js");
    const bindingsA = new BindingsStore(undefined, "memory");
    const bindingsB = new BindingsStore(undefined, "memory");
    bindingsA.add("1");
    bindingsA.add("5");
    bindingsB.add("3");
    bindingsB.add("7");

    const storedLoops = [
      { id: "1", status: "active", trigger: { type: "cron", schedule: "*/5 * * * *" } },
      { id: "3", status: "active", trigger: { type: "cron", schedule: "*/15 * * * *" } },
      { id: "5", status: "active", trigger: { type: "event", source: "x" } },
      { id: "7", status: "active", trigger: { type: "event", source: "y" } },
    ];
    const triggerSystemA = {
      start: vi.fn(), stop: vi.fn(), add: vi.fn(), remove: vi.fn(), wasRecentlyFired: vi.fn(() => false),
    };
    const triggerSystemB = {
      start: vi.fn(), stop: vi.fn(), add: vi.fn(), remove: vi.fn(), wasRecentlyFired: vi.fn(() => false),
    };
    const store = {
      list: () => storedLoops,
      clearExpired: vi.fn(),
      expireEventLoops: vi.fn(),
    };

    // Session A
    const setupA = setup({
      getStore: () => store as any,
      getTriggerSystem: () => triggerSystemA as any,
      getBindingsStore: () => bindingsA,
    });
    await setupA.drive("before_agent_start");

    // Session B uses a fresh triggerSystem but the same store + its own bindings
    const setupB = setup({
      getStore: () => store as any,
      getTriggerSystem: () => triggerSystemB as any,
      getBindingsStore: () => bindingsB,
    });
    await setupB.drive("before_agent_start");

    const idsA = triggerSystemA.add.mock.calls.map((c) => c[0].id).sort();
    const idsB = triggerSystemB.add.mock.calls.map((c) => c[0].id).sort();
    expect(idsA).toEqual(["1", "5"]);
    expect(idsB).toEqual(["3", "7"]);
    expect(idsA).not.toEqual(idsB);
  });
});
