import { describe, expect, it } from "vitest";
import {
  createWorkflowRun,
  getWorkflowOutcomeAvailability,
  isTerminalWorkflowRun,
  transitionWorkflowRun,
  validateWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowRunState,
} from "../src/workflow-reducer.js";

const baseDefinition: WorkflowDefinition = {
  version: 1,
  initialState: "init",
  states: {
    init: {
      prompt: "Start",
      on: { ok: "running", retry: "init" },
    },
    running: {
      prompt: "Run",
      maxAttempts: 2,
      on: { ok: "complete", retry: "running" },
    },
    complete: { terminal: "complete", prompt: "Done" },
  },
};

describe("validateWorkflowDefinition", () => {
  it("accepts a valid definition", () => {
    expect(validateWorkflowDefinition(baseDefinition)).toBeUndefined();
  });

  it("rejects wrong version", () => {
    expect(validateWorkflowDefinition({ ...baseDefinition, version: 2 } as never)).toMatch(/version/);
  });

  it("rejects missing initial state", () => {
    expect(validateWorkflowDefinition({ ...baseDefinition, initialState: "missing" })).toMatch(/not defined/);
  });

  it("rejects terminal initial state", () => {
    const def = {
      ...baseDefinition,
      initialState: "complete",
    };
    expect(validateWorkflowDefinition(def)).toMatch(/cannot be terminal/);
  });

  it("rejects empty state ID", () => {
    const def = {
      ...baseDefinition,
      states: { ...baseDefinition.states, "": { prompt: "x" } as never },
    };
    expect(validateWorkflowDefinition(def)).toMatch(/non-empty/);
  });

  it("rejects state with empty prompt", () => {
    const def = {
      ...baseDefinition,
      states: { ...baseDefinition.states, foo: { prompt: "  " } as never },
    };
    expect(validateWorkflowDefinition(def)).toMatch(/requires a prompt/);
  });

  it("rejects state with non-object transitions", () => {
    const def = {
      ...baseDefinition,
      states: { ...baseDefinition.states, foo: { prompt: "x", on: "bad" as never } },
    };
    expect(validateWorkflowDefinition(def)).toMatch(/must be an object/);
  });

  it("rejects terminal state with transitions", () => {
    const def = {
      ...baseDefinition,
      states: { ...baseDefinition.states, complete: { terminal: "complete", prompt: "Done", on: { foo: "init" } } },
    };
    expect(validateWorkflowDefinition(def)).toMatch(/cannot declare/);
  });

  it("rejects invalid maxAttempts (negative)", () => {
    const def = {
      ...baseDefinition,
      states: { ...baseDefinition.states, foo: { prompt: "x", maxAttempts: -1 } },
    };
    expect(validateWorkflowDefinition(def)).toMatch(/positive integer/);
  });

  it("rejects transition to unknown state", () => {
    const def = {
      ...baseDefinition,
      states: { ...baseDefinition.states, init: { prompt: "x", on: { ok: "nonexistent" } } },
    };
    expect(validateWorkflowDefinition(def)).toMatch(/unknown state/);
  });

  it("rejects transition with empty outcome name", () => {
    const def = {
      ...baseDefinition,
      states: { ...baseDefinition.states, init: { prompt: "x", on: { "": "running" } } },
    };
    expect(validateWorkflowDefinition(def)).toMatch(/empty outcome/);
  });

  it("rejects transition with non-string target", () => {
    const def = {
      ...baseDefinition,
      states: { ...baseDefinition.states, init: { prompt: "x", on: { ok: 42 as never } } },
    };
    expect(validateWorkflowDefinition(def)).toMatch(/must be a state ID/);
  });
});

describe("createWorkflowRun", () => {
  it("creates a run starting at the initial state with attempt count 1", () => {
    const run = createWorkflowRun(baseDefinition, Date.now());
    expect(run.currentState).toBe("init");
    expect(run.attemptsByState.init).toBe(1);
    expect(run.transitionSeq).toBe(0);
  });
});

describe("isTerminalWorkflowRun", () => {
  it("returns true for terminal state", () => {
    const run = createWorkflowRun(baseDefinition, Date.now());
    run.currentState = "complete";
    expect(isTerminalWorkflowRun(run)).toBe(true);
  });

  it("returns false for non-terminal state", () => {
    const run = createWorkflowRun(baseDefinition, Date.now());
    expect(isTerminalWorkflowRun(run)).toBe(false);
  });

  it("returns false for undefined run", () => {
    expect(isTerminalWorkflowRun(undefined)).toBe(false);
  });
});

describe("getWorkflowOutcomeAvailability", () => {
  it("returns all outcomes as available when no maxAttempts", () => {
    const def = {
      version: 1 as const,
      initialState: "a",
      states: {
        a: { prompt: "A", on: { ok: "b" } },
        b: { prompt: "B", on: { ok: "c" } },
        c: { prompt: "C", terminal: "done" as const },
      },
    };
    const run = createWorkflowRun(def, Date.now());
    const avail = getWorkflowOutcomeAvailability(run);
    expect(avail.available).toContain("ok");
    expect(avail.unavailable).toHaveLength(0);
  });

  it("marks outcomes unavailable when target state has exceeded maxAttempts", () => {
    const run = createWorkflowRun(baseDefinition, Date.now());
    run.currentState = "running";
    run.attemptsByState = { init: 1, running: 2 }; // running already at maxAttempts=2
    const avail = getWorkflowOutcomeAvailability(run);
    // Both 'ok' and 'retry' target 'running' which is at maxAttempts
    expect(avail.unavailable.length).toBeGreaterThan(0);
  });
});

describe("transitionWorkflowRun", () => {
  it("transitions to a valid target state", () => {
    const run = createWorkflowRun(baseDefinition, Date.now());
    const result = transitionWorkflowRun(run, { outcome: "ok" }, Date.now());
    expect(result.applied).toBe(true);
    if (result.applied) {
      expect(result.run.currentState).toBe("running");
    }
  });

  it("rejects when current state is undefined", () => {
    const run = createWorkflowRun(baseDefinition, Date.now()) as WorkflowRunState;
    (run as unknown as { definition: { states: Record<string, never> } }).definition.states = {};
    const result = transitionWorkflowRun(run, { outcome: "ok" }, Date.now());
    expect(result.applied).toBe(false);
  });

  it("rejects when current state is terminal", () => {
    const run = createWorkflowRun(baseDefinition, Date.now());
    run.currentState = "complete";
    const result = transitionWorkflowRun(run, { outcome: "ok" }, Date.now());
    expect(result.applied).toBe(false);
  });

  it("rejects when outcome is not allowed from current state", () => {
    const run = createWorkflowRun(baseDefinition, Date.now());
    const result = transitionWorkflowRun(run, { outcome: "unknown" }, Date.now());
    expect(result.applied).toBe(false);
  });
});
