import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskProviderRuntime } from "../src/runtime/task-provider-runtime.js";
import { createMockPi } from "./helpers/mock-pi.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(respondToTaskPing = false) {
  const mock = createMockPi({ respondToTaskPing });
  const runtime = createTaskProviderRuntime({
    pi: mock.pi,
    runtimeId: "runtime-a",
    resolveStorePath: () => undefined,
    getSessionId: () => "session-a",
    evaluateTaskBacklog: vi.fn(async () => ({ created: false, cleaned: 0 })),
    updateWidget: vi.fn(),
    isStaleExtensionContextError: () => false,
  });
  return { ...mock, runtime };
}

describe("task-provider-runtime", () => {
  it("registers native RPC immediately but delays colliding tools", async () => {
    const { pi, toolMap, emittedEvents, runtime } = setup();

    pi.events.emit("tasks:rpc:ping", { requestId: "early" });
    await Promise.resolve();
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      name: "tasks:rpc:ping:reply:early",
    }));
    expect(toolMap.has("TaskCreate")).toBe(false);

    await vi.advanceTimersByTimeAsync(6_100);
    expect(toolMap.has("TaskCreate")).toBe(true);
    expect(runtime.isReady()).toBe(true);
  });

  it("lets an external provider win without registering native tools", async () => {
    const { toolMap, runtime } = setup(true);
    await vi.advanceTimersByTimeAsync(6_100);

    expect(toolMap.has("TaskCreate")).toBe(false);
    expect(runtime.isReady()).toBe(true);
    expect(runtime.summary()).toEqual({ count: 0 });
  });

  it("cancels delayed fallback registration on session shutdown", async () => {
    const { extensionHandlers, toolMap } = setup();
    for (const handler of extensionHandlers.get("session_shutdown") ?? []) await handler(null, {});
    await vi.advanceTimersByTimeAsync(6_100);

    expect(toolMap.has("TaskCreate")).toBe(false);
  });
});
