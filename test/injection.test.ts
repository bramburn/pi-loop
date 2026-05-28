import { describe, expect, it, vi } from "vitest";

describe("loop:fire triggers sendUserMessage", () => {
  it("sends followUp message with pi-loop prefix when agent is processing", async () => {
    let sentMessages: Array<{ msg: string; opts: any }> = [];

    const mockPi: any = {
      events: {
        emit: vi.fn((_event: string, data: any) => {
          const cbs = eventHandlers.get(_event);
          if (cbs) for (const cb of cbs) cb(data);
        }),
        on: (_event: string, handler: (data: any) => void) => {
          if (!eventHandlers.has(_event)) eventHandlers.set(_event, []);
          eventHandlers.get(_event)!.push(handler);
          return () => {};
        },
      },
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: (msg: string, opts: any) => {
        sentMessages.push({ msg, opts });
      },
    };

    const eventHandlers = new Map<string, Array<(data: any) => void>>();

    const extension = await import("../src/index.js");
    extension.default(mockPi);

    mockPi.events.emit("loop:fire", {
      loopId: "42",
      prompt: "Pick up the next task and work on it",
      trigger: { type: "cron", schedule: "*/1 * * * *" },
      timestamp: Date.now(),
    });

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].opts).toEqual({ deliverAs: "followUp" });
    expect(sentMessages[0].msg).toContain("[pi-loop]");
    expect(sentMessages[0].msg).toContain("Loop #42 fired");
    expect(sentMessages[0].msg).toContain("Pick up the next task and work on it");
  });

  it("includes READ-ONLY MODE constraint when readOnly is true", async () => {
    let sentMessages: Array<{ msg: string; opts: any }> = [];

    const mockPi: any = {
      events: {
        emit: vi.fn((_event: string, data: any) => {
          const cbs = eventHandlers.get(_event);
          if (cbs) for (const cb of cbs) cb(data);
        }),
        on: (_event: string, handler: (data: any) => void) => {
          if (!eventHandlers.has(_event)) eventHandlers.set(_event, []);
          eventHandlers.get(_event)!.push(handler);
          return () => {};
        },
      },
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: (msg: string, opts: any) => {
        sentMessages.push({ msg, opts });
      },
    };

    const eventHandlers = new Map<string, Array<(data: any) => void>>();

    const extension = await import("../src/index.js");
    extension.default(mockPi);

    mockPi.events.emit("loop:fire", {
      loopId: "7",
      prompt: "Check the build status",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      readOnly: true,
    });

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].msg).toContain("READ-ONLY MODE");
    expect(sentMessages[0].msg).toContain("[pi-loop]");
  });

  it("does not include READ-ONLY MODE when readOnly is false", async () => {
    let sentMessages: Array<{ msg: string; opts: any }> = [];

    const mockPi: any = {
      events: {
        emit: vi.fn((_event: string, data: any) => {
          const cbs = eventHandlers.get(_event);
          if (cbs) for (const cb of cbs) cb(data);
        }),
        on: (_event: string, handler: (data: any) => void) => {
          if (!eventHandlers.has(_event)) eventHandlers.set(_event, []);
          eventHandlers.get(_event)!.push(handler);
          return () => {};
        },
      },
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: (msg: string, opts: any) => {
        sentMessages.push({ msg, opts });
      },
    };

    const eventHandlers = new Map<string, Array<(data: any) => void>>();

    const extension = await import("../src/index.js");
    extension.default(mockPi);

    mockPi.events.emit("loop:fire", {
      loopId: "8",
      prompt: "Check the build status",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      readOnly: false,
    });

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].msg).not.toContain("READ-ONLY MODE");
  });

  it("skips recurring fires when agent already has pending messages", async () => {
    let sentMessages: Array<{ msg: string; opts: any }> = [];
    const turnHandlers: Array<(...args: any[]) => void> = [];

    const mockPi: any = {
      events: {
        emit: vi.fn((_event: string, data: any) => {
          const cbs = eventHandlers.get(_event);
          if (cbs) for (const cb of cbs) cb(data);
        }),
        on: (_event: string, handler: (data: any) => void) => {
          if (!eventHandlers.has(_event)) eventHandlers.set(_event, []);
          eventHandlers.get(_event)!.push(handler);
          return () => {};
        },
      },
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === "turn_start") turnHandlers.push(handler);
      }),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: (msg: string, opts: any) => {
        sentMessages.push({ msg, opts });
      },
    };

    const eventHandlers = new Map<string, Array<(data: any) => void>>();

    const extension = await import("../src/index.js");
    extension.default(mockPi);

    for (const handler of turnHandlers) {
      handler(null, {
        ui: { setStatus: vi.fn(), setWidget: vi.fn() },
        hasPendingMessages: () => true,
        sessionManager: { getSessionId: () => "test" },
      });
    }

    mockPi.events.emit("loop:fire", {
      loopId: "9",
      prompt: "Should be skipped",
      trigger: { type: "cron", schedule: "*/1 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });

    expect(sentMessages.length).toBe(0);
  });

  it("sends one-shot fires even when agent has pending messages", async () => {
    let sentMessages: Array<{ msg: string; opts: any }> = [];
    const turnHandlers: Array<(...args: any[]) => void> = [];

    const mockPi: any = {
      events: {
        emit: vi.fn((_event: string, data: any) => {
          const cbs = eventHandlers.get(_event);
          if (cbs) for (const cb of cbs) cb(data);
        }),
        on: (_event: string, handler: (data: any) => void) => {
          if (!eventHandlers.has(_event)) eventHandlers.set(_event, []);
          eventHandlers.get(_event)!.push(handler);
          return () => {};
        },
      },
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === "turn_start") turnHandlers.push(handler);
      }),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: (msg: string, opts: any) => {
        sentMessages.push({ msg, opts });
      },
    };

    const eventHandlers = new Map<string, Array<(data: any) => void>>();

    const extension = await import("../src/index.js");
    extension.default(mockPi);

    for (const handler of turnHandlers) {
      handler(null, {
        ui: { setStatus: vi.fn(), setWidget: vi.fn() },
        hasPendingMessages: () => true,
        sessionManager: { getSessionId: () => "test" },
      });
    }

    mockPi.events.emit("loop:fire", {
      loopId: "11",
      prompt: "Monitor completed — must deliver",
      trigger: { type: "event", source: "monitor:done" },
      timestamp: Date.now(),
      recurring: false,
    });

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].msg).toContain("Monitor completed");
  });

  it("sends message when agent has no pending messages", async () => {
    let sentMessages: Array<{ msg: string; opts: any }> = [];
    const turnHandlers: Array<(...args: any[]) => void> = [];

    const mockPi: any = {
      events: {
        emit: vi.fn((_event: string, data: any) => {
          const cbs = eventHandlers.get(_event);
          if (cbs) for (const cb of cbs) cb(data);
        }),
        on: (_event: string, handler: (data: any) => void) => {
          if (!eventHandlers.has(_event)) eventHandlers.set(_event, []);
          eventHandlers.get(_event)!.push(handler);
          return () => {};
        },
      },
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === "turn_start") turnHandlers.push(handler);
      }),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: (msg: string, opts: any) => {
        sentMessages.push({ msg, opts });
      },
    };

    const eventHandlers = new Map<string, Array<(data: any) => void>>();

    const extension = await import("../src/index.js");
    extension.default(mockPi);

    for (const handler of turnHandlers) {
      handler(null, {
        ui: { setStatus: vi.fn(), setWidget: vi.fn() },
        hasPendingMessages: () => false,
        sessionManager: { getSessionId: () => "test" },
      });
    }

    mockPi.events.emit("loop:fire", {
      loopId: "10",
      prompt: "Should be sent",
      trigger: { type: "cron", schedule: "*/1 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });

    expect(sentMessages.length).toBe(1);
  });

  it("skips fire when autoTask loop has no pending tasks", async () => {
    let sentMessages: Array<{ msg: string; opts: any }> = [];
    const turnHandlers: Array<(...args: any[]) => void> = [];
    let pendingTaskCount = 0;

    const mockPi: any = {
      events: {
        emit: vi.fn((_event: string, data: any) => {
          // Route tasks RPC: reply with pending count when queried
          if (_event === "tasks:rpc:pending" && data?.requestId) {
            const replyEvent = `tasks:rpc:pending:reply:${data.requestId}`;
            const replyHandlers = allHandlers.get(replyEvent);
            if (replyHandlers) {
              for (const cb of replyHandlers) {
                cb({ success: true, data: { pending: pendingTaskCount } });
              }
            }
            return;
          }
          if (_event === "tasks:rpc:ping" && data?.requestId) {
            const replyEvent = `tasks:rpc:ping:reply:${data.requestId}`;
            const replyHandlers = allHandlers.get(replyEvent);
            if (replyHandlers) {
              for (const cb of replyHandlers) {
                cb({ success: true, data: { version: 1 } });
              }
            }
            return;
          }
          const cbs = allHandlers.get(_event);
          if (cbs) for (const cb of cbs) cb(data);
        }),
        on: vi.fn((_event: string, handler: (data: any) => void) => {
          if (!allHandlers.has(_event)) allHandlers.set(_event, []);
          allHandlers.get(_event)!.push(handler);
          return () => {};
        }),
      },
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (event === "turn_start") turnHandlers.push(handler);
      }),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: (msg: string, opts: any) => {
        sentMessages.push({ msg, opts });
      },
    };

    const allHandlers = new Map<string, Array<(data: any) => void>>();

    const extension = await import("../src/index.js");
    extension.default(mockPi);

    // Simulate pi-tasks available
    mockPi.events.emit("tasks:ready");

    // Seed turn_start so _latestCtx is set
    for (const handler of turnHandlers) {
      handler(null, {
        ui: { setStatus: vi.fn(), setWidget: vi.fn() },
        hasPendingMessages: () => false,
        sessionManager: { getSessionId: () => "test" },
      });
    }

    // pendingTaskCount is 0 — loop should skip
    pendingTaskCount = 0;
    mockPi.events.emit("loop:fire", {
      loopId: "12",
      prompt: "Should be skipped — no tasks",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      autoTask: true,
    });

    // Wait for async hasPendingTasks to resolve
    await new Promise(r => setTimeout(r, 100));
    expect(sentMessages.length).toBe(0);

    // pendingTaskCount is 5 — loop should fire
    pendingTaskCount = 5;
    mockPi.events.emit("loop:fire", {
      loopId: "12",
      prompt: "Should fire — tasks pending",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      autoTask: true,
    });

    await new Promise(r => setTimeout(r, 100));
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].msg).toContain("Should fire");
  });
});
