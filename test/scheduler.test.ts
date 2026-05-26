import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { LoopStore } from "../src/store.js";
import type { Trigger } from "../src/types.js";

const cronTrigger: Trigger = { type: "cron", schedule: "*/5 * * * *" };

describe("CronScheduler", () => {
  let store: LoopStore;
  let scheduler: CronScheduler;
  let fired: string[];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    store = new LoopStore();
    fired = [];
    scheduler = new CronScheduler(store, (entry) => {
      fired.push(entry.id);
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.restoreAllMocks();
  });

  it("fires a one-shot cron loop", () => {
    const entry = store.create(cronTrigger, "test fire", { recurring: false });
    scheduler.add(entry);

    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(fired).toContain("1");
  });

  it("does not fire paused loops", () => {
    const entry = store.create(cronTrigger, "paused test", { recurring: false });
    store.update(entry.id, { status: "paused" });
    scheduler.add(entry);

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fired).toHaveLength(0);
  });

  it("removes timer on delete", () => {
    const entry = store.create(cronTrigger, "will be deleted", { recurring: false });
    scheduler.add(entry);
    scheduler.remove("1");

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fired).toHaveLength(0);
  });

  it("fires recurring loops multiple times", () => {
    const entry = store.create(cronTrigger, "recurring", { recurring: true });
    scheduler.add(entry);

    vi.advanceTimersByTime(12 * 60 * 1000);
    expect(fired.length).toBeGreaterThanOrEqual(2);
  });

  it("stops all timers on stop()", () => {
    store.create(cronTrigger, "loop 1", { recurring: false });
    store.create(cronTrigger, "loop 2", { recurring: false });
    scheduler.start();
    scheduler.stop();

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fired).toHaveLength(0);
  });

  it("ignores non-cron triggers", () => {
    const eventTrigger: Trigger = { type: "event", source: "test" };
    store.create(eventTrigger, "event loop", { recurring: false });
    scheduler.start();

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fired).toHaveLength(0);
  });

  it("loads existing loops on start()", () => {
    store.create(cronTrigger, "existing", { recurring: false });
    scheduler.start();

    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fired).toContain("1");
  });

  it("tracks nextFire times", () => {
    const entry = store.create(cronTrigger, "tracked", { recurring: false });
    scheduler.add(entry);

    const nextFire = scheduler.nextFire("1");
    expect(nextFire).toBeDefined();
    expect(nextFire!).toBeGreaterThan(Date.now());
  });

  it("returns undefined for untracked IDs", () => {
    expect(scheduler.nextFire("999")).toBeUndefined();
  });
});
