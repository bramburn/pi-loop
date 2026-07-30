import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerLoopCommand } from "../src/commands/loop-command.js";
import { BindingsStore } from "../src/runtime/bindings-store.js";
import { LoopStore } from "../src/store.js";
import { createMockPi } from "./helpers/mock-pi.js";

interface FakeUI {
  select: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
}

function makeCtx(ui: FakeUI) {
  return { ui };
}

function setup() {
  const { pi, commandMap } = createMockPi();
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  // In-memory BindingsStore — exercises the same code path as file-backed
  // for has/add/remove semantics without tmpdir churn. File-backed behavior
  // is covered separately in test/bindings-store.test.ts.
  const bindingsStore = new BindingsStore(undefined, "memory", "test-session");
  const updateWidget = vi.fn();
  const widget = { setFiringStatus: vi.fn() };
  const notificationRuntime = { queueOrDeliverNotification: vi.fn(async () => {}) };

  // Wrap the store with a proxy that auto-injects createdBy on every create()
  // call, mirroring the production behavior in Governor and LoopCreate. Tests
  // that want a loop in "Other terminals" can override by passing
  // createdBy: undefined or a different value explicitly.
  const rawStore = new LoopStore();
  const updateMetadataSpy = vi.spyOn(rawStore, "updateMetadata");
  const store = new Proxy(rawStore, {
    get(target, prop) {
      const val = (target as any)[prop];
      if (prop === "create") {
        return (trigger: any, prompt: any, opts: any) =>
          rawStore.create(trigger, prompt, { ...opts, createdBy: bindingsStore.sessionId });
      }
      if (typeof val === "function") return val.bind(target);
      return val;
    },
  });

  registerLoopCommand({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    getBindingsStore: () => bindingsStore,
    getNotificationRuntime: () => notificationRuntime as any,
    getWidget: () => widget as any,
    updateWidget,
  });

  const ui: FakeUI = {
    select: vi.fn(),
    input: vi.fn(),
    notify: vi.fn(),
    confirm: vi.fn(),
  };

  return { commandMap, store, rawStore, triggerSystem, bindingsStore, updateWidget, ui, updateMetadataSpy, notificationRuntime, widget };
}

describe("/loop-resume command — one-shot path", () => {
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
    expect(desc).toContain("governor");
  });

  it("/loop-resume <id> re-arms + binds in a single call", async () => {
    const resumeSpy = vi.spyOn(h.store, "resume");
    h.store.create({ type: "event", source: "tool_execution_start" }, "re-arm me", {
      recurring: true,
    });

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("1", makeCtx(h.ui) as any);

    // The full one-shot sequence: store.resume + triggerSystem.add + bindings.add + notify
    expect(resumeSpy).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.bindingsStore.has("1")).toBe(true);
    expect(h.updateWidget).toHaveBeenCalled();
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop #1 re-armed and bound to this session"),
      "info",
    );
  });

  it("/loop-resume <id> reports a not-found error for unknown ids", async () => {
    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("99", makeCtx(h.ui) as any);

    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop #99 not found"),
      "error",
    );
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.bindingsStore.has("99")).toBe(false);
  });

  it("/loop-resume <id> rejects non-numeric arguments with an error message", async () => {
    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("abc", makeCtx(h.ui) as any);

    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Expected a numeric loop ID"),
      "error",
    );
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
  });

  it("/loop-resume <id> never mutates store.status", async () => {
    const entry = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "status check", {
      recurring: true,
    });
    const before = entry.status;

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!(entry.id, makeCtx(h.ui) as any);

    expect(h.store.get(entry.id)?.status).toBe(before);
  });
});

describe("/loop-resume command — governor path", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("notifies and skips the picker when the store is empty", async () => {
    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No stored loops"),
      "info",
    );
    expect(h.ui.select).not.toHaveBeenCalled();
  });

  it("opens the governor picker when called with no args and stores exist", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "first", { recurring: true });

    // User picks < Cancel on the first render → picker exits
    h.ui.select.mockResolvedValueOnce("< Cancel");
    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.select).toHaveBeenCalledTimes(1);
    const [title, options] = h.ui.select.mock.calls[0];
    expect(title).toContain("Governor");
    // First option is the loop row; last five are sentinels (OK, Continue, Disarm all, Refresh, Cancel)
    expect(options[options.length - 5]).toBe("< OK");
    expect(options[options.length - 4]).toBe("< Continue");
    expect(options[options.length - 3]).toBe("< Disarm all");
    expect(options[options.length - 2]).toBe("< Refresh>");
    expect(options[options.length - 1]).toBe("< Cancel");
    // Loop row uses [x] for currently-bound, [ ] for not; section header is at options[0]
    expect(options[1]).toMatch(/^\[ \] #1 /);
  });

  it("reflects existing bindings state in the governor checkbox", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "already-bound", {
      recurring: true,
    });
    h.bindingsStore.add("1");

    h.ui.select.mockResolvedValueOnce("< Cancel");
    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const [, options] = h.ui.select.mock.calls[0];
    // Section header at options[0]; loop row at options[1]
    expect(options[1]).toMatch(/^\[x\] #1 /);
  });

  it("governor row shows hybrid event source and debounceMs", async () => {
    h.store.create(
      { type: "hybrid", cron: "*/10 * * * *", event: { source: "tool_execution_end" }, debounceMs: 60000 },
      "hybrid-check",
      { recurring: true },
    );

    h.ui.select.mockResolvedValueOnce("< Cancel");
    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const [, options] = h.ui.select.mock.calls[0];
    expect(options[1]).toMatch(/^\[ \] #1 /);
    expect(options[1]).toContain("hybrid: */10 * * * * + event:tool_execution_end (60s debounce)");
  });

  it("governor row marks paused loops with a ~ suffix", async () => {
    const paused = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "paused-loop", {
      recurring: true,
    });
    h.store.pause(paused.id);
    h.bindingsStore.add(paused.id); // bound + paused

    h.ui.select.mockResolvedValueOnce("< Cancel");
    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const [, options] = h.ui.select.mock.calls[0];
    expect(options[1]).toMatch(/^\[x\]~ #1 \[paused\]/);
  });

  it("arming a paused loop emits a warning notification", async () => {
    const paused = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "paused-loop", {
      recurring: true,
    });
    h.store.pause(paused.id);
    // Not bound — toggling it on means arming

    // 1) picker: toggle loop → pending arm, warning emitted
    // 2) picker: < OK → apply
    h.ui.select
      .mockResolvedValueOnce("[~] #1 [paused] paused-loop (cron: */5 * * * *)")
      .mockResolvedValueOnce("< OK");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop #1 is paused"),
      "warning",
    );
    expect(h.bindingsStore.has(paused.id)).toBe(true);
  });

  it("arming an active (non-paused) loop emits no warning", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "active-loop", {
      recurring: true,
    });

    h.ui.select
      .mockResolvedValueOnce("[ ] #1 [active] active-loop (cron: */5 * * * *)")
      .mockResolvedValueOnce("< OK");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("is paused"),
      "warning",
    );
  });

  it("toggles a row, then OK applies and persists bindings", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "toggled", { recurring: true });

    h.ui.select
      .mockResolvedValueOnce("[ ] #1 [active] toggled (cron: */5 * * * *)")
      .mockResolvedValueOnce("< OK");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.select).toHaveBeenCalledTimes(2);
    expect(h.bindingsStore.has("1")).toBe(true);
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.updateWidget).toHaveBeenCalled();
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Armed: #1"),
      "info",
    );
  });

  it("toggles a bound row off, then OK disarms and persists", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "disarm-me", { recurring: true });
    h.bindingsStore.add("1");

    h.ui.select
      .mockResolvedValueOnce("[x] #1 [active] disarm-me (cron: */5 * * * *)")
      .mockResolvedValueOnce("< OK");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.bindingsStore.has("1")).toBe(false);
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Disarmed: #1"),
      "info",
    );
  });

  it("Continue opens ui.confirm; OK applies, Cancel returns to picker", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "to-arm", { recurring: true });

    h.ui.select
      .mockResolvedValueOnce("[ ] #1 [active] to-arm (cron: */5 * * * *)")
      .mockResolvedValueOnce("< Continue");
    h.ui.confirm.mockResolvedValueOnce(true);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.confirm).toHaveBeenCalledTimes(1);
    expect(h.ui.confirm).toHaveBeenCalledWith(
      "Apply changes?",
      expect.stringContaining("Arm:\n  #1 to-arm"),
    );
    expect(h.bindingsStore.has("1")).toBe(true);
    expect(h.ui.select).toHaveBeenCalledTimes(2);
  });

  it("Continue → Cancel in confirm returns to the picker without applying", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "stays-unbound", {
      recurring: true,
    });

    h.ui.select
      .mockResolvedValueOnce("[ ] #1 [active] stays-unbound (cron: */5 * * * *)")
      .mockResolvedValueOnce("< Continue")
      .mockResolvedValueOnce("< Cancel");
    h.ui.confirm.mockResolvedValueOnce(false);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.select).toHaveBeenCalledTimes(3);
    expect(h.bindingsStore.has("1")).toBe(false);
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
  });

  it("< Cancel from the picker discards pending changes", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "abort-me", { recurring: true });

    h.ui.select
      .mockResolvedValueOnce("[ ] #1 [active] abort-me (cron: */5 * * * *)")
      .mockResolvedValueOnce("< Cancel");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.bindingsStore.has("1")).toBe(false);
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Governor changes discarded"),
      "info",
    );
  });

  it("multi-loop governor: arms + disarms in one OK commit", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "alpha", { recurring: true });
    h.store.create({ type: "event", source: "tool_execution_start" }, "beta", {
      recurring: true,
    });
    h.bindingsStore.add("2"); // beta is already bound

    h.ui.select
      .mockResolvedValueOnce("[ ] #1 [active] alpha (cron: */5 * * * *)")
      .mockResolvedValueOnce("[x] #2 [active] beta (event: tool_execution_start)")
      .mockResolvedValueOnce("< OK");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.bindingsStore.has("1")).toBe(true);
    expect(h.bindingsStore.has("2")).toBe(false);
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("2");
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/Armed: #1.*Disarmed: #2/),
      "info",
    );
  });

  it("never mutates store.status during any governor flow", async () => {
    const a = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "a", { recurring: true });
    const b = h.store.create({ type: "event", source: "tool_execution_end" }, "b", {
      recurring: true,
    });
    const statusA = a.status;
    const statusB = b.status;

    h.ui.select
      .mockResolvedValueOnce("[ ] #1 [active] a (cron: */5 * * * *)")
      .mockResolvedValueOnce("[ ] #2 [active] b (event: tool_execution_end)")
      .mockResolvedValueOnce("< OK");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.store.get(a.id)?.status).toBe(statusA);
    expect(h.store.get(b.id)?.status).toBe(statusB);
  });

  it("Continue with no pending changes stays in the picker and notifies", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "noop", { recurring: true });
    h.bindingsStore.add("1");

    h.ui.select
      .mockResolvedValueOnce("< Continue")
      .mockResolvedValueOnce("< Cancel");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.confirm).not.toHaveBeenCalled();
    expect(h.ui.notify).toHaveBeenCalledWith(
      "No pending changes — select loops to toggle or click Cancel.",
      "info",
    );
  });

  it("Continue+OK with XOR-noop pending shows 'No changes to apply.'", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "xor-noop", { recurring: true });
    h.bindingsStore.add("1");

    h.ui.select
      .mockResolvedValueOnce("[x] #1 [active] xor-noop (cron: */5 * * * *)")
      .mockResolvedValueOnce("[ ] #1 [active] xor-noop (cron: */5 * * * *)")
      .mockResolvedValueOnce("< Continue");
    h.ui.confirm.mockResolvedValueOnce(true);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.confirm).toHaveBeenCalledWith("Apply changes?", "No changes.");
    expect(h.bindingsStore.has("1")).toBe(true);
    expect(h.ui.notify).toHaveBeenCalledWith("No changes to apply.", "info");
  });

  it("Continue+OK with real pending changes emits Armed/Disarmed summary", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "real", { recurring: true });
    h.bindingsStore.add("1");

    h.ui.select
      .mockResolvedValueOnce("[x] #1 [active] real (cron: */5 * * * *)")
      .mockResolvedValueOnce("< Continue");
    h.ui.confirm.mockResolvedValueOnce(true);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.bindingsStore.has("1")).toBe(false);
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Disarmed: #1"),
      "info",
    );
    expect(h.ui.notify).not.toHaveBeenCalledWith("No changes to apply.", "info");
  });

  it("Continue diff shows currently-armed loops alongside pending changes", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "alpha", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" }, "beta", { recurring: true });
    h.bindingsStore.add("1");

    h.ui.select
      .mockResolvedValueOnce("[ ] #2 [active] beta (cron: */10 * * * *)")
      .mockResolvedValueOnce("< Continue");
    h.ui.confirm.mockResolvedValueOnce(true);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.confirm).toHaveBeenCalledWith(
      "Apply changes?",
      expect.stringContaining("Armed: #1  (unchanged)"),
    );
    expect(h.ui.confirm).toHaveBeenCalledWith(
      "Apply changes?",
      expect.stringContaining("Arm:\n  #2 beta"),
    );
  });

  it("Continue diff shows only pending changes when no pre-existing bindings", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "solo", { recurring: true });

    h.ui.select
      .mockResolvedValueOnce("[ ] #1 [active] solo (cron: */5 * * * *)")
      .mockResolvedValueOnce("< Continue");
    h.ui.confirm.mockResolvedValueOnce(true);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.confirm).toHaveBeenCalledWith("Apply changes?", "Arm:\n  #1 solo");
  });

  it("Continue diff excludes loops being disarmed from Armed (unchanged) list", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "alpha", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" }, "beta", { recurring: true });
    h.bindingsStore.add("1");
    h.bindingsStore.add("2");

    h.ui.select
      .mockResolvedValueOnce("[x] #1 [active] alpha (cron: */5 * * * *)")
      .mockResolvedValueOnce("< Continue");
    h.ui.confirm.mockResolvedValueOnce(true);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.confirm).toHaveBeenCalledWith(
      "Apply changes?",
      expect.stringContaining("Armed: #2  (unchanged)"),
    );
    expect(h.ui.confirm).toHaveBeenCalledWith(
      "Apply changes?",
      expect.stringContaining("Disarm:\n  #1 alpha"),
    );
    const confirmCall = h.ui.confirm.mock.calls[0][1] as string;
    expect(confirmCall).not.toContain("Armed: #1");
  });

  it("Continue diff warns about paused loops pending arm", async () => {
    const paused = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "paused-loop", {
      recurring: true,
    });
    h.store.pause(paused.id);

    h.ui.select
      .mockResolvedValueOnce("[~] #1 [paused] paused-loop (cron: */5 * * * *)")
      .mockResolvedValueOnce("< Continue");
    h.ui.confirm.mockResolvedValueOnce(true);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.confirm).toHaveBeenCalledWith(
      "Apply changes?",
      expect.stringContaining("Warning: #1 is PAUSED — won't fire until resumed."),
    );
  });

  it("Continue diff warns about multiple paused loops pending arm", async () => {
    const paused1 = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "p1", {
      recurring: true,
    });
    const paused2 = h.store.create({ type: "cron", schedule: "*/10 * * * *" }, "p2", {
      recurring: true,
    });
    h.store.pause(paused1.id);
    h.store.pause(paused2.id);

    h.ui.select
      .mockResolvedValueOnce("[~] #1 [paused] p1 (cron: */5 * * * *)")
      .mockResolvedValueOnce("[~] #2 [paused] p2 (cron: */10 * * * *)")
      .mockResolvedValueOnce("< Continue");
    h.ui.confirm.mockResolvedValueOnce(true);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.confirm).toHaveBeenCalledWith(
      "Apply changes?",
      expect.stringContaining("Warning: #1, #2 are PAUSED — won't fire until resumed."),
    );
  });

  // Helper: toggle a loop row and then delete the loop before OK is clicked.
  function setupOrphanedBeforeOk(
    h: ReturnType<typeof setup>,
    loopId: string,
    alreadyBound: boolean,
  ) {
    if (alreadyBound) h.bindingsStore.add(loopId);
    h.ui.select
      .mockResolvedValueOnce(`[ ] #${loopId} [active] loop (cron: */5 * * * *)`)
      .mockResolvedValueOnce("< OK");
    const origGet = h.store.get.bind(h.store);
    h.store.get = (id: string) => {
      if (id === loopId) h.store.delete(id);
      return origGet(id);
    };
  }

  it("arm pending loop that was deleted from store emits warning", async () => {
    const loop = h.store.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "deleted-before-apply",
      { recurring: true },
    );
    setupOrphanedBeforeOk(h, loop.id, false);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Skipped — loops no longer exist"),
      "warning",
    );
    expect(h.bindingsStore.has(loop.id)).toBe(false);
  });

  it("disarm pending loop that was deleted from store emits warning", async () => {
    const loop = h.store.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "disarm-deleted",
      { recurring: true },
    );
    setupOrphanedBeforeOk(h, loop.id, true);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Skipped — loops no longer exist"),
      "warning",
    );
  });

  it("all pending loops deleted — warning but no false Armed/Disarmed summary", async () => {
    const loop1 = h.store.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "orphan-a",
      { recurring: true },
    );
    const loop2 = h.store.create(
      { type: "cron", schedule: "*/10 * * * *" },
      "orphan-b",
      { recurring: true },
    );
    h.ui.select
      .mockResolvedValueOnce(`[ ] #${loop1.id} [active] a (cron: */5 * * * *)`)
      .mockResolvedValueOnce(`[ ] #${loop2.id} [active] b (cron: */10 * * * *)`)
      .mockResolvedValueOnce("< OK");
    const origGet = h.store.get.bind(h.store);
    h.store.get = (id: string) => {
      if (id === loop1.id || id === loop2.id) h.store.delete(id);
      return origGet(id);
    };

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const warns = h.ui.notify.mock.calls.filter(
      ([_msg, type]) => type === "warning",
    );
    const infos = h.ui.notify.mock.calls.filter(
      ([_msg, type]) => type === "info",
    );
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toContain("Skipped — loops no longer exist");
    expect(infos).toHaveLength(1);
    expect(infos[0][0]).toBe("Governor applied.");
  });

  it("mixed orphaned and valid pending — valid changes applied, orphaned warned", async () => {
    const valid = h.store.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "valid-loop",
      { recurring: true },
    );
    const orphaned = h.store.create(
      { type: "cron", schedule: "*/10 * * * *" },
      "orphaned-loop",
      { recurring: true },
    );
    h.ui.select
      .mockResolvedValueOnce(`[ ] #${valid.id} [active] v (cron: */5 * * * *)`)
      .mockResolvedValueOnce(`[ ] #${orphaned.id} [active] o (cron: */10 * * * *)`)
      .mockResolvedValueOnce("< OK");
    const origGet = h.store.get.bind(h.store);
    h.store.get = (id: string) => {
      if (id === orphaned.id) h.store.delete(id);
      return origGet(id);
    };

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.bindingsStore.has(valid.id)).toBe(true);
    expect(h.triggerSystem.add).toHaveBeenCalled();
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Skipped — loops no longer exist"),
      "warning",
    );
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Armed"),
      "info",
    );
  });

  it("< Disarm all > disarms all currently-bound loops", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "alpha", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" }, "beta", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/15 * * * *" }, "gamma", { recurring: true });
    h.bindingsStore.add("1");
    h.bindingsStore.add("3");

    h.ui.select
      .mockResolvedValueOnce("< Disarm all")
      .mockResolvedValueOnce("< OK");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.bindingsStore.has("1")).toBe(false);
    expect(h.bindingsStore.has("2")).toBe(false);
    expect(h.bindingsStore.has("3")).toBe(false);
    expect(h.triggerSystem.remove).toHaveBeenCalledTimes(2);
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Disarmed"),
      "info",
    );
  });

  it("< Disarm all > then toggle on a loop undoes the disarm and leaves it bound", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "alpha", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" }, "beta", { recurring: true });
    h.bindingsStore.add("1");

    h.ui.select
      .mockResolvedValueOnce("< Disarm all")
      .mockResolvedValueOnce("[ ] #1 [active] alpha (cron: */5 * * * *)")
      .mockResolvedValueOnce("< OK");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.bindingsStore.has("1")).toBe(true);
    expect(h.bindingsStore.has("2")).toBe(false);
    expect(h.ui.notify).toHaveBeenCalledWith("No changes to apply.", "info");
  });

  it("< Disarm all > with no bound loops is a no-op that refreshes the picker", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "solo", { recurring: true });

    h.ui.select
      .mockResolvedValueOnce("< Disarm all")
      .mockResolvedValueOnce("< OK");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.bindingsStore.has("1")).toBe(false);
    expect(h.ui.notify).toHaveBeenCalledWith("No changes to apply.", "info");
  });

  it("< Refresh > re-reads store, reloads bindings, clears pending, and stays open", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "existing-loop", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/3 * * * *" }, "fresh-loop", {
      recurring: true,
    });

    h.ui.select
      .mockResolvedValueOnce("[ ] #1 [active] existing-loop (cron: */5 * * * *)")
      .mockResolvedValueOnce("< Refresh>")
      .mockResolvedValueOnce("< Cancel");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.bindingsStore.has("1")).toBe(false);
    expect(h.ui.notify).toHaveBeenCalledWith(
      "Governor refreshed — loop list and bindings re-read from disk.",
      "info",
    );
    expect(h.ui.select).toHaveBeenCalledTimes(3);
  });

  it("< Refresh > shows the current loop list after external changes", async () => {
    const loop1 = h.store.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "first-loop",
      { recurring: true },
    );
    h.bindingsStore.add(loop1.id);

    const origList = h.store.list.bind(h.store);
    const origCreate = h.store.create.bind(h.store);
    let callCount = 0;
    h.store.list = () => {
      callCount++;
      if (callCount === 1) return origList();
      return [
        ...origList(),
        origCreate({ type: "cron", schedule: "*/3 * * * *" }, "new-loop", { recurring: true }),
      ];
    };

    h.ui.select
      .mockResolvedValueOnce("[x] #1 [active] first-loop (cron: */5 * * * *)")
      .mockResolvedValueOnce("< Refresh>")
      .mockResolvedValueOnce("< OK");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.select).toHaveBeenCalledTimes(3);
    expect(h.ui.notify).toHaveBeenCalledWith(
      "Governor refreshed — loop list and bindings re-read from disk.",
      "info",
    );
  });

  it("< Refresh > on no-op clears pending", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "idle-loop", { recurring: true });

    h.ui.select
      .mockResolvedValueOnce("[ ] #1 [active] idle-loop (cron: */5 * * * *)")
      .mockResolvedValueOnce("< Refresh>")
      .mockResolvedValueOnce("< Cancel");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.bindingsStore.has("1")).toBe(false);
    expect(h.ui.notify).toHaveBeenCalledWith(
      "Governor refreshed — loop list and bindings re-read from disk.",
      "info",
    );
  });

  it("Governor rows annotate loops with per-session binding count (G-44)", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "shared-loop", {
      recurring: true, createdBy: "test-session",
    });
    h.bindingsStore.add("1");

    h.bindingsStore.getOtherSessionBindingCounts = () =>
      new Map([["1", 2], ["999", 1]]);

    h.ui.select.mockResolvedValueOnce("< Cancel>");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const [, options] = h.ui.select.mock.calls[0];
    expect(options[0]).toBe("— My loops —");
    const loopRow = options[1] as string;
    expect(loopRow).toContain("· bound in 2 other sessions");
  });

  it("Governor rows show no annotation when no other sessions bind the loop (G-44)", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "solo-loop", {
      recurring: true, createdBy: "test-session",
    });

    h.bindingsStore.getOtherSessionBindingCounts = () => new Map();

    h.ui.select.mockResolvedValueOnce("< Cancel>");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const [, options] = h.ui.select.mock.calls[0];
    expect(options[0]).toBe("— My loops —");
    const loopRow = options[1] as string;
    expect(loopRow).not.toContain("· bound in");
  });

  it("Governor rows show singular 'session' for exactly 1 other session (G-44)", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "shared-loop", {
      recurring: true, createdBy: "test-session",
    });

    h.bindingsStore.getOtherSessionBindingCounts = () => new Map([["1", 1]]);

    h.ui.select.mockResolvedValueOnce("< Cancel>");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const [, options] = h.ui.select.mock.calls[0];
    expect(options[0]).toBe("— My loops —");
    const loopRow = options[1] as string;
    expect(loopRow).toContain("· bound in 1 other session");
  });
});

describe("/loop command", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("schedules a cron loop from a bare interval and auto-binds the creating session", async () => {
    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("5m check the deploy", makeCtx(h.ui) as any);

    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.store.list()).toHaveLength(1);
    expect(h.store.list()[0].trigger.type).toBe("cron");
    expect(h.bindingsStore.has("1")).toBe(true);
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop #1 created"),
      "info",
    );
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("bound to this session"),
      "info",
    );
  });

  it("shows the top-level menu when called with no args", async () => {
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

  it("view loops shows hybrid event source and debounceMs", async () => {
    h.store.create(
      { type: "hybrid", cron: "*/10 * * * *", event: { source: "tool_execution_end" }, debounceMs: 60000 },
      "hybrid-check",
      { recurring: true },
    );

    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("< Back");

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const viewLoopsCall = h.ui.select.mock.calls[1];
    const loopOptions = viewLoopsCall[1];
    expect(loopOptions[0]).toContain("hybrid: */10 * * * * + event:tool_execution_end (60s debounce)");
  });
});

describe("/loop-bindings command", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("is registered", () => {
    expect(h.commandMap.has("loop-bindings")).toBe(true);
  });

  it("shows empty store message when no loops exist", async () => {
    h.ui.select.mockResolvedValueOnce("< Back");
    const cmd = h.commandMap.get("loop-bindings")!;
    await cmd.handler!("", makeCtx(h.ui) as any);
    expect(h.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("No loops"),
      expect.arrayContaining(["< Back"]),
    );
  });

  it("groups loops into Armed and Not bound sections", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "will-be-bound", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" }, "stays-unbound", { recurring: true });
    h.bindingsStore.add("1");

    h.ui.select.mockResolvedValueOnce("< Back");
    const cmd = h.commandMap.get("loop-bindings")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const [header, options] = h.ui.select.mock.calls[0] as [string, string[]];
    expect(header).toContain("Bindings");
    expect(options.some((o) => o.includes("— Armed in this session —"))).toBe(true);
    expect(options.some((o) => o.includes("— Not bound —"))).toBe(true);
    expect(options.find((o) => o.includes("will-be-bound"))).toContain("* #1");
    expect(options.find((o) => o.includes("stays-unbound"))).toContain("- #2");
  });

  it("marks paused-but-bound loops with a warning suffix", async () => {
    const entry = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "paused-bound", { recurring: true });
    h.store.pause(entry.id);
    h.bindingsStore.add(entry.id);

    h.ui.select.mockResolvedValueOnce("< Back");
    const cmd = h.commandMap.get("loop-bindings")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const [, options] = h.ui.select.mock.calls[0] as [string, string[]];
    expect(options.find((o) => o.includes("paused-bound"))).toContain("[PAUSED — won't fire]");
  });

  it("shows only Armed section when all loops are bound", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "bound-1", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" }, "bound-2", { recurring: true });
    h.bindingsStore.add("1");
    h.bindingsStore.add("2");

    h.ui.select.mockResolvedValueOnce("< Back");
    const cmd = h.commandMap.get("loop-bindings")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const [, options] = h.ui.select.mock.calls[0] as [string, string[]];
    expect(options.some((o) => o.includes("— Armed in this session —"))).toBe(true);
    expect(options.some((o) => o.includes("— Not bound —"))).toBe(false);
  });

  it("shows only Not bound section when no loops are bound", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "orphan-1", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" }, "orphan-2", { recurring: true });

    h.ui.select.mockResolvedValueOnce("< Back");
    const cmd = h.commandMap.get("loop-bindings")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const [, options] = h.ui.select.mock.calls[0] as [string, string[]];
    expect(options.some((o) => o.includes("— Not bound —"))).toBe(true);
    expect(options.some((o) => o.includes("— Armed in this session —"))).toBe(false);
  });
});

describe("/loop viewLoops — ✎ Edit action", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  // Execution path: top-level → viewLoops loop row → ✎ Edit → edit sub-menu (3+ selects)
  // active actions order: ["- Pause", "✎ Edit", "x Delete", "< Back"]
  // ui.input returns synchronously (non-Promise) so the async chain drains without deadlock.

  it("✎ Edit is at index 1 in the actions menu (after - Pause for active loops)", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "editable-loop", {
      recurring: true,
    });

    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("- #1 [active] editable-loop (cron: */5 * * * *)")
      .mockResolvedValueOnce("✎ Edit")
      .mockResolvedValueOnce("< Back");

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    // actions[0] = "- Pause", actions[1] = "✎ Edit", actions[2] = "x Delete"
    const actionsCall = h.ui.select.mock.calls[2];
    expect(actionsCall[1][0]).toBe("- Pause");
    expect(actionsCall[1][1]).toBe("✎ Edit");
    expect(actionsCall[1][2]).toBe("x Delete");
    expect(actionsCall[1][3]).toBe("< Back");
  });

  it("✎ Edit action triggers the edit sub-workflow", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "loop-to-edit", {
      recurring: true,
    });

    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("- #1 [active] loop-to-edit (cron: */5 * * * *)")
      .mockResolvedValueOnce("✎ Edit")
      .mockResolvedValueOnce("< Back");

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    // 4th select: edit sub-menu title and options
    const editCall = h.ui.select.mock.calls[3];
    expect(editCall[0]).toContain("Editing loop #1");
    expect(editCall[1]).toContain("Edit prompt");
    expect(editCall[1]).toContain("Edit trigger");
  });

  it("✎ Edit → Edit prompt calls store.updateMetadata and notifies", async () => {
    h.store.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "original-prompt",
      { recurring: true },
    );

    // ui.input returns synchronously so the flow drains without deadlock
    h.ui.input.mockReturnValue("Updated prompt");
    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("- #1 [active] original-prompt (cron: */5 * * * *)")
      .mockResolvedValueOnce("✎ Edit")
      .mockResolvedValueOnce("Edit prompt")
      .mockResolvedValueOnce("Save & exit");

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.updateMetadataSpy).toHaveBeenCalledWith("1", {
      prompt: "Updated prompt",
    });
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop #1 updated"),
      "info",
    );
    expect(h.updateWidget).toHaveBeenCalled();
  });

  it("✎ Edit → Edit trigger (cron) calls store.updateMetadata", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "cron-loop", {
      recurring: true,
    });

    h.ui.input.mockReturnValue("*/10 * * * *");
    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("- #1 [active] cron-loop (cron: */5 * * * *)")
      .mockResolvedValueOnce("✎ Edit")
      .mockResolvedValueOnce("Edit trigger")
      .mockResolvedValueOnce("cron: time-based interval")
      .mockResolvedValueOnce("Save & exit");

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.updateMetadataSpy).toHaveBeenCalledWith("1", {
      trigger: { type: "cron", schedule: "*/10 * * * *" },
    });
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop #1 updated"),
      "info",
    );
  });

  it("✎ Edit → Edit trigger (event) calls store.updateMetadata", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "event-loop", {
      recurring: true,
    });

    h.ui.input
      .mockResolvedValueOnce("tool_execution_end")
      .mockResolvedValueOnce(""); // optional filter: empty = skip
    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("- #1 [active] event-loop (cron: */5 * * * *)")
      .mockResolvedValueOnce("✎ Edit")
      .mockResolvedValueOnce("Edit trigger")
      .mockResolvedValueOnce("event: fires on a pi event")
      .mockResolvedValueOnce("Save & exit")
      .mockResolvedValueOnce("Save & exit"); // "Save changes?" prompt

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.updateMetadataSpy).toHaveBeenCalledWith("1", {
      trigger: { type: "event", source: "tool_execution_end", filter: undefined },
    });
  });

  it("✎ Edit → Edit trigger (hybrid) calls store.updateMetadata", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "hybrid-loop", {
      recurring: true,
    });

    h.ui.input
      .mockResolvedValueOnce("*/10 * * * *")
      .mockResolvedValueOnce("tool_execution_end")
      .mockResolvedValueOnce("60000");
    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("- #1 [active] hybrid-loop (cron: */5 * * * *)")
      .mockResolvedValueOnce("✎ Edit")
      .mockResolvedValueOnce("Edit trigger")
      .mockResolvedValueOnce("hybrid: cron + event with debounce")
      .mockResolvedValueOnce("Save & exit")
      .mockResolvedValueOnce("Save & exit"); // "Save changes?" prompt

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.updateMetadataSpy).toHaveBeenCalledWith("1", {
      trigger: { type: "hybrid", cron: "*/10 * * * *", event: { source: "tool_execution_end" }, debounceMs: 60000 },
    });
  });

  it("✎ Edit with trigger change re-registers active loop in triggerSystem", async () => {
    const entry = h.store.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "re-register-test",
      { recurring: true },
    );

    h.ui.input.mockReturnValue("*/10 * * * *");
    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("- #1 [active] re-register-test (cron: */5 * * * *)")
      .mockResolvedValueOnce("✎ Edit")
      .mockResolvedValueOnce("Edit trigger")
      .mockResolvedValueOnce("cron: time-based interval")
      .mockResolvedValueOnce("Save & exit");

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.triggerSystem.remove).toHaveBeenCalledWith(entry.id);
    expect(h.triggerSystem.add).toHaveBeenCalled();
    const addedEntry = (h.triggerSystem.add as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addedEntry.trigger).toEqual({ type: "cron", schedule: "*/10 * * * *" });
  });

  it("✎ Edit does not re-register triggerSystem when prompt-only change", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "prompt-only-edit", {
      recurring: true,
    });

    h.ui.input.mockReturnValue("New prompt");
    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("- #1 [active] prompt-only-edit (cron: */5 * * * *)")
      .mockResolvedValueOnce("✎ Edit")
      .mockResolvedValueOnce("Edit prompt")
      .mockResolvedValueOnce("Save & exit");

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
  });

  it("✎ Edit does not re-register paused loop even when trigger changes", async () => {
    const entry = h.store.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "paused-edit",
      { recurring: true },
    );
    h.store.pause(entry.id);

    h.ui.input.mockReturnValue("*/10 * * * *");
    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("* #1 [paused] paused-edit (cron: */5 * * * *)")
      .mockResolvedValueOnce("✎ Edit")
      .mockResolvedValueOnce("Edit trigger")
      .mockResolvedValueOnce("cron: time-based interval")
      .mockResolvedValueOnce("Save & exit");

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loop #1 updated"),
      "info",
    );
  });

  it("✎ Edit → Continue editing allows multiple changes before saving", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "multi-edit", {
      recurring: true,
    });

    h.ui.input
      .mockResolvedValueOnce("New prompt text")
      .mockResolvedValueOnce("*/10 * * * *");
    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("- #1 [active] multi-edit (cron: */5 * * * *)")
      .mockResolvedValueOnce("✎ Edit")
      .mockResolvedValueOnce("Edit prompt")
      .mockResolvedValueOnce("Continue editing")
      .mockResolvedValueOnce("Edit trigger")
      .mockResolvedValueOnce("cron: time-based interval")
      .mockResolvedValueOnce("Save & exit");

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.updateMetadataSpy).toHaveBeenCalledWith("1", {
      prompt: "New prompt text",
      trigger: { type: "cron", schedule: "*/10 * * * *" },
    });
  });

  it("✎ Edit → < Back without saving does not call store.updateMetadata", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "cancel-edit", {
      recurring: true,
    });

    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("- #1 [active] cancel-edit (cron: */5 * * * *)")
      .mockResolvedValueOnce("✎ Edit")
      .mockResolvedValueOnce("< Back");

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.updateMetadataSpy).not.toHaveBeenCalled();
    expect(h.updateWidget).not.toHaveBeenCalled();
  });

  it("✎ Edit is reachable for paused loops (Resume shown first)", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "paused-loop", {
      recurring: true,
    });

    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("* #1 [paused] paused-loop (cron: */5 * * * *)")
      .mockResolvedValueOnce("✎ Edit")
      .mockResolvedValueOnce("< Back")
      .mockResolvedValueOnce("< Back"); // 5th: viewLoops loops again after editLoop returns

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.select).toHaveBeenCalledTimes(5);
  });
});
