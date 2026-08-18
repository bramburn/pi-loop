import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerLoopFireCommand } from "../src/commands/loop-fire-command.js";
import { LoopStore } from "../src/store.js";
import { createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const mock = createMockPi();
  const store = new LoopStore(); // memory mode, no file I/O
  registerLoopFireCommand({
    pi: mock.pi,
    getStore: () => store as any,
  });
  const cmd = mock.commandMap.get("loop-fire");
  if (!cmd) throw new Error("/loop-fire command not registered");
  return { mock, store, command: cmd.handler as (args: string, ctx: any) => Promise<void> };
}

function makeCtx(ui: any, isIdle = true) {
  return { ui, isIdle: () => isIdle } as any;
}

describe("registerLoopFireCommand", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("registers /loop-fire with a description that mentions picker and id form", () => {
    const cmd = h.mock.commandMap.get("loop-fire")!;
    expect(cmd).toBeDefined();
    expect(cmd.description).toContain("Fire a stored loop's prompt");
    expect(cmd.description).toContain("/loop-fire [id]");
    expect(cmd.description).toContain("picker");
  });

  it("no-args with empty store notifies and skips the picker", async () => {
    const ui = { select: vi.fn(), notify: vi.fn() };
    await h.command("", makeCtx(ui));

    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No stored loops to fire"),
      "info",
    );
  });

  it("no-args opens a picker that lists every stored loop with status icon and < Cancel>", async () => {
    const id1 = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "check the deploy", { recurring: true }).id;
    const id2 = h.store.create({ type: "event", source: "tool_execution_start" }, "react to tool calls", { recurring: true }).id;
    h.store.pause(id2);

    const calls: Array<{ title: string; choices: string[] }> = [];
    const ui = {
      select: vi.fn(async (title: string, choices: string[]) => {
        calls.push({ title, choices });
        return "< Cancel>";
      }),
      notify: vi.fn(),
    };

    await h.command("", makeCtx(ui));

    expect(calls).toHaveLength(1);
    expect(calls[0].title).toBe("Fire loop into chat");
    expect(calls[0].choices.at(-1)).toBe("< Cancel>");
    const row1 = calls[0].choices.find((c) => c.includes(`#${id1}`));
    const row2 = calls[0].choices.find((c) => c.includes(`#${id2}`));
    expect(row1).toMatch(/^\* /);
    expect(row1).toContain("[active]");
    expect(row2).toMatch(/^- /);
    expect(row2).toContain("[paused]");
    expect(h.mock.sentUserMessages).toHaveLength(0);
  });

  it("picker selection of a row sends the loop's prompt as a fresh user message when idle", async () => {
    const id = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "check the deploy", { recurring: true }).id;
    const row = h.store.list().map((l) => l.id === id ? l : l)[0];

    const ui = {
      select: vi.fn(async () => `* #${id} [active] check the deploy (cron: */5 * * * *)`),
      notify: vi.fn(),
    };

    await h.command("", makeCtx(ui, true));

    expect(h.mock.sentUserMessages).toEqual([
      { message: "check the deploy", options: undefined },
    ]);
    expect(ui.notify).toHaveBeenCalledWith(`Loop #${id} fired into chat.`, "info");
    expect(row.prompt).toBe("check the deploy");
  });

  it("picker < Cancel> does not send or notify an error", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "check the deploy", { recurring: true });

    const ui = {
      select: vi.fn(async () => "< Cancel>"),
      notify: vi.fn(),
    };

    await h.command("", makeCtx(ui));

    expect(h.mock.sentUserMessages).toHaveLength(0);
    expect(ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("fired"), "info");
  });

  it("picker undefined (esc) does not send", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "check the deploy", { recurring: true });

    const ui = {
      select: vi.fn(async () => undefined),
      notify: vi.fn(),
    };

    await h.command("", makeCtx(ui));

    expect(h.mock.sentUserMessages).toHaveLength(0);
  });

  it("id form fires the matching loop's prompt when idle (triggers a turn)", async () => {
    const id = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "watch the build", { recurring: true }).id;
    const ui = { select: vi.fn(), notify: vi.fn() };

    await h.command(id, makeCtx(ui, true));

    expect(h.mock.sentUserMessages).toEqual([
      { message: "watch the build", options: undefined },
    ]);
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(`Loop #${id} fired into chat.`, "info");
  });

  it("id form queues the message as followUp when the agent is busy", async () => {
    const id = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "watch the build", { recurring: true }).id;
    const ui = { select: vi.fn(), notify: vi.fn() };

    await h.command(id, makeCtx(ui, false));

    expect(h.mock.sentUserMessages).toEqual([
      { message: "watch the build", options: { deliverAs: "followUp" } },
    ]);
    expect(ui.notify).toHaveBeenCalledWith(
      `Agent busy — Loop #${id} queued as follow-up.`,
      "info",
    );
  });

  it("id form reports an error and sends nothing when the id does not exist", async () => {
    const ui = { select: vi.fn(), notify: vi.fn() };

    await h.command("999", makeCtx(ui));

    expect(h.mock.sentUserMessages).toHaveLength(0);
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop #999 not found"),
      "error",
    );
  });

  it("id form rejects non-numeric ids with an error", async () => {
    const ui = { select: vi.fn(), notify: vi.fn() };

    await h.command("abc", makeCtx(ui));

    expect(h.mock.sentUserMessages).toHaveLength(0);
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Expected a numeric loop ID"),
      "error",
    );
  });

  it("id form reports an error and sends nothing for a loop with an empty prompt", async () => {
    const id = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "   ", { recurring: true }).id;
    const ui = { select: vi.fn(), notify: vi.fn() };

    await h.command(id, makeCtx(ui));

    expect(h.mock.sentUserMessages).toHaveLength(0);
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(`Loop #${id} has no prompt`),
      "error",
    );
  });

  it("sends a sendUserMessage throw as an error notification", async () => {
    const id = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "watch the build", { recurring: true }).id;
    h.mock.pi.sendUserMessage = vi.fn(() => {
      throw new Error("agent swallowed");
    });
    const ui = { select: vi.fn(), notify: vi.fn() };

    await h.command(id, makeCtx(ui, true));

    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fire Loop #" + id),
      "error",
    );
    expect(ui.notify.mock.calls[0][0]).toContain("agent swallowed");
  });

  it("fire does not bump fireCount and does not emit loop:fire", async () => {
    const entry = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "check deploy", { recurring: true });
    const beforeCount = entry.fireCount ?? 0;
    const beforeEvents = h.mock.emittedEvents.length;
    const ui = { select: vi.fn(), notify: vi.fn() };

    await h.command(entry.id, makeCtx(ui, true));

    expect(h.store.get(entry.id)?.fireCount ?? 0).toBe(beforeCount);
    expect(h.mock.emittedEvents.length).toBe(beforeEvents);
  });

  it("full-prompt is sent (not the 50-char picker truncation)", async () => {
    const longPrompt = "x".repeat(200);
    const id = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, longPrompt, { recurring: true }).id;
    const ui = { select: vi.fn(), notify: vi.fn() };

    await h.command(id, makeCtx(ui, true));

    expect(h.mock.sentUserMessages[0]?.message).toBe(longPrompt);
  });
});
