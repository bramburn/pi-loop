/**
 * Unified pi-loop settings. Replaces the v1.x scattered config:
 *  - tasks-config.ts (TasksConfig)
 *  - PI_LOOP_SCOPE env var (LoopScope)
 *  - PI_LOOP_DEBUG env var (debug)
 *  - PI_LOOP_TASK_THRESHOLD env var (taskThreshold)
 *  - PI_LOOP custom path support
 *
 * Per ADR-003, the v2.0 file is .pi/pi-loop-settings.json with strict schema.
 * Migration from v1.x is handled by src/migration/v1-to-v2.ts.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LoopScope = "memory" | "session" | "project";

export type SortOrder = "id" | "status" | "recent" | "oldest";
export type AutoClearMode = "never" | "on_list_complete" | "on_task_complete";
export type HiddenAt = "top" | "bottom";

export interface UrgentFlushThresholds {
  /** Defer-priority age (ms) before force-flush. Default: 24h — defer waits for all higher priority. */
  defer: number;
  /** Normal-priority age (ms) before force-flush. Default: 5 minutes. */
  normal: number;
  /** Urgent-priority age (ms) before force-flush. Default: 30 seconds. */
  urgent: number;
  /** Critical-priority age (ms) before force-flush. Default: 0 (immediate). */
  critical: number;
}

export interface PiLoopSettings {
  /** Where loop state is persisted. */
  loopScope: LoopScope;
  /** Where task state is persisted. */
  taskScope: LoopScope;
  /** Whether the extension logs verbose debug output. */
  debug: boolean;
  /** When completed tasks are auto-cleared. */
  autoClear: AutoClearMode;
  /** Order tasks are listed in the widget. */
  sortOrder: SortOrder;
  /** Where completed tasks fold away in the widget. */
  hiddenAt: HiddenAt;
  /** Maximum tasks shown in the widget. */
  maxVisible: number;
  /** Show all tasks regardless of maxVisible. */
  showAll: boolean;
  /** Threshold for auto-creating a backlog worker loop. */
  taskThreshold: number;
  /** Priority-based aging thresholds for force-flushing queued notifications. */
  urgentFlushThresholds: UrgentFlushThresholds;
}

export const DEFAULT_SETTINGS: PiLoopSettings = {
  loopScope: "project",
  taskScope: "session",
  debug: false,
  autoClear: "on_list_complete",
  sortOrder: "id",
  hiddenAt: "bottom",
  maxVisible: 10,
  showAll: false,
  taskThreshold: 5,
  urgentFlushThresholds: {
    defer: 86_400_000,   // 24 hours
    normal: 300_000,      // 5 minutes
    urgent: 30_000,      // 30 seconds
    critical: 0,          // immediate
  },
};

const CONFIG_DIR = ".pi";
const CONFIG_FILE = "pi-loop-settings.json";

const ALLOWED_KEYS = new Set<keyof PiLoopSettings | string>([
  "loopScope",
  "taskScope",
  "debug",
  "autoClear",
  "sortOrder",
  "hiddenAt",
  "maxVisible",
  "showAll",
  "taskThreshold",
  "urgentFlushThresholds",
]);

function resolveConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR, CONFIG_FILE);
}

function asScope(value: unknown): LoopScope | undefined {
  return value === "memory" || value === "session" || value === "project"
    ? value
    : undefined;
}

function asSortOrder(value: unknown): SortOrder | undefined {
  if (value === "id" || value === "status" || value === "recent" || value === "oldest") {
    return value;
  }
  return undefined;
}

function asAutoClear(value: unknown): AutoClearMode | undefined {
  if (value === "never" || value === "on_list_complete" || value === "on_task_complete") {
    return value;
  }
  return undefined;
}

function asHiddenAt(value: unknown): HiddenAt | undefined {
  return value === "top" || value === "bottom" ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (!Number.isNaN(n) && n >= 1) return n;
  }
  return undefined;
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  return undefined;
}

function asUrgentFlushThresholds(value: unknown): UrgentFlushThresholds | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const defer = asNonNegativeInt(obj.defer);
  const normal = asNonNegativeInt(obj.normal);
  const urgent = asNonNegativeInt(obj.urgent);
  const critical = asNonNegativeInt(obj.critical);
  if (defer === undefined || normal === undefined || urgent === undefined || critical === undefined) {
    return undefined;
  }
  return { defer, normal, urgent, critical };
}

/**
 * Parse raw JSON into a PiLoopSettings object. Rejects unknown keys
 * (strict schema). Returns defaults for missing or invalid fields.
 */
export function parseSettings(raw: unknown): PiLoopSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SETTINGS };
  }
  const record = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown pi-loop-settings.json key(s): ${unknownKeys.join(", ")}`);
  }
  const next: PiLoopSettings = { ...DEFAULT_SETTINGS };
  const loopScope = asScope(record.loopScope);
  const taskScope = asScope(record.taskScope);
  const debug = asBool(record.debug);
  const autoClear = asAutoClear(record.autoClear);
  const sortOrder = asSortOrder(record.sortOrder);
  const hiddenAt = asHiddenAt(record.hiddenAt);
  const maxVisible = asPositiveInt(record.maxVisible);
  const showAll = asBool(record.showAll);
  const taskThreshold = asPositiveInt(record.taskThreshold);
  if (loopScope !== undefined) next.loopScope = loopScope;
  if (taskScope !== undefined) next.taskScope = taskScope;
  if (debug !== undefined) next.debug = debug;
  if (autoClear !== undefined) next.autoClear = autoClear;
  if (sortOrder !== undefined) next.sortOrder = sortOrder;
  if (hiddenAt !== undefined) next.hiddenAt = hiddenAt;
  if (maxVisible !== undefined) next.maxVisible = maxVisible;
  if (showAll !== undefined) next.showAll = showAll;
  if (taskThreshold !== undefined) next.taskThreshold = taskThreshold;
  const urgentFlushThresholds = asUrgentFlushThresholds(record.urgentFlushThresholds);
  if (urgentFlushThresholds !== undefined) next.urgentFlushThresholds = urgentFlushThresholds;
  return next;
}

/**
 * Load settings from the .pi/pi-loop-settings.json file. Falls back to
 * defaults when the file is missing, malformed, or has an unknown key.
 *
 * The error is logged to console.error so a corrupt settings file doesn't
 * crash the extension on startup.
 */
export function loadSettings(cwd: string): PiLoopSettings {
  const path = resolveConfigPath(cwd);
  try {
    if (!readFileSync) return { ...DEFAULT_SETTINGS };
    return parseSettings(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Unknown pi-loop-settings.json key")) {
      console.error(`[pi-loop] ${err.message}`);
    }
    return { ...DEFAULT_SETTINGS };
  }
}

/** Save settings to disk as pretty-printed JSON. */
export function saveSettings(cwd: string, settings: PiLoopSettings): void {
  const dir = join(cwd, CONFIG_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, CONFIG_FILE);
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8");
}

/** Apply a partial update to the persisted settings and return the new state. */
export function updateSettings(cwd: string, partial: Partial<PiLoopSettings>): PiLoopSettings {
  const current = loadSettings(cwd);
  const next = { ...current, ...partial };
  saveSettings(cwd, next);
  return next;
}

/** Returns true when the settings file exists on disk. */
export function settingsFileExists(cwd: string): boolean {
  try {
    readFileSync(resolveConfigPath(cwd), "utf-8");
    return true;
  } catch {
    return false;
  }
}
