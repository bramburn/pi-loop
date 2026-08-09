import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BindingsStore } from "../src/runtime/bindings-store.js";

describe("BindingsStore", () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "pi-loop-bindings-"));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  function newStore(scope: "memory" | "session" | "project" = "project"): BindingsStore {
    const path = scope === "memory" ? undefined : join(cwd, ".pi", "loops", "bindings-test-session.json");
    return new BindingsStore(path, scope);
  }

  describe("file-backed mode", () => {
    it("reports no file before load()", () => {
      const store = newStore();
      expect(store.fileExists()).toBe(false);
      expect(store.size()).toBe(0);
      expect(store.list()).toEqual([]);
    });

    it("load() returns false when no file exists", () => {
      const store = newStore();
      expect(store.load()).toBe(false);
      expect(store.has("1")).toBe(false);
    });

    it("save() creates the file at the configured path", () => {
      const path = join(cwd, ".pi", "loops", "bindings-test-session.json");
      const store = new BindingsStore(path, "project");
      store.add("3");
      expect(existsSync(path)).toBe(true);
      const data = JSON.parse(readFileSync(path, "utf-8"));
      expect(data).toEqual({ loopIds: ["3"] });
    });

    it("add() persists immediately and is idempotent", () => {
      const store = newStore();
      store.add("1");
      store.add("1");
      store.add("2");
      expect(store.size()).toBe(2);
      expect(store.list()).toEqual(["1", "2"]);

      // Reload from disk to confirm persistence
      const reloaded = newStore();
      reloaded.load();
      expect(reloaded.list()).toEqual(["1", "2"]);
    });

    it("remove() persists immediately and is idempotent", () => {
      const store = newStore();
      store.add("1");
      store.add("2");
      store.remove("1");
      store.remove("1");
      expect(store.has("1")).toBe(false);
      expect(store.has("2")).toBe(true);

      const reloaded = newStore();
      reloaded.load();
      expect(reloaded.list()).toEqual(["2"]);
    });

    it("has() is O(1)", () => {
      const store = newStore();
      store.add("42");
      expect(store.has("42")).toBe(true);
      expect(store.has("99")).toBe(false);
    });

    it("clear() empties and persists", () => {
      const store = newStore();
      store.add("1");
      store.add("2");
      store.clear();
      expect(store.size()).toBe(0);

      const reloaded = newStore();
      reloaded.load();
      expect(reloaded.list()).toEqual([]);
    });

    it("load() returns true and populates from an existing file", () => {
      const store = newStore();
      store.add("5");
      store.add("9");

      const fresh = newStore();
      expect(fresh.load()).toBe(true);
      expect(fresh.list()).toEqual(["5", "9"]);
    });

    it("reload() discards unsaved in-memory changes and reloads from disk", () => {
      // Two separate stores pointing at the same file
      const storeA = newStore();
      storeA.add("1");
      storeA.add("3");

      const storeB = newStore();
      storeB.add("5");
      storeB.add("7");
      storeB.save(); // persist only 5 and 7 to disk

      // storeA has 1 and 3 in memory, but the file has 5 and 7
      // reload() discards the unsaved in-memory state and picks up from disk
      expect(storeA.list()).toEqual(["1", "3"]); // before reload
      storeA.reload();
      expect(storeA.list()).toEqual(["5", "7"]); // after reload — disk wins
    });

    it("reload() returns true when a file existed and was loaded", () => {
      const store = newStore();
      store.add("99");

      const fresh = newStore();
      expect(fresh.reload()).toBe(true);
      expect(fresh.list()).toEqual(["99"]);
    });

    it("reload() returns false when no file exists", () => {
      const store = newStore();
      expect(store.reload()).toBe(false);
    });

    it("recovers from a corrupt file by renaming it and starting fresh", () => {
      const path = join(cwd, ".pi", "loops", "bindings-test-session.json");
      const store = new BindingsStore(path, "project");
      store.save(); // create the file first

      // Corrupt the file in place
      const fs = require("node:fs") as typeof import("node:fs");
      fs.writeFileSync(path, "{ not json");

      const reloaded = new BindingsStore(path, "project");
      expect(reloaded.load()).toBe(false);
      expect(reloaded.size()).toBe(0);

      // Original corrupt file was preserved under .corrupt.<ts>
      const entries = fs.readdirSync(join(cwd, ".pi", "loops"));
      expect(entries.some((name) => name.startsWith("bindings-test-session.json.corrupt."))).toBe(true);
    });

    it("list() returns sorted ids", () => {
      const store = newStore();
      store.add("9");
      store.add("1");
      store.add("5");
      expect(store.list()).toEqual(["1", "5", "9"]);
    });
  });

  describe("memory scope", () => {
    it("load() and save() are no-ops", () => {
      const store = new BindingsStore(undefined, "memory");
      expect(store.path).toBeUndefined();
      expect(store.fileExists()).toBe(false);
      expect(store.load()).toBe(false);

      // add() should not throw even though save() is a no-op
      store.add("1");
      expect(store.has("1")).toBe(true);
      expect(store.list()).toEqual(["1"]);
      expect(existsSync(join(cwd, ".pi", "loops", "bindings-test-session.json"))).toBe(false);
    });

    it("reload() is a no-op in memory scope — Set preserved", () => {
      const store = new BindingsStore(undefined, "memory");
      store.add("1");
      store.add("2");
      // reload() is a no-op in memory scope — Set stays intact
      expect(store.reload()).toBe(false);
      expect(store.list()).toEqual(["1", "2"]);
    });
  });

  describe("concurrent-session independence", () => {
    it("two bindings files in the same dir do not interfere", () => {
      const storeA = new BindingsStore(join(cwd, ".pi", "loops", "bindings-A.json"), "project");
      const storeB = new BindingsStore(join(cwd, ".pi", "loops", "bindings-B.json"), "project");

      storeA.add("1");
      storeA.add("5");
      storeB.add("3");
      storeB.add("7");

      expect(storeA.list()).toEqual(["1", "5"]);
      expect(storeB.list()).toEqual(["3", "7"]);

      // Reload both from disk to confirm isolation
      const reloadA = new BindingsStore(join(cwd, ".pi", "loops", "bindings-A.json"), "project");
      const reloadB = new BindingsStore(join(cwd, ".pi", "loops", "bindings-B.json"), "project");
      reloadA.load();
      reloadB.load();
      expect(reloadA.list()).toEqual(["1", "5"]);
      expect(reloadB.list()).toEqual(["3", "7"]);

      // Mutating A does not touch B
      reloadA.remove("1");
      expect(reloadB.has("1")).toBe(false);
    });
});
  describe("getOtherSessionBindingCounts", () => {
    it("returns empty map in memory scope", () => {
      const store = new BindingsStore(undefined, "memory");
      const counts = store.getOtherSessionBindingCounts();
      expect(counts.size).toBe(0);
    });

    it("aggregates counts from other sessions' binding files", () => {
      const dir = join(cwd, ".pi", "loops");
      mkdirSync(dir, { recursive: true });
      // Write two other-session binding files
      writeFileSync(join(dir, "bindings-session-a.json"), JSON.stringify({ loopIds: ["1", "2", "3"] }));
      writeFileSync(join(dir, "bindings-session-b.json"), JSON.stringify({ loopIds: ["1", "4"] }));
      const store = new BindingsStore(join(dir, "bindings-session-c.json"), "project");
      const counts = store.getOtherSessionBindingCounts();
      // Loop 1 is bound by 2 other sessions; loops 2, 3, 4 are bound by 1
      expect(counts.get("1")).toBe(2);
      expect(counts.get("2")).toBe(1);
      expect(counts.get("3")).toBe(1);
      expect(counts.get("4")).toBe(1);
    });

    it("skips corrupt other-session binding files", () => {
      const dir = join(cwd, ".pi", "loops");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "bindings-good.json"), JSON.stringify({ loopIds: ["1"] }));
      writeFileSync(join(dir, "bindings-bad.json"), "{ not valid json");
      const store = new BindingsStore(join(dir, "bindings-current.json"), "project");
      const counts = store.getOtherSessionBindingCounts();
      // Only the good file contributes
      expect(counts.get("1")).toBe(1);
      expect(counts.size).toBe(1);
    });

    it("skips other-session files with non-array loopIds", () => {
      const dir = join(cwd, ".pi", "loops");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "bindings-bad-shape.json"), JSON.stringify({ loopIds: "not-an-array" }));
      const store = new BindingsStore(join(dir, "bindings-current.json"), "project");
      const counts = store.getOtherSessionBindingCounts();
      expect(counts.size).toBe(0);
    });

    it("returns empty map when the directory cannot be read", () => {
      const store = new BindingsStore("/nonexistent/.pi/loops/bindings-x.json", "project");
      const counts = store.getOtherSessionBindingCounts();
      expect(counts.size).toBe(0);
    });
  });

  describe("corrupt-file recovery", () => {
    it("quarantines corrupt files and loads defaults", () => {
      const path = join(cwd, ".pi", "loops", "bindings-session.json");
      mkdirSync(join(cwd, ".pi", "loops"), { recursive: true });
      writeFileSync(path, "{ this is not json");
      const store = new BindingsStore(path, "project");
      const loaded = store.load();
      expect(loaded).toBe(false);
      expect(store.list()).toEqual([]);
      // The corrupt file should have been renamed to .corrupt.<ts>
      expect(existsSync(path)).toBe(false);
      const files = readdirSync(join(cwd, ".pi", "loops"));
      const quarantined = files.find((f) => f.startsWith("bindings-session.json.corrupt."));
      expect(quarantined).toBeDefined();
    });

    it("reload() forces a fresh load from disk", () => {
      const path = join(cwd, ".pi", "loops", "bindings-session.json");
      mkdirSync(join(cwd, ".pi", "loops"), { recursive: true });
      writeFileSync(path, JSON.stringify({ loopIds: ["1", "2"] }));
      const store = new BindingsStore(path, "project");
      store.load();
      expect(store.list()).toEqual(["1", "2"]);
      // Mutate external file
      writeFileSync(path, JSON.stringify({ loopIds: ["3", "4"] }));
      // reload() should pick up the new contents
      store.reload();
      expect(store.list()).toEqual(["3", "4"]);
    });
  });

  describe("path accessor", () => {
    it("exposes the configured file path", () => {
      const path = join(cwd, ".pi", "loops", "bindings-test.json");
      const store = new BindingsStore(path, "project");
      expect(store.path).toBe(path);
    });

    it("exposes undefined path in memory scope", () => {
      const store = new BindingsStore(undefined, "memory");
      expect(store.path).toBeUndefined();
    });
  });
});
