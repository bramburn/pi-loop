/**
 * File-backed per-iteration result store for sub-agent loops.
 *
 * Writes `<scope>/sub-agent-results/<loopId>/iter-<N>/result.json` after
 * the child process exits. The file is the parent's view of the outcome
 * (the child writes result.md, but the parent owns the structured JSON).
 *
 * Writes are atomic (tmp + rename) and use mode 0600 on Unix for parity
 * with the existing per-scope conventions.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SubAgentResult, SubAgentStatus } from "../../types.js";

export interface FinalizeInput {
  loopId: string;
  iterId: number;
  status: SubAgentStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  tokens: { in: number; out: number; total: number };
  costUsd: number;
  exitCode: number | null;
  processSignal: NodeJS.Signals | null;
  preview: string;
  resultPath: string | null;
  childSessionPath: string;
  model?: string;
  thinking?: string;
  errorMessage?: string;
}

export class ResultStore {
  constructor(private readonly scopeRoot: string) {}

  iterDir(loopId: string, iterId: number): string {
    return join(this.scopeRoot, "sub-agent-results", loopId, `iter-${iterId}`);
  }

  resultPath(loopId: string, iterId: number): string {
    return join(this.iterDir(loopId, iterId), "result.json");
  }

  finalize(input: FinalizeInput): SubAgentResult {
    const dir = this.iterDir(input.loopId, input.iterId);
    mkdirSync(dir, { recursive: true });
    const result: SubAgentResult = {
      schemaVersion: 1,
      loopId: input.loopId,
      iterId: input.iterId,
      status: input.status,
      startedAt: new Date(input.startedAt).toISOString(),
      finishedAt: new Date(input.finishedAt).toISOString(),
      durationMs: input.durationMs,
      tokens: input.tokens,
      costUsd: input.costUsd,
      exitCode: input.exitCode,
      processSignal: input.processSignal,
      resultPath: input.resultPath,
      preview: input.preview,
      childSessionPath: input.childSessionPath,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    };
    this.writeAtomic(this.resultPath(input.loopId, input.iterId), result);
    return result;
  }

  read(loopId: string, iterId: number): SubAgentResult | undefined {
    const path = this.resultPath(loopId, iterId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as SubAgentResult;
    } catch {
      return undefined;
    }
  }

  listIterations(loopId: string): Array<{ iterId: number; path: string }> {
    const dir = join(this.scopeRoot, "sub-agent-results", loopId);
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const out: Array<{ iterId: number; path: string }> = [];
    for (const entry of entries) {
      const match = entry.match(/^iter-(\d+)$/);
      if (!match) continue;
      const iterId = Number.parseInt(match[1] ?? "0", 10);
      if (!Number.isFinite(iterId)) continue;
      out.push({ iterId, path: join(dir, entry, "result.json") });
    }
    out.sort((a, b) => b.iterId - a.iterId);
    return out;
  }

  /**
   * Prune old iterations for a loop, keeping the most recent `retain`
   * entries. Called by the watcher after every finalize. Uses `rmSync`
   * with `recursive: true` to remove the iter-N directory atomically.
   */
  prune(loopId: string, retain: number): number {
    // Defensive bounds: floor to an integer, then treat anything < 1
    // (negative, zero, NaN) as the original "no prune" no-op. This
    // preserves the v2.5.1 behaviour for bad input while still dropping
    // the fractional part of a non-integer `retain` (e.g. 2.7 → 2).
    const keep = Math.floor(retain);
    if (!Number.isFinite(keep) || keep < 1) return 0;
    const all = this.listIterations(loopId);
    if (all.length <= keep) return 0;
    let pruned = 0;
    for (const it of all.slice(keep)) {
      const iterDir = dirname(it.path);
      try {
        rmSync(iterDir, { recursive: true, force: true });
        pruned++;
      } catch { /* ignore */ }
    }
    return pruned;
  }

  private writeAtomic(path: string, data: SubAgentResult): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
    // renameSync is atomic on POSIX and atomic-replacement on Windows
    // since Node 18 when the destination exists.
    renameSync(tmp, path);
  }
}
