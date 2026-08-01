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
  let sessionId = "session-a";
  const mock = createMockPi({ respondToTaskPing });
  const runtime = createTaskProviderRuntime({
    pi: mock.pi,
    runtimeId: "runtime-a",
    resolveStorePath: () => undefined,
    getSessionId: () => sessionId,
    evaluateTaskBacklog: vi.fn(async () => ({ created: false, cleaned: 0 })),
    updateWidget: vi.fn(),
    isStaleExtensionContextError: () => false,
  });
  return { ...mock, runtime, setSessionId: (next: string) => { sessionId = next; } };
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

  it("keeps native ownership when an external provider appears after native tools register", async () => {
    const { pi, toolMap, runtime } = setup();
    await vi.advanceTimersByTimeAsync(6_100);
    pi.events.on("tasks:rpc:ping", (request: { requestId: string }) => {
      pi.events.emit(`tasks:rpc:ping:reply:${request.requestId}`, {
        success: true,
        data: { version: 3, provider: "late-external" },
      });
    });

    pi.events.emit("tasks:ready", {});
    await vi.advanceTimersByTimeAsync(10);
    await toolMap.get("TaskCreate")!.execute!("create", { subject: "native", description: "owned here" });

    expect(runtime.summary()).toMatchObject({ count: 1, focusText: "next: native" });
  });

  it("rebinds native task tools when the active session changes", async () => {
    const { toolMap, setSessionId } = setup();
    await vi.advanceTimersByTimeAsync(6_100);
    const create = toolMap.get("TaskCreate")!;
    const list = toolMap.get("TaskList")!;
    await create.execute!("a", { subject: "session A", description: "A" });

    setSessionId("session-b");
    expect((await list.execute!("list-b", {})).content[0].text).toBe("No tasks.");
    await create.execute!("b", { subject: "session B", description: "B" });

    setSessionId("session-a");
    const inA = (await list.execute!("list-a", {})).content[0].text;
    expect(inA).toContain("session A");
    expect(inA).not.toContain("session B");
  });

  it("cancels delayed fallback registration on session shutdown", async () => {
    const { extensionHandlers, toolMap } = setup();
    for (const handler of extensionHandlers.get("session_shutdown") ?? []) await handler(null, {});
    await vi.advanceTimersByTimeAsync(6_100);

    expect(toolMap.has("TaskCreate")).toBe(false);
  });
});
