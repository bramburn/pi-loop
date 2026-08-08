This file is a merged representation of a subset of the codebase, containing specifically included files and files not matching ignore patterns, combined into a single document by Repomix.

# File Summary

## Purpose
This file contains a packed representation of a subset of the repository's contents that is considered the most important context.
It is designed to be easily consumable by AI systems for analysis, code review,
or other automated processes.

## File Format
The content is organized as follows:
1. This summary section
2. Repository information
3. Directory structure
4. Repository files (if enabled)
5. Multiple file entries, each consisting of:
  a. A header with the file path (## File: path/to/file)
  b. The full contents of the file in a code block

## Usage Guidelines
- This file should be treated as read-only. Any changes should be made to the
  original repository files, not this packed version.
- When processing this file, use the file path to distinguish
  between different files in the repository.
- Be aware that this file may contain sensitive information. Handle it with
  the same level of security as you would the original repository.

## Notes
- Some files may have been excluded based on .gitignore rules and Repomix's configuration
- Binary files are not included in this packed representation. Please refer to the Repository Structure section for a complete list of file paths, including binary files
- Only files matching these patterns are included: AGENTS.md, src/runtime/bindings-store.ts, src/runtime/scope.ts, src/runtime/session-runtime.ts, src/runtime/AGENTS.md, src/commands/loop-command.ts, src/commands/AGENTS.md, src/index.ts, src/store.ts, src/loop-reducer.ts, src/types.ts, docs/loop-governor-design.md, README.md, test/bindings-store.test.ts, test/session-runtime.test.ts, test/loop-resume-command.test.ts, test/loop-command.test.ts, test/scope.test.ts
- Files matching these patterns are excluded: node_modules/**, dist/**, coverage/**, .git/**
- Files matching patterns in .gitignore are excluded
- Files matching default ignore patterns are excluded
- Files are sorted by Git change count (files with more changes are at the bottom)

# Directory Structure
````
docs/
  loop-governor-design.md
src/
  commands/
    AGENTS.md
    loop-command.ts
  runtime/
    AGENTS.md
    bindings-store.ts
    scope.ts
    session-runtime.ts
  index.ts
  loop-reducer.ts
  store.ts
  types.ts
test/
  bindings-store.test.ts
  loop-command.test.ts
  loop-resume-command.test.ts
  scope.test.ts
  session-runtime.test.ts
AGENTS.md
README.md
````

# Files

## File: docs/loop-governor-design.md
````markdown
# Loop Governor + Per-Session Bindings — Design Note

> Embedded verbatim into the PR body at ship time. Captures the UX, file format, default behavior, and isolation invariant the user agreed to.

## Governor UX

**Row format**: `[x] #N [status] prompt (trigger)` where `[x]` reflects the current session's binding state (not just whether the trigger is armed in-process).

Examples:
- `[x] #1 [active] Check if the build passed (cron: */5 * * * *)`
- `[ ] #2 [active] Log the tool being used (event: tool_execution_start)`
- `[x] #3 [paused] Old reminder (cron: 0 9 * * 1-5)`

**Sentinels** at the bottom of the picker (after all loop rows):
- `< OK` — commit all pending toggles, write bindings file, apply triggerSystem.add/remove, exit
- `< Continue` — open `ui.confirm` with a diff preview; OK applies, Cancel returns to picker
- `< Cancel` — discard pending toggles, exit without writing

**Confirm dialog wording**:
- Title: `Apply changes?`
- Body: `Arm: #5, #9\nDisarm: #7` (or `No changes` if the user toggled nothing on Continue)

## Bindings file format

Per-session file at `<cwd>/.pi/loops/bindings-<sessionId>.json`:

```json
{
  "loopIds": ["1", "3", "7"]
}
```

Plain JSON, no atomic-write lock needed — single-owner file per session. Created lazily on first write. String IDs match the LoopStore's `entries: Map<string, LoopEntry>`.

## BindingsStore API

```ts
class BindingsStore {
  constructor(path: string | undefined, scope: LoopScope);
  load(): void;             // reads file into Set<string>; no-op if path undefined (memory scope)
  save(): void;             // writes current Set to file as {loopIds: string[]}; no-op if memory scope
  has(id: string): boolean; // O(1) check
  add(id: string): void;    // adds + saves immediately
  remove(id: string): void; // removes + saves immediately
  list(): string[];         // sorted snapshot
  clear(): void;            // empties + saves
  size(): number;
}
```

## Strict-isolation default

When `session-runtime.ts:showPersistedLoops()` runs on a fresh session (no bindings file), it:
1. Calls `bindingsStore.load()` → empty Set
2. Calls `bindingsStore.save()` → creates `{loopIds: []}` file
3. Sets `bindingsInitialized = true`
4. Emits one-time notify: `"No bindings for this session — run /loop-resume to choose which loops this terminal arms."` (info level)
5. Arms **zero** loops

On subsequent session_restart/turn_start, the file exists and is loaded silently with no notify.

This is a deliberate behavior change from prior versions, where every session armed every active loop on start. It is loud: AGENTS.md, README.md, and this PR body all call it out.

## Concurrent-session invariant

Two terminals in the same repo with different session IDs have independent bindings files:
- Terminal A (sessionId=`abc`) writes only `.pi/loops/bindings-abc.json`
- Terminal B (sessionId=`xyz`) writes only `.pi/loops/bindings-xyz.json`
- Each session's `session-runtime.ts:showPersistedLoops()` reads only its own bindings file
- Trigger subscriptions are process-local — Terminal A's `triggerSystem.add(#5)` does NOT cause Terminal B to fire `#5`
- The shared project store `.pi/loops/loops.json` is read by all sessions for the loop registry; writes (LoopCreate / LoopDelete / LoopUpdate) go through `LoopStore.withLock` which provides atomic write + stale-PID detection (existing behavior, unchanged)

Test invariant: simulate two sessions by instantiating two `LoopStore` + `BindingsStore` pairs in the same process; bind `#5` in session A; verify session B's `bindings.has("5") === false`.

## /loop-resume <id> one-shot path

```
/loop-resume 5
  → store.get("5")                          (must exist)
  → bindingsStore.add("5") + save()         (writes bindings-<sessionId>.json)
  → triggerSystem.add(entry)                (re-binds subscription if not already armed)
  → ui.notify("Loop #5 re-armed and bound to this session", "info")
  → return (one call, no picker)
```

## Governor commit path

```
Governor loops via ui.select:
  - User toggles rows → updates in-memory Set<string> pending
  - User picks < OK → pending applied: bindings.save + triggerSystem.add/remove per row; ui.notify summary; return
  - User picks < Continue → ui.confirm("Apply changes?", "Arm: #5, #9\nDisarm: #7")
      - OK → apply pending; ui.notify summary; return
      - Cancel → discard pending; return to picker
  - User picks < Cancel → discard pending; return
  - User picks Esc / undefined → discard pending; return

No store.status mutation anywhere in the governor path.
```
````

## File: src/runtime/bindings-store.ts
````typescript
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { LoopScope } from "./scope.js";

/**
 * Persists a per-session subset of loop IDs that THIS session has chosen
 * to arm. Each terminal/process owns its own bindings file at
 * `<cwd>/.pi/loops/bindings-<sessionId>.json`, so two terminals in the
 * same repo can arm disjoint subsets of the shared loop registry without
 * interfering. See design note at docs/loop-governor-design.md.
 *
 * File format:
 * ```json
 * { "loopIds": ["1", "3", "7"] }
 * ```
 *
 * String IDs match the LoopStore's `entries: Map<string, LoopEntry>`.
 *
 * In `memory` scope (path === undefined) the store is purely in-process —
 * load/save are no-ops and the Set survives only as long as the process.
 */

export interface BindingsData {
  loopIds: string[];
}

export class BindingsStore {
  private ids = new Set<string>();

  /**
   * The sessionId associated with this BindingsStore. Set at construction
   * time (via setSessionId in index.ts) or mutated directly by tests.
   * Used by the Governor to partition loops into "My loops"
   * (createdBy === sessionId) and "Other terminals"
   * (createdBy !== sessionId or undefined).
   */
  sessionId: string | undefined;

  /**
   * Construct a bindings store.
   *
   * @param filePath  Absolute path to the bindings JSON file, or undefined
   *                  for in-memory mode (PI_LOOP_SCOPE=memory).
   * @param scope     Loop scope — currently only `memory` suppresses file I/O.
   * @param sessionId The sessionId this store belongs to (used for Governor
   *                  loop-partitioning by creation session).
   */
  constructor(
    private readonly filePath: string | undefined,
    private readonly scope: LoopScope,
    sessionId?: string,
  ) {
    this.sessionId = sessionId;
  }

  /**
   * Force a reload from disk, discarding any unsaved in-memory changes.
   * Unlike `load()` which may be a no-op when no backing file exists,
   * `reload()` always empties the in-memory Set first and then calls `load()`,
   * so callers can be certain the Set reflects the current file state.
   * No-op in memory scope (path === undefined) — nothing to reload from.
   */
  reload(): boolean {
    if (!this.filePath) return false;
    this.ids = new Set();
    return this.load();
  }

  // ── File I/O ──

  /** Returns true if a backing file exists at the configured path. */
  fileExists(): boolean {
    return this.filePath !== undefined && existsSync(this.filePath);
  }

  /**
   * Read the backing file into the in-memory Set. No-op if path is undefined
   * (memory scope). On parse failure, the corrupt file is preserved as
   * `<path>.corrupt.<timestamp>` and the Set stays empty (mirrors the
   * LoopStore's G-25 recovery behavior).
   *
   * @returns true if a backing file existed and was loaded (or quarantined);
   *          false if there was no file (fresh session) or path is undefined.
   */
  load(): boolean {
    if (!this.filePath) return false;
    if (!existsSync(this.filePath)) return false;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf-8")) as BindingsData;
      this.ids = new Set(Array.isArray(data.loopIds) ? data.loopIds.map(String) : []);
      return true;
    } catch {
      // Corrupt file — preserve for forensic recovery (matches LoopStore G-25)
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt.${Date.now()}`);
      } catch { /* ignore rename failure */ }
      this.ids = new Set();
      return false;
    }
  }

  /**
   * Atomic-write the current Set to the backing file as
   * `{ "loopIds": ["<id>", ...] }` (sorted). No-op if path is undefined.
   * Uses the standard tmp-write + rename pattern from ReducerBackedStore.
   */
  save(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const data: BindingsData = { loopIds: this.list() };
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  // ── Mutators (each persists immediately) ──

  /** O(1) check. */
  has(id: string): boolean {
    return this.ids.has(String(id));
  }

  /** Add an id and persist. Idempotent. */
  add(id: string): void {
    const key = String(id);
    if (this.ids.has(key)) return;
    this.ids.add(key);
    this.save();
  }

  /** Remove an id and persist. Idempotent. */
  remove(id: string): void {
    const key = String(id);
    if (!this.ids.has(key)) return;
    this.ids.delete(key);
    this.save();
  }

  /** Empty the Set and persist. */
  clear(): void {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this.save();
  }

  // ── Accessors ──

  /** Sorted snapshot of bound loop IDs. */
  list(): string[] {
    return Array.from(this.ids).sort((a, b) => Number(a) - Number(b));
  }

  size(): number {
    return this.ids.size;
  }

  /** For diagnostics — the path passed at construction. */
  get path(): string | undefined {
    return this.filePath;
  }

  /** For diagnostics — the scope passed at construction. */
  get loopScope(): LoopScope {
    return this.scope;
  }

  /**
   * Scans all bindings files in the same directory as this BindingsStore's
   * file (i.e. `.pi/loops/bindings-*.json`) and returns a Map from loopId
   * → count of OTHER sessions that have the loop bound.
   *
   * Used by the Governor to annotate each row with a hint like
   * "bound in 2 other sessions", helping the user distinguish loops
   * created/armed by other terminals in project scope.
   *
   * No-op in memory scope (path === undefined) or if the directory cannot
   * be read; returns an empty Map.
   */
  getOtherSessionBindingCounts(): Map<string, number> {
    if (!this.filePath) return new Map();
    const dir = dirname(this.filePath);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.startsWith("bindings-") && f.endsWith(".json"));
    } catch {
      return new Map();
    }
    const counts = new Map<string, number>();
    for (const file of files) {
      if (file === basename(this.filePath)) continue; // skip current session's own file
      try {
        const data = JSON.parse(readFileSync(`${dir}/${file}`, "utf-8")) as BindingsData;
        for (const id of Array.isArray(data.loopIds) ? data.loopIds : []) {
          counts.set(String(id), (counts.get(String(id)) ?? 0) + 1);
        }
      } catch {
        // Skip unreadable/corrupt files — not our concern here
      }
    }
    return counts;
  }
}
````

## File: test/bindings-store.test.ts
````typescript
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});
````

## File: test/loop-resume-command.test.ts
````typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerLoopCommand } from "../src/commands/loop-command.js";
import { LoopStore } from "../src/store.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const { pi, commandMap } = createMockPi();
  const store = new LoopStore(); // memory mode, no file I/O
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const updateWidget = vi.fn();
  registerLoopCommand({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    updateWidget,
  });
  const resume = commandMap.get("loop-resume");
  if (!resume) throw new Error("/loop-resume command not registered");
  return { store, triggerSystem, updateWidget, resume: resume.handler as (args: string, ctx: any) => Promise<void> };
}

async function createPausedLoop(store: LoopStore, prompt = "check deploy"): Promise<string> {
  const entry = store.create({ type: "cron", schedule: "*/5 * * * *" }, prompt, { recurring: true });
  store.pause(entry.id);
  return entry.id;
}

describe("registerLoopCommand — /loop-resume", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("registers /loop-resume alongside /loop", () => {
    // sanity: setup already asserts this; reaffirm at the suite level
    expect(h.resume).toBeInstanceOf(Function);
  });

  it("re-arms a stored loop by id and re-adds the trigger subscription", async () => {
    const id = await createPausedLoop(h.store);
    const ctx = createCtx();

    await h.resume(id, ctx);

    const entry = h.store.get(id);
    expect(entry?.status).toBe("active");
    expect(h.triggerSystem.add).toHaveBeenCalledWith(entry);
    expect(h.updateWidget).toHaveBeenCalled();
    expect(ctx.notifications[0].message).toContain(`Loop #${id}`);
  });

  it("is idempotent for already-active loops (re-armed without status transition)", async () => {
    const entry = h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "active loop", { recurring: true });
    const beforeStatus = entry.status;
    const ctx = createCtx();

    await h.resume(entry.id, ctx);

    expect(h.store.get(entry.id)?.status).toBe(beforeStatus);
    expect(h.triggerSystem.add).toHaveBeenCalled();
    expect(ctx.notifications[0].message).toContain(`Loop #${entry.id}`);
    expect(ctx.notifications[0].message).toContain("re-armed");
  });

  it("reports an error when the loop id does not exist", async () => {
    const ctx = createCtx();

    await h.resume("999", ctx);

    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.updateWidget).not.toHaveBeenCalled();
    expect(ctx.notifications[0]).toEqual({
      level: "error",
      message: expect.stringContaining("Loop #999 not found"),
    });
  });

  it("rejects non-numeric loop ids with a notify error", async () => {
    const ctx = createCtx();

    await h.resume("abc", ctx);

    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(ctx.notifications[0].level).toBe("error");
    expect(ctx.notifications[0].message).toContain("Expected a numeric loop ID");
  });

  it("with no args opens a picker listing stored loops and re-arms the chosen one", async () => {
    const id1 = await createPausedLoop(h.store, "first");
    await createPausedLoop(h.store, "second");
    const ui = {
      select: vi.fn(async () => `- #${id1} [paused] first (cron: */5 * * * *)`),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.resume("", ctx);

    expect(ui.select).toHaveBeenCalledWith("Re-arm which loop?", expect.any(Array));
    expect(h.store.get(id1)?.status).toBe("active");
    expect(h.triggerSystem.add).toHaveBeenCalled();
  });

  it("with no args and an empty store notifies and skips the picker", async () => {
    const notifications: Array<{ message: string; level?: string }> = [];
    const ctx = {
      ui: {
        select: vi.fn(),
        input: vi.fn(),
        notify: (message: string, level?: string) => notifications.push({ message, level }),
      },
    } as any;

    await h.resume("", ctx);

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(notifications[0]).toEqual({
      level: "info",
      message: expect.stringContaining("No stored loops to re-arm"),
    });
  });

  it("with no args honours the < Back picker sentinel without re-arming", async () => {
    const id = await createPausedLoop(h.store);
    const ui = {
      select: vi.fn(async () => "< Back"),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.resume("", ctx);

    expect(h.store.get(id)?.status).toBe("paused");
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
  });

  it("accepts the first whitespace-separated token as the loop id", async () => {
    const id = await createPausedLoop(h.store);
    const ctx = createCtx();

    await h.resume(`${id} trailing junk`, ctx);

    expect(h.store.get(id)?.status).toBe("active");
    expect(h.triggerSystem.add).toHaveBeenCalled();
  });
});
````

## File: test/scope.test.ts
````typescript
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLoopStorePath, resolveTaskStorePath, type ScopeOptions } from "../src/runtime/scope.js";

const CWD = "/tmp/pi-loop-scope";

function opts(overrides: Partial<ScopeOptions> = {}): ScopeOptions {
  return { loopScope: "session", cwd: CWD, ...overrides };
}

describe("resolveLoopStorePath", () => {
  it("returns undefined when PI_LOOP env is 'off'", () => {
    expect(resolveLoopStorePath(opts({ piLoopEnv: "off" }), "s1")).toBeUndefined();
  });

  it("uses an absolute PI_LOOP env path verbatim", () => {
    expect(resolveLoopStorePath(opts({ piLoopEnv: "/custom/loops.json" }), "s1")).toBe("/custom/loops.json");
  });

  it("resolves a relative PI_LOOP env path against cwd", () => {
    expect(resolveLoopStorePath(opts({ piLoopEnv: "./loops.json" }))).toBe(resolve("./loops.json"));
  });

  it("uses a bare PI_LOOP env value as-is", () => {
    expect(resolveLoopStorePath(opts({ piLoopEnv: "named-store" }), "s1")).toBe("named-store");
  });

  it("returns undefined for memory scope", () => {
    expect(resolveLoopStorePath(opts({ loopScope: "memory" }), "s1")).toBeUndefined();
  });

  it("returns a session-scoped path when a sessionId is present", () => {
    expect(resolveLoopStorePath(opts({ loopScope: "session" }), "abc")).toBe(
      join(CWD, ".pi", "loops", "loops-abc.json"),
    );
  });

  it("returns undefined for session scope without a sessionId", () => {
    expect(resolveLoopStorePath(opts({ loopScope: "session" }))).toBeUndefined();
  });

  it("returns the shared project path for project scope", () => {
    expect(resolveLoopStorePath(opts({ loopScope: "project" }), "abc")).toBe(
      join(CWD, ".pi", "loops", "loops.json"),
    );
  });

  it("PI_LOOP env takes precedence over scope", () => {
    expect(resolveLoopStorePath(opts({ loopScope: "memory", piLoopEnv: "/x.json" }))).toBe("/x.json");
  });
});

describe("resolveTaskStorePath", () => {
  it("returns undefined for memory scope", () => {
    expect(resolveTaskStorePath(opts({ loopScope: "memory" }), "s1")).toBeUndefined();
  });

  it("returns a session-scoped path when a sessionId is present", () => {
    expect(resolveTaskStorePath(opts({ loopScope: "session" }), "abc")).toBe(
      join(CWD, ".pi", "tasks", "tasks-abc.json"),
    );
  });

  it("returns undefined for session scope without a sessionId", () => {
    expect(resolveTaskStorePath(opts({ loopScope: "session" }))).toBeUndefined();
  });

  it("returns the shared project path for project scope", () => {
    expect(resolveTaskStorePath(opts({ loopScope: "project" }), "abc")).toBe(
      join(CWD, ".pi", "tasks", "tasks.json"),
    );
  });

  it("ignores PI_LOOP env (task path is scope-only)", () => {
    expect(resolveTaskStorePath(opts({ loopScope: "project", piLoopEnv: "/x.json" }), "abc")).toBe(
      join(CWD, ".pi", "tasks", "tasks.json"),
    );
  });
});
````

## File: src/commands/AGENTS.md
````markdown
# `src/commands/` — Slash Commands

Slash commands are the agent-facing menu surface, registered via `pi.registerCommand("name", handler)`. They complement the tool surface with interactive `ui.select` / `ui.input` flows.

## Files

- `loop-command.ts` — `/loop [interval] [prompt]` and the interactive top-level menu. Also registers `/loop-resume <id>` (one-shot: re-arms AND writes the bindings file in one call) and `/loop-resume` (no args: opens the governor picker with checkbox rows reflecting per-session binding state, sentinels `< OK` / `< Continue` / `< Cancel`).
- `tasks-command.ts` — `/tasks [subject]` and the native task viewer.
- `monitors-command.ts` — `/monitors` for managing background processes.

## Conventions

- **Bare invocation shows a menu** — `/loop` and `/tasks` (no args) show a top-level menu. `/monitors` always shows the list. The menu pattern is the same: `ui.select("Title", ["Option 1", "Option 2", "< Back"])`.
- **`< Back` is a sentinel** — the actions list for a selected item always includes `< Back` to return to the previous menu. `ui.select` returning `undefined` or `< Back` short-circuits the action.
- **Trim args before interpreting** — `args.trim()` then check `!trimmed` for the menu case.
- **Recursion for navigation** — `viewX(ui)` calls itself after an action so the user can navigate multiple items without returning to the menu.
- **Notify, don't return** — commands communicate results via `ui.notify(level, msg)` rather than returning a value. The handler returns void.
- **Don't tie command UX to tool UX** — commands can have their own copy and flow that differs from the tool descriptions.

## Cross-cutting concerns

- The commands share store references via the `getXxx()` getters passed in `LoopCommandOptions` / `TasksCommandOptions` / `MonitorsCommandOptions`. This is the same pattern the tools use.
- `updateWidget()` is called after every mutation so the status bar reflects the new state.
- The native tasks command is only registered when `pi-tasks` is absent (after the 6s fallback window). Don't assume it's always present.

## When adding a new command

1. Create a new file with `registerXxxCommand(options)` that takes the extension API and the resources it needs
2. The handler signature is `async (args: string, ctx: ExtensionCommandContext) => void`
3. The command description goes to the LLM as part of the slash-command help — keep it under 100 chars
4. Add tests in `test/<command>-command.test.ts` that mock the UI (`select`, `notify`, `input`) and assert on the calls
5. If the command mirrors a tool, consider whether the user could do the same thing with the tool — prefer the tool for programmatic use, the command for human-driven exploration

## See also

- `src/AGENTS.md` — core types and stores
- `src/tools/AGENTS.md` — tool counterpart
- `src/runtime/AGENTS.md` — runtimes the commands call into
````

## File: src/runtime/AGENTS.md
````markdown
# `src/runtime/` — Long-Running Behaviour

Runtimes coordinate behaviour that crosses tool/command boundaries: session lifecycle, notification delivery, monitor-completion wakes, task backlog, and the pi-tasks RPC bridge.

## Files

- `session-runtime.ts` — `registerSessionRuntimeHooks` wires `turn_start`, `before_agent_start`, `agent_start`, `agent_end`, `session_shutdown`, `session_switch`, and `tool_execution_end` (for git-commit pruning). Also runs the 30s `HEARTBEAT_MS` interval that pumps `CronScheduler`.
- `notification-runtime.ts` — Buffers loop fires until the agent is idle, then delivers them via `pi.sendMessage({ deliverAs: "steer", triggerTurn: true })`. Uses a coordinator with a `NOTIFICATION_RUNTIME_UPDATED` reducer so flush + idle checks are atomic.
- `task-backlog-runtime.ts` — Owns the auto task worker loop (`AUTO_TASK_WORKER_PROMPT`) lifecycle. Threshold is `AUTO_TASK_WORKER_THRESHOLD` (5) and is overridable via the `PI_LOOP_TASK_THRESHOLD` env var.
- `task-rpc.ts` — Bridges native task tools to `@tintinweb/pi-tasks` over the event bus when pi-tasks is loaded.
- `task-events.ts` — Defines `emitNativeTaskEvent` for the `tasks:*` family of events.
- `monitor-ondone-runtime.ts` — Wires `MonitorManager.onComplete` callbacks to `LoopStore.delete` so the one-shot `monitor:done` wake loop is cleaned up after delivery.
- `scope.ts` — `resolveLoopStorePath` and `resolveTaskStorePath` based on `PI_LOOP_SCOPE` and `PI_LOOP` env vars. Default scope is `project` so loops and tasks persist across sessions under `.pi/loops/loops.json` and `.pi/tasks/tasks.json` (mirrors pi-goal-x's `.pi/goals/` pattern).
- `bindings-store.ts` — `BindingsStore` class for per-session loop bindings. Persists `{loopIds: string[]}` at `.pi/loops/bindings-<sessionId>.json` so multiple pi terminals in the same repo can arm disjoint subsets. Atomic write via tmp + rename; corrupt-file recovery via `.corrupt.<ts>` rename (mirrors G-25).

## Conventions

- **Coordinators, not raw promises** — the runtimes that have multi-step state (notification, task backlog, monitor on-done) all use `createCoordinator` with a reducer + effect handlers. Don't reach for `Promise.all` / ad-hoc `await` chains when you can express the flow as reducer events.
- **Lock ordering** — never invoke `triggerSystem.remove(id)` from inside a `LoopStore.withLock()` body. `expireEventLoops` / `clearExpired` / `clearAll` collect removed IDs and invoke `onLoopRemoved` *after* releasing the lock to avoid deadlocks (closed G-06/G-07).
- **30s heartbeat** — `HEARTBEAT_MS` is wall-clock. Without it, a loop whose fire time elapses while the agent is idle would never fire. The timer is `unref()`-ed so `pi -p` (one-shot) can exit.

## Cross-cutting concerns

- The `agent_end` hook is the *only* place where buffered loop wakes are delivered and the task backlog is cleaned up. Do not call `flushPendingNotifications` or `cleanupTaskBacklogLoops` from anywhere else.
- The `tool_execution_end` handler triggers `cleanDoneTasks` on `git commit`. This is a heuristic — false positives will sweep tasks the user didn't intend to prune.

## See also

- `src/AGENTS.md` — core types and stores
- `src/tools/AGENTS.md` — tools that call into runtimes
- `userflow/notification-coordinator.md` — notification flow walkthrough
````

## File: src/runtime/scope.ts
````typescript
import { join, resolve } from "node:path";

export type LoopScope = "memory" | "session" | "project";

export interface ScopeOptions {
  piLoopEnv?: string;
  loopScope: LoopScope;
  taskScope?: LoopScope;
  cwd?: string;
}

export function resolveLoopStorePath(options: ScopeOptions, sessionId?: string): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  const { piLoopEnv, loopScope } = options;

  if (piLoopEnv === "off") return undefined;
  if (piLoopEnv?.startsWith("/")) return piLoopEnv;
  if (piLoopEnv?.startsWith(".")) return resolve(piLoopEnv);
  if (piLoopEnv) return piLoopEnv;
  if (loopScope === "memory") return undefined;
  if (loopScope === "session" && sessionId) {
    return join(cwd, ".pi", "loops", `loops-${sessionId}.json`);
  }
  if (loopScope === "session") return undefined;
  return join(cwd, ".pi", "loops", "loops.json");
}

export function resolveTaskStorePath(options: ScopeOptions, sessionId?: string): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  const { taskScope = options.loopScope } = options;

  if (taskScope === "memory") return undefined;
  if (taskScope === "session" && sessionId) {
    return join(cwd, ".pi", "tasks", `tasks-${sessionId}.json`);
  }
  if (taskScope === "session") return undefined;
  return join(cwd, ".pi", "tasks", "tasks.json");
}

/**
 * Resolves the per-session loop-bindings file. In project scope (default)
 * this lives at `<cwd>/.pi/loops/bindings-<sessionId>.json`. In session scope
 * the file lives at the same path (no conflict — each sessionId is unique).
 * In memory scope returns undefined and the BindingsStore stays in-process.
 *
 * Concurrent sessions on the same repo each get their own file because the
 * sessionId is embedded in the filename — no shared-state contention.
 */
export function resolveBindingsPath(options: ScopeOptions, sessionId?: string): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  const { loopScope } = options;

  if (loopScope === "memory") return undefined;
  if (!sessionId) return undefined;
  return join(cwd, ".pi", "loops", `bindings-${sessionId}.json`);
}
````

## File: test/session-runtime.test.ts
````typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSessionRuntimeHooks, type SessionRuntimeOptions } from "../src/runtime/session-runtime.js";
import { LoopStore } from "../src/store.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

function setup(overrides: Partial<SessionRuntimeOptions> = {}) {
  const { pi, extensionHandlers } = createMockPi();
  const scheduler = { nextFire: vi.fn(() => undefined), pump: vi.fn() };
  const store: LoopStore =
    "store" in overrides && overrides.store instanceof LoopStore
      ? (overrides.store as LoopStore)
      : new LoopStore();
  const options: SessionRuntimeOptions = {
    pi,
    getLoopScope: () => "memory",
    getPiLoopEnv: () => undefined,
    recreateSessionStore: vi.fn(),
    clearAllLoops: vi.fn(),
    getStore: () => store as any,
    getScheduler: () => scheduler as any,
    getTriggerSystem: () => ({ start: vi.fn(), stop: vi.fn() }),
    setLatestCtx: vi.fn(),
    setSessionId: vi.fn(),
    widget: { setUICtx: vi.fn(), update: vi.fn() },
    getLoopSnapshots: vi.fn(() => store.list().map(() => ({ id: "1", status: "active" as const, hasDynamic: false, isTaskBacklog: false, hasWorkflow: false }))),
    notificationRuntime: {
      syncRuntimeState: vi.fn(),
      queueOrDeliverNotification: vi.fn(async () => {}),
      queueOrDeliverMonitorStarted: vi.fn(async () => {}),
      discardMonitorStarted: vi.fn(),
      flushPendingNotifications: vi.fn(async () => {}),
      clear: vi.fn(),
    },
    flushPendingNotifications: vi.fn(async () => {}),
    migrateTaskBacklogLoops: vi.fn(() => 0),
    cleanupTaskBacklogLoops: vi.fn(async () => 0),
    adoptTaskBacklogLoops: vi.fn(async () => 0),
    releaseTaskBacklogWakes: vi.fn(),
    hasPendingTasks: vi.fn(async () => 0),
    cleanDoneTasks: vi.fn(async () => {}),
    showLoopListOverlayFn: vi.fn(async () => undefined),
    showEscapeDialogFn: vi.fn(async () => "continue" as const),
    ...overrides,
  };
  // Don't double-pass store/getStore/showLoopListOverlayFn/showEscapeDialogFn
  if (!("store" in overrides)) delete (options as { store?: unknown }).store;
  registerSessionRuntimeHooks(options);
  let lastCtx = createCtx();
  const drive = async (name: string) => {
    for (const handler of extensionHandlers.get(name) ?? []) {
      lastCtx = createCtx();
      await handler(null, lastCtx);
    }
  };
  return {
    scheduler,
    drive,
    ctxForDrive: () => lastCtx,
  };
}

describe("session-runtime heartbeat lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("starts an unref'd heartbeat interval on turn_start", async () => {
    const unref = vi.fn();
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue({ unref } as any);

    const { drive } = setup();
    await drive("turn_start");

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(30000);
    expect(unref).toHaveBeenCalledTimes(1); // never keeps a `pi -p` process alive
  });

  it("migrates persisted backlog prompts before starting loop triggers", async () => {
    const calls: string[] = [];
    const migrateTaskBacklogLoops = vi.fn(() => {
      calls.push("migrate");
      return 1;
    });
    const triggerSystem = {
      start: vi.fn(() => calls.push("start")),
      stop: vi.fn(),
    };
    const { drive } = setup({
      migrateTaskBacklogLoops,
      getStore: () => ({
        list: () => [{ id: "8", status: "active" }],
        clearExpired: vi.fn(),
        expireEventLoops: vi.fn(),
      }) as any,
      getTriggerSystem: () => triggerSystem,
    });

    await drive("session_start");

    expect(migrateTaskBacklogLoops).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["migrate", "start"]);
  });

  it("repaints the widget on session_start after the harness resets extension UI", async () => {
    const widget = { setUICtx: vi.fn(), update: vi.fn() };
    const setSessionId = vi.fn();
    const { drive } = setup({ widget, setSessionId });

    await drive("session_start");

    expect(setSessionId).toHaveBeenCalledWith("test-session");
    expect(widget.setUICtx).toHaveBeenCalledTimes(1);
    expect(widget.update).toHaveBeenCalledTimes(1);
  });

  it("binds the destination session during session_switch", async () => {
    const setSessionId = vi.fn();
    const { drive } = setup({ setSessionId });

    await drive("session_switch");

    expect(setSessionId.mock.calls).toEqual([[undefined], ["test-session"]]);
  });

  it("repaints the widget on heartbeat to recover an externally cleared status", async () => {
    vi.useFakeTimers();
    const widget = { setUICtx: vi.fn(), update: vi.fn() };
    const { drive } = setup({ widget });

    await drive("turn_start");
    widget.update.mockClear();
    await vi.advanceTimersByTimeAsync(30000);

    expect(widget.update).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — does not start a second interval across turn boundaries", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue({ unref: vi.fn() } as any);

    const { drive } = setup();
    await drive("before_agent_start");
    await drive("turn_start");
    await drive("turn_start");

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the heartbeat on session_shutdown", async () => {
    const timer = { unref: vi.fn() };
    vi.spyOn(global, "setInterval").mockReturnValue(timer as any);
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const { drive } = setup();
    await drive("turn_start");
    await drive("session_shutdown");

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });

  it("does not leak an unhandled rejection when a heartbeat pump throws", async () => {
    vi.useFakeTimers();
    const scheduler = {
      nextFire: vi.fn(() => undefined),
      pump: vi.fn(() => {
        throw new Error("pump boom");
      }),
    };
    const widget = { setUICtx: vi.fn(), update: vi.fn() };
    const { drive } = setup({ getScheduler: () => scheduler as any, widget });

    // before_agent_start starts the heartbeat without itself calling pumpLoops.
    await drive("before_agent_start");
    widget.update.mockClear();
    // Fire one heartbeat tick → its pumpLoops() rejects. With the `.catch`, this
    // is swallowed; without it, vitest fails the test on the unhandled rejection.
    await vi.advanceTimersByTimeAsync(30000);

    expect(scheduler.pump).toHaveBeenCalled();
    expect(widget.update).toHaveBeenCalledTimes(1);
  });
});

describe("session-runtime keybindings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("Ctrl+Shift+L opens the loop list overlay and returns { consume: true }", async () => {
    const showLoopListOverlayFn = vi.fn(async () => undefined);
    const showEscapeDialogFn = vi.fn(async () => "continue" as const);
    const { drive, ctxForDrive } = setup({ showLoopListOverlayFn, showEscapeDialogFn });
    await drive("session_start");
    const handlers = ctxForDrive().terminalInputs;
    expect(handlers.length).toBeGreaterThan(0);
    const handler = handlers[handlers.length - 1]!;
    const result = handler("ctrl+shift+l");
    expect(result?.consume).toBe(true);
    expect(showLoopListOverlayFn).toHaveBeenCalled();
  });

  it("Escape without active loops is NOT consumed (returns undefined)", async () => {
    const showLoopListOverlayFn = vi.fn(async () => undefined);
    const showEscapeDialogFn = vi.fn(async () => "continue" as const);
    const { drive, ctxForDrive } = setup({ showLoopListOverlayFn, showEscapeDialogFn });
    await drive("session_start");
    const handlers = ctxForDrive().terminalInputs;
    const handler = handlers[handlers.length - 1]!;
    const result = handler("escape");
    expect(result).toBeUndefined();
  });

  it("Escape with active loops IS consumed and shows the dialog", async () => {
    const showLoopListOverlayFn = vi.fn(async () => undefined);
    const showEscapeDialogFn = vi.fn(async () => "continue" as const);
    const store = new LoopStore();
    store.create({ type: "cron", schedule: "*/5 * * * *" }, "active loop", { recurring: true });
    const { drive, ctxForDrive } = setup({ store, showLoopListOverlayFn, showEscapeDialogFn });
    await drive("session_start");
    const handlers = ctxForDrive().terminalInputs;
    const handler = handlers[handlers.length - 1]!;
    const result = handler("escape");
    expect(result?.consume).toBe(true);
    expect(showEscapeDialogFn).toHaveBeenCalled();
  });

  it("session_shutdown unregisters the terminal input handler", async () => {
    const showLoopListOverlayFn = vi.fn(async () => undefined);
    const showEscapeDialogFn = vi.fn(async () => "continue" as const);
    const { drive, ctxForDrive } = setup({ showLoopListOverlayFn, showEscapeDialogFn });
    await drive("session_start");
    const handlers = ctxForDrive().terminalInputs;
    expect(handlers.length).toBeGreaterThan(0);
    await drive("session_shutdown");
    expect(handlers.length).toBe(0);
  });
});
````

## File: src/loop-reducer.ts
````typescript
import type { DynamicLoopState, LoopEntry, Trigger, WorkflowDefinition } from "./types.js";
import { createWorkflowRun, transitionWorkflowRun } from "./workflow-reducer.js";

export const MAX_LOOP_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a loop has reached its fire cap. Single source of truth for the
 * `maxFires` check shared by the fire callbacks (`onLoopFire` pre-fire guard and
 * `TriggerSystem.fireLoop` post-fire cleanup). Each caller keeps its own timing;
 * only the predicate is shared.
 */
export function atMaxFires(loop: Pick<LoopEntry, "maxFires" | "fireCount">): boolean {
  return !!loop.maxFires && (loop.fireCount ?? 0) >= loop.maxFires;
}

type ReducerSource = "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";

export interface LoopReducerState {
  nextId: number;
  loopsById: Record<string, LoopEntry>;
}

export type LoopReducerEvent =
  | {
    type: "LOOP_CREATED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      prompt: string;
      trigger: Trigger;
      recurring: boolean;
      autoTask?: boolean;
      taskBacklog?: boolean;
      readOnly?: boolean;
      maxFires?: number;
      dynamic?: Partial<DynamicLoopState>;
      workflow?: WorkflowDefinition;
    };
  }
  | {
    type:
      | "LOOP_PAUSED"
      | "LOOP_RESUMED"
      | "LOOP_FIRED"
      | "LOOP_DELETED"
      | "LOOP_MAX_FIRES_REACHED"
      | "LOOP_BACKLOG_EMPTY";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: { id: string };
  }
  | {
    type: "LOOP_EXPIRED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      id: string;
      reason: "expires_at" | "resume_event_stale" | "already_completed_monitor";
    };
  }
  | {
    type: "LOOP_DYNAMIC_UPDATED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      id: string;
      prompt?: string;
      dynamic: Partial<DynamicLoopState>;
    };
  }
  | {
    type: "LOOP_WORKFLOW_TRANSITION";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      id: string;
      outcome: string;
      evidence?: string;
      activeTaskId?: string;
    };
  }
  | {
    type: "LOOP_WORKFLOW_TASK_SET";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: { id: string; taskId?: string };
  };

export type LoopReducerEffect =
  | {
    type: "PERSIST_LOOP";
    entityType: "loop";
    entityId: string;
    payload: { loop: LoopEntry };
  }
  | {
    type: "DELETE_LOOP";
    entityType: "loop";
    entityId: string;
    payload: { id: string };
  };

export interface LoopReduceResult {
  state: LoopReducerState;
  effects: LoopReducerEffect[];
}

function cloneState(state: LoopReducerState): LoopReducerState {
  return {
    nextId: state.nextId,
    loopsById: { ...state.loopsById },
  };
}

export function reduceLoopState(state: LoopReducerState, event: LoopReducerEvent): LoopReduceResult {
  if (event.type === "LOOP_CREATED") {
    const next = cloneState(state);
    const id = String(next.nextId++);
    const loop: LoopEntry = {
      id,
      prompt: event.payload.prompt,
      trigger: event.payload.trigger,
      status: "active",
      recurring: event.payload.recurring,
      createdAt: event.at,
      updatedAt: event.at,
      expiresAt: event.at + MAX_LOOP_EXPIRY_MS,
      autoTask: event.payload.autoTask,
      taskBacklog: event.payload.taskBacklog,
      readOnly: event.payload.readOnly,
      maxFires: event.payload.maxFires,
      fireCount: 0,
      dynamic: event.payload.trigger.type === "dynamic" || event.payload.dynamic
        ? {
            goal: event.payload.dynamic?.goal ?? event.payload.prompt,
            state: event.payload.dynamic?.state,
            metrics: event.payload.dynamic?.metrics,
            doneCriteria: event.payload.dynamic?.doneCriteria,
            iteration: event.payload.dynamic?.iteration ?? 0,
            nextWakeAt: event.payload.dynamic?.nextWakeAt,
            awaitingUpdate: event.payload.dynamic?.awaitingUpdate ?? false,
            lastUpdatedAt: event.payload.dynamic?.lastUpdatedAt ?? event.at,
          }
        : undefined,
      workflow: event.payload.workflow ? createWorkflowRun(event.payload.workflow, event.at) : undefined,
    };
    next.loopsById[id] = loop;
    return {
      state: next,
      effects: [{ type: "PERSIST_LOOP", entityType: "loop", entityId: id, payload: { loop } }],
    };
  }

  const id = event.payload.id;
  const current = state.loopsById[id];
  if (!current) return { state, effects: [] };

  if (
    event.type === "LOOP_DELETED"
    || event.type === "LOOP_MAX_FIRES_REACHED"
    || event.type === "LOOP_EXPIRED"
    || event.type === "LOOP_BACKLOG_EMPTY"
  ) {
    const next = cloneState(state);
    delete next.loopsById[id];
    return {
      state: next,
      effects: [{ type: "DELETE_LOOP", entityType: "loop", entityId: id, payload: { id } }],
    };
  }

  const next = cloneState(state);
  const loop: LoopEntry = { ...current };

  if (event.type === "LOOP_PAUSED") {
    loop.status = "paused";
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_RESUMED") {
    loop.status = "active";
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_FIRED") {
    loop.fireCount = (loop.fireCount ?? 0) + 1;
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_DYNAMIC_UPDATED") {
    loop.prompt = event.payload.prompt ?? loop.prompt;
    loop.dynamic = {
      goal: event.payload.dynamic.goal ?? loop.dynamic?.goal ?? loop.prompt,
      state: event.payload.dynamic.state ?? loop.dynamic?.state,
      metrics: event.payload.dynamic.metrics ?? loop.dynamic?.metrics,
      doneCriteria: event.payload.dynamic.doneCriteria ?? loop.dynamic?.doneCriteria,
      iteration: event.payload.dynamic.iteration ?? loop.dynamic?.iteration ?? 0,
      nextWakeAt: "nextWakeAt" in event.payload.dynamic ? event.payload.dynamic.nextWakeAt : loop.dynamic?.nextWakeAt,
      awaitingUpdate: event.payload.dynamic.awaitingUpdate ?? loop.dynamic?.awaitingUpdate ?? false,
      lastUpdatedAt: event.payload.dynamic.lastUpdatedAt ?? event.at,
    };
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_WORKFLOW_TRANSITION") {
    if (!loop.workflow) return { state, effects: [] };
    const result = transitionWorkflowRun(loop.workflow, {
      outcome: event.payload.outcome,
      evidence: event.payload.evidence,
      activeTaskId: event.payload.activeTaskId,
    }, event.at);
    if (!result.applied) return { state, effects: [] };
    loop.workflow = result.run;
    loop.dynamic = {
      goal: loop.dynamic?.goal ?? loop.prompt,
      state: result.run.currentState,
      metrics: loop.dynamic?.metrics,
      doneCriteria: loop.dynamic?.doneCriteria,
      iteration: (loop.dynamic?.iteration ?? 0) + 1,
      nextWakeAt: undefined,
      awaitingUpdate: false,
      lastUpdatedAt: event.at,
    };
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_WORKFLOW_TASK_SET") {
    if (!loop.workflow) return { state, effects: [] };
    loop.workflow = { ...loop.workflow, activeTaskId: event.payload.taskId };
    loop.updatedAt = event.at;
  }

  next.loopsById[id] = loop;
  return {
    state: next,
    effects: [{ type: "PERSIST_LOOP", entityType: "loop", entityId: id, payload: { loop } }],
  };
}
````

## File: test/loop-command.test.ts
````typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerLoopCommand } from "../src/commands/loop-command.js";
import { LoopStore } from "../src/store.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const { pi, commandMap } = createMockPi();
  const store = new LoopStore(); // memory mode, no file I/O
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const updateWidget = vi.fn();
  const maybeBootstrapTaskLoop = vi.fn(async () => false);
  const onDynamicLoopActivated = vi.fn();
  registerLoopCommand({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    updateWidget,
    maybeBootstrapTaskLoop,
    onDynamicLoopActivated,
  });
  const command = commandMap.get("loop")!;
  return { store, triggerSystem, updateWidget, maybeBootstrapTaskLoop, onDynamicLoopActivated, command };
}

describe("registerLoopCommand", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("registers a loop command with a description", () => {
    expect(h.command).toBeDefined();
    expect(h.command.description).toContain("dynamic goal loop");
  });

  it("creates a cron loop from an interval + prompt argument string", async () => {
    const ctx = createCtx();
    await h.command.handler!("5m check the deploy", ctx);

    expect(h.store.list()).toHaveLength(1);
    const entry = h.store.get("1");
    expect(entry?.prompt).toBe("check the deploy");
    expect(entry?.trigger.type).toBe("cron");
    expect(entry?.recurring).toBe(true);
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.updateWidget).toHaveBeenCalledTimes(1);
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0].message).toContain("Loop #1 created");
    expect(ctx.notifications[0].level).toBe("info");
  });

  it("warns when an interval is given without a prompt", async () => {
    const ctx = createCtx();
    await h.command.handler!("5m", ctx);

    expect(h.store.list()).toHaveLength(0);
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0].level).toBe("warning");
    expect(ctx.notifications[0].message).toContain("Provide a prompt after the interval");
  });

  it("creates a cron loop from a full cron expression + prompt", async () => {
    const ctx = createCtx();
    await h.command.handler!("*/15 * * * * check metrics", ctx);

    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get("1")?.trigger).toEqual({ type: "cron", schedule: "*/15 * * * *" });
    expect(h.store.get("1")?.prompt).toBe("check metrics");
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
  });

  it("no-args invocation opens the Loop menu and creates nothing without a selection", async () => {
    const ui = {
      select: vi.fn(async () => undefined),
      input: vi.fn(async () => undefined),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(ui.select).toHaveBeenCalledWith("Loop", [
      "Create scheduled loop",
      "Create event-triggered loop",
      "View loops",
      "Settings",
    ]);
    expect(h.store.list()).toHaveLength(0);
  });

  it("no-args invocation with 'Settings' reports active/total loop counts", async () => {
    const ui = {
      select: vi.fn(async () => "Settings"),
      input: vi.fn(async () => undefined),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("active loops (max 25)"), "info");
  });

  it("no-args invocation with 'View loops' reports no loops configured when empty", async () => {
    const ui = {
      select: vi.fn(async (title: string) => (title === "Loop" ? "View loops" : undefined)),
      input: vi.fn(async () => undefined),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(ui.select).toHaveBeenCalledWith("No loops configured", ["< Back"]);
  });

  it("no-args invocation with 'Create scheduled loop' prompts for prompt + interval and creates a loop", async () => {
    const ui = {
      select: vi.fn(async () => "Create scheduled loop"),
      input: vi.fn()
        .mockResolvedValueOnce("watch the build") // prompt
        .mockResolvedValueOnce("10m"), // interval
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get("1")?.prompt).toBe("watch the build");
    expect(h.store.get("1")?.trigger.type).toBe("cron");
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Loop #1 created"), "info");
  });

  it("edge: an unparseable interval typed interactively surfaces a notify error and creates nothing", async () => {
    const ui = {
      select: vi.fn(async () => "Create scheduled loop"),
      input: vi.fn()
        .mockResolvedValueOnce("watch the build")
        .mockResolvedValueOnce("not-an-interval"),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.store.list()).toHaveLength(0);
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Cannot parse interval"), "error");
  });

  it("no-args invocation with 'Create event-triggered loop' creates a non-recurring event loop", async () => {
    const ui = {
      select: vi.fn(async () => "Create event-triggered loop"),
      input: vi.fn()
        .mockResolvedValueOnce("react to tool calls") // prompt
        .mockResolvedValueOnce("tool_execution_start"), // event source
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tool_execution_start" });
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("Event loop #1 created"), "info");
  });

  it("free-text input defaults to a dynamic goal loop without prompting for mode", async () => {
    const ctx = createCtx();

    await h.command.handler!("finish the monitor wake fix", ctx);

    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get("1")?.trigger).toEqual({ type: "dynamic" });
    expect(h.store.get("1")?.prompt).toBe("finish the monitor wake fix");
    expect(h.store.get("1")?.recurring).toBe(true);
    expect(h.store.get("1")?.maxFires).toBe(20);
    expect(h.store.get("1")?.dynamic).toMatchObject({
      goal: "finish the monitor wake fix",
      iteration: 0,
    });
    expect(h.store.get("1")?.dynamic?.nextWakeAt).toBeUndefined();
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.onDynamicLoopActivated).toHaveBeenCalledWith(h.store.get("1"));
    expect(ctx.notifications[0].message).toContain("Dynamic loop #1 created");
  });

  it("keeps numeric free-text goals in dynamic mode", async () => {
    const ctx = createCtx();

    await h.command.handler!("2026 release must ship by Friday", ctx);

    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get("1")?.trigger).toEqual({ type: "dynamic" });
    expect(h.store.get("1")?.prompt).toBe("2026 release must ship by Friday");
    expect(h.onDynamicLoopActivated).toHaveBeenCalledWith(h.store.get("1"));
    expect(ctx.notifications[0].message).toContain("Dynamic loop #1 created");
  });

  it("rejects cron-shaped invalid expressions without persisting a loop", async () => {
    const ctx = createCtx();

    await h.command.handler!("99 * * * * check metrics", ctx);

    expect(h.store.list()).toHaveLength(0);
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(ctx.notifications).toEqual([
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("Invalid cron expression"),
      }),
    ]);
  });

  it("rolls back a cron loop when trigger registration fails", async () => {
    const ctx = createCtx();
    h.triggerSystem.add.mockImplementationOnce(() => {
      throw new Error("arm failed");
    });

    await h.command.handler!("5m check metrics", ctx);

    expect(h.store.list()).toHaveLength(0);
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(ctx.notifications[0]).toEqual({
      level: "error",
      message: "arm failed",
    });
  });

  it("explicit event syntax creates an event loop without mode selection", async () => {
    const ctx = createCtx();

    await h.command.handler!("event tasks:created process new tasks", ctx);

    expect(h.store.list()).toHaveLength(1);
    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tasks:created" });
    expect(h.store.get("1")?.prompt).toBe("process new tasks");
    expect(h.store.get("1")?.taskBacklog).toBe(true);
    expect(h.store.get("1")?.maxFires).toBe(25);
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.maybeBootstrapTaskLoop).toHaveBeenCalledWith(h.store.get("1"));
  });

  it("reports when a slash-created task worker adopts an existing backlog", async () => {
    h.maybeBootstrapTaskLoop.mockResolvedValueOnce(true);
    const ctx = createCtx();

    await h.command.handler!("event tasks:created process existing tasks", ctx);

    expect(ctx.notifications[0].message).toContain("adopts unfinished tasks");
    expect(ctx.notifications[0].message).toContain("initial wake queued");
  });

  it("no-args 'View loops' -> select entry -> Delete removes the loop and its trigger", async () => {
    await h.command.handler!("5m check the deploy", createCtx());
    expect(h.store.list()).toHaveLength(1);

    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Loop") return "View loops";
        if (title === "Loops") {
          return h.store.get("1")
            ? "* #1 [active] check the deploy (cron: */5 * * * *)"
            : "< Back";
        }
        if (title.startsWith("#1")) return "x Delete";
        return "< Back";
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.store.get("1")).toBeUndefined();
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(ui.notify).toHaveBeenCalledWith("Loop #1 deleted", "info");
  });

  it("refuses command deletion while a workflow owns an active task", async () => {
    h.store.create({ type: "dynamic" }, "workflow", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "work",
        states: { work: { prompt: "Work.", on: { done: "done" } }, done: { prompt: "Done.", terminal: "completed" } },
      },
    });
    h.store.setWorkflowActiveTask("1", "12");
    let loopVisits = 0;
    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Loop") return "View loops";
        if (title === "Loops") return loopVisits++ === 0 ? "* #1 [active] workflow (dynamic)" : "< Back";
        if (title.startsWith("#1")) return "x Delete";
        return "< Back";
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };

    await h.command.handler!("", { ui } as any);

    expect(h.store.get("1")).toBeDefined();
    expect(h.triggerSystem.remove).not.toHaveBeenCalledWith("1");
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("use LoopDelete with its claimId"), "warning");
  });

  it("no-args 'View loops' -> select entry -> Pause pauses without deleting", async () => {
    await h.command.handler!("5m check the deploy", createCtx());

    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Loop") return "View loops";
        if (title === "Loops") {
          return h.store.get("1")?.status === "paused"
            ? "< Back"
            : "* #1 [active] check the deploy (cron: */5 * * * *)";
        }
        if (title.startsWith("#1")) return "- Pause";
        return "< Back";
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.store.get("1")?.status).toBe("paused");
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(ui.notify).toHaveBeenCalledWith("Loop #1 paused", "info");
  });

  it("does not offer resume for a workflow paused in a terminal state", async () => {
    h.store.create({ type: "dynamic" }, "Investigate", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "investigate",
        states: {
          investigate: { prompt: "Find the blocker.", on: { blocked: "blocked" } },
          blocked: { prompt: "Report the blocker.", terminal: "paused" },
        },
      },
    });
    h.store.transitionWorkflow("1", { outcome: "blocked" });
    h.store.pause("1");

    const actionChoices: string[][] = [];
    let loopVisits = 0;
    const ui = {
      select: vi.fn(async (title: string, choices: string[]) => {
        if (title === "Loop") return "View loops";
        if (title === "Loops") {
          loopVisits++;
          return loopVisits === 1
            ? "- #1 [paused] Investigate (dynamic)"
            : "< Back";
        }
        if (title.startsWith("#1")) {
          actionChoices.push(choices);
          return "< Back";
        }
        return undefined;
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };

    await h.command.handler!("", { ui } as any);

    expect(actionChoices).toEqual([["x Delete", "< Back"]]);
    expect(h.store.get("1")?.status).toBe("paused");
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.onDynamicLoopActivated).not.toHaveBeenCalled();
  });

  it("resumes a blocked dynamic loop and clears its awaiting-update gate", async () => {
    await h.command.handler!("finish release", createCtx());
    h.store.updateDynamic("1", { dynamic: { awaitingUpdate: true } });
    h.store.pause("1");

    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Loop") return "View loops";
        if (title === "Loops") {
          return h.store.get("1")?.status === "paused"
            ? "- #1 [paused] finish release (dynamic)"
            : "< Back";
        }
        if (title.startsWith("#1")) return "* Resume";
        return undefined;
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };

    await h.command.handler!("", { ui } as any);

    const resumed = h.store.get("1");
    expect(resumed?.status).toBe("active");
    expect(resumed?.dynamic?.awaitingUpdate).toBe(false);
    expect(h.triggerSystem.add).toHaveBeenLastCalledWith(resumed);
    expect(h.onDynamicLoopActivated).toHaveBeenLastCalledWith(resumed);
    expect(ui.notify).toHaveBeenCalledWith("Loop #1 resumed", "info");
  });
});
````

## File: AGENTS.md
````markdown
# pi-loop Development Guidelines

## Overview
`pi-loop` is a pi extension providing cron/event-based agent re-wake loops and background process monitoring. Modeled after Claude Code's `/loop`, `CronCreate`, and `MonitorCreate` tools.

## Stack
- TypeScript 6.x (strict, ES2022 target, bundler module resolution)
- `typebox` for tool parameter validation
- `vitest` for tests
- `biome` for linting (linter: on, formatter: off)
- npm packaging as `@bramburn/pi-loop`

## Architecture
```
src/
├── index.ts              # Extension entry: 4 loop tools + /loop + /loop-resume + widget
├── types.ts              # LoopKind, Trigger spec, LoopEntry, MonitorEntry, LoopConfig
├── store.ts              # File-backed CRUD (.pi/loops/loops.json) with file locking
├── scheduler.ts          # Timer-based cron scheduler with jitter + 7-day expiry
├── trigger-system.ts     # Unified trigger engine: cron timers + pi event subscriptions + hybrid
├── monitor-manager.ts    # ChildProcess tracking, output buffering, event emission, stop
├── loop-parse.ts         # Human interval → cron expression, next-fire computation, jitter
├── telemetry/            # Sentry integration (opt-in via SENTRY_DSN)
│   ├── sentry.ts         # initSentry, captureException, addBreadcrumb, log*, scrubPii, wrapToolExecute
│   └── index.ts          # Public re-exports
└── ui/
    └── widget.ts         # Persistent widget: active loops + monitors
```

## Conventions (mirror pi-tasks)
- No comments unless answering "why", never "what"
- `debug(...)` helper gated on `PI_LOOP_DEBUG` env var, logs to stderr
- `textResult(msg)` helper for uniform tool output
- All tool params use `Type.Object()` with description strings
- Tool descriptions follow Claude Code format: `## When to Use`, `## When NOT to Use`
- Cross-extension communication via `pi.events` with `requestId` + reply channels
- File-backed stores use atomic write (write tmp → rename) + pid-based file locking
- Runtime tracker UI uses `UICtx.setStatus()` for compact single-line state
- Tests co-located in `test/`, named `<module>.test.ts`

## Tool Schema Discipline
- Tool calls must use the exact schema field names from the tool definition. Do not invent aliases.
- Example: `TaskUpdate` uses `id`, not `taskId`.
- When a tool validation error clearly indicates an immediately recoverable schema mismatch, correct it silently and retry. Do not emit user-facing chatter like "retrying with the correct shape" unless the recovery itself changes the user's understanding.
- When adding or revising tool prompt guidance, include concrete parameter-name reminders for commonly miscalled tools.

## File Locking Pattern
Copy TaskStore from pi-tasks: `O_EXCL` lockfile, stale PID detection, `LOCK_RETRY_MS`/`LOCK_MAX_RETRIES`

## Loop Persistence Scope
`PI_LOOP_SCOPE` controls where loops and native fallback tasks are stored. The default is **`project`** so loops persist across chat sessions and survive process restarts, mirroring pi-goal-x's `.pi/goals/` pattern.

| Scope | Location (relative to cwd) | Survives session switch? | Survives process restart? |
|-------|----------------------------|--------------------------|---------------------------|
| `project` (default) | `.pi/loops/loops.json`, `.pi/tasks/tasks.json` | yes | yes |
| `session` | `.pi/loops/loops-<sessionId>.json`, `.pi/tasks/tasks-<sessionId>.json` | no | no |
| `memory` | in-process only | no | no |

Override with `PI_LOOP_SCOPE=session` for per-session isolation, `PI_LOOP_SCOPE=memory` to disable on-disk persistence entirely, or `PI_LOOP=/abs/path` (or `PI_LOOP=./relative.json`) to pin a custom location.

After a process restart in project scope, cron loops re-arm automatically via the 30s heartbeat pump in `session-runtime.ts`. **Event/hybrid trigger subscriptions do NOT auto-re-arm** — call `/loop-resume <id>` (or `LoopDelete({id, action: "resume"})`) to re-bind them. The resume path is idempotent: it re-arms the trigger whether or not the stored loop is paused.

## Per-Session Loop Bindings

Multiple pi terminals in the same repo each pick a disjoint subset of stored loops to arm, so parallel agents can split work without one terminal firing another terminal's loops. The mechanism is a per-session bindings file at `<cwd>/.pi/loops/bindings-<sessionId>.json` containing `{ "loopIds": ["1","3","7"] }`. Each session owns its own file (no contention with other terminals).

- **Fresh-session default is strict isolation**: if the bindings file does not exist on first start, the session arms **zero** loops and emits a one-time notify: `'No bindings for this session — run /loop-resume to choose which loops this terminal arms.'`. This is a deliberate behavior change — the extension no longer auto-arms every active loop in the project store on session start.
- **`/loop-resume <id>` (one-shot)**: re-arms the loop and writes the id into the bindings file in a single call.
- **`/loop-resume` (no args)** opens a simple picker: every stored loop is shown as `* #N [status] prompt (trigger)`. Selecting a row re-arms that loop; `< Back` exits without changing anything.
- **Concurrent-session invariant**: two terminals in the same repo write only their own bindings files; the shared `.pi/loops/loops.json` registry is read by all sessions and written through the existing `LoopStore.withLock`. Trigger subscriptions are process-local — terminal A's `triggerSystem.add(#5)` does NOT cause terminal B to fire `#5`.

Implementation: `src/runtime/bindings-store.ts` (BindingsStore class), `src/runtime/scope.ts` (`resolveBindingsPath`), `src/runtime/session-runtime.ts` (`showPersistedLoops` filters arm-list by bindings), `src/commands/loop-command.ts` (simple picker + bindings-aware one-shot).
## Trigger Types
Three trigger types, all stored as `LoopEntry.trigger`:
- `{ type: "cron", schedule: "*/5 * * * *" }` — timer-based
- `{ type: "event", source: "tool_execution_start", filter?: "regex:..." | '{"key":"value"}' }` — eventbus-based
- `{ type: "hybrid", cron: "...", event: { source, filter? }, debounceMs: 30000 }` — both with debounce

All cron/hybrid loops are dynamic: they track their next fire time but only deliver on agent idle (`agent_end`/`turn_start`) rather than wall-clock timers.

## Re-wake via In-Memory Pending Notifications
When a loop fires, the scheduler calls `onLoopFire()` which emits `pi.events("loop:fire", ...)`. The extension buffers a pending notification in memory, re-checks whether the wake is still relevant, and only then injects a `pi.sendMessage()` custom message to wake the agent. Do not rely on early queued follow-up user messages for loop delivery; those are not extension-cancelable once handed to pi's queue.

All loops are idle-driven. Cron and hybrid loops track their next fire time but only deliver when the agent becomes idle (via `agent_end`/`turn_start`), resetting their timer from the actual delivery point.

## Monitor Streaming via PI Events
Monitor stdout/stderr lines are emitted as `pi.events("monitor:output", { monitorId, line, timestamp })`. Tool consumers subscribe to these events. Completion emits `"monitor:done"` / `"monitor:error"`.

## pi-tasks Integration
When `@tintinweb/pi-tasks` is present, `LoopCreate` with `autoTask: true` fires an RPC to create a task. Communication via `pi.events`:
- `tasks:rpc:ping` on init → detect pi-tasks presence
- `tasks:ready` listener → late-binding detection
- `tasks:rpc:create` → auto-create task when loop fires (if `autoTask: true`)

## /loop Self-Paced Mode
When no interval is specified in `/loop prompt`, the loop runs in self-paced mode. The agent receives the prompt, acts on it, and uses `LoopCreate`/`LoopUpdate` to schedule the next iteration. The loop fires once, then the agent decides the next interval dynamically (matching Claude Code's dynamic interval behavior).

## Testing
- `vitest` with `describe`/`it` blocks
- In-memory stores for unit tests, `tmpdir` for file-backed tests
- Fake timers (`vi.useFakeTimers`) for scheduler tests
- Mock pi eventbus for monitor-manager tests
- `vitest run` in CI, `vitest` for watch mode

## Limits
- Maximum 25 active loops
- Maximum 25 running monitors
- 7-day expiry on recurring loops
- 5-minute default cron interval for self-paced mode

## Telemetry (Sentry)

Crash analytics is **opt-in**. End users set `SENTRY_DSN` to enable; without it, every callsite in `src/telemetry/sentry.ts` is a no-op (verified by `test/telemetry/sentry.test.ts`).

**Public API (from `src/telemetry/index.ts`):**

| Function | Purpose | Notes |
|---|---|---|
| `initSentry(opts)` | Boot Sentry with PII scrubbing, capture logs, install process handlers | Returns `false` if `SENTRY_DSN` unset |
| `captureException(err, ctx?)` | Forward an error to Sentry | No-op when not initialized |
| `addBreadcrumb(msg, data?)` | Emit a structured breadcrumb | No-op when not initialized |
| `logInfo / logDebug / logWarn / logError` | Pipe structured logs via Sentry's `logger` | No-op when not initialized |
| `flushSentry(timeoutMs?)` | Flush buffered events (e.g. on shutdown) | No-op when not initialized |
| `wrapToolExecute(name, fn)` | Wrap a tool's `execute` with parallel-storm guard + breadcrumb + capture + rethrow | Used at the `pi.registerTool` boundary in `src/index.ts` |
| `recordParallelCall(name)` / `checkParallelStorm(name)` / `resetParallelGuard()` | Per-tool sliding-window call counter (2 calls / 1s) | Throws on the 3rd call to prevent TUI freeze |
| `scrubPii(input)` | Recursive PII redactor (paths, env, DSN, sensitive keys) | Used by `beforeSend` / `beforeBreadcrumb` / `beforeSendLog` |

**PII scrubbing rules** (in `scrubPii`):
- Strip `C:\...` and `/Users|...`, `/home|...`, `/root|...` paths from strings
- Strip `process.env.*` references
- Strip Sentry DSN URLs (`https://<key>@<org>.ingest.<region>.sentry.io/<id>`)
- Redact values under keys: `prompt`, `message`, `text`, `body`, `content`, `description`
- Redact `filename` and `abs_path` fields in stack frames

**Env vars (full list in `.env.example`):** `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_DEBUG`, `SENTRY_CAPTURE_LOGS`.

**Out of scope:** source-map upload via auth tokens, server-side PII rules (rely on Sentry's defaults), CI-side secret wiring (no production deploy of this package).
````

## File: src/runtime/session-runtime.ts
````typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { LoopStore } from "../store.js";
import { type LoopSnapshot, syncLoopTools } from "../tools/tool-visibility.js";
import type { NotificationRuntime } from "./notification-runtime.js";
import type { LoopScope } from "./scope.js";
import { showEscapeDialog } from "../ui/escape-dialog.js";
import { showLoopListOverlay } from "../ui/overlays.js";

export interface SessionSwitchEvent {
  reason?: string;
}

// Wall-clock cadence for the idle heartbeat that pumps the scheduler. Cron is
// minute-granular, so 30s gives sub-minute wake latency while idle.
const HEARTBEAT_MS = 30_000;

export interface SessionRuntimeOptions {
  pi: ExtensionAPI;
  getLoopScope: () => LoopScope;
  getPiLoopEnv: () => string | undefined;
  recreateSessionStore: (sessionId: string) => void;
  clearAllLoops: () => void;
  getStore: () => LoopStore;
  getScheduler: () => { nextFire(id: string): number | undefined; pump(now: number, filter?: (entry: { id: string }) => boolean): void };
  getTriggerSystem: () => { start(): void; stop(): void };
  setLatestCtx: (ctx: ExtensionContext) => void;
  setSessionId: (sessionId: string | undefined) => void;
  widget: { setUICtx(ui: ExtensionContext["ui"]): void; update(): void };
  /** Snapshot of the current loop state. Read by syncLoopTools to decide
   *  which loop tools should be exposed to the LLM. */
  getLoopSnapshots: () => LoopSnapshot[];
  /** Optional override of the runtime sync fn for tests. */
  syncLoopToolsFn?: typeof syncLoopTools;
  /** Optional override for the loop overlay (for tests). */
  showLoopListOverlayFn?: typeof showLoopListOverlay;
  /** Optional override for the escape dialog (for tests). */
  showEscapeDialogFn?: typeof showEscapeDialog;
  notificationRuntime: NotificationRuntime;
  flushPendingNotifications: (options?: { ignorePendingMessages?: boolean }) => Promise<void>;
  migrateTaskBacklogLoops: () => number;
  cleanupTaskBacklogLoops: () => Promise<number>;
  adoptTaskBacklogLoops: (baselineFireCounts?: ReadonlyMap<string, number>) => Promise<number>;
  releaseTaskBacklogWakes: () => void;
  hasPendingTasks: () => Promise<number>;
  cleanDoneTasks: () => Promise<void>;
}

export function registerSessionRuntimeHooks(options: SessionRuntimeOptions): void {
  const {
    pi,
    getLoopScope,
    getPiLoopEnv,
    recreateSessionStore,
    clearAllLoops,
    getStore,
    getScheduler,
    getTriggerSystem,
    setLatestCtx,
    setSessionId,
    widget,
    getLoopSnapshots,
    syncLoopToolsFn,
    notificationRuntime,
    flushPendingNotifications,
    migrateTaskBacklogLoops,
    cleanupTaskBacklogLoops,
    adoptTaskBacklogLoops,
    releaseTaskBacklogWakes,
    hasPendingTasks,
    cleanDoneTasks,
    showLoopListOverlayFn,
    showEscapeDialogFn,
  } = options;

  let storeUpgraded = false;
  let persistedShown = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let agentStartFireCounts: ReadonlyMap<string, number> | undefined;
  let terminalInputUnsubscribe: (() => void) | undefined;

  // The CronScheduler is pump-driven; without this heartbeat it only advances at
  // turn boundaries (turn_start/agent_end), so a loop whose fire time elapses
  // while the agent is idle would never fire and never re-wake the agent. The
  // timer is unref'd so it never keeps a one-shot (`pi -p`) process alive.
  function ensureHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      // Swallow pump failures so a transient error never surfaces as an
      // unhandled rejection; repaint still runs so cleared harness UI heals.
      void pumpLoops()
        .catch(() => {})
        .then(() => widget.update())
        .catch(() => {});
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }

  function syncToolsNow(): void {
    const fn = syncLoopToolsFn ?? syncLoopTools;
    fn(pi, getLoopSnapshots());
  }

  function stopHeartbeat(): void {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  // Register global keybindings. Per ADR-004: Ctrl+Shift+L opens the loop
  // list overlay; Escape during a pending fire opens the skip/continue/cancel
  // dialog. Returns { consume: true } only when consuming the key.
  function registerKeybindings(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      // Ctrl+Shift+L — always available when idle and has UI.
      if (matchesKey(data, "ctrl+shift+l")) {
        void (showLoopListOverlayFn ?? showLoopListOverlay)(ctx, {
          loops: getStore().list(),
          monitors: [],
          tasks: { count: 0 },
          myLoopIds: new Set(getStore().list().map((l) => l.id)),
        });
        return { consume: true };
      }
      // Escape — only consumed when an operation is in flight. Otherwise the
      // TUI handles Escape (e.g. clearing editor text).
      if (matchesKey(data, "escape")) {
        const hasRecentFire = getStore().list().some((l) => l.status === "active");
        if (!hasRecentFire) return undefined;
        void (showEscapeDialogFn ?? showEscapeDialog)(ctx, {
          operationLabel: "Loop firing",
        }).then((choice) => {
          if (choice === "cancel") {
            ctx.ui.notify("Operation cancelled via Escape", "info");
          } else if (choice === "skip") {
            ctx.ui.notify("Iteration skipped via Escape", "info");
          }
        });
        return { consume: true };
      }
      return undefined;
    });
  }

  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if ((getLoopScope() === "session" || getLoopScope() === "memory") && !getPiLoopEnv()) {
      recreateSessionStore(ctx.sessionManager.getSessionId());
    }
    storeUpgraded = true;
  }

  async function showPersistedLoops(_isResume = false) {
    if (persistedShown) return;
    persistedShown = true;
    const sessionStartedAt = Date.now();
    migrateTaskBacklogLoops();
    const loops = getStore().list();
    if (loops.length > 0) {
      getStore().clearExpired();
      getStore().expireEventLoops(sessionStartedAt);
      getTriggerSystem().start();
      ensureHeartbeat();
    }
    await adoptTaskBacklogLoops();
  }

  async function pumpLoops(): Promise<void> {
    const pendingTasks = new Map<string, boolean>();
    for (const entry of getStore().list()) {
      if (entry.status !== "active") continue;
      if (!entry.autoTask) continue;
      if (entry.trigger.type !== "cron" && entry.trigger.type !== "hybrid") continue;
      const nextFire = getScheduler().nextFire(entry.id);
      if (!nextFire || Date.now() < nextFire) continue;
      const pending = await hasPendingTasks();
      if (pending <= 0) pendingTasks.set(entry.id, true);
    }
    getScheduler().pump(Date.now(), (entry) => !pendingTasks.has(entry.id));
  }

  pi.on("session_start", async (_event, ctx) => {
    setLatestCtx(ctx);
    setSessionId(ctx.sessionManager.getSessionId());
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    await showPersistedLoops();
    registerKeybindings(ctx);
    widget.update();
  });

  pi.on("turn_start", async (_event, ctx) => {
    setLatestCtx(ctx);
    setSessionId(ctx.sessionManager.getSessionId());
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    await showPersistedLoops();
    widget.update();
    await pumpLoops();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    await showPersistedLoops();
    // Per ADR-002: sync the LLM's active tool set to the current loop
    // state. First sync MUST happen in before_agent_start, never in
    // session_start (runtime not bound — see pragmaxim d77e3b8).
    syncToolsNow();
    widget.update();
  });

  pi.on("agent_start", async (_event, ctx) => {
    notificationRuntime.syncRuntimeState({
      agentRunning: true,
      hasPendingMessages: ctx.hasPendingMessages(),
    });
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    agentStartFireCounts = new Map(getStore().list().map((entry) => [entry.id, entry.fireCount ?? 0]));
  });

  pi.on("agent_end", async (_event, ctx) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    notificationRuntime.syncRuntimeState({
      agentRunning: false,
      hasPendingMessages: ctx.hasPendingMessages(),
    });
    releaseTaskBacklogWakes();
    await cleanupTaskBacklogLoops();
    await adoptTaskBacklogLoops(agentStartFireCounts);
    agentStartFireCounts = undefined;
    await flushPendingNotifications({ ignorePendingMessages: true });
    await pumpLoops();
  });

  pi.on("session_shutdown", async () => {
    stopHeartbeat();
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = undefined;
    releaseTaskBacklogWakes();
    notificationRuntime.clear("session_shutdown");
  });

  pi.on("session_switch" as never, async (event: SessionSwitchEvent, ctx: ExtensionContext) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    getTriggerSystem().stop();
    stopHeartbeat();
    notificationRuntime.clear("session_switch");
    releaseTaskBacklogWakes();
    setSessionId(undefined);

    const isResume = event?.reason === "resume";
    storeUpgraded = false;
    persistedShown = false;

    setSessionId(ctx.sessionManager.getSessionId());
    upgradeStoreIfNeeded(ctx);
    if (!isResume && getLoopScope() === "memory") clearAllLoops();
    await showPersistedLoops(isResume);
    widget.update();
  });

  pi.on("tool_execution_end", async (event: unknown, ctx: ExtensionContext) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);

    const typed = event as {
      toolName?: string;
      isError?: boolean;
      args?: { command?: string };
      input?: { command?: string };
    };

    if (typed.toolName !== "bash" || typed.isError) return;

    const command = typed.args?.command ?? typed.input?.command;
    if (typeof command !== "string") return;
    if (!/^\s*git\s+commit\b/i.test(command)) return;

    await cleanDoneTasks();
  });
}
````

## File: src/commands/loop-command.ts
````typescript
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { formatTrigger } from "../loop-format.js";
import { isValidCronExpression, parseInterval } from "../loop-parse.js";
import type { DynamicLoopState, LoopEntry, Trigger } from "../types.js";
import { isTerminalWorkflowRun } from "../workflow-reducer.js";

interface LoopStoreLike {
  list(): LoopEntry[];
  get(id: string): LoopEntry | undefined;
  create(trigger: Trigger, prompt: string, options: {
    recurring: boolean;
    autoTask?: boolean;
    taskBacklog?: boolean;
    readOnly?: boolean;
    maxFires?: number;
    dynamic?: Partial<DynamicLoopState>;
  }): LoopEntry;
  pause(id: string): LoopEntry | undefined;
  resume(id: string): LoopEntry | undefined;
  delete(id: string): boolean;
}

interface TriggerSystemLike {
  add(entry: LoopEntry): void;
  remove(id: string): void;
}

export interface LoopCommandOptions {
  pi: ExtensionAPI;
  getStore: () => LoopStoreLike;
  getTriggerSystem: () => TriggerSystemLike;
  updateWidget: () => void;
  maybeBootstrapTaskLoop?: (entry: LoopEntry) => Promise<boolean>;
  onDynamicLoopActivated?: (entry: LoopEntry) => void;
}

type LoopCommandRoute =
  | { type: "menu" }
  | { type: "event"; source: string; prompt: string }
  | { type: "cron"; interval: string; prompt: string; notifyEvery: boolean }
  | { type: "invalid-cron"; interval: string }
  | { type: "missing-interval-prompt" }
  | { type: "dynamic"; goal: string };

function parseLoopCommandRoute(input: string): LoopCommandRoute {
  const trimmed = input.trim();
  if (!trimmed) return { type: "menu" };

  const eventMatch = trimmed.match(/^(?:event|when)\s+(\S+)\s+(.+)$/i);
  if (eventMatch?.[1] && eventMatch[2]) {
    return { type: "event", source: eventMatch[1], prompt: eventMatch[2].trim() };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length > 5) {
    const interval = parts.slice(0, 5).join(" ");
    const cronShaped = parts.slice(0, 5).every((part) => /^[\d*/,-]+$/.test(part));
    if (cronShaped) {
      if (!isValidCronExpression(interval)) return { type: "invalid-cron", interval };
      return { type: "cron", interval, prompt: parts.slice(5).join(" "), notifyEvery: false };
    }
  }

  const intervalMatch = trimmed.match(/^(\d+\s*[smhdS]\b)/i);
  if (intervalMatch) {
    const interval = intervalMatch[1] ?? intervalMatch[0];
    const prompt = trimmed.slice(intervalMatch[0].length).trim();
    if (!prompt) return { type: "missing-interval-prompt" };
    return { type: "cron", interval, prompt, notifyEvery: true };
  }

  return { type: "dynamic", goal: trimmed };
}

export function registerLoopCommand(options: LoopCommandOptions): void {
  const { pi, getStore, getTriggerSystem, updateWidget, maybeBootstrapTaskLoop, onDynamicLoopActivated } = options;

  function createCronLoop(ui: ExtensionUIContext, interval: string, prompt: string, notifyEvery: boolean) {
    let entry: LoopEntry | undefined;
    try {
      const parsed = parseInterval(interval);
      const trigger: Trigger = { type: "cron", schedule: parsed.cron };
      entry = getStore().create(trigger, prompt, { recurring: true });
      getTriggerSystem().add(entry);
      updateWidget();
      const cadence = notifyEvery ? `every ${parsed.description}` : parsed.description;
      ui.notify(`Loop #${entry.id} created: ${cadence} — ${prompt.slice(0, 50)}`, "info");
    } catch (err: unknown) {
      if (entry) {
        getTriggerSystem().remove(entry.id);
        getStore().delete(entry.id);
        updateWidget();
      }
      ui.notify((err as Error).message, "error");
    }
  }

  async function scheduleLoop(ui: ExtensionUIContext, prompt?: string) {
    const p = prompt || await ui.input("Prompt (what should the agent check?)");
    if (!p) return;

    const interval = await ui.input("Interval (e.g., 5m, 2h, 1d)");
    if (!interval) return;

    createCronLoop(ui, interval, p, true);
  }

  async function eventLoop(ui: ExtensionUIContext, prompt?: string, sourceOverride?: string) {
    const p = prompt || await ui.input("Prompt");
    if (!p) return;

    const source = sourceOverride || await ui.input("Pi event source (e.g., tool_execution_start, before_agent_start)");
    if (!source) return;

    const trigger: Trigger = { type: "event", source };
    const taskBacklog = source === "tasks:created";
    const entry = getStore().create(trigger, p, {
      recurring: true,
      taskBacklog,
      maxFires: taskBacklog ? 25 : undefined,
    });
    getTriggerSystem().add(entry);
    updateWidget();
    const bootstrapped = taskBacklog ? await maybeBootstrapTaskLoop?.(entry) : false;
    const adoption = taskBacklog
      ? `; adopts unfinished tasks${bootstrapped ? " (initial wake queued)" : ""}`
      : "";
    ui.notify(`Event loop #${entry.id} created: fires on "${source}"${adoption}`, "info");
  }

  function dynamicLoop(ui: ExtensionUIContext, goal: string) {
    const trigger: Trigger = { type: "dynamic" };
    const entry = getStore().create(trigger, goal, {
      recurring: true,
      maxFires: 20,
      dynamic: { goal, iteration: 0 },
    });
    getTriggerSystem().add(entry);
    updateWidget();
    ui.notify(`Dynamic loop #${entry.id} created — ${goal.slice(0, 50)}`, "info");
    onDynamicLoopActivated?.(entry);
  }

  async function viewLoops(ui: ExtensionUIContext) {
    const loops = getStore().list();
    if (loops.length === 0) {
      await ui.select("No loops configured", ["< Back"]);
      return;
    }

    const choices = loops.map((l) => {
      const icon = l.status === "active" ? "*" : l.status === "paused" ? "-" : "x";
      return `${icon} #${l.id} [${l.status}] ${l.prompt.slice(0, 50)} (${formatTrigger(l.trigger, "command")})`;
    });
    choices.push("< Back");

    const selected = await ui.select("Loops", choices);
    if (!selected || selected === "< Back") return;

    const match = selected.match(/#(\d+)/);
    if (match?.[1]) {
      const entry = getStore().get(match[1]);
      if (entry) {
        const actions = ["x Delete"];
        if (entry.status === "active") actions.unshift("- Pause");
        else if (entry.status === "paused" && !isTerminalWorkflowRun(entry.workflow)) actions.unshift("* Resume");
        actions.push("< Back");

        const action = await ui.select(
          `#${entry.id}: ${entry.prompt}\nTrigger: ${JSON.stringify(entry.trigger)}`,
          actions,
        );

        if (action === "x Delete") {
          if (entry.workflow?.activeTaskId) {
            ui.notify(`Workflow #${entry.id} has active task #${entry.workflow.activeTaskId}; use LoopDelete with its claimId to cancel safely`, "warning");
            return viewLoops(ui);
          }
          getTriggerSystem().remove(entry.id);
          getStore().delete(entry.id);
          updateWidget();
          ui.notify(`Loop #${entry.id} deleted`, "info");
        } else if (action === "- Pause") {
          getStore().pause(entry.id);
          getTriggerSystem().remove(entry.id);
          updateWidget();
          ui.notify(`Loop #${entry.id} paused`, "info");
        } else if (action === "* Resume") {
          const resumed = getStore().resume(entry.id);
          if (!resumed) return viewLoops(ui);
          getTriggerSystem().add(resumed);
          updateWidget();
          ui.notify(`Loop #${entry.id} resumed`, "info");
          if (resumed.trigger.type === "dynamic") onDynamicLoopActivated?.(resumed);
        }
      }
    }

    return viewLoops(ui);
  }

  async function settings(ui: ExtensionUIContext) {
    const loops = getStore().list();
    const active = loops.filter((l) => l.status === "active").length;
    ui.notify(`${active}/${loops.length} active loops (max 25)`, "info");
  }

  pi.registerCommand("loop", {
    description: "Create a loop. Use /loop [interval] [prompt] for scheduled loops, /loop event <source> <prompt> for event loops, or /loop <goal> for a dynamic goal loop.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;
      const route = parseLoopCommandRoute(args);

      if (route.type === "menu") {
        const choice = await ui.select("Loop", [
          "Create scheduled loop",
          "Create event-triggered loop",
          "View loops",
          "Settings",
        ]);

        if (!choice) return;
        if (choice.startsWith("Create scheduled")) return scheduleLoop(ui);
        if (choice.startsWith("Create event")) return eventLoop(ui);
        if (choice.startsWith("View loops")) return viewLoops(ui);
        return settings(ui);
      }

      if (route.type === "event") return eventLoop(ui, route.prompt, route.source);
      if (route.type === "cron") return createCronLoop(ui, route.interval, route.prompt, route.notifyEvery);
      if (route.type === "invalid-cron") {
        ui.notify(`Invalid cron expression: ${route.interval}`, "error");
        return;
      }
      if (route.type === "missing-interval-prompt") {
        ui.notify("Provide a prompt after the interval, e.g., /loop 5m check the deploy", "warning");
        return;
      }
      return dynamicLoop(ui, route.goal);
    },
  });

  pi.registerCommand("loop-resume", {
    description: "Re-arm a stored loop by ID (e.g., after a session restart). Usage: /loop-resume <id>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const ui = ctx.ui;

      if (!trimmed) {
        const loops = getStore().list();
        if (loops.length === 0) {
          ui.notify("No stored loops to re-arm. Use /loop to create one first.", "info");
          return;
        }
        const choices = loops.map((l) => {
          const icon = l.status === "active" ? "*" : l.status === "paused" ? "-" : "x";
          const triggerDesc = l.trigger.type === "cron"
            ? `cron: ${l.trigger.schedule}`
            : l.trigger.type === "event"
              ? `event: ${l.trigger.source}`
              : l.trigger.type === "hybrid"
                ? `hybrid: ${l.trigger.cron}`
                : "dynamic";
          return `${icon} #${l.id} [${l.status}] ${l.prompt.slice(0, 50)} (${triggerDesc})`;
        });
        choices.push("< Back");
        const selected = await ui.select("Re-arm which loop?", choices);
        if (!selected || selected === "< Back") return;
        const match = selected.match(/#(\d+)/);
        if (!match) return;
        await rearmLoop(ui, match[1]);
        return;
      }

      const id = trimmed.split(/\s+/)[0];
      if (!id || !/^\d+$/.test(id)) {
        ui.notify(`Expected a numeric loop ID, got "${id}". Try /loop-resume <id>.`, "error");
        return;
      }
      await rearmLoop(ui, id);
    },
  });

  async function rearmLoop(ui: ExtensionUIContext, id: string): Promise<void> {
    const before = getStore().get(id);
    if (!before) {
      ui.notify(`Loop #${id} not found in the store. Use /loop to create it first.`, "error");
      return;
    }
    const entry = getStore().resume(id) ?? before;
    getTriggerSystem().add(entry);
    updateWidget();
    const transitioned = before.status !== entry.status;
    const tag = transitioned ? "resumed" : "re-armed";
    ui.notify(`Loop #${entry.id} ${tag} (status: ${entry.status})`, "info");
  }
}
````

## File: README.md
````markdown
<p align="center">
<h1 align="center">@bramburn/pi-loop</h1>
<h6 align="center">Cron and event loops for the pi coding agent. Scheduled re-wakes, idle-driven dynamic goal loops, event-triggered agents, and per-session bindings.</h6>
</p>

## Install

```bash
pi install npm:@bramburn/pi-loop
```

## Quick start

```text
LoopCreate trigger="5m" prompt="Check if the build passed"
LoopCreate trigger="tool_execution_start" prompt="Log the tool being used" triggerType="event"
LoopList
LoopDelete id="1"
```

## Commands

`/loop [interval] [prompt]` — interactive loop creation.

```text
/loop                         # menu
/loop 5m check the deploy     # 5-minute cron loop
```

`/loop-resume <id>` — re-arm a stored loop by ID and re-add it to the trigger system. Use this after a session/process restart when a stored event/hybrid loop's trigger subscription was lost. Idempotent: re-arming an already-active loop just refreshes the trigger.

```text
/loop-resume 5        # re-arm loop #5 by id
/loop-resume          # open a single-select picker of all stored loops
```

`/loop-resume` (no args) — open a simple picker listing every stored loop as `* #N [status] prompt (trigger)`. Pick a row to re-arm it, or `< Back` to exit without changing anything. Each terminal reads and writes its own `.pi/loops/bindings-<sessionId>.json` so parallel sessions do not interfere.

## Tools

| Tool | What it does |
|---|---|
| `LoopCreate` | Schedule a prompt on a cron timer, a pi event, or both with debounce |
| `LoopUpdate` | Update progress for a dynamic goal loop (self-paced mode) |
| `LoopList` | Show active loops with IDs, triggers, and next-fire times |
| `LoopDelete` | Delete or pause a loop |
| `MonitorCreate` | _(retired — see [Retired tools](#retired-tools))_ |
| `MonitorList` | _(retired)_ |
| `MonitorStop` | _(retired)_ |
| `TaskCreate` | _(retired — see [Retired tools](#retired-tools))_ |
| `TaskList` | _(retired)_ |
| `TaskUpdate` | _(retired)_ |
| `TaskDelete` | _(retired)_ |

Trigger types: `cron` (`5m`, `1h`, `0 9 * * 1-5`), `event` (any pi event source), or `hybrid` (both, debounced).

## Tasks

### With `pi-tasks`

Works with [@tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks). Pass `autoTask: true` on `LoopCreate` and each loop fire auto-creates a tracked task. Detection happens over pi's event bus — no manual wiring.

### Without `pi-tasks`

If `pi-tasks` does not respond during startup detection, `pi-loop` registers a native fallback task system for the session:

- session- or project-scoped task files under `.pi/tasks/` depending on `PI_LOOP_SCOPE`
- `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskDelete`
- `/tasks` interactive viewer
- compact status-line task tracking


This fallback is session-sticky: `pi-loop` decides once at startup whether `pi-tasks` or native tasks own task management for that session.

## Status line

`pi-loop` keeps a compact persistent status line in the TUI.

When active work exists, it shows a single focus-friendly line such as:

```text
1 loop · 1 monitor
2 tasks | active: Fix deploy polling
1 loop · 2 monitors · 3 tasks | next: Update README
```

When no loops, monitors, or native tasks are active, the status line clears completely.

Only task counts and the single active/next task are shown there so attention stays on what is currently happening. Use `LoopList`, `MonitorList`, and `/tasks` for detail.

## Configuration

| Variable | Effect | Default |
|---|---|---|
| `PI_LOOP` | Store path override. `off` to disable, absolute or project-relative path | unset → derived from `PI_LOOP_SCOPE` |
| `PI_LOOP_SCOPE` | `memory` (ephemeral), `session` (per-session file), `project` (shared, persists across sessions) | `project` |
| `PI_LOOP_DEBUG` | Debug logging to stderr | unset |
| `SENTRY_DSN` | Enable anonymous crash + log reporting (Sentry). Set to your project DSN to opt in. | unset → telemetry disabled |
| `SENTRY_ENVIRONMENT` | Environment tag for events (e.g. `production`, `development`) | `development` |
| `SENTRY_TRACES_SAMPLE_RATE` | Performance transaction sample rate (`0.0`–`1.0`) | `0.1` |
| `SENTRY_CAPTURE_LOGS` | Pipe `debug()` output into Sentry logs | `true` |
| `SENTRY_DEBUG` | Verbose Sentry SDK debug logging to stderr | `false` |

In `project` scope (default), loop and task files are saved to `.pi/loops/loops.json` and `.pi/tasks/tasks.json` so they survive across chat sessions and process restarts in the same repository — mirroring pi-goal-x's `.pi/goals/` pattern. In `memory` scope nothing persists to disk.

### Recommended scope policy

`PI_LOOP_SCOPE=project` is the default and best balance for normal use.

- `project` is the default: loops and tasks persist across sessions and process restarts in the same repo, so a 5m cron loop survives closing and reopening pi.
- `session` is best when you want each pi session isolated (e.g. concurrent worktrees, throwaway explorations). Loops disappear when the session ID changes.
- `memory` is best for disposable scratch work, tests, or situations where you explicitly do not want any persisted loop/task state.

### Re-arming loops after a restart

Cron loops re-arm themselves automatically **only if they are bound to this session** (see Per-Session Bindings below). Event/hybrid loops do **not** auto-re-arm their trigger subscriptions — use `/loop-resume <id>` (programmatic equivalent: `LoopDelete({id, action: "resume"})`) to re-bind them.

### Per-session bindings (multi-terminal parallelism)

If you run two or three pi terminals in the same repo and want each one to fire a different subset of loops, use the bindings mechanism:

- Each terminal has its own `.pi/loops/bindings-<sessionId>.json` file listing the loop IDs it has chosen to arm.
- A fresh session (no bindings file yet) starts with **zero** loops armed (strict isolation). Run `/loop-resume <id>` to bind loops for this terminal.
- Terminal A binding loop #5 does **not** cause Terminal B to fire #5, because each session reads only its own bindings file and its trigger subscriptions are process-local.

This is a deliberate behavior change from previous versions, where every session armed every active loop on start.



## Crash analytics (opt-in)

`pi-loop` integrates with [Sentry](https://sentry.io/) for anonymous crash analytics and structured log capture. **Telemetry is strictly opt-in** — leaving `SENTRY_DSN` unset (the default) makes every Sentry callsite a no-op.

To enable reporting:

1. Apply for [Sentry for Open Source](https://sentry.io/for/open-source/) and create a project for `@bramburn/pi-loop`. Once approved, you'll receive a DSN like `https://publickey@o1234567.ingest.us.sentry.io/1234567`.
2. Set `SENTRY_DSN` in your shell environment (or add it to `.env` — see `.env.example`):
   ```bash
   export SENTRY_DSN=https://publickey@o1234567.ingest.us.sentry.io/1234567
   ```
3. Restart pi. The extension will initialize Sentry on load and start capturing:
   - Unhandled exceptions and unhandled promise rejections
   - Tool errors via the `wrapToolExecute` wrapper around every `pi.registerTool` call
   - Breadcrumbs on `session_switch`, `loop_fire`, and tool entry
   - Optional `debug()` log output (controlled by `SENTRY_CAPTURE_LOGS`)

All events are passed through a `beforeSend` hook that strips:
- Absolute filesystem paths (Windows + Unix user dirs)
- `process.env.*` references
- Sentry DSN literals
- Values under sensitive keys (`prompt`, `message`, `text`, `body`, `content`, `description`)
- Stack-frame `filename`/`abs_path` fields

The DSN itself is a *public* client identifier (it's shipped to browsers in Sentry's own SDK) — it only grants permission to *send* events, not to read them. Even so, the DSN is **never** committed to this repository. See `.env.example` for the full telemetry env-var matrix.

For the wider design rationale see [`docs/SENTRY.md`](docs/SENTRY.md).



## Retired tools

The Loop family is now active (see [Status](#install) and [Quick start](#quick-start)). The following tools and commands remain present in source but **not registered** in `src/index.ts` to keep the extension footprint minimal:

| File | What's in it |
|---|---|
| `src/tools/monitor-tools.ts` | `MonitorCreate`, `MonitorList`, `MonitorStop`, `MonitorDelete` |
| `src/tools/native-task-tools.ts` | `TaskCreate`, `TaskList`, `TaskGet`, `TaskClaim`, `TaskHeartbeat`, `TaskUpdate`, `TaskDelete`, `TaskPrune` |
| `src/tools/workflow-tools.ts` | Workflow step-execution tools |
| `src/commands/monitors-command.ts` | `/monitors` command |
| `src/commands/tasks-command.ts` | `/tasks` command |

The infrastructure that would back these tools is still in place: `src/monitor-manager.ts`, `src/task-store.ts`, `src/runtime/task-*.ts` coordinators. To re-enable any of them, add the matching `register*()` call to `src/index.ts` and provide the runtime stubs that the registered tools depend on.

## Limits

25 active loops, 25 running monitors. Recurring loops expire after 7 days.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — [LICENSE](./LICENSE)
````

## File: src/types.ts
````typescript
export type LoopDeletionReason = "task_backlog_empty";

export interface LoopDeletionTombstone {
  id: string;
  reason: LoopDeletionReason;
  deletedAt: number;
  prompt: string;
  pendingCount?: number;
}

export type LoopDeletionTombstoneInput = Omit<LoopDeletionTombstone, "id" | "deletedAt" | "prompt">;

export type LoopStatus = "active" | "paused";

export interface CronTrigger {
  type: "cron";
  schedule: string;
}

export interface EventTrigger {
  type: "event";
  source: string;
  filter?: string;
}

export interface HybridTrigger {
  type: "hybrid";
  cron: string;
  event: { source: string; filter?: string };
  debounceMs: number;
}

export interface DynamicTrigger {
  type: "dynamic";
}

export type Trigger = CronTrigger | EventTrigger | HybridTrigger | DynamicTrigger;

export interface DynamicLoopState {
  goal: string;
  state?: string;
  metrics?: string;
  doneCriteria?: string;
  iteration: number;
  nextWakeAt?: number;
  awaitingUpdate?: boolean;
  lastUpdatedAt?: number;
}

export type WorkflowTerminalStatus = "completed" | "paused";

export interface WorkflowTaskDefinition {
  subject: string;
  description: string;
}

export interface WorkflowStateDefinition {
  prompt: string;
  task?: WorkflowTaskDefinition;
  on?: Record<string, string>;
  terminal?: WorkflowTerminalStatus;
  maxAttempts?: number;
}

export interface WorkflowDefinition {
  version: 1;
  initialState: string;
  states: Record<string, WorkflowStateDefinition>;
}

export interface WorkflowTransitionRecord {
  from: string;
  to: string;
  outcome: string;
  evidence?: string;
  at: number;
  sequence: number;
}

export interface WorkflowRunState {
  definition: WorkflowDefinition;
  currentState: string;
  transitionSeq: number;
  stateEnteredAt: number;
  attemptsByState: Record<string, number>;
  activeTaskId?: string;
  lastTransition?: WorkflowTransitionRecord;
}

export interface LoopEntry {
  id: string;
  prompt: string;
  trigger: Trigger;
  status: LoopStatus;
  recurring: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  autoTask?: boolean;
  taskBacklog?: boolean;
  readOnly?: boolean;
  maxFires?: number;
  fireCount?: number;
  dynamic?: DynamicLoopState;
  workflow?: WorkflowRunState;
}

export interface LoopStoreData {
  nextId: number;
  loops: LoopEntry[];
}

export interface MonitorEntry {
  id: string;
  command: string;
  description?: string;
  timeout: number;
  status: "running" | "completed" | "error" | "stopped";
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  outputLines: number;
  outputBuffer: string[];
  lastOutputAt?: number;
  outputRatePerMinute?: number;
  progress?: MonitorProgress;
}

export interface MonitorProgress {
  current?: number;
  total?: number;
  message?: string;
  source: "jsonl" | "agent";
  updatedAt: number;
}

export interface MonitorProcess {
  entry: MonitorEntry;
  pid: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
  completionCallbacks: Array<() => void>;
  lastOutputEventAt: number;
  lastProgressChangeAt: number;
  progressChangeTimer?: ReturnType<typeof setTimeout>;
  pendingOutputLines: number;
  latestOutputLine?: string;
  outputBuckets: Array<{ second: number; count: number }>;
  stdoutDecoder: import("node:string_decoder").StringDecoder;
  stderrDecoder: import("node:string_decoder").StringDecoder;
  stdoutRemainder: string;
  stderrRemainder: string;
}
````

## File: src/store.ts
````typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { type LoopReducerEvent, type LoopReducerState, reduceLoopState } from "./loop-reducer.js";
import { ReducerBackedStore } from "./reducer-backed-store.js";
import type { DynamicLoopState, LoopDeletionTombstone, LoopDeletionTombstoneInput, LoopEntry, LoopStoreData, Trigger, WorkflowDefinition, WorkflowTerminalStatus } from "./types.js";
import { isTerminalWorkflowRun, transitionWorkflowRun, validateWorkflowDefinition, type WorkflowTransitionFailure, type WorkflowTransitionInput } from "./workflow-reducer.js";

const LOOPS_DIR = join(homedir(), ".pi", "loops");
const MAX_LOOPS = 25;
const TOMBSTONE_TTL_MS = 10 * 60 * 1000;

export class LoopStore extends ReducerBackedStore<LoopEntry, LoopReducerState, LoopReducerEvent, LoopStoreData> {
  private tombstones = new Map<string, LoopDeletionTombstone>();

  constructor(listIdOrPath?: string) {
    super(
      {
        baseDir: LOOPS_DIR,
        reduce: (state, event) => reduceLoopState(state, event),
        toReducerState: (nextId, entries) => ({ nextId, loopsById: Object.fromEntries(entries.entries()) }),
        fromReducerState: (state) => ({ nextId: state.nextId, entries: new Map(Object.entries(state.loopsById)) }),
        serialize: (nextId, entries) => ({ nextId, loops: Array.from(entries.values()) }),
        deserialize: (data) => ({ nextId: data.nextId, entries: new Map(data.loops.map((l) => [l.id, l])) }),
      },
      listIdOrPath,
    );
  }

  create(trigger: Trigger, prompt: string, opts: { recurring: boolean; autoTask?: boolean; taskBacklog?: boolean; readOnly?: boolean; maxFires?: number; dynamic?: Partial<DynamicLoopState>; workflow?: WorkflowDefinition }): LoopEntry {
    return this.withLock(() => {
      if (this.entries.size >= MAX_LOOPS) {
        throw new Error(`Maximum of ${MAX_LOOPS} loops reached. Delete some before creating new ones.`);
      }
      if (opts.workflow) {
        if (trigger.type !== "dynamic") throw new Error("Workflow loops require a dynamic trigger.");
        const validationError = validateWorkflowDefinition(opts.workflow);
        if (validationError) throw new Error(`Invalid workflow: ${validationError}`);
      }
      const now = Date.now();
      this.applyReducerEvent({
        type: "LOOP_CREATED",
        at: now,
        source: "tool",
        entityType: "loop",
        payload: {
          prompt,
          trigger,
          recurring: opts.recurring,
          autoTask: opts.autoTask,
          taskBacklog: opts.taskBacklog,
          readOnly: opts.readOnly,
          maxFires: opts.maxFires,
          dynamic: opts.dynamic,
          workflow: opts.workflow,
        },
      });
      return this.entries.get(String(this.nextId - 1))!;
    });
  }

  pause(id: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      this.applyReducerEvent({
        type: "LOOP_PAUSED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  resume(id: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || isTerminalWorkflowRun(entry.workflow)) return undefined;
      this.applyReducerEvent({
        type: "LOOP_RESUMED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      if (entry.trigger.type === "dynamic" && entry.dynamic?.awaitingUpdate) {
        this.applyReducerEvent({
          type: "LOOP_DYNAMIC_UPDATED",
          at: Date.now(),
          source: "tool",
          entityType: "loop",
          entityId: id,
          payload: {
            id,
            dynamic: {
              awaitingUpdate: false,
              lastUpdatedAt: Date.now(),
            },
          },
        });
      }
      return this.entries.get(id);
    });
  }

  fire(id: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      this.applyReducerEvent({
        type: "LOOP_FIRED",
        at: Date.now(),
        source: "system",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  updateMetadata(id: string, fields: { trigger?: Trigger; prompt?: string; taskBacklog?: boolean }): { entry: LoopEntry | undefined; changedFields: string[] } {
    return this.withLock(() => {
      const current = this.entries.get(id);
      if (!current) return { entry: undefined, changedFields: [] };

      const changedFields: string[] = [];
      const now = Date.now();

      if (fields.trigger !== undefined) {
        current.trigger = fields.trigger;
        changedFields.push("trigger");
      }
      if (fields.prompt !== undefined && fields.prompt !== current.prompt) {
        current.prompt = fields.prompt;
        changedFields.push("prompt");
      }
      if (fields.taskBacklog !== undefined && fields.taskBacklog !== current.taskBacklog) {
        current.taskBacklog = fields.taskBacklog;
        changedFields.push("taskBacklog");
      }
      if (changedFields.length > 0) {
        current.updatedAt = now;
      }

      return { entry: this.entries.get(id), changedFields };
    });
  }


  updateDynamic(id: string, fields: { prompt?: string; dynamic: Partial<DynamicLoopState> }): LoopEntry | undefined {
    return this.withLock(() => {
      if (!this.entries.has(id)) return undefined;
      this.applyReducerEvent({
        type: "LOOP_DYNAMIC_UPDATED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id, prompt: fields.prompt, dynamic: fields.dynamic },
      });
      return this.entries.get(id);
    });
  }

  continueDynamic(
    id: string,
    fields: { prompt?: string; dynamic: Partial<DynamicLoopState> },
    expected?: { status: LoopEntry["status"]; iteration: number; updatedAt: number },
  ): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || entry.trigger.type !== "dynamic" || !entry.dynamic || entry.workflow) return undefined;
      if (expected && (
        entry.status !== expected.status
        || entry.dynamic.iteration !== expected.iteration
        || entry.updatedAt !== expected.updatedAt
      )) return undefined;
      const now = Date.now();
      if (entry.status === "paused") {
        this.applyReducerEvent({
          type: "LOOP_RESUMED",
          at: now,
          source: "tool",
          entityType: "loop",
          entityId: id,
          payload: { id },
        });
      }
      this.applyReducerEvent({
        type: "LOOP_DYNAMIC_UPDATED",
        at: now,
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id, prompt: fields.prompt, dynamic: fields.dynamic },
      });
      return this.entries.get(id);
    });
  }

  stopDynamic(
    id: string,
    status: "completed" | "paused",
    expected: { status: LoopEntry["status"]; iteration: number; updatedAt: number },
  ): boolean {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || entry.trigger.type !== "dynamic" || !entry.dynamic || entry.workflow
        || entry.status !== expected.status
        || entry.dynamic.iteration !== expected.iteration
        || entry.updatedAt !== expected.updatedAt) return false;
      this.applyReducerEvent({
        type: status === "completed" ? "LOOP_DELETED" : "LOOP_PAUSED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return true;
    });
  }

  transitionWorkflow(
    id: string,
    input: WorkflowTransitionInput,
    expected?: { currentState: string; transitionSeq: number; activeTaskId?: string },
  ): { entry?: LoopEntry; applied: boolean; error?: string; failure?: WorkflowTransitionFailure; terminal?: WorkflowTerminalStatus } {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return { applied: false, error: `Loop #${id} not found` };
      if (!entry.workflow) return { applied: false, error: `Loop #${id} is not a workflow loop` };
      if (expected && (
        entry.workflow.currentState !== expected.currentState
        || entry.workflow.transitionSeq !== expected.transitionSeq
        || entry.workflow.activeTaskId !== expected.activeTaskId
      )) {
        return { applied: false, error: `Workflow #${id} changed; inspect LoopList and retry the transition.` };
      }

      const result = transitionWorkflowRun(entry.workflow, input, Date.now());
      if (!result.applied) {
        return { applied: false, error: result.error, failure: result.failure };
      }

      this.applyReducerEvent({
        type: "LOOP_WORKFLOW_TRANSITION",
        at: result.run.stateEnteredAt,
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: {
          id,
          outcome: input.outcome,
          evidence: input.evidence,
          activeTaskId: input.activeTaskId,
        },
      });
      return { entry: this.entries.get(id), applied: true, terminal: result.terminal };
    });
  }

  setWorkflowActiveTask(
    id: string,
    taskId?: string,
    expected?: { currentState: string; transitionSeq: number; activeTaskId?: string },
  ): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry?.workflow) return undefined;
      if (expected && (
        entry.workflow.currentState !== expected.currentState
        || entry.workflow.transitionSeq !== expected.transitionSeq
        || entry.workflow.activeTaskId !== expected.activeTaskId
      )) return undefined;
      this.applyReducerEvent({
        type: "LOOP_WORKFLOW_TASK_SET",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id, taskId },
      });
      return this.entries.get(id);
    });
  }

  getDeletionTombstone(id: string): LoopDeletionTombstone | undefined {
    const tombstone = this.tombstones.get(id);
    if (!tombstone) return undefined;
    if (Date.now() - tombstone.deletedAt <= TOMBSTONE_TTL_MS) return tombstone;
    this.tombstones.delete(id);
    return undefined;
  }

  recordDeletionTombstone(id: string, input: LoopDeletionTombstoneInput): LoopDeletionTombstone | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const tombstone: LoopDeletionTombstone = {
      id,
      reason: input.reason,
      pendingCount: input.pendingCount,
      deletedAt: Date.now(),
      prompt: entry.prompt,
    };
    this.tombstones.set(id, tombstone);
    return tombstone;
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.entries.has(id)) return false;
      this.applyReducerEvent({
        type: "LOOP_DELETED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return true;
    });
  }

  clearExpired(): number {
    return this.withLock(() => {
      const now = Date.now();
      let count = 0;
      for (const [id, entry] of [...this.entries.entries()]) {
        if (now < entry.expiresAt) continue;
        this.applyReducerEvent(entry.workflow
          ? {
              type: "LOOP_PAUSED",
              at: now,
              source: "system",
              entityType: "loop",
              entityId: id,
              payload: { id },
            }
          : {
              type: "LOOP_EXPIRED",
              at: now,
              source: "system",
              entityType: "loop",
              entityId: id,
              payload: { id, reason: "expires_at" },
            });
        count++;
      }
      return count;
    });
  }

  expireEventLoops(sessionStartedAt: number): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, entry] of [...this.entries.entries()]) {
        if (entry.status !== "active") continue;
        if (entry.trigger.type !== "event" && entry.trigger.type !== "hybrid") continue;
        const eventSource = entry.trigger.type === "event" ? entry.trigger.source : entry.trigger.event.source;
        if (entry.taskBacklog && eventSource === "tasks:created") continue;
        if (entry.createdAt >= sessionStartedAt) continue;
        this.applyReducerEvent({
          type: "LOOP_EXPIRED",
          at: sessionStartedAt,
          source: "session",
          entityType: "loop",
          entityId: id,
          payload: { id, reason: "resume_event_stale" },
        });
        count++;
      }
      return count;
    });
  }

  clearAll(options?: { preserveWorkflows?: boolean }): number {
    return this.withLock(() => {
      const entries = [...this.entries.values()];
      for (const entry of entries) {
        this.applyReducerEvent(options?.preserveWorkflows && entry.workflow
          ? {
              type: "LOOP_PAUSED",
              at: Date.now(),
              source: "system",
              entityType: "loop",
              entityId: entry.id,
              payload: { id: entry.id },
            }
          : {
              type: "LOOP_DELETED",
              at: Date.now(),
              source: "system",
              entityType: "loop",
              entityId: entry.id,
              payload: { id: entry.id },
            });
      }
      return entries.length;
    });
  }
}
````

## File: src/index.ts
````typescript
/**
 * @bramburn/pi-loop — A pi extension providing cron/event-based agent re-wake loops.
 *
 * Tools (registered):
 *   LoopCreate    — Create a scheduled or event-triggered re-wake loop
 *   LoopUpdate    — Update progress for a dynamic loop
 *   LoopList      — List all active loops with status and next-fire times
 *   LoopDelete    — Delete or pause a loop by ID
 *
 * Commands (registered):
 *   /loop         — Schedule or manage re-wake loops: /loop [interval] [prompt]
 *   /loop-resume  — Re-arm a stored loop by ID (or open the picker with no args)
 *
 * DISABLED (per upstream constraint): MonitorXxx, TaskXxx, /monitors, /tasks,
 * and workflow-tools remain unregistered. The MonitorManager class is still
 * instantiated so the LoopWidget can show a zero-count summary, but no
 * monitor tools or command are wired up.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLoopCommand } from "./commands/loop-command.js";
import { registerSettingsCommand } from "./commands/settings-command.js";
import { atMaxFires } from "./loop-reducer.js";
import { migrateV1ToV2 } from "./migration/v1-to-v2.js";
import { MonitorManager } from "./monitor-manager.js";
import { BindingsStore } from "./runtime/bindings-store.js";
import {
  createNotificationRuntime,
  type LoopFireEvent,
} from "./runtime/notification-runtime.js";
import { type LoopScope, resolveBindingsPath, resolveLoopStorePath } from "./runtime/scope.js";
import { registerSessionRuntimeHooks } from "./runtime/session-runtime.js";
import { CronScheduler } from "./scheduler.js";
import { loadSettings, type PiLoopSettings } from "./settings.js";
import { LoopStore } from "./store.js";
import { addBreadcrumb, initSentry, isSentryInitialized, logDebug, wrapToolExecute } from "./telemetry/sentry.js";
import { registerLoopTools } from "./tools/loop-tools.js";
import { snapshotFromLoop, syncLoopTools } from "./tools/tool-visibility.js";
import { TriggerSystem } from "./trigger-system.js";
import type { LoopEntry } from "./types.js";
import { LoopWidget } from "./ui/widget.js";

initSentry();

// Per ADR-003, v2.0 reads settings from .pi/pi-loop-settings.json. Env vars
// (PI_LOOP_SCOPE, PI_LOOP_DEBUG, PI_LOOP_TASK_THRESHOLD, PI_LOOP) are
// captured once by the v1-to-v2 migration into the file and ignored
// thereafter.
function loadInitialSettings(): PiLoopSettings {
  const cwd = process.cwd();
  const result = migrateV1ToV2(cwd, process.env);
  if (result.migrated && result.banner) {
    console.error(`[pi-loop] ${result.banner}`);
  }
  return loadSettings(cwd);
}

let _initialSettings = loadInitialSettings();

const DEBUG = _initialSettings.debug;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-loop]", ...args);
  if (isSentryInitialized()) logDebug("[pi-loop]", ...args);
}

export default function (pi: ExtensionAPI) {
  // Wrap every tool's execute() with a Sentry-capturing try/catch. Done once
  // here so the tool registrations in src/tools/*.ts don't need per-call
  // try/catch boilerplate. The wrapper re-throws so the tool framework still
  // sees the original error.
  interface ToolDefinitionLike {
    name: string;
    execute?: (...args: unknown[]) => Promise<unknown>;
    [key: string]: unknown;
  }
  type WideRegisterTool = (def: ToolDefinitionLike) => void;
  const _realRegisterTool: WideRegisterTool = (pi.registerTool.bind(pi) as unknown) as WideRegisterTool;
  (pi as unknown as { registerTool: WideRegisterTool }).registerTool = (def: ToolDefinitionLike) => {
    const wrapped = {
      ...def,
      execute: def.execute
        ? wrapToolExecute(def.name, def.execute)
        : def.execute,
    };
    return _realRegisterTool(wrapped);
  };

  addBreadcrumb("extension_loaded");

  // Per ADR-003, settings come from .pi/pi-loop-settings.json (with v1.x
  // migration already applied at module load). PI_LOOP_SCOPE and PI_LOOP
  // env vars are no longer read — use /loop-settings to change loopScope.
  const piLoopEnv: string | undefined = undefined;
  const loopScope: LoopScope = _initialSettings.loopScope;

  const getScopeOptions = () => ({ piLoopEnv, loopScope });

  // Hoisted so the BindingsStore below can reference it on init.
  let _latestCtx: ExtensionContext | undefined;
  let _sessionId: string | undefined;

  let store = new LoopStore(resolveLoopStorePath(getScopeOptions()));
  // MonitorManager is instantiated so the LoopWidget can render the monitor
  // count, but no monitor tools or /monitors command are registered in this
  // build (kept disabled per upstream constraint).
  const monitorManager = new MonitorManager(pi);
  let scheduler: CronScheduler;
  let triggerSystem: TriggerSystem;
  // Per-session loop bindings — see docs/loop-governor-design.md.
  // Initial path is undefined because the sessionId is not yet known at
  // extension load time; the session-runtime hook swaps it on session_switch.
  let bindingsStore = new BindingsStore(resolveBindingsPath(getScopeOptions(), _sessionId), loopScope, _sessionId);
  const widget = new LoopWidget(store, monitorManager);

  scheduler = new CronScheduler(store, onLoopFire);
  triggerSystem = new TriggerSystem(pi, scheduler, store, onLoopFire);

  // ── Task hooks (stubs) ──
  // pi-tasks / native task fallback is disabled in this build, but
  // session-runtime and notification-runtime still expect these as
  // dependency-injected callbacks. Provide no-ops so loops can fire without
  // any task coordination.
  const hasPendingTasks = async (): Promise<number> => 0;
  const cleanDoneTasks = async (): Promise<void> => {};
  const migrateTaskBacklogLoops = (): number => 0;
  const cleanupTaskBacklogLoops = async (): Promise<number> => 0;
  const adoptTaskBacklogLoops = async (_baseline?: ReadonlyMap<string, number>): Promise<number> => 0;
  const releaseTaskBacklogWakes = (): void => {};
  // LoopCreate with taskBacklog=true would normally bootstrap an immediate
  // wake from existing pending tasks. Since tasks are disabled, return false.
  const maybeBootstrapTaskLoop = async (_entry: LoopEntry): Promise<boolean> => false;
  const isTaskSystemReady = (): boolean => false;
  // workflow-tools is disabled, so there is never a workflow task to close.
  // Returning true lets LoopDelete proceed past the workflow-task guard.
  const closeWorkflowTask = async (_taskId: string, _claimId?: string): Promise<boolean> => true;

  const notificationRuntime = createNotificationRuntime({
    pi,
    hasPendingTasks,
    cleanDoneTasks,
    getHasPendingMessages: () => _latestCtx?.hasPendingMessages() ?? false,
    debug,
  });

  // ── Loop fire handler ──

  function onLoopFire(entry: LoopEntry): void {
    debug(`loop:fire #${entry.id}`, { prompt: entry.prompt.slice(0, 50) });

    if (atMaxFires(entry)) {
      debug(`loop #${entry.id} — reached maxFires ${entry.maxFires}, expiring`);
      store.delete(entry.id);
      return;
    }
    store.fire(entry.id);

    // The widget renders the firing loop's row with a "-> firing (Ns ago)"
    // suffix for 5 seconds, refreshing every 1s while the indicator is
    // visible. setFiringStatus also starts the internal ticker.
    widget.setFiringStatus(entry.id, entry.prompt);

    pi.events.emit("loop:fire", {
      loopId: entry.id,
      prompt: entry.prompt,
      trigger: entry.trigger,
      timestamp: Date.now(),
      readOnly: entry.readOnly,
      recurring: entry.recurring,
      autoTask: entry.autoTask,
    });
  }

  // ── Session lifecycle ──

  registerSessionRuntimeHooks({
    pi,
    getLoopScope: () => loopScope,
    getPiLoopEnv: () => piLoopEnv,
    recreateSessionStore: (sessionId: string) => {
      const path = resolveLoopStorePath(getScopeOptions(), sessionId);
      store = new LoopStore(path);
      widget.setStore(store);
      scheduler = new CronScheduler(store, onLoopFire);
      triggerSystem = new TriggerSystem(pi, scheduler, store, onLoopFire);
      bindingsStore = new BindingsStore(resolveBindingsPath(getScopeOptions(), sessionId), loopScope);
    },
    clearAllLoops: () => {
      store.clearAll();
    },
    getStore: () => store,
    getScheduler: () => scheduler,
    getTriggerSystem: () => triggerSystem,
    setLatestCtx: (ctx) => {
      _latestCtx = ctx;
    },
    setSessionId: (sessionId) => {
      _sessionId = sessionId;
      const expectedPath = resolveBindingsPath(getScopeOptions(), sessionId);
      if (bindingsStore.path !== expectedPath) {
        bindingsStore = new BindingsStore(expectedPath, loopScope, sessionId);
      }
    },
    widget,
    getLoopSnapshots: () => store.list().map(snapshotFromLoop),
    notificationRuntime,
    flushPendingNotifications: notificationRuntime.flushPendingNotifications,
    migrateTaskBacklogLoops,
    cleanupTaskBacklogLoops,
    adoptTaskBacklogLoops,
    releaseTaskBacklogWakes,
    hasPendingTasks,
    cleanDoneTasks,
    showLoopListOverlayFn: undefined,
    showEscapeDialogFn: undefined,
  });

  // ── Loop fire → delivery ──

  const { queueOrDeliverNotification } = notificationRuntime;

  // Per ADR-002: re-sync the LLM's active tool set after every store
  // mutation. Cheap (microseconds) but ensures the LLM can never call a
  // tool that the current loop state has just invalidated.
  function refreshToolVisibility(): void {
    syncLoopTools(pi, store.list().map(snapshotFromLoop));
  }

  pi.events.on("loop:fire", async (event: unknown) => {
    const data = event as LoopFireEvent;
    refreshToolVisibility();
    await queueOrDeliverNotification(data);
  });

  registerLoopTools({
    pi,
    getStore: () => store,
    getTriggerSystem: () => triggerSystem,
    getScheduler: () => scheduler,
    getMonitorManager: () => monitorManager,
    updateWidget: () => {
      widget.update();
      refreshToolVisibility();
    },
    maybeBootstrapTaskLoop,
    isTaskSystemReady,
    closeWorkflowTask,
  });

  registerLoopCommand({
    pi,
    getStore: () => store,
    getTriggerSystem: () => triggerSystem,
    updateWidget: () => {
      widget.update();
      refreshToolVisibility();
    },
    maybeBootstrapTaskLoop,
  });

  registerSettingsCommand({
    pi,
    getCwd: () => process.cwd(),
  });
}
````
