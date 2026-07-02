import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { registerLoopTools } from "../src/tools/loop-tools.js";
import { createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const { pi, toolMap } = createMockPi();
  const store = new LoopStore(); // memory mode, no file I/O
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const scheduler = { nextFire: vi.fn(() => undefined) };
  const monitorManager = { get: vi.fn(() => undefined) };
  registerLoopTools({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    getScheduler: () => scheduler as any,
    getMonitorManager: () => monitorManager as any,
    updateWidget: vi.fn(),
    maybeBootstrapTaskLoop: vi.fn(async () => false),
    isTaskSystemReady: () => true,
  });
  const text = async (name: string, args: any) =>
    (await toolMap.get(name)!.execute!("t", args)).content[0].text as string;
  return { store, triggerSystem, text };
}

describe("LoopCreate", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("creates a cron loop from an interval and arms the trigger system", async () => {
    const out = await h.text("LoopCreate", { trigger: "5m", prompt: "check build", triggerType: "cron" });
    expect(out).toContain("Loop #1 created");
    expect(out).toContain("schedule:");
    expect(out).toContain("Recurring: true");
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.store.get("1")?.trigger.type).toBe("cron");
  });

  it("creates an event loop that defaults to non-recurring", async () => {
    const out = await h.text("LoopCreate", { trigger: "tasks:created", prompt: "go", triggerType: "event" });
    expect(out).toContain("event: tasks:created");
    expect(out).toContain("Recurring: false");
    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tasks:created" });
  });

  it("creates a hybrid loop", async () => {
    const out = await h.text("LoopCreate", { trigger: "5m", prompt: "go", triggerType: "hybrid" });
    expect(out).toContain("hybrid: cron");
    expect(h.store.get("1")?.trigger.type).toBe("hybrid");
  });

  it("rejects an empty event source with a validation message", async () => {
    const out = await h.text("LoopCreate", { trigger: "", prompt: "go", triggerType: "event" });
    expect(out).toContain("Invalid event trigger");
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.store.list()).toHaveLength(0);
  });

  it("infers cron from an interval when triggerType is omitted", async () => {
    await h.text("LoopCreate", { trigger: "30s", prompt: "poll" });
    expect(h.store.get("1")?.trigger.type).toBe("cron");
  });

  it("infers cron from a full 5-field cron expression when triggerType is omitted", async () => {
    await h.text("LoopCreate", { trigger: "0 9 * * 1-5", prompt: "morning" });
    expect(h.store.get("1")?.trigger.type).toBe("cron");
  });

  it("infers event from a non-interval source when triggerType is omitted", async () => {
    await h.text("LoopCreate", { trigger: "tool_execution_start", prompt: "react" });
    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tool_execution_start" });
  });

  it("persists readOnly and maxFires flags", async () => {
    await h.text("LoopCreate", { trigger: "5m", prompt: "poll", triggerType: "cron", readOnly: true, maxFires: 20 });
    const entry = h.store.get("1");
    expect(entry?.readOnly).toBe(true);
    expect(entry?.maxFires).toBe(20);
  });
});

describe("LoopList", () => {
  it("reports when no loops are configured", async () => {
    const h = setup();
    expect(await h.text("LoopList", {})).toContain("No loops configured");
  });

  it("lists active loops with trigger info", async () => {
    const h = setup();
    await h.text("LoopCreate", { trigger: "5m", prompt: "build check", triggerType: "cron" });
    const out = await h.text("LoopList", {});
    expect(out).toContain("#1");
    expect(out).toContain("[active]");
    expect(out).toContain("cron:");
  });
});

describe("LoopDelete", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(async () => {
    h = setup();
    await h.text("LoopCreate", { trigger: "5m", prompt: "x", triggerType: "cron" });
  });

  it("deletes a loop and removes its trigger", async () => {
    const out = await h.text("LoopDelete", { id: "1", action: "delete" });
    expect(out).toBe("Loop #1 deleted");
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.store.get("1")).toBeUndefined();
  });

  it("pauses a loop without removing it", async () => {
    const out = await h.text("LoopDelete", { id: "1", action: "pause" });
    expect(out).toBe("Loop #1 paused");
    expect(h.store.get("1")?.status).toBe("paused");
  });

  it("reports not found for an unknown id", async () => {
    expect(await h.text("LoopDelete", { id: "99", action: "delete" })).toBe("Loop #99 not found");
  });

  it("resumes a paused loop and re-arms the trigger", async () => {
    await h.text("LoopDelete", { id: "1", action: "pause" });
    (h.triggerSystem.add as any).mockClear();
    const out = await h.text("LoopDelete", { id: "1", action: "resume" });
    expect(out).toBe("Loop #1 resumed");
    expect(h.store.get("1")?.status).toBe("active");
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
  });

  it("resuming an already-active loop is a no-op (does not re-add trigger)", async () => {
    (h.triggerSystem.add as any).mockClear();
    const out = await h.text("LoopDelete", { id: "1", action: "resume" });
    expect(out).toBe("Loop #1 resumed");
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
  });
});

describe("LoopUpdate", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(async () => {
    h = setup();
    await h.text("LoopCreate", { trigger: "5m", prompt: "build check", triggerType: "cron" });
  });

  it("updates only the prompt and keeps the trigger intact", async () => {
    (h.triggerSystem.remove as any).mockClear();
    (h.triggerSystem.add as any).mockClear();
    const out = await h.text("LoopUpdate", { id: "1", prompt: "new prompt" });
    expect(out).toContain("Loop #1 updated: prompt");
    expect(h.store.get("1")?.prompt).toBe("new prompt");
    expect(h.store.get("1")?.trigger.type).toBe("cron");
    // Trigger was re-registered with the same value.
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
  });

  it("changes the trigger and re-subscribes", async () => {
    const out = await h.text("LoopUpdate", { id: "1", trigger: "10m" });
    expect(out).toContain("Loop #1 updated: trigger");
    expect(h.store.get("1")?.trigger).toEqual({ type: "cron", schedule: "*/10 * * * *" });
  });

  it("switches a loop from cron to event trigger", async () => {
    const out = await h.text("LoopUpdate", { id: "1", trigger: "tool_execution_end" });
    expect(out).toContain("Loop #1 updated: trigger");
    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tool_execution_end" });
  });

  it("updates maxFires and reports the change", async () => {
    const out = await h.text("LoopUpdate", { id: "1", maxFires: 10 });
    expect(out).toContain("Loop #1 updated: maxFires");
    expect(h.store.get("1")?.maxFires).toBe(10);
  });

  it("returns not-found for an unknown id", async () => {
    const out = await h.text("LoopUpdate", { id: "99", prompt: "x" });
    expect(out).toBe("Loop #99 not found");
  });

  it("rejects an invalid new trigger", async () => {
    const out = await h.text("LoopUpdate", { id: "1", trigger: "" });
    expect(out).toContain("Invalid event trigger");
    // Trigger unchanged.
    expect(h.store.get("1")?.trigger.type).toBe("cron");
  });

  it("reports no change when called with no fields", async () => {
    const out = await h.text("LoopUpdate", { id: "1" });
    expect(out).toContain("No changes provided");
  });
});

describe("LoopList filter (G-20)", () => {
  it("hides internal monitor:done one-shot loops", async () => {
    const h = setup();
    // User-configured loop
    await h.text("LoopCreate", { trigger: "5m", prompt: "user loop", triggerType: "cron" });
    // Internal one-shot monitor:done loop
    h.store.create(
      { type: "event", source: "monitor:done" },
      "internal wake",
      { recurring: false },
    );
    const out = await h.text("LoopList", {});
    expect(out).toContain("#1");
    expect(out).not.toContain("internal wake");
  });
});
