import { rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_STATE_FILE = join(".pi", "fruit-loops", "test_loop5_state.json");

describe("Node Hygiene State Management", () => {
  beforeEach(() => {
    process.env.NODE_HYGIENE_STATE = TEST_STATE_FILE;
    if (existsSync(TEST_STATE_FILE)) {
      rmSync(TEST_STATE_FILE);
    }
  });

  afterEach(() => {
    if (existsSync(TEST_STATE_FILE)) {
      rmSync(TEST_STATE_FILE);
    }
    delete process.env.NODE_HYGIENE_STATE;
  });

  it("should create default state when file does not exist", async () => {
    const { loadState } = await import("../../src/runtime/fruit-loops/node-hygiene.js");
    const state = loadState();
    expect(state).toBeDefined();
    expect(state.age_threshold_minutes).toBe(60);
    expect(state.cpu_idle_threshold_percent).toBe(2);
    expect(state.min_samples_before_kill).toBe(3);
    expect(state.protected_patterns).toContain("pi.dev");
    expect(state.tracked_processes).toEqual({});
    expect(state.kill_log).toEqual([]);
  });

  it("should load existing state file", async () => {
    const { loadState, createDefaultState } = await import("../../src/runtime/fruit-loops/node-hygiene.js");
    const defaultState = createDefaultState();
    defaultState.tracked_processes = {
      "1234": {
        commandline: "test.js",
        creation_date: "2026-07-04T10:00:00Z",
        cpu_samples: [0, 1, 2],
        protected: false,
      },
    };
    writeFileSync(TEST_STATE_FILE, JSON.stringify(defaultState));

    const state = loadState();
    expect(state.tracked_processes["1234"]).toBeDefined();
    expect(state.tracked_processes["1234"].commandline).toBe("test.js");
  });

  it("should backup and recreate corrupted state", async () => {
    const { loadState } = await import("../../src/runtime/fruit-loops/node-hygiene.js");
    writeFileSync(TEST_STATE_FILE, "{ invalid json }");

    const state = loadState();
    expect(state).toBeDefined();
    // Check that a backup file was created
    const backupFiles = readdirSync(".pi/fruit-loops/").filter(f => f.includes("test_loop5_state.json.backup."));
    expect(backupFiles.length).toBeGreaterThan(0);
  });
});

describe("Protected Pattern Matching", () => {
  it("should identify pi.dev processes as protected", async () => {
    const { isProtected } = await import("../../src/runtime/fruit-loops/node-hygiene.js");
    const patterns = ["pi.dev", "tabby", ".pi\\", "@earendil-works"];

    expect(isProtected("C:\\...\\pi.dev\\agent\\cli.js", patterns)).toBe(true);
    expect(isProtected("node --loader tsx @earendil-works/pi-coding-agent", patterns)).toBe(true);
    expect(isProtected("tabby-web", patterns)).toBe(true);
    expect(isProtected("C:\\Users\\.pi\\config.json", patterns)).toBe(true);
  });

  it("should not flag unknown processes as protected", async () => {
    const { isProtected } = await import("../../src/runtime/fruit-loops/node-hygiene.js");
    const patterns = ["pi.dev", "tabby", ".pi\\"];

    expect(isProtected("C:\\Projects\\MyApp\\node.exe server.js", patterns)).toBe(false);
    expect(isProtected("npm run build", patterns)).toBe(false);
  });
});

describe("Kill Candidate Logic", () => {
  it("should calculate age correctly from WMIC date format", async () => {
    const { getAgeMinutes } = await import("../../src/runtime/fruit-loops/node-hygiene.js");

    const oldDate = "20260101000000.000000+000";
    // Use a date within the last hour - derive from current time minus 30 minutes
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recentDate = `${thirtyMinsAgo.getFullYear()}${String(thirtyMinsAgo.getMonth() + 1).padStart(2, "0")}${String(thirtyMinsAgo.getDate()).padStart(2, "0")}${String(thirtyMinsAgo.getHours()).padStart(2, "0")}${String(thirtyMinsAgo.getMinutes()).padStart(2, "0")}${String(thirtyMinsAgo.getSeconds()).padStart(2, "0")}.000000+000`;

    expect(getAgeMinutes(oldDate)).toBeGreaterThan(0);
    expect(getAgeMinutes(recentDate)).toBeLessThan(60);
  });
});
