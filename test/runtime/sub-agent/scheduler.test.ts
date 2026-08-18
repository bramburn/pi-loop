/**
 * Tests for the sub-agent scheduler (gate). Pure logic, no I/O.
 *
 * The scheduler decides whether a fire should spawn, defer, or pause
 * based on the loop's state, the session's active-iteration count, and
 * the merged subAgent settings.
 */

import { describe, expect, it } from "vitest";
import { gate } from "../../../src/runtime/sub-agent/scheduler.js";
import { DEFAULT_SUB_AGENT_SETTINGS, type PiLoopSettings } from "../../../src/settings.js";
import type { LoopEntry } from "../../../src/types.js";

function makeLoop(overrides: Partial<LoopEntry> = {}): LoopEntry {
  return {
    id: "1",
    prompt: "test",
    trigger: { type: "cron", schedule: "*/5 * * * *" },
    status: "active",
    recurring: true,
    createdAt: 0,
    updatedAt: 0,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<PiLoopSettings> = {}): PiLoopSettings {
  return {
    loopScope: "project",
    taskScope: "session",
    debug: false,
    autoClear: "on_list_complete",
    sortOrder: "id",
    hiddenAt: "bottom",
    maxVisible: 10,
    showAll: false,
    taskThreshold: 5,
    urgentFlushThresholds: { defer: 86_400_000, normal: 300_000, urgent: 30_000, critical: 0 },
    subAgent: { ...DEFAULT_SUB_AGENT_SETTINGS, envOverrides: {} },
    ...overrides,
  };
}

describe("sub-agent scheduler gate", () => {
  it("returns spawn when no caps are hit", () => {
    const decision = gate({
      loop: makeLoop(),
      activeCount: 0,
      settings: makeSettings(),
    });
    expect(decision.kind).toBe("spawn");
  });

  it("defers when the active-iteration cap is reached", () => {
    const settings = makeSettings({ subAgent: { ...DEFAULT_SUB_AGENT_SETTINGS, activeIterationsMax: 2, envOverrides: {} } });
    const decision = gate({
      loop: makeLoop(),
      activeCount: 2,
      settings,
    });
    expect(decision.kind).toBe("defer");
    if (decision.kind === "defer") {
      expect(decision.reason).toBe("concurrency_cap");
      expect(decision.activeCount).toBe(2);
      expect(decision.cap).toBe(2);
    }
  });

  it("pauses when the iteration cap is reached", () => {
    const loop = makeLoop({
      iterCount: 10,
      subAgent: { maxIterations: 10 },
    });
    const decision = gate({ loop, activeCount: 0, settings: makeSettings() });
    expect(decision.kind).toBe("pause");
    if (decision.kind === "pause") {
      expect(decision.reason).toBe("iteration_cap");
      expect(decision.iterCount).toBe(10);
      expect(decision.cap).toBe(10);
    }
  });

  it("pauses when the token budget is reached", () => {
    const loop = makeLoop({
      cumulativeTokens: 100_000,
      subAgent: { maxTokens: 100_000 },
    });
    const decision = gate({ loop, activeCount: 0, settings: makeSettings() });
    expect(decision.kind).toBe("pause");
    if (decision.kind === "pause") {
      expect(decision.reason).toBe("budget_cap");
    }
  });

  it("pauses after 3 consecutive failures", () => {
    const loop = makeLoop({ consecutiveFailures: 3 });
    const decision = gate({ loop, activeCount: 0, settings: makeSettings() });
    expect(decision.kind).toBe("pause");
    if (decision.kind === "pause") {
      expect(decision.reason).toBe("failure_cap");
      expect(decision.consecutiveFailures).toBe(3);
      expect(decision.cap).toBe(3);
    }
  });

  it("does NOT pause on 2 consecutive failures (below threshold)", () => {
    const loop = makeLoop({ consecutiveFailures: 2 });
    const decision = gate({ loop, activeCount: 0, settings: makeSettings() });
    expect(decision.kind).toBe("spawn");
  });

  it("concurrency cap is evaluated before other caps", () => {
    const loop = makeLoop({
      iterCount: 100,
      cumulativeTokens: 1_000_000,
      subAgent: { maxIterations: 100, maxTokens: 1_000_000 },
    });
    const settings = makeSettings({ subAgent: { ...DEFAULT_SUB_AGENT_SETTINGS, activeIterationsMax: 1, envOverrides: {} } });
    const decision = gate({ loop, activeCount: 1, settings });
    expect(decision.kind).toBe("defer");
  });
});
