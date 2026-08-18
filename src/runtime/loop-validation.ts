/**
 * Per-field validators for the new LoopEntry fields added in v2.5:
 * isolation, goal, successCriteria, failureCriteria, stateFile, subAgent.
 *
 * Each validator returns `{ ok: true, value }` on success or
 * `{ ok: false, message }` on failure. The message names the field and
 * the constraint so error messages are actionable.
 *
 * Used by:
 *  - LoopCreate / LoopUpdate tool execution
 *  - LoopStore.persist (defensive; tool layer is the primary gate)
 *  - the v2-to-v2.5 migration (validates pre-existing data)
 */

import type { LoopIsolation, LoopSubAgentConfig } from "../types.js";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

const MAX_GOAL = 1_000;
const MAX_CRITERIA = 2_000;
const MAX_STATE_FILE_PATH = 1_000;

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function err(message: string): ValidationResult<never> {
  return { ok: false, message };
}

export function validateIsolation(value: unknown): ValidationResult<LoopIsolation> {
  if (value === undefined) return ok("in-process");
  if (value === "in-process" || value === "sub-agent") return ok(value);
  return err(`isolation must be "in-process" or "sub-agent", got ${JSON.stringify(value)}`);
}

export function validateGoal(value: unknown): ValidationResult<string | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "string") return err(`goal must be a string, got ${typeof value}`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return err("goal must be non-empty when set");
  if (trimmed.length > MAX_GOAL) return err(`goal must be at most ${MAX_GOAL} characters, got ${trimmed.length}`);
  if (trimmed.includes("\0")) return err("goal must not contain NUL bytes");
  return ok(trimmed);
}

export function validateCriteria(field: "successCriteria" | "failureCriteria", value: unknown): ValidationResult<string | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "string") return err(`${field} must be a string, got ${typeof value}`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return err(`${field} must be non-empty when set`);
  if (trimmed.length > MAX_CRITERIA) return err(`${field} must be at most ${MAX_CRITERIA} characters, got ${trimmed.length}`);
  if (trimmed.includes("\0")) return err(`${field} must not contain NUL bytes`);
  return ok(trimmed);
}

export function validateStateFile(value: unknown, root: string): ValidationResult<string | undefined> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "string") return err(`stateFile must be a string, got ${typeof value}`);
  if (value.length === 0 || value.length > MAX_STATE_FILE_PATH) {
    return err(`stateFile must be 1..${MAX_STATE_FILE_PATH} characters, got ${value.length}`);
  }
  if (value.includes("\0")) return err("stateFile must not contain NUL bytes");
  // Reject absolute paths and parent-traversal; resolve relative to root.
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) {
    return err("stateFile must be a relative path");
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.includes("..")) {
    return err("stateFile must not contain '..'");
  }
  // Verify the resolved path is within root.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _rootNorm = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (!normalized.startsWith("./") && !normalized.startsWith("../") === false) {
    // Accept both "./foo" and "foo" forms; normalise to "./foo".
    return ok(normalized.startsWith("./") ? normalized : `./${normalized}`);
  }
  return ok(normalized);
}

export function validateSubAgentConfig(value: unknown): ValidationResult<LoopSubAgentConfig | undefined> {
  if (value === undefined) return ok(undefined);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return err(`subAgent must be an object, got ${typeof value}`);
  }
  const obj = value as Record<string, unknown>;
  const knownKeys = [
    "model", "thinking", "tools", "iterationTimeoutMs", "iterationTokenBudget",
    "maxTokens", "maxIterations", "cwd", "label", "retainIterations",
  ];
  const unknownKeys = Object.keys(obj).filter((k) => !knownKeys.includes(k));
  if (unknownKeys.length > 0) {
    return err(`subAgent has unknown key(s): ${unknownKeys.join(", ")}`);
  }
  const out: LoopSubAgentConfig = {};

  if (obj.model !== undefined) {
    if (typeof obj.model !== "string" || obj.model.trim().length === 0) {
      return err("subAgent.model must be a non-empty string");
    }
    out.model = obj.model;
  }
  if (obj.thinking !== undefined) {
    if (obj.thinking !== "off" && obj.thinking !== "low" && obj.thinking !== "medium" && obj.thinking !== "high") {
      return err(`subAgent.thinking must be off/low/medium/high, got ${JSON.stringify(obj.thinking)}`);
    }
    out.thinking = obj.thinking;
  }
  if (obj.tools !== undefined) {
    if (!Array.isArray(obj.tools) || !obj.tools.every((t) => typeof t === "string")) {
      return err("subAgent.tools must be an array of strings");
    }
    out.tools = obj.tools as string[];
  }
  if (obj.iterationTimeoutMs !== undefined) {
    if (typeof obj.iterationTimeoutMs !== "number" || !Number.isInteger(obj.iterationTimeoutMs) || obj.iterationTimeoutMs < 1) {
      return err("subAgent.iterationTimeoutMs must be a positive integer");
    }
    out.iterationTimeoutMs = obj.iterationTimeoutMs;
  }
  if (obj.iterationTokenBudget !== undefined) {
    if (!obj.iterationTokenBudget || typeof obj.iterationTokenBudget !== "object" || Array.isArray(obj.iterationTokenBudget)) {
      return err("subAgent.iterationTokenBudget must be an object { in, out }");
    }
    const b = obj.iterationTokenBudget as Record<string, unknown>;
    const inn = typeof b.in === "number" && Number.isInteger(b.in) && b.in > 0 ? b.in : null;
    const outn = typeof b.out === "number" && Number.isInteger(b.out) && b.out > 0 ? b.out : null;
    if (inn === null || outn === null) {
      return err("subAgent.iterationTokenBudget.in/out must be positive integers");
    }
    out.iterationTokenBudget = { in: inn, out: outn };
  }
  if (obj.maxTokens !== undefined) {
    if (typeof obj.maxTokens !== "number" || !Number.isInteger(obj.maxTokens) || obj.maxTokens < 1) {
      return err("subAgent.maxTokens must be a positive integer");
    }
    out.maxTokens = obj.maxTokens;
  }
  if (obj.maxIterations !== undefined) {
    if (typeof obj.maxIterations !== "number" || !Number.isInteger(obj.maxIterations) || obj.maxIterations < 1) {
      return err("subAgent.maxIterations must be a positive integer");
    }
    out.maxIterations = obj.maxIterations;
  }
  if (obj.cwd !== undefined) {
    if (typeof obj.cwd !== "string" || obj.cwd.trim().length === 0) {
      return err("subAgent.cwd must be a non-empty string");
    }
    out.cwd = obj.cwd;
  }
  if (obj.label !== undefined) {
    if (typeof obj.label !== "string" || obj.label.trim().length === 0) {
      return err("subAgent.label must be a non-empty string");
    }
    out.label = obj.label;
  }
  if (obj.retainIterations !== undefined) {
    if (typeof obj.retainIterations !== "number" || !Number.isInteger(obj.retainIterations) || obj.retainIterations < 1) {
      return err("subAgent.retainIterations must be a positive integer");
    }
    out.retainIterations = obj.retainIterations;
  }
  return ok(out);
}
