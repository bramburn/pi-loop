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
});
