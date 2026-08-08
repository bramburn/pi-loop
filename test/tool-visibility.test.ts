import { describe, expect, it, vi } from "vitest";
import {
  computeActiveTools,
  type LoopSnapshot,
  snapshotFromLoop,
  syncLoopTools,
} from "../src/tools/tool-visibility.js";

function makePi(initial: string[] = []) {
  return {
    current: [...initial],
    getActiveTools: vi.fn(function (this: { current: string[] }) {
      return [...this.current];
    }),
    setActiveTools: vi.fn(function (this: { current: string[] }, tools: string[]) {
      this.current = tools;
    }),
  };
}

const ACTIVE_DYNAMIC: LoopSnapshot = { id: "1", status: "active", hasDynamic: true, isTaskBacklog: false, hasWorkflow: false };
const ACTIVE_CRON: LoopSnapshot = { id: "2", status: "active", hasDynamic: false, isTaskBacklog: false, hasWorkflow: false };
const PAUSED: LoopSnapshot = { id: "3", status: "paused", hasDynamic: false, isTaskBacklog: false, hasWorkflow: false };
const TASK_BACKLOG: LoopSnapshot = { id: "4", status: "active", hasDynamic: false, isTaskBacklog: true, hasWorkflow: false };
const WORKFLOW: LoopSnapshot = { id: "5", status: "active", hasDynamic: false, isTaskBacklog: false, hasWorkflow: true };

describe("computeActiveTools (pure)", () => {
  it("always adds LoopCreate and LoopList", () => {
    const out = computeActiveTools([], []);
    expect(out).toContain("LoopCreate");
    expect(out).toContain("LoopList");
  });

  it("does not add LoopUpdate when no dynamic loop is active", () => {
    const out = computeActiveTools([], [ACTIVE_CRON]);
    expect(out).not.toContain("LoopUpdate");
  });

  it("adds LoopUpdate when at least one dynamic loop is active", () => {
    const out = computeActiveTools([], [ACTIVE_DYNAMIC]);
    expect(out).toContain("LoopUpdate");
  });

  it("does not add LoopDelete when no paused or taskBacklog loop exists", () => {
    const out = computeActiveTools([], [ACTIVE_CRON, ACTIVE_DYNAMIC]);
    expect(out).not.toContain("LoopDelete");
  });

  it("adds LoopDelete when a paused loop exists", () => {
    const out = computeActiveTools([], [ACTIVE_CRON, PAUSED]);
    expect(out).toContain("LoopDelete");
  });

  it("adds LoopDelete when a taskBacklog loop exists", () => {
    const out = computeActiveTools([], [ACTIVE_CRON, TASK_BACKLOG]);
    expect(out).toContain("LoopDelete");
  });

  it("does not add WorkflowTransition unless a workflow loop exists", () => {
    const out = computeActiveTools([], [ACTIVE_CRON, PAUSED]);
    expect(out).not.toContain("WorkflowTransition");
  });

  it("adds WorkflowTransition when a workflow loop is active", () => {
    const out = computeActiveTools([], [WORKFLOW]);
    expect(out).toContain("WorkflowTransition");
  });

  it("removes previously-enabled tools when the predicate no longer matches", () => {
    const initial = ["LoopCreate", "LoopList", "LoopUpdate", "LoopDelete"];
    // No loops — all conditional tools should be removed.
    const out = computeActiveTools(initial, []);
    expect(out).toContain("LoopCreate");
    expect(out).toContain("LoopList");
    expect(out).not.toContain("LoopUpdate");
    expect(out).not.toContain("LoopDelete");
  });

  it("preserves unrelated tools that were already in the initial set", () => {
    const initial = ["LoopCreate", "LoopList", "Write", "Edit", "Bash"];
    const out = computeActiveTools(initial, [ACTIVE_CRON]);
    expect(out).toContain("Write");
    expect(out).toContain("Edit");
    expect(out).toContain("Bash");
  });
});

describe("syncLoopTools (integration with mock pi)", () => {
  it("returns undefined and logs an error when getActiveTools returns null", () => {
    const logger = vi.fn();
    const pi = {
      getActiveTools: vi.fn(() => null as unknown as string[]),
      setActiveTools: vi.fn(),
    };
    const result = syncLoopTools(pi, [], { logger });
    expect(result).toBeUndefined();
    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0]![0]).toContain("did not return an array");
  });

  it("returns undefined and logs when getActiveTools returns undefined", () => {
    const logger = vi.fn();
    const pi = {
      getActiveTools: vi.fn(() => undefined as unknown as string[]),
      setActiveTools: vi.fn(),
    };
    syncLoopTools(pi, [], { logger });
    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0]![0]).toContain("did not return an array");
  });

  it("returns the new tool list when getActiveTools is an array", () => {
    const pi = makePi([]);
    const result = syncLoopTools(pi, [ACTIVE_DYNAMIC]);
    expect(result).toBeDefined();
    expect(result).toContain("LoopUpdate");
    expect(pi.setActiveTools).toHaveBeenCalledOnce();
  });

  it("calls setActiveTools with the computed list, not the initial list", () => {
    const pi = makePi(["LoopCreate", "LoopList", "LoopUpdate"]);
    // No dynamic loop — LoopUpdate should be removed.
    syncLoopTools(pi, [ACTIVE_CRON]);
    expect(pi.setActiveTools).toHaveBeenCalledOnce();
    const written = pi.setActiveTools.mock.calls[0]![0] as string[];
    expect(written).not.toContain("LoopUpdate");
    expect(written).toContain("LoopCreate");
  });

  it("returns undefined and logs when setActiveTools throws", () => {
    const logger = vi.fn();
    const pi = {
      getActiveTools: vi.fn(() => ["LoopCreate"]),
      setActiveTools: vi.fn(() => {
        throw new Error("runtime not initialized");
      }),
    };
    const result = syncLoopTools(pi, [], { logger });
    expect(result).toBeUndefined();
    expect(logger).toHaveBeenCalledOnce();
    expect(logger.mock.calls[0]![0]).toContain("runtime not initialized");
  });

  it("respects the initialTools override (no pi.getActiveTools call)", () => {
    const pi = makePi([]);
    const result = syncLoopTools(pi, [], { initialTools: ["LoopCreate", "LoopList", "Write"] });
    expect(result).toContain("Write");
    expect(pi.getActiveTools).not.toHaveBeenCalled();
  });
});

describe("snapshotFromLoop (helper)", () => {
  it("extracts the four visibility fields from a LoopEntry-shaped object", () => {
    const snap = snapshotFromLoop({
      status: "active",
      dynamic: { goal: "x", iteration: 0 },
      taskBacklog: false,
    });
    expect(snap.status).toBe("active");
    expect(snap.hasDynamic).toBe(true);
    expect(snap.isTaskBacklog).toBe(false);
    expect(snap.hasWorkflow).toBe(false);
  });

  it("treats undefined dynamic / workflow as not-present", () => {
    const snap = snapshotFromLoop({
      status: "paused",
      dynamic: undefined,
      taskBacklog: false,
      workflow: undefined,
    });
    expect(snap.hasDynamic).toBe(false);
    expect(snap.hasWorkflow).toBe(false);
    expect(snap.status).toBe("paused");
  });

  it("treats empty object fields as not-present", () => {
    const snap = snapshotFromLoop({
      status: "active",
      dynamic: null,
      taskBacklog: false,
      workflow: null,
    });
    expect(snap.hasDynamic).toBe(false);
    expect(snap.hasWorkflow).toBe(false);
  });

  it("coerces unknown status strings to 'active'", () => {
    const snap = snapshotFromLoop({
      status: "completed",
      dynamic: undefined,
      taskBacklog: false,
      workflow: undefined,
    });
    expect(snap.status).toBe("active");
  });
});

// Full state x tool matrix test (mirror pragmaxim's goal-tool-visibility.test.ts).
describe("state x tool matrix", () => {
  const cases: Array<{ name: string; loops: LoopSnapshot[]; expected: string[] }> = [
    {
      name: "no loops",
      loops: [],
      expected: ["LoopCreate", "LoopList"],
    },
    {
      name: "active cron loop only",
      loops: [ACTIVE_CRON],
      expected: ["LoopCreate", "LoopList"],
    },
    {
      name: "active dynamic loop",
      loops: [ACTIVE_DYNAMIC],
      expected: ["LoopCreate", "LoopList", "LoopUpdate"],
    },
    {
      name: "paused loop enables LoopDelete",
      loops: [PAUSED],
      expected: ["LoopCreate", "LoopList", "LoopDelete"],
    },
    {
      name: "taskBacklog loop enables LoopDelete",
      loops: [TASK_BACKLOG],
      expected: ["LoopCreate", "LoopList", "LoopDelete"],
    },
    {
      name: "workflow loop enables WorkflowTransition",
      loops: [WORKFLOW],
      expected: ["LoopCreate", "LoopList", "WorkflowTransition"],
    },
    {
      name: "all-loop mix enables everything",
      loops: [ACTIVE_DYNAMIC, PAUSED, TASK_BACKLOG, WORKFLOW],
      expected: ["LoopCreate", "LoopList", "LoopUpdate", "LoopDelete", "WorkflowTransition"],
    },
  ];

  for (const c of cases) {
    it(`${c.name}: includes ${c.expected.join(", ")}`, () => {
      const out = computeActiveTools([], c.loops);
      for (const name of c.expected) {
        expect(out).toContain(name);
      }
    });
  }
});
