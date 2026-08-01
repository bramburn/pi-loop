import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { TaskStore } from "../../src/task-store.js";
import type { TaskStatus } from "../../src/task-types.js";
import { propertyOptions } from "./config.js";

type ModelTask = {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
};

type StoreCommand =
  | { kind: "create"; subject: string; description: string }
  | { kind: "start" | "complete" | "reopen" | "delete"; id: number }
  | { kind: "update"; id: number; subject: string; description: string };

const text = fc.string({ maxLength: 30 });
const id = fc.integer({ min: 1, max: 15 });
const command: fc.Arbitrary<StoreCommand> = fc.oneof(
  fc.record({ kind: fc.constant<"create">("create"), subject: text, description: text }),
  fc.record({ kind: fc.constantFrom("start", "complete", "reopen", "delete"), id }),
  fc.record({ kind: fc.constant<"update">("update"), id, subject: text, description: text }),
);

function normalizedTasks(store: TaskStore): ModelTask[] {
  return store.list().map(({ id: taskId, subject, description, status }) => ({
    id: taskId,
    subject,
    description,
    status,
  }));
}

describe("task store properties", () => {
  it("preserves randomized command sequences across every reopen", () => {
    fc.assert(
      fc.property(fc.array(command, { maxLength: 30 }), (commands) => {
        const directory = mkdtempSync(join(tmpdir(), "pi-loop-property-"));
        const path = join(directory, "tasks.json");
        const model = new Map<string, ModelTask>();
        let nextId = 1;
        let store = new TaskStore(path);

        try {
          for (const current of commands) {
            if (current.kind === "create") {
              const created = store.create(current.subject, current.description);
              const taskId = String(nextId++);
              expect(created.id).toBe(taskId);
              model.set(taskId, {
                id: taskId,
                subject: current.subject,
                description: current.description,
                status: "pending",
              });
            } else {
              const taskId = String(current.id);
              const existing = model.get(taskId);
              switch (current.kind) {
                case "start":
                  expect(store.start(taskId) === undefined).toBe(existing === undefined);
                  if (existing) existing.status = "in_progress";
                  break;
                case "complete":
                  expect(store.complete(taskId) === undefined).toBe(existing === undefined);
                  if (existing) existing.status = "completed";
                  break;
                case "reopen":
                  expect(store.reopen(taskId) === undefined).toBe(existing === undefined);
                  if (existing) existing.status = "pending";
                  break;
                case "delete":
                  expect(store.delete(taskId)).toBe(existing !== undefined);
                  model.delete(taskId);
                  break;
                case "update":
                  expect(
                    store.updateDetails(taskId, {
                      subject: current.subject,
                      description: current.description,
                    }) === undefined,
                  ).toBe(existing === undefined);
                  if (existing) {
                    existing.subject = current.subject;
                    existing.description = current.description;
                  }
                  break;
              }
            }

            store = new TaskStore(path);
            const expected = [...model.values()].sort((left, right) => Number(left.id) - Number(right.id));
            expect(normalizedTasks(store)).toEqual(expected);
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }),
      propertyOptions(25, 250),
    );
  });
});
