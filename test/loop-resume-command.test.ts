import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerLoopCommand } from "../src/commands/loop-command.js";
import { LoopStore } from "../src/store.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const { pi, commandMap } = createMockPi();
  const store = new LoopStore(); // memory mode, no file I/O
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const updateWidget = vi.fn();
  registerLoopCommand({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    updateWidget,
  });
  const resume = commandMap.get("loop-resume");
  if (!resume) throw new Error("/loop-resume command not registered");
  return { store, triggerSystem, updateWidget, resume: resume.handler as (args: string, ctx: any) => Promise<void> };
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

  it("is idempotent for already-active loops (re-armed without status transition)", async () => {
    const entry = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "active loop", { recurring: true });
    const beforeStatus = entry.status;
    const ctx = createCtx();

    await h.resume(entry.id, ctx);

    expect(h.store.get(entry.id)?.status).toBe(beforeStatus);
    expect(h.triggerSystem.add).toHaveBeenCalled();
    expect(ctx.notifications[0].message).toContain(`Loop #${entry.id}`);
    expect(ctx.notifications[0].message).toContain("re-armed");
  });

  it("reports an error when the loop id does not exist", async () => {
    const ctx = createCtx();

    await h.resume("999", ctx);

    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.updateWidget).not.toHaveBeenCalled();
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

  it("with no args opens a picker listing stored loops and re-arms the chosen one", async () => {
    const id1 = await createPausedLoop(h.store, "first");
    await createPausedLoop(h.store, "second");
    const ui = {
      select: vi.fn(async () => `- #${id1} [paused] first (cron: */5 * * * *)`),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.resume("", ctx);

    expect(ui.select).toHaveBeenCalledWith("Re-arm which loop?", expect.any(Array));
    expect(h.store.get(id1)?.status).toBe("active");
    expect(h.triggerSystem.add).toHaveBeenCalled();
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

  it("with no args honours the < Back picker sentinel without re-arming", async () => {
    const id = await createPausedLoop(h.store);
    const ui = {
      select: vi.fn(async () => "< Back"),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.resume("", ctx);

    expect(h.store.get(id)?.status).toBe("paused");
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
  });

  it("accepts the first whitespace-separated token as the loop id", async () => {
    const id = await createPausedLoop(h.store);
    const ctx = createCtx();

    await h.resume(`${id} trailing junk`, ctx);

    expect(h.store.get(id)?.status).toBe("active");
    expect(h.triggerSystem.add).toHaveBeenCalled();
  });
});
