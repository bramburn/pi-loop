/**
 * One-line summary formatter for sub-agent iteration results. Pure
 * function: takes a `SubAgentResult` and returns a single-line wake string
 * the parent agent reads.
 *
 * Tiered by priority (per spec CMD-01 / TUI-01):
 *  - normal / urgent / defer: 200 chars
 *  - critical: 1,000 chars
 *
 * Falls back to "unknown" for any missing field. Truncates with an
 * ellipsis if the result.md is longer than the cap.
 */

import type { SubAgentResult } from "../../types.js";

const NORMAL_CAP = 200;
const CRITICAL_CAP = 1_000;

export function formatSubAgentResult(result: SubAgentResult, priority: "defer" | "normal" | "urgent" | "critical" = "normal"): string {
  const cap = priority === "critical" ? CRITICAL_CAP : NORMAL_CAP;
  const duration = formatDuration(result.durationMs);
  const tokens = result.tokens?.total ?? 0;
  const model = result.model ?? "unknown";
  const statusLabel = statusToLabel(result.status);
  const base = `Sub-agent loop #${result.loopId} iter-${result.iterId} · ${duration} · ${model} · ${tokens.toLocaleString("en-US")} tok · ${statusLabel}.`;
  let body = result.preview?.trim() || "(no output)";
  // Truncate body to the remaining cap.
  const remaining = cap - base.length - 2; // -2 for " · "
  if (body.length > remaining) {
    body = `${body.slice(0, Math.max(0, remaining - 1))}…`;
  }
  return body.length > 0 ? `${base} ${body}` : base;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

function statusToLabel(status: SubAgentResult["status"]): string {
  switch (status) {
    case "succeeded": return "succeeded";
    case "succeeded_by_criteria": return "succeeded (criteria)";
    case "failed": return "failed";
    case "failed_by_criteria": return "failed (criteria)";
    case "timeout": return "failed (timeout)";
    case "orphaned": return "orphaned";
    case "cancelled": return "cancelled";
    case "running": return "running";
  }
}
