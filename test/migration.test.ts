import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateV1ToV2 } from "../src/migration/v1-to-v2.js";

describe("migrateV1ToV2", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = join(tmpdir(), `pi-loop-migration-test-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, ".pi"), { recursive: true });
    env = {};
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when no v1 file and no env vars exist", () => {
    const result = migrateV1ToV2(dir, env);
    expect(result.migrated).toBe(false);
    expect(existsSync(join(dir, ".pi", "pi-loop-settings.json"))).toBe(false);
  });

  it("does nothing when the v2 file already exists (idempotent)", () => {
    const v2Path = join(dir, ".pi", "pi-loop-settings.json");
    writeFileSync(v2Path, JSON.stringify({ loopScope: "session" }));
    const result = migrateV1ToV2(dir, { PI_LOOP_SCOPE: "memory" });
    expect(result.migrated).toBe(false);
    // v2 file is unchanged
    const reread = JSON.parse(readFileSync(v2Path, "utf-8"));
    expect(reread.loopScope).toBe("session");
  });

  it("migrates v1 tasks-config.json fields into v2 settings", () => {
    const v1Path = join(dir, ".pi", "tasks-config.json");
    writeFileSync(
      v1Path,
      JSON.stringify({
        taskScope: "project",
        sortOrder: "recent",
        maxVisible: 25,
        showAll: true,
        hiddenAt: "top",
        autoClearCompleted: "never",
      }),
    );

    const result = migrateV1ToV2(dir, env);
    expect(result.migrated).toBe(true);
    expect(result.banner).toContain("pi-loop v2.0 migrated");

    const v2Path = join(dir, ".pi", "pi-loop-settings.json");
    const v2 = JSON.parse(readFileSync(v2Path, "utf-8"));
    expect(v2.taskScope).toBe("project");
    expect(v2.sortOrder).toBe("recent");
    expect(v2.maxVisible).toBe(25);
    expect(v2.showAll).toBe(true);
    expect(v2.hiddenAt).toBe("top");
    expect(v2.autoClear).toBe("never");
    // Renamed v1 file to .v1.bak
    expect(existsSync(`${v1Path}.v1.bak`)).toBe(true);
  });

  it("captures PI_LOOP_SCOPE env var into loopScope", () => {
    const result = migrateV1ToV2(dir, { PI_LOOP_SCOPE: "memory" });
    expect(result.migrated).toBe(true);
    const v2 = JSON.parse(readFileSync(join(dir, ".pi", "pi-loop-settings.json"), "utf-8"));
    expect(v2.loopScope).toBe("memory");
  });

  it("captures PI_LOOP_DEBUG env var into debug", () => {
    const result = migrateV1ToV2(dir, { PI_LOOP_DEBUG: "1" });
    expect(result.migrated).toBe(true);
    const v2 = JSON.parse(readFileSync(join(dir, ".pi", "pi-loop-settings.json"), "utf-8"));
    expect(v2.debug).toBe(true);
  });

  it("captures PI_LOOP_TASK_THRESHOLD env var into taskThreshold", () => {
    const result = migrateV1ToV2(dir, { PI_LOOP_TASK_THRESHOLD: "10" });
    expect(result.migrated).toBe(true);
    const v2 = JSON.parse(readFileSync(join(dir, ".pi", "pi-loop-settings.json"), "utf-8"));
    expect(v2.taskThreshold).toBe(10);
  });

  it("ignores invalid PI_LOOP_SCOPE values (keeps default)", () => {
    const result = migrateV1ToV2(dir, { PI_LOOP_SCOPE: "bogus" });
    expect(result.migrated).toBe(true);
    const v2 = JSON.parse(readFileSync(join(dir, ".pi", "pi-loop-settings.json"), "utf-8"));
    expect(v2.loopScope).toBe("project"); // default
  });

  it("ignores invalid PI_LOOP_TASK_THRESHOLD values (keeps default)", () => {
    const result = migrateV1ToV2(dir, { PI_LOOP_TASK_THRESHOLD: "abc" });
    expect(result.migrated).toBe(true);
    const v2 = JSON.parse(readFileSync(join(dir, ".pi", "pi-loop-settings.json"), "utf-8"));
    expect(v2.taskThreshold).toBe(5); // default
  });

  it("ignores out-of-range PI_LOOP_TASK_THRESHOLD (keeps default)", () => {
    const result = migrateV1ToV2(dir, { PI_LOOP_TASK_THRESHOLD: "0" });
    expect(result.migrated).toBe(true);
    const v2 = JSON.parse(readFileSync(join(dir, ".pi", "pi-loop-settings.json"), "utf-8"));
    expect(v2.taskThreshold).toBe(5); // default
  });

  it("merges v1 file + env vars (env wins on conflict)", () => {
    const v1Path = join(dir, ".pi", "tasks-config.json");
    writeFileSync(v1Path, JSON.stringify({ taskScope: "project", maxVisible: 25 }));
    const result = migrateV1ToV2(dir, { PI_LOOP_SCOPE: "memory" });
    expect(result.migrated).toBe(true);
    const v2 = JSON.parse(readFileSync(join(dir, ".pi", "pi-loop-settings.json"), "utf-8"));
    expect(v2.loopScope).toBe("memory"); // from env
    expect(v2.taskScope).toBe("project"); // from v1
    expect(v2.maxVisible).toBe(25); // from v1
  });

  it("banner mentions env vars when they are the only source", () => {
    const result = migrateV1ToV2(dir, { PI_LOOP_SCOPE: "memory" });
    expect(result.banner).toContain("env vars");
    expect(result.banner).toContain("PI_LOOP_SCOPE");
  });

  it("banner does NOT mention env vars when only v1 file is the source", () => {
    const v1Path = join(dir, ".pi", "tasks-config.json");
    writeFileSync(v1Path, JSON.stringify({ taskScope: "project" }));
    const result = migrateV1ToV2(dir, env);
    expect(result.banner).toContain("v1 file");
    expect(result.banner).not.toContain("PI_LOOP");
  });

  it("does not crash on corrupt v1 JSON", () => {
    const v1Path = join(dir, ".pi", "tasks-config.json");
    writeFileSync(v1Path, "{ corrupt");
    // Should still migrate any env vars and skip v1 fields
    const result = migrateV1ToV2(dir, { PI_LOOP_SCOPE: "memory" });
    expect(result.migrated).toBe(true);
    const v2 = JSON.parse(readFileSync(join(dir, ".pi", "pi-loop-settings.json"), "utf-8"));
    expect(v2.loopScope).toBe("memory");
  });
});