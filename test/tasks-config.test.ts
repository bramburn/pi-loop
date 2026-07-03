import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TASKS_CONFIG,
  loadTasksConfig,
  saveTasksConfig,
  updateTasksConfig,
} from "../src/tasks-config.js";

describe("tasks-config", () => {
  const dir = join(tmpdir(), `pi-loop-task-config-test-${Date.now()}`);
  const path = join(dir, ".pi", "tasks-config.json");

  beforeEach(() => {
    rmSync(path, { force: true });
  });

  afterEach(() => {
    rmSync(path, { force: true });
  });

  it("loadTasksConfig returns defaults when no file exists", () => {
    const config = loadTasksConfig(dir);
    expect(config).toEqual(DEFAULT_TASKS_CONFIG);
  });

  it("saveTasksConfig writes a file", () => {
    const config = { ...DEFAULT_TASKS_CONFIG, taskScope: "project" as const, maxVisible: 20 };
    saveTasksConfig(dir, config);
    const loaded = loadTasksConfig(dir);
    expect(loaded.taskScope).toBe("project");
    expect(loaded.maxVisible).toBe(20);
  });

  it("updateTasksConfig merges partial changes", () => {
    const initial = loadTasksConfig(dir);
    expect(initial.taskScope).toBe("session"); // default

    const next = updateTasksConfig(dir, { taskScope: "memory" });
    expect(next.taskScope).toBe("memory");
    expect(next.sortOrder).toBe(initial.sortOrder); // unchanged
    expect(next.maxVisible).toBe(initial.maxVisible); // unchanged
  });

  it("updateTasksConfig handles all config keys", () => {
    const overrides = {
      taskScope: "project" as const,
      sortOrder: "status" as const,
      maxVisible: 50,
      showAll: true,
      hiddenAt: "top" as const,
      autoClearCompleted: "never" as const,
    };
    const config = updateTasksConfig(dir, overrides);
    expect(config).toEqual(overrides);
  });
});
