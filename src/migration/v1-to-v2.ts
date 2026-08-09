/**
 * One-shot migration from pi-loop v1.x to v2.0.
 *
 * Per ADR-003, this is a clean break: v1.x files (`tasks-config.json`) and
 * env vars (`PI_LOOP_SCOPE`, `PI_LOOP_DEBUG`, `PI_LOOP_TASK_THRESHOLD`,
 * `PI_LOOP`) are migrated once on first v2 startup. The v1 file is renamed
 * to `.v1.bak`. Env vars are captured into the new settings file but no
 * longer read after migration.
 *
 * The migration is idempotent: it only fires when the new settings file
 * does NOT exist. Subsequent startups do nothing.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type PiLoopSettings } from "../settings.js";

const V1_CONFIG_FILE = "tasks-config.json";
const V2_CONFIG_FILE = "pi-loop-settings.json";

export interface MigrationResult {
  /** Whether the migration actually ran (false if already migrated or no v1 data). */
  migrated: boolean;
  /** Optional banner message for the user. */
  banner?: string;
  /** Path the v2 settings file lives at. */
  v2Path: string;
  /** Path of the v1 file that was corrupt (if any). Caller can decide whether to surface this. */
  corruptV1Path?: string;
}

interface V1TasksConfig {
  taskScope?: "memory" | "session" | "project";
  sortOrder?: "id" | "status" | "recent" | "oldest";
  maxVisible?: number;
  showAll?: boolean;
  hiddenAt?: "top" | "bottom";
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";
}

function isV1LoopScope(value: unknown): value is "memory" | "session" | "project" {
  return value === "memory" || value === "session" || value === "project";
}

/**
 * Run the v1 -> v2 migration if needed. Returns metadata about what (if
 * anything) happened. Always returns the v2 path so the caller can confirm
 * where to read from.
 */
export function migrateV1ToV2(cwd: string, env: NodeJS.ProcessEnv = process.env): MigrationResult {
  const v2Path = join(cwd, ".pi", V2_CONFIG_FILE);
  const v1Path = join(cwd, ".pi", V1_CONFIG_FILE);
  let corruptV1Path: string | undefined;

  // Already migrated (or no prior data) — nothing to do.
  if (existsSync(v2Path)) {
    return { migrated: false, v2Path };
  }

  const hasV1File = existsSync(v1Path);
  const hasV1EnvVars =
    env.PI_LOOP_SCOPE !== undefined ||
    env.PI_LOOP_DEBUG !== undefined ||
    env.PI_LOOP_TASK_THRESHOLD !== undefined ||
    env.PI_LOOP_TASK_WORKER_THRESHOLD !== undefined;

  if (!hasV1File && !hasV1EnvVars) {
    // Nothing to migrate. Don't write the v2 file — let DEFAULT_SETTINGS apply.
    return { migrated: false, v2Path };
  }

  const merged: PiLoopSettings = { ...DEFAULT_SETTINGS };

  if (hasV1File) {
    try {
      const raw = JSON.parse(readFileSync(v1Path, "utf-8")) as V1TasksConfig;
      if (raw.taskScope !== undefined) merged.taskScope = raw.taskScope;
      if (raw.sortOrder !== undefined) merged.sortOrder = raw.sortOrder;
      if (typeof raw.maxVisible === "number") merged.maxVisible = raw.maxVisible;
      if (typeof raw.showAll === "boolean") merged.showAll = raw.showAll;
      if (raw.hiddenAt !== undefined) merged.hiddenAt = raw.hiddenAt;
      if (raw.autoClearCompleted !== undefined) merged.autoClear = raw.autoClearCompleted;
    } catch (err) {
      // Corrupt v1 file — fall through to env-var capture, leave v1 in place.
      // Surface the error so the user can recover the file manually.
      console.error(`[pi-loop] migration: failed to parse ${v1Path}: ${err instanceof Error ? err.message : String(err)}`);
      corruptV1Path = v1Path;
    }
  }

  if (isV1LoopScope(env.PI_LOOP_SCOPE)) {
    merged.loopScope = env.PI_LOOP_SCOPE;
  }
  if (env.PI_LOOP_DEBUG === "1" || env.PI_LOOP_DEBUG === "true") {
    merged.debug = true;
  }
  if (env.PI_LOOP_TASK_THRESHOLD !== undefined) {
    const n = Number.parseInt(env.PI_LOOP_TASK_THRESHOLD, 10);
    if (!Number.isNaN(n) && n >= 1) merged.taskThreshold = n;
  }

  // Write v2 file.
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(v2Path, JSON.stringify(merged, null, 2), "utf-8");

  // Rename v1 file (if any) to .v1.bak so the user can recover manually.
  if (hasV1File) {
    try {
      renameSync(v1Path, `${v1Path}.v1.bak`);
    } catch {
      // Best-effort; v2 file is the source of truth now.
    }
  }

  const bannerParts = [`pi-loop v2.0 migrated your config to .pi/${V2_CONFIG_FILE}.`];
  if (hasV1File) bannerParts.push(`The v1 file is at .pi/${V1_CONFIG_FILE}.v1.bak.`);
  if (corruptV1Path) {
    bannerParts.push(
      `Warning: ${corruptV1Path} was corrupt and could not be parsed; defaults applied for missing fields. Inspect the file manually.`,
    );
  }
  if (hasV1EnvVars) {
    bannerParts.push(
      "PI_LOOP_SCOPE / PI_LOOP_DEBUG / PI_LOOP_TASK_THRESHOLD env vars are no longer read; their values were captured into the file.",
    );
  }

  return {
    migrated: true,
    banner: bannerParts.join(" "),
    v2Path,
    corruptV1Path,
  };
}
