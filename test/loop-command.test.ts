import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerLoopCommand } from "../src/commands/loop-command.js";
import { LoopStore } from "../src/store.js";
import { createMockPi } from "./helpers/mock-pi.js";

interface FakeUI {
  select: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
}

function makeCtx(ui: FakeUI) {
  return { ui };
}

function setup() {
  const { pi, commandMap } = createMockPi();
  const store = new LoopStore();
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const updateWidget = vi.fn();

  registerLoopCommand({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    updateWidget,
  });

  const ui: FakeUI = {
    select: vi.fn(),
    input: vi.fn(),
    notify: vi.fn(),
  };

  return { commandMap, store, triggerSystem, updateWidget, ui };
}

describe("/loop-resume command", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("is registered alongside /loop", () => {
    expect(h.commandMap.has("loop")).toBe(true);
    expect(h.commandMap.has("loop-resume")).toBe(true);
  });

  it("describes itself with the usage hint", () => {
    const desc = h.commandMap.get("loop-resume")?.description ?? "";
    expect(desc).toContain("/loop-resume <id>");
  });

  it("re-arms a known loop id without prompt and adds the trigger", async () => {
    // Seed the store with an active event loop (simulating a project-scoped
    // loop that survived a session restart but lost its trigger subscription).
    h.store.create({ type: "event", source: "tool_execution_start" }, "re-arm me", {
      recurring: true,
    });

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("1", makeCtx(h.ui) as any);

    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.triggerSystem.add).toHaveBeenCalledWith(expect.objectContaining({ id: "1" }));
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop #1 re-armed"),
      "info",
    );
  });

  it("reports a not-found error for unknown ids", async () => {
    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("99", makeCtx(h.ui) as any);

    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop #99 not found"),
      "error",
    );
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
  });

  it("rejects non-numeric arguments with an error message", async () => {
    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("abc", makeCtx(h.ui) as any);

    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Expected a numeric loop ID'),
      "error",
    );
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
  });

  it("shows a picker when called with no argument and re-arms the selected loop", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "first", { recurring: true });
    h.store.create({ type: "event", source: "before_agent_start" }, "second", {
      recurring: true,
    });

    h.ui.select.mockResolvedValueOnce("* #2 [active] second (event: before_agent_start)");
    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.select).toHaveBeenCalledTimes(1);
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.triggerSystem.add).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }));
    expect(h.updateWidget).toHaveBeenCalled();
  });

  it("does nothing when the picker returns < Back", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "loop", { recurring: true });

    h.ui.select.mockResolvedValueOnce("< Back");
    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.ui.notify).not.toHaveBeenCalled();
  });

  it("notifies info when no loops exist and no id is given", async () => {
    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No stored loops"),
      "info",
    );
    expect(h.ui.select).not.toHaveBeenCalled();
  });
});

describe("/loop command", () => {
  it("schedules a cron loop from a bare interval", async () => {
    const h = setup();
    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("5m check the deploy", makeCtx(h.ui) as any);

    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.store.list()).toHaveLength(1);
    expect(h.store.list()[0].trigger.type).toBe("cron");
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop #1 created"),
      "info",
    );
  });

  it("shows the top-level menu when called with no args", async () => {
    const h = setup();
    h.ui.select.mockResolvedValueOnce("");
    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.select).toHaveBeenCalledWith(
      "Loop",
      expect.arrayContaining([
        expect.stringContaining("Create scheduled loop"),
        expect.stringContaining("Create event-triggered loop"),
        expect.stringContaining("View loops"),
        expect.stringContaining("Settings"),
      ]),
    );
  });
});
