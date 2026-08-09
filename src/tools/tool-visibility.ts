import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Tool visibility gating for the v2.0 loop tool family.
 *
 * Per ADR-002, this module is called from `before_agent_start` and after
 * every store mutation. It hides loop tools from the LLM's active tool set
 * when they are not relevant to the current state — preventing the agent
 * from calling `LoopDelete` after a normal fire, calling `LoopUpdate` when
 * no dynamic loop is active, or calling `WorkflowTransition` when no
 * workflow loop is in flight.
 *
 * Lessons inherited from pragmaxim's `d77e3b8` (defer tool sync to
 * `before_agent_start`) and `34818ac` (defensive array check + error
 * logging):
 *  - Never call `setActiveTools` from `session_start` (runtime not bound).
 *  - Always `Array.isArray()` guard `getActiveTools()` result.
 *  - Wrap in try/catch with `console.error` (never silent swallow).
 */

export const LOOP_TOOL_CREATE = "LoopCreate";
export const LOOP_TOOL_LIST = "LoopList";
export const LOOP_TOOL_UPDATE = "LoopUpdate";
export const LOOP_TOOL_DELETE = "LoopDelete";
export const LOOP_TOOL_WORKFLOW_TRANSITION = "WorkflowTransition";

/** Tools that are always available regardless of state. */
const ALWAYS_AVAILABLE: readonly string[] = [LOOP_TOOL_CREATE, LOOP_TOOL_LIST];

/** Tools that are conditionally available based on store state. */
const CONDITIONAL_TOOLS = {
  [LOOP_TOOL_UPDATE]: (loops: LoopSnapshot[]) =>
    loops.some((l) => l.status === "active" && l.hasDynamic),
  [LOOP_TOOL_DELETE]: (loops: LoopSnapshot[]) =>
    loops.some((l) => l.status === "paused") || loops.some((l) => l.isTaskBacklog),
  [LOOP_TOOL_WORKFLOW_TRANSITION]: (loops: LoopSnapshot[]) =>
    loops.some((l) => l.hasWorkflow),
} as const;

export interface LoopSnapshot {
  id: string;
  status: "active" | "paused";
  hasDynamic: boolean;
  isTaskBacklog: boolean;
  hasWorkflow: boolean;
}

export interface SyncLoopToolsOptions {
  /** Optional override of the active tool list. Defaults to `pi.getActiveTools()`. */
  initialTools?: string[];
  /** Inject a logger for diagnostics. Defaults to `console.error`. */
  logger?: (message: string) => void;
}

/**
 * Compute the new active tool set given the current loop snapshot.
 * Pure function — exposed for testability.
 */
export function computeActiveTools(
  initialTools: string[],
  loops: readonly LoopSnapshot[],
): string[] {
  const active = new Set(initialTools);
  for (const name of ALWAYS_AVAILABLE) active.add(name);
  for (const [name, predicate] of Object.entries(CONDITIONAL_TOOLS)) {
    if (predicate(loops as LoopSnapshot[])) {
      active.add(name);
    } else {
      active.delete(name);
    }
  }
  return Array.from(active);
}

/**
 * Sync the LLM's active tool set to the current loop state.
 *
 * Safe to call from `before_agent_start` and after store mutations.
 * Returns the new active tool list, or `undefined` on failure (with an
 * error logged via `console.error`).
 */
export function syncLoopTools(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  loops: readonly LoopSnapshot[],
  options: SyncLoopToolsOptions = {},
): string[] | undefined {
  const logger = options.logger ?? console.error;
  try {
    const initial = options.initialTools ?? pi.getActiveTools();
    if (!Array.isArray(initial)) {
      logger(`[pi-loop] syncLoopTools: pi.getActiveTools() did not return an array, got ${typeof initial}`);
      return undefined;
    }
    const next = computeActiveTools(initial, loops);
    pi.setActiveTools(next);
    return next;
  } catch (err) {
    logger(`[pi-loop] syncLoopTools error: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Convert a `LoopEntry`-shaped record to a `LoopSnapshot` for visibility. */
export function snapshotFromLoop(loop: {
  status: string;
  dynamic?: unknown;
  taskBacklog?: boolean;
  workflow?: unknown;
}): LoopSnapshot {
  return {
    id: "", // not needed for the predicate; placeholder for the type
    status: loop.status === "paused" ? "paused" : "active",
    hasDynamic: loop.dynamic !== undefined && loop.dynamic !== null,
    isTaskBacklog: loop.taskBacklog === true,
    hasWorkflow: loop.workflow !== undefined && loop.workflow !== null,
  };
}
