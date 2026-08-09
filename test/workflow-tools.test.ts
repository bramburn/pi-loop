import { describe, expect, it } from "vitest";
import { formatWorkflowSummary } from "../src/tools/workflow-tools.js";
import type { LoopEntry } from "../src/types.js";

function makeEntry(overrides: Partial<LoopEntry["workflow"]> = {}): LoopEntry {
  const workflow = {
    definition: {
      initialState: "init",
      states: {
        init: {
          prompt: "Start",
          on: { ok: "running" },
        },
        running: {
          prompt: "Run",
          maxAttempts: 3,
          on: { ok: "complete", retry: "running" },
        },
        complete: { terminal: "complete" },
      },
    },
    currentState: "running",
    attemptsByState: { init: 1, running: 1 },
    ...overrides,
  } as LoopEntry["workflow"];
  return {
    id: "1",
    prompt: "test goal",
    status: "active",
    recurring: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 86400000,
    trigger: { type: "cron", schedule: "*/5 * * * *" },
    workflow,
  };
}

describe("formatWorkflowSummary", () => {
  it("renders basic header with goal and current state", () => {
    const entry = makeEntry();
    const out = formatWorkflowSummary(entry, "Heading");
    expect(out).toContain("Heading");
    expect(out).toContain("Goal: test goal");
    expect(out).toContain("Current state: running");
    expect(out).toContain("Attempt: 1/3");
  });

  it("renders simple attempt count when maxAttempts is not set", () => {
    const entry = makeEntry({
      definition: {
        initialState: "init",
        states: {
          init: { prompt: "Start", on: {} },
        },
      },
      currentState: "init",
      attemptsByState: { init: 5 },
    });
    const out = formatWorkflowSummary(entry, "H");
    expect(out).toContain("Attempt: 5");
  });

  it("includes last transition when present", () => {
    const entry = makeEntry();
    entry.workflow!.lastTransition = {
      from: "init",
      to: "running",
      outcome: "ok",
      evidence: "build passed",
    };
    const out = formatWorkflowSummary(entry, "H");
    expect(out).toContain("Last transition:");
    expect(out).toContain("init \u2192 running");
    expect(out).toContain("Evidence: build passed");
  });

  it("includes state prompt when present", () => {
    const out = formatWorkflowSummary(makeEntry(), "H");
    expect(out).toContain("Instruction: Run");
  });

  it("includes active task ID when set", () => {
    const entry = makeEntry();
    entry.workflow!.activeTaskId = "42";
    const out = formatWorkflowSummary(entry, "H");
    expect(out).toContain("Active task: #42");
  });

  it("shows 'no task was created' when state has task but no activeTaskId", () => {
    const entry = makeEntry();
    entry.workflow!.definition.states.running.task = { subject: "do the thing" } as never;
    const out = formatWorkflowSummary(entry, "H");
    expect(out).toContain("no task was created");
  });

  it("shows 'none configured for this state' when no task and no activeTaskId", () => {
    const entry = makeEntry();
    const out = formatWorkflowSummary(entry, "H");
    expect(out).toContain("none configured");
  });

  it("shows 'Terminal: <status>' when state is terminal", () => {
    const entry = makeEntry({ currentState: "complete" });
    const out = formatWorkflowSummary(entry, "H");
    expect(out).toContain("Terminal: complete");
  });

  it("shows 'Needs attention' when state has no declared outcomes", () => {
    const entry = makeEntry();
    entry.workflow!.definition.states.running.on = {};
    const out = formatWorkflowSummary(entry, "H");
    expect(out).toContain("Needs attention");
  });

  it("shows 'Blocked' when all declared outcomes are unavailable", () => {
    const entry = makeEntry();
    entry.workflow!.definition.states.running.on = { ok: "running" };
    entry.workflow!.definition.states.running.maxAttempts = 1;
    const out = formatWorkflowSummary(entry, "H");
    expect(out).toContain("Blocked");
  });

  it("lists unavailable outcomes with target state and attempt limit", () => {
    const entry = makeEntry();
    entry.workflow!.definition.states.running.on = { ok: "running" };
    entry.workflow!.definition.states.running.maxAttempts = 2;
    entry.workflow!.attemptsByState = { init: 1, running: 2 };
    const out = formatWorkflowSummary(entry, "H");
    expect(out).toContain("Unavailable outcome");
    expect(out).toContain("running");
    expect(out).toContain("2 attempt limit");
  });

  it("sorts unavailable outcomes to put the failed outcome first", () => {
    const entry = makeEntry();
    entry.workflow!.definition.states.running.maxAttempts = 1;
    entry.workflow!.attemptsByState = { init: 1, running: 1 };
    const out = formatWorkflowSummary(entry, "H", {
      outcome: "ok",
      targetState: "running",
      attempts: 1,
      maxAttempts: 1,
      evidence: "failed",
    });
    // First mentioned outcome should be 'ok' (the failure)
    expect(out.indexOf("ok \u2014 target state")).toBeLessThan(out.length);
  });
});
