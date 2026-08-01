import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../../src/types.js";
import { createWorkflowRun, transitionWorkflowRun } from "../../src/workflow-reducer.js";
import { propertyOptions } from "./config.js";

const definition: WorkflowDefinition = {
  version: 1,
  initialState: "left",
  states: {
    left: { prompt: "left", on: { next: "right", finish: "done" } },
    right: { prompt: "right", on: { next: "left", finish: "done" } },
    done: { prompt: "done", terminal: "completed" },
  },
};

describe("workflow properties", () => {
  it("applies declared edges exactly once and keeps failed transitions immutable", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("next", "finish", "invalid"), { maxLength: 100 }),
        (outcomes) => {
          let run = createWorkflowRun(definition, 0);
          let appliedCount = 0;

          outcomes.forEach((outcome, index) => {
            const before = structuredClone(run);
            const source = run.currentState;
            const target = run.definition.states[source]?.on?.[outcome];
            const result = transitionWorkflowRun(run, { outcome }, index + 1);

            if (target && !run.definition.states[source]?.terminal) {
              expect(result.applied).toBe(true);
              if (!result.applied) return;
              appliedCount++;
              expect(result.run.currentState).toBe(target);
              expect(result.run.transitionSeq).toBe(appliedCount);
              expect(result.run.lastTransition).toMatchObject({
                from: source,
                to: target,
                outcome,
                sequence: appliedCount,
              });
              run = result.run;
            } else {
              expect(result.applied).toBe(false);
              expect(run).toEqual(before);
            }
          });

          expect(run.transitionSeq).toBe(appliedCount);
          expect(Object.values(run.attemptsByState).reduce((sum, count) => sum + count, 0)).toBe(
            appliedCount + 1,
          );
        },
      ),
      propertyOptions(),
    );
  });

  it("never exceeds generated max-attempt limits", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 0, max: 100 }), (limit, attempts) => {
        const limited: WorkflowDefinition = {
          version: 1,
          initialState: "retry",
          states: {
            retry: { prompt: "retry", on: { again: "retry" }, maxAttempts: limit },
          },
        };
        let run = createWorkflowRun(limited, 0);
        let applied = 0;

        for (let index = 0; index < attempts; index++) {
          const result = transitionWorkflowRun(run, { outcome: "again" }, index + 1);
          if (!result.applied) {
            expect(result.failure).toMatchObject({
              code: "target_exhausted",
              maxAttempts: limit,
              targetState: "retry",
            });
            continue;
          }
          applied++;
          run = result.run;
        }

        expect(applied).toBe(Math.min(attempts, Math.max(0, limit - 1)));
        expect(run.attemptsByState.retry).toBe(Math.min(limit, attempts + 1));
      }),
      propertyOptions(),
    );
  });
});
