import { describe, expect, it } from "vitest";
import { createCoordinator, type ReducerEffect, type ReducerHandler } from "../src/coordinator.js";
import {
  reduceTaskBacklogEvent,
  type TaskBacklogEvent,
} from "../src/task-backlog-coordinator.js";

function event(pendingCount: number): TaskBacklogEvent {
  return {
    type: "TASK_BACKLOG_EVALUATED",
    at: 100,
    source: "system",
    entityType: "task",
    payload: { pendingCount },
  };
}

describe("task backlog coordinator", () => {
  it("does not create a worker for a non-empty backlog", () => {
    expect(reduceTaskBacklogEvent(event(5))).toEqual([]);
  });

  it("emits cleanup effect when the pending count drops to zero", () => {
    expect(reduceTaskBacklogEvent(event(0))).toEqual([
      {
        type: "CLEANUP_TASK_BACKLOG_LOOPS",
        entityType: "task",
        payload: { pendingCount: 0 },
      },
    ]);
  });

  it("emits no effects for intermediate pending counts", () => {
    expect(reduceTaskBacklogEvent(event(3))).toEqual([]);
  });

  it("routes backlog effects through the coordinator", async () => {
    const handled: string[] = [];
    const reducer: ReducerHandler = incoming => reduceTaskBacklogEvent(incoming as TaskBacklogEvent);
    const coordinator = createCoordinator({
      reducers: [reducer],
      effectHandlers: {
        CLEANUP_TASK_BACKLOG_LOOPS: (effect: ReducerEffect) => {
          handled.push(`${effect.type}:${(effect.payload as { pendingCount: number }).pendingCount}`);
        },
      },
    });

    await coordinator.dispatch(event(0));

    expect(handled).toEqual(["CLEANUP_TASK_BACKLOG_LOOPS:0"]);
  });
});
