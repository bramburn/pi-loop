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

export type LoopScope = "memory" | "session" | "project" | "shared";

export type SortOrder = "id" | "status" | "recent" | "oldest";
export type AutoClearMode = "never" | "on_list_complete" | "on_task_complete";
export type HiddenAt = "top" | "bottom";

/**
 * Per-execution-mode settings for sub-agent loops. All fields optional
 * with safe defaults. See `docs/PRD/sub-agent.md` §11.
 */
export interface SubAgentSettings {
  /** Default isolation for new loops created by /loop. /loop-subagent is always "sub-agent". */
  defaultIsolation?: LoopIsolation;
  /** Hard cap on concurrent in-flight sub-agent iterations in this session. Default 4, max 25. */
  activeIterationsMax?: number;
  /** Default wall-clock timeout for one iteration. Default 600,000 ms (10 min). */
  defaultIterationTimeoutMs?: number;
  /** Default per-iteration soft token budget. Default { in: 30,000, out: 6,000 }. */
  defaultIterationTokenBudget?: { in: number; out: number };
  /** Path to the pi binary used to spawn children. Default "pi". */
  piBinary?: string;
  /** Extra env vars to pass to the child. Default {}. */
  envOverrides?: Record<string, string>;
  /** Whether to register as a background-work provider if pi-subagents is present. Default true. */
  registerBackgroundWorkProvider?: boolean;
  /** Whether to honour pi-subagents' capability ceiling. Default true. */
  honorCapabilityCeiling?: boolean;
  /** Whether critical-priority sub-agent results always interrupt the parent. Default false. */
  criticalInterruptsAll?: boolean;
  /** Whether to show the cumulative sub-agent cost in the editor status line. Default true. */
  showCostInStatusLine?: boolean;
  /** Whether to use the optional LLM-call evaluator (stretch). Default false. */
  useLlmEvaluator?: boolean;
}

/** Defaults for the subAgent settings block. Single source of truth. */
export const DEFAULT_SUB_AGENT_SETTINGS: Required<Omit<SubAgentSettings, "envOverrides">> = {
  defaultIsolation: "in-process",
  activeIterationsMax: 4,
  defaultIterationTimeoutMs: 600_000, // 10 min
  defaultIterationTokenBudget: { in: 30_000, out: 6_000 },
  piBinary: "pi",
  registerBackgroundWorkProvider: true,
  honorCapabilityCeiling: true,
  criticalInterruptsAll: false,
  showCostInStatusLine: true,
  useLlmEvaluator: false,
};

/** Loop execution mode. "in-process" is the v2.x default; "sub-agent" spawns a child pi session. */
export type LoopIsolation = "in-process" | "sub-agent";

/** Age in ms before a notification of each priority is force-flushed. */
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

/** Default thresholds for REQUEST_URGENT_FLUSH. Single source of truth;
 *  imported by the notification reducer and tests rather than duplicated. */
export const DEFAULT_FLUSH_THRESHOLDS: UrgentFlushThresholds = {
  defer: 86_400_000,   // 24 hours
  normal: 300_000,     // 5 minutes
  urgent: 30_000,      // 30 seconds
  critical: 0,         // immediate
};

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
  /** Sub-agent execution-mode settings (v2.5+). */
  subAgent?: SubAgentSettings;
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
  subAgent: { ...DEFAULT_SUB_AGENT_SETTINGS, envOverrides: {} },
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
  "subAgent",
]);

function resolveConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR, CONFIG_FILE);
}

function asScope(value: unknown): LoopScope | undefined {
  return value === "memory" || value === "session" || value === "project" || value === "shared"
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

function asLoopIsolation(value: unknown): LoopIsolation | undefined {
  return value === "in-process" || value === "sub-agent" ? value : undefined;
}

function asSubAgentSettings(value: unknown): SubAgentSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const knownKeys = [
    "defaultIsolation", "activeIterationsMax", "defaultIterationTimeoutMs",
    "defaultIterationTokenBudget", "piBinary", "envOverrides",
    "registerBackgroundWorkProvider", "honorCapabilityCeiling",
    "criticalInterruptsAll", "showCostInStatusLine", "useLlmEvaluator",
  ];
  const unknownKeys = Object.keys(obj).filter((k) => !knownKeys.includes(k));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown pi-loop-settings.json subAgent key(s): ${unknownKeys.join(", ")}`);
  }
  const out: SubAgentSettings = {};
  const iso = asLoopIsolation(obj.defaultIsolation);
  if (iso !== undefined) out.defaultIsolation = iso;
  const cap = asPositiveInt(obj.activeIterationsMax);
  if (cap !== undefined) out.activeIterationsMax = cap;
  const timeout = asPositiveInt(obj.defaultIterationTimeoutMs);
  if (timeout !== undefined) out.defaultIterationTimeoutMs = timeout;
  const budget = obj.defaultIterationTokenBudget;
  if (budget && typeof budget === "object" && !Array.isArray(budget)) {
    const b = budget as Record<string, unknown>;
    const inn = asPositiveInt(b.in);
    const outn = asPositiveInt(b.out);
    if (inn !== undefined && outn !== undefined) {
      out.defaultIterationTokenBudget = { in: inn, out: outn };
    }
  }
  if (typeof obj.piBinary === "string" && obj.piBinary.trim().length > 0) {
    out.piBinary = obj.piBinary;
  }
  if (obj.envOverrides && typeof obj.envOverrides === "object" && !Array.isArray(obj.envOverrides)) {
    const eo: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.envOverrides as Record<string, unknown>)) {
      if (typeof v === "string") eo[k] = v;
    }
    out.envOverrides = eo;
  }
  if (obj.registerBackgroundWorkProvider !== undefined) {
    const b = asBool(obj.registerBackgroundWorkProvider);
    if (b !== undefined) out.registerBackgroundWorkProvider = b;
  }
  if (obj.honorCapabilityCeiling !== undefined) {
    const b = asBool(obj.honorCapabilityCeiling);
    if (b !== undefined) out.honorCapabilityCeiling = b;
  }
  if (obj.criticalInterruptsAll !== undefined) {
    const b = asBool(obj.criticalInterruptsAll);
    if (b !== undefined) out.criticalInterruptsAll = b;
  }
  if (obj.showCostInStatusLine !== undefined) {
    const b = asBool(obj.showCostInStatusLine);
    if (b !== undefined) out.showCostInStatusLine = b;
  }
  if (obj.useLlmEvaluator !== undefined) {
    const b = asBool(obj.useLlmEvaluator);
    if (b !== undefined) out.useLlmEvaluator = b;
  }
  return out;
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
  if (record.subAgent !== undefined) {
    const sa = asSubAgentSettings(record.subAgent);
    if (sa !== undefined) next.subAgent = { ...DEFAULT_SUB_AGENT_SETTINGS, ...next.subAgent, ...sa };
  }
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
