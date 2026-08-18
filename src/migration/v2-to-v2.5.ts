/**
 * One-shot migration from v2.x to v2.5 (sub-agent execution mode).
 *
 * On first startup with v2.5, this migration adds the `subAgent` block to
 * `.pi/pi-loop-settings.json` with all defaults. Existing loops are
 * unaffected (the new fields on `LoopEntry` are all optional; missing means
 * "use the default" and `isolation` defaults to `"in-process"`).
 *
 * Idempotent: running it twice is a no-op.
 * No-touch: it only writes the file if the `subAgent` block is missing; it
 * does not touch any other field.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SUB_AGENT_SETTINGS, parseSettings } from "../settings.js";

const CONFIG_DIR = ".pi";
const CONFIG_FILE = "pi-loop-settings.json";

export interface MigrationResult {
  changed: boolean;
  reason: "added-subAgent-block" | "already-migrated" | "no-settings-file" | "write-failed";
  path: string;
}

export function migrateV2ToV25(cwd: string): MigrationResult {
  const path = join(cwd, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(path)) {
    return { changed: false, reason: "no-settings-file", path };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { changed: false, reason: "write-failed", path };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { changed: false, reason: "write-failed", path };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.subAgent !== undefined) {
    return { changed: false, reason: "already-migrated", path };
  }
  obj.subAgent = { ...DEFAULT_SUB_AGENT_SETTINGS, envOverrides: {} };
  try {
    // Round-trip through parseSettings to validate the final shape; if it
    // throws (unknown key, etc.) the migration is aborted with a clear error.
    parseSettings(obj);
  } catch {
    return { changed: false, reason: "write-failed", path };
  }
  try {
    writeFileSync(path, JSON.stringify(obj, null, 2), "utf-8");
    return { changed: true, reason: "added-subAgent-block", path };
  } catch {
    return { changed: false, reason: "write-failed", path };
  }
}
