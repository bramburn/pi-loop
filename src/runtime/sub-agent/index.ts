/**
 * Sub-agent runtime: the public surface for the sub-agent execution
 * feature. Owns the cost-tracker, result-store, and result-watcher;
 * exposes a single `handleFire(entry)` method that the trigger system
 * calls when a sub-agent loop fires.
 *
 * Lifecycle:
 *   - Constructed once per session, wired up in src/index.ts.
 *   - `handleFire(loop)` is called from `onLoopFire()` in the trigger
 *     system, with the loop entry as input. The runtime:
 *       1. Reads merged settings + the loop's overrides.
 *       2. Checks the gate. If the gate returns 'pause' or 'defer',
 *          applies the right state transition and enqueues a
 *          notification; returns.
 *       3. Otherwise, computes the iteration id, ensures the per-iter
 *          directory, and spawns the child.
 *       4. Registers the iteration with the watcher; the watcher
 *          handles the rest (token reading, cost accrual, result
 *          finalisation, notification enqueue).
 *   - `reconcileAfterRestart()` is called from session-runtime startup
 *     before any new fires are accepted; marks stale in-flight
 *     iterations as 'orphaned'.
 *   - `onShutdown()` is called on parent SIGINT; kills in-flight
 *     children with SIGTERM and lets the watcher finalise them as
 *     'cancelled'.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SUB_AGENT_SETTINGS, type PiLoopSettings } from "../../settings.js";
import type { LoopStore } from "../../store.js";
import type { LoopEntry } from "../../types.js";
import { CostTracker } from "./cost-tracker.js";
import { ResultStore } from "./result-store.js";
import { ResultWatcher, reconcileAfterRestart, type SubAgentNotification } from "./result-watcher.js";
import { gate } from "./scheduler.js";
import { type SpawnHandle, spawnSubAgent } from "./spawn.js";

export interface SubAgentRuntimeOptions {
  /** The store used to read/write LoopEntry. */
  store: LoopStore;
  /** The session's effective settings. */
  settings: () => PiLoopSettings;
  /** The session id (for cost aggregation). */
  sessionId: string;
  /** Where loop sub-agent-results live. Resolved via LoopScope. */
  scopeRoot: string;
  /** Push a notification into the parent session. */
  enqueueNotification: (n: SubAgentNotification) => void;
}

export class SubAgentRuntime {
  readonly costTracker: CostTracker;
  readonly resultStore: ResultStore;
  readonly watcher: ResultWatcher;
  private readonly opts: SubAgentRuntimeOptions;
  /** Stale threshold for parent-restart reconciliation. Default 5 min. */
  private readonly staleMs = 5 * 60 * 1000;

  constructor(opts: SubAgentRuntimeOptions) {
    this.opts = opts;
    this.costTracker = new CostTracker();
    this.resultStore = new ResultStore(opts.scopeRoot);
    this.watcher = new ResultWatcher({
      store: opts.store,
      resultStore: this.resultStore,
      costTracker: this.costTracker,
      settings: opts.settings,
      sessionId: opts.sessionId,
      enqueueNotification: opts.enqueueNotification,
      getActiveCount: () => this.watcher.activeCount(),
    });
  }

  /**
   * Entry point called from the trigger system when a sub-agent loop
   * fires. Returns a status string for the caller (fire / defer / pause).
   */
  async handleFire(loop: LoopEntry): Promise<"fired" | "deferred" | "paused"> {
    if (loop.isolation !== "sub-agent") {
      // Defensive: the trigger system should only call this for sub-agent
      // loops, but if not, no-op.
      return "fired";
    }
    const decision = gate({
      loop,
      activeCount: this.watcher.activeCount(),
      settings: this.opts.settings(),
    });
    if (decision.kind === "defer") {
      this.notify(loop, {
        kind: "sub-agent-result",
        loopId: loop.id,
        iterId: this.nextIterId(loop),
        priority: loop.priority ?? "defer",
        preview: `Sub-agent loop #${loop.id} deferred: ${decision.activeCount}/${decision.cap} active iterations. Wait for one to finish.`,
        artifactPath: null,
        sessionPath: "",
      });
      return "deferred";
    }
    if (decision.kind === "pause") {
      const reasonLabel = decision.reason === "iteration_cap"
        ? `iteration cap reached (${decision.iterCount}/${decision.cap})`
        : decision.reason === "budget_cap"
          ? `budget cap reached (${decision.cumulativeTokens.toLocaleString("en-US")}/${decision.cap.toLocaleString("en-US")} tokens)`
          : `consecutive failures reached (${decision.consecutiveFailures}/${decision.cap})`;
      this.notify(loop, {
        kind: "sub-agent-result",
        loopId: loop.id,
        iterId: this.nextIterId(loop),
        priority: "urgent",
        preview: `Sub-agent loop #${loop.id} paused: ${reasonLabel}. Use LoopUpdate to change the cap, or ask the user to delete it via /loop's View-loops menu.`,
        artifactPath: null,
        sessionPath: "",
      });
      return "paused";
    }

    // Gate says spawn. Do it.
    const iterId = this.nextIterId(loop);
    const sub = { ...DEFAULT_SUB_AGENT_SETTINGS, ...(this.opts.settings().subAgent ?? {}), ...(loop.subAgent ?? {}) };
    const iterationDir = this.resultStore.iterDir(loop.id, iterId);
    mkdirSync(iterationDir, { recursive: true });
    const childSessionPath = join(iterationDir, "session.jsonl");
    const promptPath = join(iterationDir, "prompt.txt");
    const cwd = sub.cwd ?? this.opts.scopeRoot;
    const handle: SpawnHandle = await spawnSubAgent({
      loopId: loop.id,
      iterId,
      cwd,
      childSessionPath,
      promptPath,
      model: sub.model,
      thinking: sub.thinking,
      iterationTimeoutMs: sub.defaultIterationTimeoutMs ?? DEFAULT_SUB_AGENT_SETTINGS.defaultIterationTimeoutMs,
      piBinary: sub.piBinary,
      envOverrides: sub.envOverrides,
      prompt: loop.prompt,
      loopName: loop.goal ?? `loop-${loop.id}`,
    });
    this.watcher.register(loop, iterId, handle, sub.model, sub.thinking);
    return "fired";
  }

  reconcile(): { reconciled: number; orphan: number; recovered: number } {
    return reconcileAfterRestart({
      scopeRoot: this.opts.scopeRoot,
      sessionId: this.opts.sessionId,
      watcher: this.watcher,
      store: this.opts.store,
      resultStore: this.resultStore,
      nowMs: Date.now(),
      staleMs: this.staleMs,
    });
  }

  onShutdown(): number {
    return this.watcher.cancel("__all__" as string);
  }

  private nextIterId(loop: LoopEntry): number {
    // Increment the loop's iterCount by 1 and use that.
    const current = this.opts.store.get(loop.id);
    return (current?.iterCount ?? 0) + 1;
  }

  private notify(_loop: LoopEntry, n: SubAgentNotification): void {
    this.opts.enqueueNotification(n);
  }
}

/**
 * Resolve the per-scope results directory for a loop given the project's
 * loop-scope convention. Mirrors `src/runtime/scope.ts:resolveLoopStorePath`
 * for the .pi/loops dir; the sub-agent-results dir lives one level under
 * that.
 */
export function resolveSubAgentScopeRoot(cwd: string, scope: "memory" | "session" | "project" | "shared", sessionId?: string): string {
  switch (scope) {
    case "project":
      return join(cwd, ".pi", "loops");
    case "session":
      return join(cwd, ".pi", `loops-${sessionId ?? "default"}`);
    case "shared":
      return join(homedir(), ".pi", "loops", "shared");
    case "memory":
      // In-memory; the scope root doesn't matter but we return a temp
      // path so writes go somewhere harmless if anything escapes.
      return join(cwd, ".pi", "loops-memory");
  }
}
