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