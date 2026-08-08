import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerLoopCommand } from "../src/commands/loop-command.js";
import { LoopStore } from "../src/store.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const { pi, commandMap } = createMockPi();
  const store = new LoopStore(); // memory mode, no file I/O
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const updateWidget = vi.fn();
  const bindingsStore = {
    list: vi.fn(() => [] as string[]),
    add: vi.fn(),
    remove: vi.fn(),
    load: vi.fn(() => true),
    save: vi.fn(),
    fileExists: vi.fn(() => false),
  };
  registerLoopCommand({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    getBindingsStore: () => bindingsStore as any,
    updateWidget,
  });
  const resume = commandMap.get("loop-resume");
  if (!resume) throw new Error("/loop-resume command not registered");
  return { store, triggerSystem, updateWidget, bindingsStore, resume: resume.handler as (args: string, ctx: any) => Promise<void> };
}

async function createPausedLoop(store: LoopStore, prompt = "check deploy"): Promise<string> {
  const entry = store.create({ type: "cron", schedule: "*/5 * * * *" }, prompt, { recurring: true });
  store.pause(entry.id);
  return entry.id;
}

describe("registerLoopCommand — /loop-resume", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("registers /loop-resume alongside /loop", () => {
    // sanity: setup already asserts this; reaffirm at the suite level
    expect(h.resume).toBeInstanceOf(Function);
  });

  it("re-arms a stored loop by id and re-adds the trigger subscription", async () => {
    const id = await createPausedLoop(h.store);
    const ctx = createCtx();

    await h.resume(id, ctx);

    const entry = h.store.get(id);
    expect(entry?.status).toBe("active");
    expect(h.triggerSystem.add).toHaveBeenCalledWith(entry);
    expect(h.updateWidget).toHaveBeenCalled();
    expect(ctx.notifications[0].message).toContain(`Loop #${id}`);
  });

  it("writes the loop id to the bindings store on one-shot resume", async () => {
    const id = await createPausedLoop(h.store);
    const ctx = createCtx();

    await h.resume(id, ctx);

    expect(h.bindingsStore.add).toHaveBeenCalledWith(id);
  });

  it("is idempotent for already-active loops (re-armed without status transition)", async () => {
    const entry = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "active loop", { recurring: true });
    const beforeStatus = entry.status;
    const ctx = createCtx();

    await h.resume(entry.id, ctx);

    expect(h.store.get(entry.id)?.status).toBe(beforeStatus);
    expect(h.triggerSystem.add).toHaveBeenCalled();
    expect(ctx.notifications[0].message).toContain(`Loop #${entry.id}`);
    expect(ctx.notifications[0].message).toContain("re-armed");
    expect(h.bindingsStore.add).toHaveBeenCalledWith(entry.id);
  });

  it("reports an error when the loop id does not exist", async () => {
    const ctx = createCtx();

    await h.resume("999", ctx);

    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.updateWidget).not.toHaveBeenCalled();
    expect(h.bindingsStore.add).not.toHaveBeenCalled();
    expect(ctx.notifications[0]).toEqual({
      level: "error",
      message: expect.stringContaining("Loop #999 not found"),
    });
  });

  it("rejects non-numeric loop ids with a notify error", async () => {
    const ctx = createCtx();

    await h.resume("abc", ctx);

    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(ctx.notifications[0].level).toBe("error");
    expect(ctx.notifications[0].message).toContain("Expected a numeric loop ID");
  });

  it("with no args and an empty store notifies and skips the picker", async () => {
    const notifications: Array<{ message: string; level?: string }> = [];
    const ctx = {
      ui: {
        select: vi.fn(),
        input: vi.fn(),
        notify: (message: string, level?: string) => notifications.push({ message, level }),
      },
    } as any;

    await h.resume("", ctx);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(notifications[0]).toEqual({
      level: "info",
      message: expect.stringContaining("No stored loops to re-arm"),
    });
  });

  it("with no args opens a Governor picker with [x]/[ ] markers and < OK>/< Cancel> sentinels", async () => {
    const id1 = await createPausedLoop(h.store, "first");
    await createPausedLoop(h.store, "second");
    h.bindingsStore.list.mockReturnValueOnce([id1]);

    const calls: Array<{ title: string; choices: string[] }> = [];
    const ui = {
      select: vi.fn(async (title: string, choices: string[]) => {
        calls.push({ title, choices });
        return "< Cancel>";
      }),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.resume("", ctx);

    expect(calls).toHaveLength(1);
    const row1 = calls[0].choices.find((c) => c.includes(`#${id1}`));
    const row2 = calls[0].choices.find((c) => c.includes("#2"));
    expect(row1).toMatch(/^\[x\] /);
    expect(row2).toMatch(/^\[ \] /);
    expect(calls[0].choices).toContain("< OK>");
    expect(calls[0].choices).toContain("< Cancel>");
  });

  it("governor < OK> commits pending toggles to bindings and triggerSystem", async () => {
    const id1 = await createPausedLoop(h.store, "first");
    const id2 = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "second", { recurring: true }).id;
    h.bindingsStore.list.mockReturnValue([id1]);

    const ui = {
      select: vi.fn()
        .mockResolvedValueOnce(`[ ] #${id2} [active] second (cron: */5 * * * *)`) // toggle id2 ON
        .mockResolvedValueOnce("< OK>"),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.resume("", ctx);

    expect(h.bindingsStore.add).toHaveBeenCalledWith(id2);
    expect(h.triggerSystem.add).toHaveBeenCalledWith(h.store.get(id2));
    expect(ui.notify).toHaveBeenCalledWith("2 loops bound to this session", "info");
    expect(h.updateWidget).toHaveBeenCalled();
  });

  it("governor < OK> does not call triggerSystem.add for a paused loop that was toggled on", async () => {
    const id2 = await createPausedLoop(h.store, "second");
    h.bindingsStore.list.mockReturnValue([]);

    const ui = {
      select: vi.fn()
        .mockResolvedValueOnce(`[ ] #${id2} [paused] second (cron: */5 * * * *)`)
        .mockResolvedValueOnce("< OK>"),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.resume("", ctx);

    expect(h.bindingsStore.add).toHaveBeenCalledWith(id2);
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("1 loop bound to this session", "info");
  });

  it("governor < OK> disarms loops that were removed from the pending set", async () => {
    const id1 = await createPausedLoop(h.store, "first");
    const id2 = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "second", { recurring: true }).id;
    h.bindingsStore.list.mockReturnValue([id1, id2]);

    const ui = {
      select: vi.fn()
        .mockResolvedValueOnce(`[x] #${id2} [active] second (cron: */5 * * * *)`) // toggle id2 OFF
        .mockResolvedValueOnce("< OK>"),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.resume("", ctx);

    expect(h.bindingsStore.remove).toHaveBeenCalledWith(id2);
    expect(h.triggerSystem.remove).toHaveBeenCalledWith(id2);
    expect(ui.notify).toHaveBeenCalledWith("1 loop bound to this session", "info");
  });

  it("governor < Cancel> discards pending toggles without touching bindings", async () => {
    const id1 = await createPausedLoop(h.store, "first");
    const id2 = await createPausedLoop(h.store, "second");
    h.bindingsStore.list.mockReturnValue([id1]);

    const ui = {
      select: vi.fn()
        .mockResolvedValueOnce(`[ ] #${id2} [paused] second (cron: */5 * * * *)`) // would toggle ON
        .mockResolvedValueOnce("< Cancel>"),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.resume("", ctx);

    expect(h.bindingsStore.add).not.toHaveBeenCalled();
    expect(h.bindingsStore.remove).not.toHaveBeenCalled();
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.triggerSystem.remove).not.toHaveBeenCalled();
  });

  it("accepts the first whitespace-separated token as the loop id", async () => {
    const id = await createPausedLoop(h.store);
    const ctx = createCtx();

    await h.resume(`${id} trailing junk`, ctx);

    expect(h.store.get(id)?.status).toBe("active");
    expect(h.triggerSystem.add).toHaveBeenCalled();
    expect(h.bindingsStore.add).toHaveBeenCalledWith(id);
  });
});
