import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  parseSettings,
  saveSettings,
  settingsFileExists,
  updateSettings,
} from "../src/settings.js";

describe("parseSettings", () => {
  it("returns defaults for non-object input", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("garbage")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings([])).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults when no fields are present", () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("accepts a valid full settings object", () => {
    const out = parseSettings({
      loopScope: "session",
      taskScope: "project",
      debug: true,
      autoClear: "never",
      sortOrder: "recent",
      hiddenAt: "top",
      maxVisible: 25,
      showAll: true,
      taskThreshold: 10,
    });
    expect(out.loopScope).toBe("session");
    expect(out.taskScope).toBe("project");
    expect(out.debug).toBe(true);
    expect(out.autoClear).toBe("never");
    expect(out.sortOrder).toBe("recent");
    expect(out.hiddenAt).toBe("top");
    expect(out.maxVisible).toBe(25);
    expect(out.showAll).toBe(true);
    expect(out.taskThreshold).toBe(10);
  });

  it("accepts string-encoded booleans and numbers (loose coercion)", () => {
    const out = parseSettings({
      debug: "true",
      showAll: "false",
      maxVisible: "20",
      taskThreshold: "7",
    });
    expect(out.debug).toBe(true);
    expect(out.showAll).toBe(false);
    expect(out.maxVisible).toBe(20);
    expect(out.taskThreshold).toBe(7);
  });

  it("rejects unknown keys (strict schema)", () => {
    expect(() => parseSettings({ unknownKey: 42 })).toThrow(/Unknown pi-loop-settings.json key/);
    expect(() => parseSettings({ foo: 1, bar: 2 })).toThrow(/Unknown pi-loop-settings.json key/);
  });

  it("rejects invalid enum values silently (falls back to default)", () => {
    const out = parseSettings({
      loopScope: "bogus",
      sortOrder: "alphabetical",
      autoClear: "always",
      hiddenAt: "middle",
    });
    expect(out.loopScope).toBe(DEFAULT_SETTINGS.loopScope);
    expect(out.sortOrder).toBe(DEFAULT_SETTINGS.sortOrder);
    expect(out.autoClear).toBe(DEFAULT_SETTINGS.autoClear);
    expect(out.hiddenAt).toBe(DEFAULT_SETTINGS.hiddenAt);
  });

  it("rejects out-of-range integers silently (falls back to default)", () => {
    const out = parseSettings({
      maxVisible: 0,
      taskThreshold: 0.5,
    });
    expect(out.maxVisible).toBe(DEFAULT_SETTINGS.maxVisible);
    expect(out.taskThreshold).toBe(DEFAULT_SETTINGS.taskThreshold);
  });
});

describe("loadSettings / saveSettings (file I/O)", () => {
  let dir: string;
  beforeEach(() => {
    dir = join(tmpdir(), `pi-loop-settings-test-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when the file does not exist", () => {
    const settings = loadSettings(dir);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("reads a valid settings file", () => {
    const path = join(dir, ".pi", "pi-loop-settings.json");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(path, JSON.stringify({ loopScope: "memory", debug: true }));
    const settings = loadSettings(dir);
    expect(settings.loopScope).toBe("memory");
    expect(settings.debug).toBe(true);
    // Other fields keep their defaults
    expect(settings.sortOrder).toBe(DEFAULT_SETTINGS.sortOrder);
  });

  it("returns defaults on malformed JSON (does not throw)", () => {
    const path = join(dir, ".pi", "pi-loop-settings.json");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(path, "{ not valid json");
    const settings = loadSettings(dir);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults on unknown keys (logs error, does not throw)", () => {
    const path = join(dir, ".pi", "pi-loop-settings.json");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(path, JSON.stringify({ totallyMadeUp: true }));
    const settings = loadSettings(dir);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("saveSettings writes pretty-printed JSON", () => {
    saveSettings(dir, { ...DEFAULT_SETTINGS, loopScope: "memory" });
    const path = join(dir, ".pi", "pi-loop-settings.json");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('"loopScope": "memory"');
    expect(content).toContain("\n"); // pretty-printed
  });

  it("updateSettings merges partial updates into the persisted state", () => {
    saveSettings(dir, { ...DEFAULT_SETTINGS, loopScope: "memory" });
    const next = updateSettings(dir, { debug: true });
    expect(next.loopScope).toBe("memory");
    expect(next.debug).toBe(true);
    // Re-read from disk to confirm persistence
    const reread = loadSettings(dir);
    expect(reread.debug).toBe(true);
  });

  it("settingsFileExists returns false when no file, true after save", () => {
    expect(settingsFileExists(dir)).toBe(false);
    saveSettings(dir, DEFAULT_SETTINGS);
    expect(settingsFileExists(dir)).toBe(true);
  });
});
