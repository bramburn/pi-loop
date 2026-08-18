/**
 * Sub-agent scheduler: gate fires against concurrency / budget / iteration
 * caps. Pure logic, no I/O. The watcher calls `gate()` before spawning and
 * applies the returned decision (spawn, defer, pause).
 *
 * Gates (in order):
 *  1. Active-iteration cap (session-wide). If `active >= max` → defer.
 *  2. Per-loop iteration cap (`subAgent.maxIterations`). If `iterCount >= max` → pause.
 *  3. Per-loop token budget (`subAgent.maxTokens`). If `cumulativeTokens >= max` → pause.
 *  4. Consecutive-failure pause (after 3). If `consecutiveFailures >= 3` → pause.
 *  5. Otherwise → spawn.
 *
 * The function is pure: it takes a snapshot and returns a decision. The
 * watcher applies the decision (set status, write notification).
 */

import { DEFAULT_SUB_AGENT_SETTINGS, type PiLoopSettings } from "../../settings.js";
import type { LoopEntry } from "../../types.js";

export type GateDecision =
  | { kind: "spawn" }
  | { kind: "defer"; reason: "concurrency_cap"; activeCount: number; cap: number }
  | { kind: "pause"; reason: "iteration_cap"; iterCount: number; cap: number }
  | { kind: "pause"; reason: "budget_cap"; cumulativeTokens: number; cap: number }
  | { kind: "pause"; reason: "failure_cap"; consecutiveFailures: number; cap: number };

export interface GateInput {
  loop: LoopEntry;
  /** Number of in-flight sub-agent iterations across all sub-agent loops in this session. */
  activeCount: number;
  /** Effective settings block (the merged subAgent fields). */
  settings: PiLoopSettings;
}

export function gate(input: GateInput): GateDecision {
  const sub = input.settings.subAgent ?? {};
  const activeCap = sub.activeIterationsMax ?? DEFAULT_SUB_AGENT_SETTINGS.activeIterationsMax;
  const iterCap = input.loop.subAgent?.maxIterations;
  const budgetCap = input.loop.subAgent?.maxTokens;
  const failureCap = 3;

  if (input.activeCount >= activeCap) {
    return { kind: "defer", reason: "concurrency_cap", activeCount: input.activeCount, cap: activeCap };
  }
  if (iterCap !== undefined && (input.loop.iterCount ?? 0) >= iterCap) {
    return { kind: "pause", reason: "iteration_cap", iterCount: input.loop.iterCount ?? 0, cap: iterCap };
  }
  if (budgetCap !== undefined && (input.loop.cumulativeTokens ?? 0) >= budgetCap) {
    return { kind: "pause", reason: "budget_cap", cumulativeTokens: input.loop.cumulativeTokens ?? 0, cap: budgetCap };
  }
  if ((input.loop.consecutiveFailures ?? 0) >= failureCap) {
    return { kind: "pause", reason: "failure_cap", consecutiveFailures: input.loop.consecutiveFailures ?? 0, cap: failureCap };
  }
  return { kind: "spawn" };
}
