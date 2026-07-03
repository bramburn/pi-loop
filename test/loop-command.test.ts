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
  const store = new LoopStore();
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  // In-memory BindingsStore — exercises the same code path as file-backed
  // for has/add/remove semantics without tmpdir churn. File-backed behavior
  // is covered separately in test/bindings-store.test.ts.
  const bindingsStore = new BindingsStore(undefined, "memory");
  const updateWidget = vi.fn();

  registerLoopCommand({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    getBindingsStore: () => bindingsStore,
    updateWidget,
  });

  const ui: FakeUI = {
    select: vi.fn(),
    input: vi.fn(),
    notify: vi.fn(),
    confirm: vi.fn(),
  };

  return { commandMap, store, triggerSystem, bindingsStore, updateWidget, ui };
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
    // First option is the loop row; last four are sentinels (OK, Continue, Disarm all, Cancel)
    expect(options[options.length - 4]).toBe("< OK");
    expect(options[options.length - 3]).toBe("< Continue");
    expect(options[options.length - 2]).toBe("< Disarm all");
    expect(options[options.length - 1]).toBe("< Cancel");
    // Loop row uses [x] for currently-bound, [ ] for not
    expect(options[0]).toMatch(/^\[ \] #1 /);
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
    expect(options[0]).toMatch(/^\[x\] #1 /);
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
    expect(options[0]).toMatch(/^\[ \] #1 /);
    expect(options[0]).toContain("hybrid: */10 * * * * + event:tool_execution_end (60s debounce)");
  });

  it("toggles a row, then OK applies and persists bindings", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "toggled", { recurring: true });

    // First render: pick the loop row (toggles it on, pending={1: "arm"})
    // Second render: pick < OK
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

    // 1) picker: toggle loop on
    // 2) picker: < Continue → ui.confirm
    // 3) ui.confirm OK
    h.ui.select
      .mockResolvedValueOnce("[ ] #1 [active] to-arm (cron: */5 * * * *)")
      .mockResolvedValueOnce("< Continue");
    h.ui.confirm.mockResolvedValueOnce(true);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.confirm).toHaveBeenCalledTimes(1);
    expect(h.ui.confirm).toHaveBeenCalledWith(
      "Apply changes?",
      expect.stringContaining("Arm: #1"),
    );
    expect(h.bindingsStore.has("1")).toBe(true);
    expect(h.ui.select).toHaveBeenCalledTimes(2);
  });

  it("Continue → Cancel in confirm returns to the picker without applying", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "stays-unbound", {
      recurring: true,
    });

    // 1) picker: toggle loop on
    // 2) picker: < Continue → ui.confirm
    // 3) ui.confirm Cancel → return to picker
    // 4) picker: < Cancel (exit)
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

    // 1) picker: toggle loop on (pending = {1: "arm"})
    // 2) picker: < Cancel → discard
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

    // Render 1: toggle alpha (off → arm)
    // Render 2: toggle beta (bound → disarm)
    // Render 3: < OK → apply
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

  it("Continue with no pending changes shows 'No changes.' preview", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "noop", { recurring: true });
    h.bindingsStore.add("1");

    h.ui.select.mockResolvedValueOnce("< Continue");
    h.ui.confirm.mockResolvedValueOnce(true);

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.ui.confirm).toHaveBeenCalledWith("Apply changes?", "No changes.");
  });

  // Helper: toggle a loop row and then delete the loop before OK is clicked.
  // This simulates another terminal deleting the loop while the Governor is open.
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
    // The loop was orphaned — binding was never added because the loop no
    // longer exists in the store at apply time.
    expect(h.bindingsStore.has(loop.id)).toBe(false);
  });

  it("disarm pending loop that was deleted from store emits warning", async () => {
    const loop = h.store.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "disarm-deleted",
      { recurring: true },
    );
    setupOrphanedBeforeOk(h, loop.id, true); // already bound

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
    // Both toggled on but deleted before OK
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
    // Three loops; loop 1 and 3 are currently bound.
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "alpha", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" }, "beta", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/15 * * * *" }, "gamma", { recurring: true });
    h.bindingsStore.add("1");
    h.bindingsStore.add("3");

    // 1) picker: < Disarm all -> all bound marked for disarm
    // 2) picker: < OK -> apply pending
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

    // 1) picker: < Disarm all -> pending = {1: "disarm"}
    // 2) picker: toggle #1 -> prev=disarm -> delete(1) removes the disarm entry
    // 3) picker: < OK -> no pending for #1, stays in original state (bound)
    h.ui.select
      .mockResolvedValueOnce("< Disarm all")
      .mockResolvedValueOnce("[ ] #1 [active] alpha (cron: */5 * * * *)")
      .mockResolvedValueOnce("< OK");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.bindingsStore.has("1")).toBe(true);
    expect(h.bindingsStore.has("2")).toBe(false);
    // No pending disarm survived, so the notify shows no changes applied
    expect(h.ui.notify).toHaveBeenCalledWith("No changes to apply.", "info");
  });

  it("< Disarm all > with no bound loops is a no-op that refreshes the picker", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "solo", { recurring: true });
    // No loops are bound.

    // 1) picker: < Disarm all -> pending stays empty (no bound loops to disarm)
    // 2) picker: < OK -> no-op
    h.ui.select
      .mockResolvedValueOnce("< Disarm all")
      .mockResolvedValueOnce("< OK");

    const cmd = h.commandMap.get("loop-resume")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    expect(h.bindingsStore.has("1")).toBe(false);
    expect(h.ui.notify).toHaveBeenCalledWith("No changes to apply.", "info");
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

  it("view loops shows hybrid event source and debounceMs", async () => {
    const h = setup();
    h.store.create(
      { type: "hybrid", cron: "*/10 * * * *", event: { source: "tool_execution_end" }, debounceMs: 60000 },
      "hybrid-check",
      { recurring: true },
    );

    // First select: top-level menu → "View loops"
    // Second select: "View loops" submenu → "< Back"
    h.ui.select
      .mockResolvedValueOnce("View loops")
      .mockResolvedValueOnce("< Back");

    const cmd = h.commandMap.get("loop")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    // The view loops submenu calls ui.select with all loop rows
    const viewLoopsCall = h.ui.select.mock.calls[1];
    const loopOptions = viewLoopsCall[1];
    expect(loopOptions[0]).toContain("hybrid: */10 * * * * + event:tool_execution_end (60s debounce)");
  });
});

describe("/loop-bindings command", () => {
  it("is registered", () => {
    const h = setup();
    expect(h.commandMap.has("loop-bindings")).toBe(true);
  });

  it("shows empty store message when no loops exist", async () => {
    const h = setup();
    h.ui.select.mockResolvedValueOnce("< Back");
    const cmd = h.commandMap.get("loop-bindings")!;
    await cmd.handler!("", makeCtx(h.ui) as any);
    expect(h.ui.select).toHaveBeenCalledWith(
      expect.stringContaining("No loops"),
      expect.arrayContaining(["< Back"]),
    );
  });

  it("groups loops into Armed and Not bound sections", async () => {
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "will-be-bound", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" }, "stays-unbound", { recurring: true });
    h.bindingsStore.add("1"); // loop #1 is bound

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
    const h = setup();
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
    const h = setup();
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
    const h = setup();
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "orphan-1", { recurring: true });
    h.store.create({ type: "cron", schedule: "*/10 * * * *" }, "orphan-2", { recurring: true });
    // bindingsStore is empty (memory scope, no adds)

    h.ui.select.mockResolvedValueOnce("< Back");
    const cmd = h.commandMap.get("loop-bindings")!;
    await cmd.handler!("", makeCtx(h.ui) as any);

    const [, options] = h.ui.select.mock.calls[0] as [string, string[]];
    expect(options.some((o) => o.includes("— Not bound —"))).toBe(true);
    expect(options.some((o) => o.includes("— Armed in this session —"))).toBe(false);
  });
});