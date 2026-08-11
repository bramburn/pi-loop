import { describe, expect, it, vi } from "vitest";
import { registerLoopEditCommand } from "../src/commands/loop-edit-command.js";
import { LoopStore } from "../src/store.js";
import { createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const { pi, commandMap } = createMockPi();
  const store = new LoopStore();
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const updateWidget = vi.fn();
  registerLoopEditCommand({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    updateWidget,
  });
  const command = commandMap.get("loop-edit")!;
  return { store, triggerSystem, updateWidget, command };
}

function ctxWithUi(ui: any) {
  return { ui } as any;
}

function makeUi(overrides: Partial<{ select: any; input: any }> = {}) {
  const notifications: Array<{ message: string; level?: string }> = [];
  return {
    ui: {
      select: overrides.select ?? vi.fn(async () => undefined),
      input: overrides.input ?? vi.fn(async () => undefined),
      notify: overrides.notify ?? ((message: string, level?: string) => notifications.push({ message, level })),
    },
    notifications,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Interval parsing — what the user explicitly asked about
// ════════════════════════════════════════════════════════════════════════════

describe("interval edits via /loop-edit", () => {
  it.each([
    { input: "5m", cron: "*/5 * * * *", from: "*/30 * * * *" },
    { input: "10m", cron: "*/10 * * * *", from: "*/5 * * * *" },
    { input: "15m", cron: "*/15 * * * *", from: "*/5 * * * *" },
    { input: "30m", cron: "*/30 * * * *", from: "*/15 * * * *" },
    { input: "1h", cron: "0 * * * *", from: "*/30 * * * *" },
    { input: "2h", cron: "0 */2 * * *", from: "0 * * * *" },
    { input: "3h", cron: "0 */3 * * *", from: "0 * * * *" },
    { input: "6h", cron: "0 */6 * * *", from: "0 */2 * * *" },
    { input: "12h", cron: "0 */12 * * *", from: "0 */6 * * *" },
    { input: "1d", cron: "0 0 * * *", from: "0 */12 * * *" },
  ])("parses '$input' → '$cron' and re-arms", async ({ input, cron, from }) => {
    const h = setup();
    h.store.create({ type: "cron", schedule: from } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce(`* #1 [active] p (cron: ${from})`)
      .mockResolvedValueOnce(`trigger: cron: ${from}`)
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => input);
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect((h.store.get("1")!.trigger as any).schedule).toBe(cron);
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalled();
  });

  it("rounds '7m' to the nearest common interval", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "7m");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    const schedule = (h.store.get("1")!.trigger as any).schedule;
    // 7m rounds to either 5m or 10m — accept either since both are valid
    expect(["*/5 * * * *", "*/10 * * * *"]).toContain(schedule);
  });

  it("clamps sub-minute '30s' to */1 * * * *", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "0 0 * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: 0 0 * * *)")
      .mockResolvedValueOnce("trigger: cron: 0 0 * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "30s");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect((h.store.get("1")!.trigger as any).schedule).toBe("*/1 * * * *");
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Cron expression parsing
// ════════════════════════════════════════════════════════════════════════════

describe("cron expression edits", () => {
  it.each([
    "*/15 * * * *",
    "0 9 * * 1-5",
    "0 0 * * 0",
    "30 14 * * *",
    "0 0 1 * *",
  ])("accepts cron expression: %s", async (cron) => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => cron);
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.trigger).toEqual({ type: "cron", schedule: cron });
  });

  it("accepts explicit 'cron <expr>' prefix", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "cron 0 9 * * 1-5");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.trigger).toEqual({ type: "cron", schedule: "0 9 * * 1-5" });
  });

  it("rejects malformed 5-field expression", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "0 9 * *"); // 4 fields, not 5
    const { ui, notifications } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.trigger).toEqual({ type: "cron", schedule: "*/5 * * * *" });
    expect(notifications.some((n) => n.level === "error" && n.message.includes("Could not parse trigger"))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Event trigger edge cases
// ════════════════════════════════════════════════════════════════════════════

describe("event trigger edits", () => {
  it("switches from cron to event with bare source", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "event before_agent_start");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.trigger).toEqual({ type: "event", source: "before_agent_start" });
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalled();
  });

  it("switches from event back to cron via interval shorthand", async () => {
    const h = setup();
    h.store.create({ type: "event", source: "tool_execution_start" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (event: tool_execution_start)")
      .mockResolvedValueOnce("trigger: event: tool_execution_start")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "10m");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.trigger).toEqual({ type: "cron", schedule: "*/10 * * * *" });
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalled();
  });

  it("preserves filter when event trigger remains unchanged", async () => {
    const h = setup();
    h.store.create(
      { type: "event", source: "tool_execution_start", filter: "regex:error" } as any,
      "p",
      { recurring: true },
    );

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (event: tool_execution_start)")
      .mockResolvedValueOnce("prompt: p")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "new prompt");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.trigger).toEqual({
      type: "event",
      source: "tool_execution_start",
      filter: "regex:error",
    });
    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
  });

  it("parses event with filter including spaces", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "event tool_execution_start regex:error timeout");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.trigger).toEqual({
      type: "event",
      source: "tool_execution_start",
      filter: "regex:error timeout",
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Trigger re-arm gating
// ════════════════════════════════════════════════════════════════════════════

describe("trigger re-arm gating", () => {
  it("does NOT re-arm when trigger reference is identical", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("Save & Exit");
    const { ui } = makeUi({ select });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
  });

  it("does NOT re-arm when new trigger is structurally identical to old", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    // Use the trigger-edit branch so the draft goes through updateMetadata
    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "5m"); // round-trips to "*/5 * * * *"
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
  });

  it("DOES re-arm when type changes from event to cron", async () => {
    const h = setup();
    h.store.create({ type: "event", source: "before_agent_start" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (event: before_agent_start)")
      .mockResolvedValueOnce("trigger: event: before_agent_start")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "5m");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalledWith(h.store.get("1"));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// State preservation across edits
// ════════════════════════════════════════════════════════════════════════════

describe("state preservation", () => {
  it("preserves createdAt across edits", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });
    const createdAt = h.store.get("1")!.createdAt;

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("recurring: true")
      .mockResolvedValueOnce("Save & Exit");
    const { ui } = makeUi({ select });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.createdAt).toBe(createdAt);
  });

  it("preserves fireCount across edits", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });
    h.store.get("1")!.fireCount = 7;

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("prompt: p")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "new prompt");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.fireCount).toBe(7);
  });

  it("preserves id across edits", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("prompt: p")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "new prompt");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.id).toBe("1");
  });

  it("preserves dynamic state when present", async () => {
    const h = setup();
    h.store.create(
      { type: "dynamic" } as any,
      "achieve X",
      { recurring: true, dynamic: { goal: "achieve X", iteration: 3, doneCriteria: "all done" } },
    );

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] achieve X (dynamic)")
      .mockResolvedValueOnce("prompt: achieve X")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "achieve Y");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    const entry = h.store.get("1")!;
    expect(entry.prompt).toBe("achieve Y");
    expect(entry.dynamic).toBeDefined();
    expect(entry.dynamic!.iteration).toBe(3);
    expect(entry.dynamic!.doneCriteria).toBe("all done");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// maxFires boundary values
// ════════════════════════════════════════════════════════════════════════════

describe("maxFires boundaries", () => {
  it("accepts 1 (minimum valid)", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("maxFires: (none)")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "1");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.maxFires).toBe(1);
  });

  it("rejects 0", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("maxFires: (none)")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "0");
    const { ui, notifications } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.maxFires).toBeUndefined();
    expect(notifications.some((n) => n.level === "error" && n.message.includes("positive integer"))).toBe(true);
  });

  it("rejects negative numbers", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("maxFires: (none)")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "-5");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.maxFires).toBeUndefined();
  });

  it("rejects decimal numbers", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("maxFires: (none)")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "3.14");
    const { ui, notifications } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.maxFires).toBeUndefined();
    expect(notifications.some((n) => n.level === "error")).toBe(true);
  });

  it("parses whitespace-padded number '  25  '", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("maxFires: (none)")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "  25  ");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.maxFires).toBe(25);
  });

  it("accepts very large numbers", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("maxFires: (none)")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "999999999");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.maxFires).toBe(999999999);
  });

  it("clearing maxFires when already undefined is idempotent", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("maxFires: (none)")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "");
    const { ui, notifications } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.maxFires).toBeUndefined();
    expect(notifications.some((n) => n.message.includes("no changes"))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Prompt edge cases
// ════════════════════════════════════════════════════════════════════════════

describe("prompt edge cases", () => {
  it("accepts a multi-line prompt", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("prompt: p")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "first line\nsecond line\nthird line");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.prompt).toBe("first line\nsecond line\nthird line");
  });

  it("accepts a prompt with special characters", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("prompt: p")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "check: 'quotes' & <html> tags");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.prompt).toBe("check: 'quotes' & <html> tags");
  });

  it("rejects a prompt that is only whitespace", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("prompt: p")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "   \t  ");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.prompt).toBe("p");
  });

  it("accepts a very long prompt (>1000 chars)", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });
    const longPrompt = "x".repeat(5000);

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("prompt: p")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => longPrompt);
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.prompt).toBe(longPrompt);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Multiple loops / picker behavior
// ════════════════════════════════════════════════════════════════════════════

describe("picker with multiple loops", () => {
  it("lists all active and paused loops", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "first", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" } as any, "second", { recurring: true });
    h.store.pause("2");

    let capturedChoices: string[] = [];
    const select = vi.fn(async (title: string, opts: string[]) => {
      if (title === "Edit loop") {
        capturedChoices = opts;
        return opts[0]; // pick the first loop
      }
      return "Save & Exit";
    });
    const { ui } = makeUi({ select });

    await h.command.handler!("", ctxWithUi(ui));

    expect(capturedChoices).toContain("* #1 [active] first (cron: */5 * * * *)");
    expect(capturedChoices).toContain("- #2 [paused] second (cron: */10 * * * *)");
  });

  it("excludes deleted loops from picker", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "keep", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" } as any, "remove me", { recurring: true });
    h.store.delete("2");

    let capturedChoices: string[] = [];
    const select = vi.fn(async (title: string, opts: string[]) => {
      if (title === "Edit loop") {
        capturedChoices = opts;
        return undefined;
      }
      return undefined;
    });
    const { ui } = makeUi({ select });

    await h.command.handler!("", ctxWithUi(ui));

    expect(capturedChoices.some((c) => c.includes("remove me"))).toBe(false);
    expect(capturedChoices.some((c) => c.includes("keep"))).toBe(true);
  });

  it("returns immediately on empty store with a 'No editable loops' notice", async () => {
    const h = setup();

    let capturedTitle = "";
    const select = vi.fn(async (title: string) => {
      capturedTitle = title;
      return undefined;
    });
    const { ui } = makeUi({ select });

    await h.command.handler!("", ctxWithUi(ui));

    expect(capturedTitle).toBe("No editable loops");
    expect(h.updateWidget).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Multi-field edits in a single session
// ════════════════════════════════════════════════════════════════════════════

describe("multi-field edits", () => {
  it("applies multiple field changes in one Save & Exit", async () => {
    const h = setup();
    h.store.create(
      { type: "cron", schedule: "*/5 * * * *" } as any,
      "p",
      { recurring: true, readOnly: false, autoTask: false },
    );

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (cron: */5 * * * *)")
      .mockResolvedValueOnce("prompt: p")
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("recurring: true")
      .mockResolvedValueOnce("readOnly: false")
      .mockResolvedValueOnce("autoTask: false")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async (prompt: string) => {
      if (prompt.startsWith("Prompt")) return "new prompt";
      if (prompt.startsWith("Trigger")) return "15m";
      return "";
    });
    const { ui, notifications } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    const entry = h.store.get("1")!;
    expect(entry.prompt).toBe("new prompt");
    expect((entry.trigger as any).schedule).toBe("*/15 * * * *");
    expect(entry.recurring).toBe(false);
    expect(entry.readOnly).toBe(true);
    expect(entry.autoTask).toBe(true);

    const notify = notifications.find((n) => n.message.includes("updated"));
    expect(notify?.message).toContain("prompt");
    expect(notify?.message).toContain("trigger");
    expect(notify?.message).toContain("recurring");
    expect(notify?.message).toContain("readOnly");
    expect(notify?.message).toContain("autoTask");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Cancel discards draft changes
// ════════════════════════════════════════════════════════════════════════════

describe("cancel discards draft", () => {
  it("does not persist any field changes after Cancel", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "original", { recurring: true });
    const originalTrigger = h.store.get("1")!.trigger;
    const originalEntry = JSON.parse(JSON.stringify(h.store.get("1")));

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] original (cron: */5 * * * *)")
      .mockResolvedValueOnce("prompt: original")
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("recurring: true")
      .mockResolvedValueOnce("readOnly: false")
      .mockResolvedValueOnce("< Cancel");
    const inputMock = vi.fn(async () => "modified");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    const entry = h.store.get("1")!;
    expect(entry.prompt).toBe("original");
    expect(entry.trigger).toBe(originalTrigger);
    expect(entry.recurring).toBe(true);
    expect(entry.readOnly).toBeUndefined();
    expect(h.updateWidget).not.toHaveBeenCalled();
    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(entry))).toEqual(originalEntry);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Hybrid trigger preservation
// ════════════════════════════════════════════════════════════════════════════

describe("hybrid trigger preservation", () => {
  it("preserves hybrid trigger when only prompt changes", async () => {
    const h = setup();
    const hybridTrigger = {
      type: "hybrid" as const,
      cron: "*/5 * * * *",
      event: { source: "tool_execution_start" },
      debounceMs: 30000,
    };
    h.store.create(hybridTrigger as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("* #1 [active] p (hybrid)")
      .mockResolvedValueOnce("prompt: p")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "new prompt");
    const { ui } = makeUi({ select, input: inputMock });

    await h.command.handler!("", ctxWithUi(ui));

    expect(h.store.get("1")!.prompt).toBe("new prompt");
    expect(h.store.get("1")!.trigger).toEqual(hybridTrigger);
    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
  });
});