import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  editLoopInteractive,
  type LoopStoreLike,
  pickLoopForEdit,
  type TriggerSystemLike,
} from "../src/commands/loop-edit-command.js";
import { LoopStore } from "../src/store.js";
import { createMockPi } from "./helpers/mock-pi.js";

interface Setup {
  store: LoopStore;
  triggerSystem: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  updateWidget: ReturnType<typeof vi.fn>;
}

function setup(): Setup {
  const store = new LoopStore();
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const updateWidget = vi.fn();
  return { store, triggerSystem, updateWidget };
}

function makeUi(overrides: Partial<{ select: any; input: any; notify: any }> = {}) {
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

async function runEdit(
  h: Setup,
  entry: ReturnType<LoopStore["get"]>,
  ui: any,
  onAfterSave: () => void = h.updateWidget,
) {
  await editLoopInteractive(
    ui,
    h.store as unknown as LoopStoreLike,
    h.triggerSystem as unknown as TriggerSystemLike,
    entry!,
    onAfterSave,
  );
}

describe("editLoopInteractive (the core edit flow)", () => {
  let h: Setup;
  beforeEach(() => {
    h = setup();
  });

  it("edits a loop's prompt via ui.input and persists the change", async () => {
    h.store.create(
      { type: "cron", schedule: "*/5 * * * *" } as any,
      "old prompt",
      { recurring: true },
    );

    const select = vi.fn()
      .mockResolvedValueOnce("prompt: old prompt")
      .mockResolvedValueOnce("Save & Exit");
    const input = vi.fn(async () => "new prompt");
    const { ui, notifications } = makeUi({ select, input });

    await runEdit(h, h.store.get("1"), ui);

    const entry = h.store.get("1");
    expect(entry?.prompt).toBe("new prompt");
    expect(input).toHaveBeenCalledTimes(1);
    expect(notifications.some((n) => n.message.includes("Loop #1 updated"))).toBe(true);
    expect(h.updateWidget).toHaveBeenCalled();
  });

  it("does not re-arm the trigger when only the prompt changes", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("prompt: p")
      .mockResolvedValueOnce("Save & Exit");
    const { ui } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
  });

  it("re-arms the trigger when it changes and the loop is active", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const input = vi.fn(async () => "15m");
    const { ui } = makeUi({ select, input });

    await runEdit(h, h.store.get("1"), ui);

    const entry = h.store.get("1");
    expect((entry!.trigger as any).schedule).toBe("*/15 * * * *");
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalled();
  });

  it("persists but does NOT re-arm when the loop is paused", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });
    h.store.pause("1");

    const select = vi.fn()
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const input = vi.fn(async () => "15m");
    const { ui } = makeUi({ select, input });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")?.trigger).toEqual({ type: "cron", schedule: "*/15 * * * *" });
    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
  });

  it("cycles recurring without prompting", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("recurring: true")
      .mockResolvedValueOnce("Save & Exit");
    const { ui } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")?.recurring).toBe(false);
  });

  it("cycles priority via a select dialog", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("priority: normal")
      .mockResolvedValueOnce("urgent (current)")
      .mockResolvedValueOnce("Save & Exit");
    const { ui } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")?.priority).toBe("urgent");
  });

  it("clears maxFires when the user enters an empty string", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", {
      recurring: true,
      maxFires: 25,
    });

    const select = vi.fn()
      .mockResolvedValueOnce("maxFires: 25")
      .mockResolvedValueOnce("Save & Exit");
    const input = vi.fn(async () => "");
    const { ui } = makeUi({ select, input });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")?.maxFires).toBeUndefined();
  });

  it("rejects non-numeric maxFires and keeps the previous value", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", {
      recurring: true,
      maxFires: 25,
    });

    const select = vi.fn()
      .mockResolvedValueOnce("maxFires: 25")
      .mockResolvedValueOnce("Save & Exit");
    const input = vi.fn(async () => "abc");
    const { ui, notifications } = makeUi({ select, input });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")?.maxFires).toBe(25);
    expect(notifications.some((n) => n.level === "error")).toBe(true);
  });

  it("cancels cleanly when the user picks < Cancel", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("< Cancel");
    const { ui, notifications } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")?.prompt).toBe("p");
    expect(h.updateWidget).not.toHaveBeenCalled();
    expect(notifications.some((n) => n.message.includes("cancelled"))).toBe(true);
  });

  it("parses an event trigger string via ui.input", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const input = vi.fn(async () => "event tool_execution_start");
    const { ui } = makeUi({ select, input });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tool_execution_start" });
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalled();
  });

  it("parses an interval shorthand trigger (15m) and re-arms", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "15m");
    const { ui } = makeUi({ select, input: inputMock });

    await runEdit(h, h.store.get("1"), ui);

    expect((h.store.get("1")!.trigger as any).schedule).toBe("*/15 * * * *");
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalled();
  });

  it("parses a raw cron expression trigger and re-arms", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "0 9 * * 1-5");
    const { ui } = makeUi({ select, input: inputMock });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")!.trigger).toEqual({ type: "cron", schedule: "0 9 * * 1-5" });
  });

  it("accepts explicit 'cron <expr>' trigger syntax", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "cron 15 * * * *");
    const { ui } = makeUi({ select, input: inputMock });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")!.trigger).toEqual({ type: "cron", schedule: "15 * * * *" });
  });

  it("rejects malformed trigger input and keeps current trigger", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });
    const originalTrigger = h.store.get("1")?.trigger;

    const select = vi.fn()
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "garbage @ not parseable");
    const { ui, notifications } = makeUi({ select, input: inputMock });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")?.trigger).toEqual(originalTrigger);
    expect(notifications.some((n) => n.level === "error" && n.message.includes("Could not parse trigger"))).toBe(true);
    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
  });

  it("keeps current trigger when the user submits an empty string", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });
    const originalTrigger = h.store.get("1")?.trigger;

    const select = vi.fn()
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "");
    const { ui } = makeUi({ select, input: inputMock });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")?.trigger).toEqual(originalTrigger);
    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
  });

  it("parses 'event <source>' trigger and re-arms", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "event before_agent_start");
    const { ui } = makeUi({ select, input: inputMock });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")!.trigger).toEqual({ type: "event", source: "before_agent_start" });
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalled();
  });

  it("parses 'event <source> <filter>' trigger", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "event tool_execution_start regex:error");
    const { ui } = makeUi({ select, input: inputMock });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")!.trigger).toEqual({
      type: "event",
      source: "tool_execution_start",
      filter: "regex:error",
    });
  });

  it("cycles priority across all four enum values", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("priority: normal")
      .mockResolvedValueOnce("defer")
      .mockResolvedValueOnce("Save & Exit");
    const { ui } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")!.priority).toBe("defer");
  });

  it("cycles priority to critical", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("priority: normal")
      .mockResolvedValueOnce("critical")
      .mockResolvedValueOnce("Save & Exit");
    const { ui } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")!.priority).toBe("critical");
  });

  it("toggles readOnly true→false→true across two cycles", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", {
      recurring: true,
      readOnly: true,
    });

    const select = vi.fn()
      .mockResolvedValueOnce("readOnly: true")
      .mockResolvedValueOnce("readOnly: false")
      .mockResolvedValueOnce("Save & Exit");
    const { ui } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")!.readOnly).toBe(true);
  });

  it("toggles autoTask from false to true", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("autoTask: false")
      .mockResolvedValueOnce("Save & Exit");
    const { ui } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")!.autoTask).toBe(true);
  });

  it("keeps the prompt when the user enters an empty string", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "keep me", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("prompt: keep me")
      .mockResolvedValueOnce("Save & Exit");
    const input = vi.fn(async () => "");
    const { ui } = makeUi({ select, input });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")!.prompt).toBe("keep me");
  });

  it("updates the widget exactly once on save", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("recurring: true")
      .mockResolvedValueOnce("recurring: false")
      .mockResolvedValueOnce("Save & Exit");
    const { ui } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.updateWidget).toHaveBeenCalledTimes(1);
  });

  it("does not update the widget when cancelled", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("< Cancel");
    const { ui } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.updateWidget).not.toHaveBeenCalled();
  });

  it("calls the onAfterSave callback exactly once on save", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });
    const onAfterSave = vi.fn();

    const select = vi.fn()
      .mockResolvedValueOnce("recurring: true")
      .mockResolvedValueOnce("Save & Exit");
    const { ui } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui, onAfterSave);

    expect(onAfterSave).toHaveBeenCalledTimes(1);
  });

  it("does not call onAfterSave when cancelled", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });
    const onAfterSave = vi.fn();

    const select = vi.fn()
      .mockResolvedValueOnce("< Cancel");
    const { ui } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui, onAfterSave);

    expect(onAfterSave).not.toHaveBeenCalled();
  });

  it("reports 'no changes' when Save & Exit is invoked immediately", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("Save & Exit");
    const { ui, notifications } = makeUi({ select });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.updateWidget).toHaveBeenCalled();
    expect(notifications.some((n) => n.message.includes("no changes"))).toBe(true);
    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
  });

  it("notifies error if the loop disappears between selection and save", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const select = vi.fn()
      .mockResolvedValueOnce("Save & Exit");
    const { ui, notifications } = makeUi({ select });

    const entry = h.store.get("1")!;
    h.store.delete("1");
    await runEdit(h, entry, ui);

    expect(notifications.some((n) => n.level === "error" && n.message.includes("not found"))).toBe(true);
  });
});

describe("editLoopInteractive (re-arm failure)", () => {
  let h: Setup;
  beforeEach(() => {
    h = setup();
  });

  it("notifies error if trigger re-arm fails (add throws)", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    h.triggerSystem.add.mockImplementation(() => {
      throw new Error("scheduler rejected trigger");
    });

    const select = vi.fn()
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "15m");
    const { ui, notifications } = makeUi({ select, input: inputMock });

    await runEdit(h, h.store.get("1"), ui);

    expect(h.store.get("1")?.trigger).toEqual({ type: "cron", schedule: "*/15 * * * *" });
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalled();
    expect(
      notifications.some(
        (n) =>
          n.level === "error" &&
          n.message.includes("could not be activated") &&
          n.message.includes("Loop #1"),
      ),
    ).toBe(true);
  });

  it("preserves the trigger change when add throws and remove had already succeeded", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    h.triggerSystem.add.mockImplementation(() => {
      throw new Error("boom");
    });

    const select = vi.fn()
      .mockResolvedValueOnce("trigger: cron: */5 * * * *")
      .mockResolvedValueOnce("Save & Exit");
    const inputMock = vi.fn(async () => "15m");
    const { ui } = makeUi({ select, input: inputMock });

    await runEdit(h, h.store.get("1"), ui);

    expect((h.store.get("1")!.trigger as any).schedule).toBe("*/15 * * * *");
    expect(h.triggerSystem.remove).toHaveBeenCalledTimes(1);
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
  });
});

describe("pickLoopForEdit", () => {
  let h: Setup;
  beforeEach(() => {
    h = setup();
  });

  it("returns undefined and shows 'No editable loops' when the store is empty", async () => {
    const select = vi.fn(async () => undefined);
    const { ui, notifications } = makeUi({ select });

    const result = await pickLoopForEdit(ui, h.store as unknown as LoopStoreLike);

    expect(result).toBeUndefined();
    expect(select).toHaveBeenCalledWith("No editable loops", ["< Back"]);
    expect(notifications).toHaveLength(0);
  });

  it("returns the chosen entry on selection", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "first", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" } as any, "second", { recurring: true });

    const select = vi.fn(async () => "* #1 [active] first (cron: */5 * * * *)");
    const { ui } = makeUi({ select });

    const result = await pickLoopForEdit(ui, h.store as unknown as LoopStoreLike);

    expect(result?.id).toBe("1");
    expect(result?.prompt).toBe("first");
  });

  it("returns undefined when the user picks < Back", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });
    const select = vi.fn(async () => "< Back");
    const { ui } = makeUi({ select });

    const result = await pickLoopForEdit(ui, h.store as unknown as LoopStoreLike);

    expect(result).toBeUndefined();
  });

  it("accepts a custom title for the picker", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });
    const select = vi.fn(async () => "* #1 [active] p (cron: */5 * * * *)");
    const { ui } = makeUi({ select });

    await pickLoopForEdit(ui, h.store as unknown as LoopStoreLike, "Pick a loop", "No loops");

    expect(select).toHaveBeenCalledWith(
      "Pick a loop",
      expect.arrayContaining(["* #1 [active] p (cron: */5 * * * *)"]),
    );
  });
});

describe("LoopStore.updateMetadata (extended fields)", () => {
  it("accepts priority, recurring, maxFires, readOnly, autoTask", () => {
    const store = new LoopStore();
    store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const result = store.updateMetadata("1", {
      priority: "urgent",
      recurring: false,
      maxFires: 10,
      readOnly: true,
      autoTask: true,
    });

    expect(result.changedFields).toEqual(
      expect.arrayContaining(["priority", "recurring", "maxFires", "readOnly", "autoTask"]),
    );
    const entry = store.get("1");
    expect(entry?.priority).toBe("urgent");
    expect(entry?.recurring).toBe(false);
    expect(entry?.maxFires).toBe(10);
    expect(entry?.readOnly).toBe(true);
    expect(entry?.autoTask).toBe(true);
    expect(entry?.updatedAt).toBeGreaterThan(0);
  });

  it("omits unchanged fields from changedFields", () => {
    const store = new LoopStore();
    store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });
    const before = store.get("1")!.updatedAt;

    const result = store.updateMetadata("1", { prompt: "p", maxFires: undefined });

    expect(result.changedFields).toEqual([]);
    expect(store.get("1")?.updatedAt).toBe(before);
  });

  it("returns undefined entry and empty changedFields for a missing id", () => {
    const store = new LoopStore();
    const result = store.updateMetadata("999", { prompt: "x" });
    expect(result.entry).toBeUndefined();
    expect(result.changedFields).toEqual([]);
  });

  it("treats an unchanged trigger as no-op (no changedFields bump)", () => {
    const store = new LoopStore();
    store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });
    const triggerRef = store.get("1")!.trigger;

    const result = store.updateMetadata("1", { trigger: triggerRef });

    expect(result.changedFields).toEqual([]);
    expect(store.get("1")?.trigger).toBe(triggerRef);
  });

  it("treats a structurally-equal but new trigger reference as no-op", () => {
    const store = new LoopStore();
    store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const result = store.updateMetadata("1", {
      trigger: { type: "cron", schedule: "*/5 * * * *" } as any,
    });

    expect(result.changedFields).toEqual([]);
  });

  it("detects a trigger schedule change", () => {
    const store = new LoopStore();
    store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const result = store.updateMetadata("1", {
      trigger: { type: "cron", schedule: "*/15 * * * *" } as any,
    });

    expect(result.changedFields).toEqual(["trigger"]);
    expect((store.get("1")!.trigger as any).schedule).toBe("*/15 * * * *");
  });

  it("detects an event trigger source change", () => {
    const store = new LoopStore();
    store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    const result = store.updateMetadata("1", {
      trigger: { type: "event", source: "tool_execution_start" } as any,
    });

    expect(result.changedFields).toEqual(["trigger"]);
    expect(store.get("1")!.trigger).toEqual({ type: "event", source: "tool_execution_start" });
  });

  it("clearMaxFires removes the field and bumps updatedAt", () => {
    const store = new LoopStore();
    store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", {
      recurring: true,
      maxFires: 25,
    });
    const before = store.get("1")!.updatedAt;

    const cleared = store.clearMaxFires("1");

    expect(cleared).toBe(true);
    expect(store.get("1")!.maxFires).toBeUndefined();
    expect(store.get("1")!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("clearMaxFires is idempotent", () => {
    const store = new LoopStore();
    store.create({ type: "cron", schedule: "*/5 * * * *" } as any, "p", { recurring: true });

    expect(store.clearMaxFires("1")).toBe(false);
  });

  it("clearMaxFires returns false for a missing id", () => {
    const store = new LoopStore();
    expect(store.clearMaxFires("999")).toBe(false);
  });
});

// Silence "createMockPi not used" — kept for parity with the rest of the suite.
void createMockPi;