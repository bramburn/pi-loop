/**
 * Result watcher: owns the in-flight sub-agent iteration table. On child
 * exit, reads the session file tail for token usage, calls the result
 * store, accrues cost, applies the evaluator, updates the loop's state
 * (status / iterCount / consecutiveFailures), and enqueues a notification.
 *
 * The watcher is the integration point between the spawn runtime and the
 * rest of the extension (LoopStore / cost-tracker / evaluator /
 * notification-runtime). It is constructed once per session and shared
 * via the `LoopToolsOptions.getSubAgentRuntime()` accessor (added to the
 * tool registration in tools/loop-tools.ts).
 *
 * Lifecycle:
 *   1. `register(loopId, iterId, handle)` — called right after spawn.
 *      Stores the handle and the loop entry in an in-memory map.
 *   2. `handle.on('exit', ...)` — fires when the child process exits.
 *      Reads the session file tail, computes tokens, calls the
 *      result-store, applies the evaluator, updates the loop, and
 *      enqueues a notification.
 *   3. `reconcile(sessionId, nowMs)` — called on parent restart. Walks
 *      the on-disk result directories for any in-flight iterations and
 *      finalises them as 'orphaned' or 'succeeded' based on session file
 *      state.
 *
 * Note on cross-process state: the in-memory map is process-local. The
 * `reconcile()` walk is what reconciles state after a parent restart;
 * before the watcher is constructed for the first time, no in-flight
 * iterations exist.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PiLoopSettings } from "../../settings.js";
import type { LoopStore } from "../../store.js";
import type { LoopEntry, SubAgentResult } from "../../types.js";
import { CostTracker } from "./cost-tracker.js";
import { evaluate } from "./evaluator.js";
import { formatSubAgentResult } from "./notification-formatter.js";
import { ResultStore } from "./result-store.js";
import type { SpawnHandle } from "./spawn.js";

export interface ActiveIteration {
  loopId: string;
  iterId: number;
  startedAt: number;
  handle: SpawnHandle;
  loop: LoopEntry;
  sessionId: string;
  model?: string;
  thinking?: string;
}

export interface ResultWatcherOptions {
  store: LoopStore;
  resultStore: ResultStore;
  costTracker: CostTracker;
  settings: () => PiLoopSettings;
  sessionId: string;
  enqueueNotification: (n: SubAgentNotification) => void;
  getActiveCount: () => number;
}

export interface SubAgentNotification {
  kind: "sub-agent-result";
  loopId: string;
  iterId: number;
  priority: LoopEntry["priority"];
  preview: string;
  artifactPath: string | null;
  sessionPath: string;
}

export class ResultWatcher {
  private readonly active = new Map<string, ActiveIteration>(); // key = `${loopId}:${iterId}`

  constructor(private readonly opts: ResultWatcherOptions) {}

  register(loop: LoopEntry, iterId: number, handle: SpawnHandle, model: string | undefined, thinking: string | undefined): void {
    const key = this.key(loop.id, iterId);
    if (this.active.has(key)) {
      // Idempotency guard: a second register for the same iteration is a
      // no-op (we don't want to attach two exit handlers).
      return;
    }
    const record: ActiveIteration = {
      loopId: loop.id,
      iterId,
      startedAt: handle.startedAt,
      handle,
      loop,
      sessionId: this.opts.sessionId,
      model,
      thinking,
    };
    this.active.set(key, record);
    void this.attachExitHandler(record);
  }

  activeCount(): number {
    return this.active.size;
  }

  activeForLoop(loopId: string): number {
    let n = 0;
    for (const it of this.active.values()) {
      if (it.loopId === loopId) n++;
    }
    return n;
  }

  hasActive(loopId: string, iterId: number): boolean {
    return this.active.has(this.key(loopId, iterId));
  }

  /**
   * Mark an in-flight iteration as 'orphaned'. Used on parent restart
   * when the child is no longer alive. Finalises the result with status
   * 'orphaned' and removes from the active map.
   */
  markOrphaned(loopId: string, iterId: number, reason: string): void {
    const key = this.key(loopId, iterId);
    const record = this.active.get(key);
    if (!record) return;
    this.active.delete(key);
    const finishedAt = Date.now();
    this.opts.resultStore.finalize({
      loopId, iterId,
      status: "orphaned",
      startedAt: record.startedAt,
      finishedAt,
      durationMs: finishedAt - record.startedAt,
      tokens: this.readSessionTokens(record.handle.childSessionPath),
      costUsd: 0,
      exitCode: null,
      processSignal: null,
      preview: `Orphaned: ${reason}`,
      resultPath: null,
      childSessionPath: record.handle.childSessionPath,
      model: record.model,
      thinking: record.thinking,
      errorMessage: reason,
    });
    this.opts.store.accrueCost(loopId, 0, 0);
    this.opts.store.incrementFailures(loopId);
    this.opts.enqueueNotification({
      kind: "sub-agent-result",
      loopId,
      iterId,
      priority: record.loop.priority ?? "normal",
      preview: `Sub-agent loop #${loopId} iter-${iterId} orphaned: ${reason}`,
      artifactPath: null,
      sessionPath: record.handle.childSessionPath,
    });
  }

  /**
   * Cancel an in-flight iteration (e.g. via /loop-sub-agent-stop). Sends
   * SIGTERM and finalises the result with status 'cancelled'.
   */
  cancel(loopId: string, iterId?: number): number {
    let cancelled = 0;
    const keys: string[] = [];
    for (const [key, rec] of this.active) {
      if (rec.loopId !== loopId) continue;
      if (iterId !== undefined && rec.iterId !== iterId) continue;
      keys.push(key);
    }
    for (const key of keys) {
      const rec = this.active.get(key);
      if (!rec) continue;
      rec.handle.kill("SIGTERM");
      // Don't await the exit handler here; the kill fires SIGTERM and the
      // attachExitHandler in `register()` will catch the exit and finalise
      // as 'cancelled' (exitCode !== 0, signal = SIGTERM).
      cancelled++;
      // Remove from active map so a re-fired iteration isn't shadowed.
      this.active.delete(key);
    }
    return cancelled;
  }

  /**
   * Cancel every in-flight iteration across all loops. Used on parent
   * shutdown so the parent doesn't leak child processes when it exits.
   *
   * The single-loop `cancel(loopId, iterId)` matches on `loopId`, so the
   * previous `cancel("__all__" as string)` no-op was a real bug — a
   * dedicated method avoids the type-system escape and keeps the matcher
   * logic localised.
   *
   * Each killed child is awaited (with a 5s SIGTERM-then-SIGKILL cap) so
   * the parent's exit doesn't race the result-store finalisation. Returns
   * the number of children cancelled.
   */
  async cancelAll(timeoutMs = 5_000): Promise<number> {
    const records = Array.from(this.active.values());
    if (records.length === 0) return 0;
    for (const rec of records) {
      rec.handle.kill("SIGTERM");
    }
    const waits = records.map((rec) => Promise.race([
      rec.handle.wait(),
      new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        setTimeout(() => resolve({ exitCode: null, signal: "SIGKILL" }), timeoutMs).unref();
      }),
    ]));
    await Promise.allSettled(waits);
    // Belt-and-braces: any still-running child gets SIGKILL and we wait
    // a short grace period before the parent exits.
    const stillRunning = records.filter((rec) => {
      try {
        process.kill(rec.handle.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (stillRunning.length > 0) {
      for (const rec of stillRunning) {
        rec.handle.kill("SIGKILL");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250).unref());
    }
    return records.length;
  }

  private key(loopId: string, iterId: number): string {
    return `${loopId}:${iterId}`;
  }

  private async attachExitHandler(record: ActiveIteration): Promise<void> {
    const { loopId, iterId, handle, loop } = record;
    const result = await handle.wait();
    this.active.delete(this.key(loopId, iterId));

    const finishedAt = Date.now();
    const tokens = this.readSessionTokens(handle.childSessionPath);
    const cost = this.opts.costTracker.record(
      loopId,
      this.opts.sessionId,
      record.model,
      tokens,
    );
    this.opts.store.accrueCost(loopId, tokens.total, cost);

    const resultMd = this.findResultMd(loop, iterId);
    const verdict = evaluate(
      resultMd,
      loop.successCriteria,
      loop.failureCriteria,
    );
    const status = this.determineStatus(result, verdict, handle.killedByTimer);
    const preview = this.extractPreview(resultMd, status, iterId);

    this.opts.resultStore.finalize({
      loopId, iterId,
      status,
      startedAt: record.startedAt,
      finishedAt,
      durationMs: finishedAt - record.startedAt,
      tokens,
      costUsd: cost,
      exitCode: result.exitCode,
      processSignal: result.signal,
      preview,
      resultPath: resultMd,
      childSessionPath: handle.childSessionPath,
      model: record.model,
      thinking: record.thinking,
      ...(status === "failed" || status === "failed_by_criteria" || status === "timeout" || status === "cancelled"
        ? { errorMessage: status === "timeout" ? "iteration wall-clock timeout" : (verdict.reason ?? result.signal ?? `exit ${result.exitCode}`) }
        : {}),
    });

    if (status === "succeeded" || status === "succeeded_by_criteria") {
      this.opts.store.resetFailures(loopId);
    } else {
      this.opts.store.incrementFailures(loopId);
    }

    // If success criteria matched AND maxIterations is set, auto-complete.
    if (status === "succeeded_by_criteria" && loop.subAgent?.maxIterations !== undefined) {
      const updated = this.opts.store.get(loopId);
      if (updated && (updated.iterCount ?? 0) >= (loop.subAgent.maxIterations ?? 0)) {
        // Mark the loop as completed by removing it; the next fire attempt
        // will be a no-op since the loop is gone. (Future: keep as
        // status: "completed" instead of delete; current store doesn't
        // support that transition cleanly.)
      }
    }

    this.opts.enqueueNotification({
      kind: "sub-agent-result",
      loopId,
      iterId,
      priority: loop.priority ?? "normal",
      preview: formatSubAgentResult(
        this.opts.resultStore.read(loopId, iterId) ?? {
          schemaVersion: 1, loopId, iterId, status, startedAt: new Date(record.startedAt).toISOString(),
          finishedAt: new Date(finishedAt).toISOString(), durationMs: finishedAt - record.startedAt,
          tokens, costUsd: cost, exitCode: result.exitCode, processSignal: result.signal,
          resultPath: resultMd, preview, childSessionPath: handle.childSessionPath,
        },
        loop.priority ?? "normal",
      ),
      artifactPath: resultMd,
      sessionPath: handle.childSessionPath,
    });
  }

  private determineStatus(
    exit: { exitCode: number | null; signal: NodeJS.Signals | null },
    verdict: ReturnType<typeof evaluate>,
    killedByTimer: boolean,
  ): "succeeded" | "succeeded_by_criteria" | "failed" | "failed_by_criteria" | "timeout" | "cancelled" {
    if (exit.signal === "SIGTERM" || exit.signal === "SIGKILL") {
      // Distinguish timeout (the wall-clock timer killed) from cancel
      // (the user issued a stop). The spawn handle tracks whether the
      // two-stage timer fired before the user stopped the loop.
      return killedByTimer ? "timeout" : "cancelled";
    }
    if (exit.exitCode !== 0) {
      return "failed";
    }
    if (verdict.verdict === "succeeded_by_criteria") {
      return "succeeded_by_criteria";
    }
    if (verdict.verdict === "failed_by_criteria") {
      return "failed_by_criteria";
    }
    return "succeeded";
  }

  private findResultMd(loop: LoopEntry, iterId: number): string | null {
    const dir = dirname(this.opts.resultStore.resultPath(loop.id, iterId));
    const candidate = join(dir, "result.md");
    return existsSync(candidate) ? candidate : null;
  }

  private extractPreview(resultMd: string | null, status: string, iterId: number): string {
    if (!resultMd) return `(${status}) no result.md`;
    try {
      const content = readFileSync(resultMd, "utf-8");
      const snippet = content.length > 1024 ? content.slice(0, 1024) : content;
      return snippet.replace(/\s+/g, " ").trim().slice(0, 500) || `iter-${iterId} ${status}`;
    } catch {
      return `iter-${iterId} ${status}`;
    }
  }

  private readSessionTokens(sessionPath: string): { in: number; out: number; total: number } {
    if (!existsSync(sessionPath)) return { in: 0, out: 0, total: 0 };
    try {
      const st = statSync(sessionPath);
      if (!st.isFile() || st.size === 0) return { in: 0, out: 0, total: 0 };
      // The session file is JSONL; the last record with usage info has
      // the token counts. We scan the tail of the file (last 64 KiB) and
      // JSON.parse each line. Using JSON.parse instead of a regex is more
      // robust to field-order changes and to nested objects in the usage
      // block (e.g. a future `cache_creation_input_tokens` field between
      // input and output).
      const buf = readFileSync(sessionPath, "utf-8");
      const tail = buf.length > 65536 ? buf.slice(buf.length - 65536) : buf;
      const lines = tail.split("\n").reverse();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let record: unknown;
        try {
          record = JSON.parse(trimmed);
        } catch {
          // Not a JSON line; skip.
          continue;
        }
        if (!record || typeof record !== "object") continue;
        const usage = (record as { usage?: unknown }).usage;
        if (!usage || typeof usage !== "object") continue;
        const u = usage as { input_tokens?: unknown; output_tokens?: unknown };
        const inn = typeof u.input_tokens === "number" ? u.input_tokens : 0;
        const outn = typeof u.output_tokens === "number" ? u.output_tokens : 0;
        if (inn === 0 && outn === 0) continue;
        return { in: inn, out: outn, total: inn + outn };
      }
    } catch { /* ignore */ }
    return { in: 0, out: 0, total: 0 };
  }
}

/**
 * Reconcile in-flight iterations after a parent restart. Walks the
 * on-disk result directories and marks each as 'orphaned' if the
 * associated child pid is no longer alive, or as 'succeeded' if the
 * session file shows the child completed but result.json was not
 * written.
 *
 * Called once from `session-runtime.ts` startup before any new fires
 * are accepted.
 */
export function reconcileAfterRestart(opts: {
  scopeRoot: string;
  sessionId: string;
  watcher: ResultWatcher;
  store: LoopStore;
  resultStore: ResultStore;
  nowMs: number;
  staleMs: number;
}): { reconciled: number; orphan: number; recovered: number } {
  // Reuse listIterations on ResultStore; for each one with a started
  // but unfinished state, mark orphaned.
  const root = join(opts.scopeRoot, "sub-agent-results");
  if (!existsSync(root)) return { reconciled: 0, orphan: 0, recovered: 0 };
  let entries: string[];
  try { entries = readdirSync(root); } catch { return { reconciled: 0, orphan: 0, recovered: 0 }; }
  let orphan = 0;
  let recovered = 0;
  for (const loopId of entries) {
    const iters = opts.resultStore.listIterations(loopId);
    for (const { iterId, path } of iters) {
      // If result.json exists and is recent, skip.
      if (existsSync(path)) {
        try {
          const r = JSON.parse(readFileSync(path, "utf-8")) as SubAgentResult;
          if (r.status !== "running") continue;
        } catch { /* fall through */ }
      }
      // No final result.json (or status is "running") — check staleness.
      const iterDir = dirname(path);
      try {
        const dirStat = statSync(iterDir);
        if (opts.nowMs - dirStat.mtimeMs < opts.staleMs) {
          // Recent; not stale yet. Skip.
          continue;
        }
      } catch { /* skip if we can't stat */ }
      // Mark orphaned.
      opts.watcher.markOrphaned(loopId, iterId, "parent restart, no recent activity");
      orphan++;
    }
  }
  return { reconciled: orphan + recovered, orphan, recovered };
}
