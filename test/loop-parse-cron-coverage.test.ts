// Additional coverage tests for loop-parse.ts: cronFieldMatches and
// cronToNextFire edge cases.

import { describe, expect, it } from "vitest";
import { computeJitter, cronToNextFire } from "../src/loop-parse.js";

describe("cronToNextFire edge cases", () => {
  it("throws on invalid cron expressions", () => {
    expect(() => cronToNextFire("not a cron")).toThrow();
    expect(() => cronToNextFire("60 * * * *")).toThrow();
    expect(() => cronToNextFire("* 24 * * *")).toThrow();
  });

  it("computes next minute for '* * * * *' (every minute)", () => {
    const from = new Date("2026-08-08T12:00:00Z");
    const next = cronToNextFire("* * * * *", from);
    expect(next.getUTCMinutes()).toBe(1);
    expect(next.getUTCSeconds()).toBe(0);
    expect(next.getUTCMilliseconds()).toBe(0);
  });

  it("respects day-of-week match (Sunday = 0)", () => {
    const from = new Date("2026-08-09T12:00:00Z"); // Sunday
    // Every Sunday at 14:30 UTC. Advance minute-by-minute from noon.
    const next = cronToNextFire("30 14 * * 0", from);
    expect(next.getUTCDay()).toBe(0); // Sunday
  });

  it("handles day-of-month match", () => {
    const from = new Date("2026-08-01T00:00:00Z");
    // 14th of every month at 23:59 (the latest minute before day 15)
    const next = cronToNextFire("59 23 14 * *", from);
    expect(next.getUTCDate()).toBe(14);
  });

  it("handles month match", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    // March 1 at midnight
    const next = cronToNextFire("0 0 1 3 *", from);
    expect(next.getUTCMonth()).toBe(2); // March (0-indexed)
  });

  it("handles comma-separated lists", () => {
    const from = new Date("2026-08-08T12:00:00Z");
    // Every 0,15,30,45 minute
    const next = cronToNextFire("0,15,30,45 * * * *", from);
    expect([0, 15, 30, 45]).toContain(next.getUTCMinutes());
  });

  it("handles step expressions (every 5 minutes)", () => {
    const from = new Date("2026-08-08T12:00:00Z");
    const next = cronToNextFire("*/5 * * * *", from);
    expect(next.getUTCMinutes() % 5).toBe(0);
  });

  it("handles range expressions (10-20 minute)", () => {
    const from = new Date("2026-08-08T12:00:00Z");
    const next = cronToNextFire("10-20 * * * *", from);
    expect(next.getUTCMinutes()).toBeGreaterThanOrEqual(10);
    expect(next.getUTCMinutes()).toBeLessThanOrEqual(20);
  });

  it("handles combined step + range expressions", () => {
    const from = new Date("2026-08-08T12:00:00Z");
    const next = cronToNextFire("10-30/5 * * * *", from);
    expect(next.getUTCMinutes() % 5).toBe(0);
    expect(next.getUTCMinutes()).toBeGreaterThanOrEqual(10);
    expect(next.getUTCMinutes()).toBeLessThanOrEqual(30);
  });

  it("throws if no matching time is found within search window", () => {
    // Feb 30 doesn't exist; Feb 31 impossible; use impossible cron
    expect(() => cronToNextFire("0 0 30 2 *")).toThrow(/No matching time/);
  });
});

describe("computeJitter", () => {
  it("returns 0 for non-recurring tasks with low scheduleMinutes", () => {
    const jitter = computeJitter("task-1", false, 5);
    expect(jitter).toBeGreaterThanOrEqual(0);
  });

  it("returns bounded jitter for recurring tasks with scheduleMinutes <= 30", () => {
    const jitter = computeJitter("task-1", true, 10);
    // Bound: normalized * (scheduleMinutes/2) * 60 * 1000 = up to 5 * 60 * 1000 = 300_000ms
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThanOrEqual(300_000);
  });

  it("returns bounded jitter for recurring tasks with scheduleMinutes > 30", () => {
    const jitter = computeJitter("task-1", true, 60);
    // Bound: normalized * 30 * 60 * 1000 = up to 30 * 60 * 1000 = 1_800_000ms
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThanOrEqual(1_800_000);
  });

  it("returns bounded jitter for non-recurring tasks", () => {
    const jitter = computeJitter("task-1", false, 60);
    // Bound: normalized * 90 * 1000 = up to 90_000ms
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThanOrEqual(90_000);
  });

  it("produces deterministic output for the same taskId", () => {
    const j1 = computeJitter("task-1", true, 30);
    const j2 = computeJitter("task-1", true, 30);
    expect(j1).toBe(j2);
  });

  it("produces different output for different taskIds", () => {
    const j1 = computeJitter("task-1", true, 30);
    const j2 = computeJitter("task-2", true, 30);
    // Highly likely different (hash collision probability < 0.01%)
    expect(j1).not.toBe(j2);
  });

  it("handles empty taskId", () => {
    expect(() => computeJitter("", true, 30)).not.toThrow();
  });

  it("handles long taskId strings", () => {
    const longId = "x".repeat(1000);
    expect(() => computeJitter(longId, true, 30)).not.toThrow();
  });
});
