/**
 * Tests for the sub-agent evaluator (regex match against result.md).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluate } from "../../../src/runtime/sub-agent/evaluator.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "sub-agent-eval-"));
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function writeResult(content: string): string {
  const path = join(workdir, "result.md");
  writeFileSync(path, content);
  return path;
}

describe("sub-agent evaluator", () => {
  it("returns no_match when no criteria are set", () => {
    const path = writeResult("anything");
    const result = evaluate(path, undefined, undefined);
    expect(result.verdict).toBe("no_match");
  });

  it("returns no_match when result.md is missing", () => {
    const result = evaluate("/nonexistent/result.md", "ok", "fail");
    expect(result.verdict).toBe("no_match");
  });

  it("returns succeeded_by_criteria when success criteria matches", () => {
    const path = writeResult("All 3 audits passed. No issues found.");
    const result = evaluate(path, "all.*passed", undefined);
    expect(result.verdict).toBe("succeeded_by_criteria");
  });

  it("returns failed_by_criteria when failure criteria matches", () => {
    const path = writeResult("ERROR: tests failed");
    const result = evaluate(path, undefined, "error");
    expect(result.verdict).toBe("failed_by_criteria");
  });

  it("failure wins when both criteria match", () => {
    const path = writeResult("ERROR: passed but with errors");
    const result = evaluate(path, "passed", "error");
    expect(result.verdict).toBe("failed_by_criteria");
  });

  it("returns succeeded when no criteria match", () => {
    const path = writeResult("Some normal output");
    const result = evaluate(path, "all.*passed", "fatal");
    expect(result.verdict).toBe("no_match");
  });

  it("treats invalid regex as no-match with a reason", () => {
    const path = writeResult("anything");
    const result = evaluate(path, "[unclosed", undefined);
    expect(result.verdict).toBe("no_match");
    expect(result.reason).toMatch(/invalid regex/);
  });

  it("is case-insensitive by default", () => {
    const path = writeResult("ALL AUDITS PASSED");
    const result = evaluate(path, "all.*passed", undefined);
    expect(result.verdict).toBe("succeeded_by_criteria");
  });
});
