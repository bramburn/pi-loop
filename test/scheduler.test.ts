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
      // Mimic the real onLoopFire: increment fireCount and emit.
      store.fire(entry.id);
      fired.push(entry.id);
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.restoreAllMocks();
  });

  it("fires a one-shot cron loop via pump", () => {
    const entry = store.create(cronTrigger, "test fire", { recurring: false });
    scheduler.add(entry);

    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toContain("1");
  });

  it("does not fire past the maxFires cap (G-17)", () => {
    const entry = store.create(cronTrigger, "capped", { recurring: true, maxFires: 1 });
    scheduler.add(entry);
    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired.filter((id) => id === "1")).toHaveLength(1);
    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    // The 2nd pump must NOT fire — the cap was reached and the entry deleted.
    expect(fired.filter((id) => id === "1")).toHaveLength(1);
    expect(store.get("1")).toBeUndefined();
  });

  it("enforces maxFires on non-recurring loops (G-11)", () => {
    // A non-recurring loop with maxFires: 1 fires once, then is deleted.
    // (The cap is now applied symmetrically for both recurring and
    // non-recurring loops.)
    const entry = store.create(cronTrigger, "capped one-shot", { recurring: false, maxFires: 1 });
    scheduler.add(entry);
    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toContain("1");
    expect(store.get("1")).toBeUndefined();
  });

  it("does not fire past the maxFires cap (G-17)", () => {
    const entry = store.create(cronTrigger, "capped", { recurring: true, maxFires: 1 });
    scheduler.add(entry);
    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired.filter((id) => id === "1")).toHaveLength(1);
    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    // The 2nd pump must NOT fire — the cap was reached and the entry deleted.
    expect(fired.filter((id) => id === "1")).toHaveLength(1);
    expect(store.get("1")).toBeUndefined();
  });

  it("does not fire paused loops", () => {
    const entry = store.create(cronTrigger, "paused test", { recurring: false });
    store.pause(entry.id);
    scheduler.add(entry);

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
  });

  it("removes on delete before pump", () => {
    const entry = store.create(cronTrigger, "will be deleted", { recurring: false });
    scheduler.add(entry);
    scheduler.remove("1");

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
  });

  it("pump fires recurring loops multiple times when time advances far enough", () => {
    const entry = store.create(cronTrigger, "recurring", { recurring: true });
    scheduler.add(entry);

    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toContain("1");

    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired.length).toBeGreaterThanOrEqual(2);
  });

  it("stop clears fireTimes", () => {
    store.create(cronTrigger, "loop 1", { recurring: false });
    store.create(cronTrigger, "loop 2", { recurring: false });
    scheduler.start();
    scheduler.stop();

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
  });

  it("ignores non-cron triggers", () => {
    const eventTrigger: Trigger = { type: "event", source: "test" };
    store.create(eventTrigger, "event loop", { recurring: false });
    scheduler.start();

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
  });

  it("loads existing loops on start and fires via pump", () => {
    store.create(cronTrigger, "existing", { recurring: false });
    scheduler.start();

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
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

  it("pump does not fire when time has not reached nextFire", () => {
    const entry = store.create(cronTrigger, "not yet", { recurring: false });
    scheduler.add(entry);

    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
  });

  it("deletes expired entries on pump", () => {
    const entry = store.create(cronTrigger, "expired", { recurring: false });
    entry.expiresAt = Date.now() - 1;
    scheduler.add(entry);

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
    expect(store.get(entry.id)).toBeUndefined();
  });

  it("add() twice for same cron entry fires once, not twice (G-45)", () => {
    const entry = store.create(cronTrigger, "dup cron", { recurring: false });
    scheduler.add(entry);
    scheduler.add(entry); // duplicate add — must not create a second timer

    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    // Exactly one fire, not two
    expect(fired).toHaveLength(1);
  });
});
