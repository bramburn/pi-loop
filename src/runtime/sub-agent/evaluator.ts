/**
 * Result evaluator: applies a loop's `successCriteria` and `failureCriteria`
 * to the child's `result.md` after each iteration.
 *
 * Default evaluator is regex-based. Both criteria are treated as case-
 * insensitive regex against the first 32 KiB of result.md. The criteria
 * fields are intentionally free-form text (the user writes them in plain
 * English), so we anchor with `m` (multiline) and `i` (case-insensitive)
 * to be forgiving.
 *
 * Result:
 *  - `succeeded_by_criteria` if successCriteria matches
 *  - `failed_by_criteria` if failureCriteria matches
 *  - `succeeded` otherwise (default; the iteration ran without error)
 *
 * Edge cases:
 *  - result.md missing or empty → no-match, treated as `succeeded`
 *  - invalid regex → caught, treated as no-match, logged
 *  - both criteria match → failure wins (per spec SCH-05)
 */

import { existsSync, readFileSync, statSync } from "node:fs";

export type EvaluatorVerdict = "succeeded" | "succeeded_by_criteria" | "failed_by_criteria" | "no_match";

export interface EvaluatorResult {
  verdict: EvaluatorVerdict;
  reason?: string;
}

const MAX_READ_BYTES = 32 * 1024;

function safeReadResultMd(path: string | null | undefined): string {
  if (!path) return "";
  if (!existsSync(path)) return "";
  try {
    const st = statSync(path);
    if (!st.isFile()) return "";
  } catch {
    return "";
  }
  try {
    // Read at most the first MAX_READ_BYTES via fs.openSync with truncation.
    // For simplicity, read the whole file when small; truncate to 32 KiB otherwise.
    const content = readFileSync(path, "utf-8");
    return content.length > MAX_READ_BYTES ? content.slice(0, MAX_READ_BYTES) : content;
  } catch {
    return "";
  }
}

function tryMatch(pattern: string, haystack: string): { match: boolean; reason?: string } {
  try {
    const re = new RegExp(pattern, "im");
    const m = re.exec(haystack);
    if (m) {
      const snippet = m[0]?.slice(0, 80) ?? "";
      return { match: true, reason: `matched: ${JSON.stringify(snippet)}` };
    }
    return { match: false };
  } catch (err) {
    return { match: false, reason: `invalid regex: ${(err as Error).message}` };
  }
}

export function evaluate(
  resultMdPath: string | null | undefined,
  successCriteria: string | undefined,
  failureCriteria: string | undefined,
): EvaluatorResult {
  if (!successCriteria && !failureCriteria) {
    return { verdict: "no_match" };
  }
  const haystack = safeReadResultMd(resultMdPath);
  if (haystack.length === 0) {
    return { verdict: "no_match", reason: "result.md missing or empty" };
  }
  const failureResult = failureCriteria ? tryMatch(failureCriteria, haystack) : { match: false as const };
  if (failureResult.match) {
    return { verdict: "failed_by_criteria", reason: `failureCriteria ${failureResult.reason ?? ""}` };
  }
  const successResult = successCriteria ? tryMatch(successCriteria, haystack) : { match: false as const };
  if (successResult.match) {
    return { verdict: "succeeded_by_criteria", reason: `successCriteria ${successResult.reason ?? ""}` };
  }
  const reason = failureResult.reason ?? successResult.reason;
  return { verdict: "no_match", ...(reason ? { reason } : {}) };
}
