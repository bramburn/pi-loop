/**
 * Tests for the sub-agent result-store (atomic write + read).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResultStore } from "../../../src/runtime/sub-agent/result-store.js";

let workdir: string;
let store: ResultStore;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "sub-agent-rs-"));
  store = new ResultStore(workdir);
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("sub-agent result-store", () => {
  it("writes and reads back a result", () => {
    const result = store.finalize({
      loopId: "1",
      iterId: 5,
      status: "succeeded",
      startedAt: 1_000_000,
      finishedAt: 1_600_000,
      durationMs: 600_000,
      tokens: { in: 1000, out: 200, total: 1200 },
      costUsd: 0.01,
      exitCode: 0,
      processSignal: null,
      preview: "Did the thing",
      resultPath: null,
      childSessionPath: "/tmp/session.jsonl",
    });
    expect(result.loopId).toBe("1");
    expect(result.iterId).toBe(5);
    expect(result.status).toBe("succeeded");
    const read = store.read("1", 5);
    expect(read).toBeDefined();
    expect(read?.status).toBe("succeeded");
    expect(read?.tokens.total).toBe(1200);
  });

  it("creates iter directories on demand", () => {
    store.finalize({
      loopId: "2",
      iterId: 1,
      status: "succeeded",
      startedAt: 0,
      finishedAt: 100,
      durationMs: 100,
      tokens: { in: 0, out: 0, total: 0 },
      costUsd: 0,
      exitCode: 0,
      processSignal: null,
      preview: "",
      resultPath: null,
      childSessionPath: "/tmp/s.jsonl",
    });
    const path = store.resultPath("2", 1);
    expect(existsSync(path)).toBe(true);
    const content = JSON.parse(readFileSync(path, "utf-8"));
    expect(content.schemaVersion).toBe(1);
  });

  it("returns undefined for missing iterations", () => {
    expect(store.read("nope", 99)).toBeUndefined();
    expect(store.listIterations("nope")).toEqual([]);
  });

  it("listIterations returns newest first", () => {
    for (const i of [1, 3, 2, 5, 4]) {
      store.finalize({
        loopId: "3",
        iterId: i,
        status: "succeeded",
        startedAt: 0,
        finishedAt: 100,
        durationMs: 100,
        tokens: { in: 0, out: 0, total: 0 },
        costUsd: 0,
        exitCode: 0,
        processSignal: null,
        preview: `iter ${i}`,
        resultPath: null,
        childSessionPath: "/tmp/s.jsonl",
      });
    }
    const list = store.listIterations("3");
    expect(list.map((it) => it.iterId)).toEqual([5, 4, 3, 2, 1]);
  });

  it("prune removes oldest iterations beyond retain count", () => {
    for (const i of [1, 2, 3, 4, 5]) {
      store.finalize({
        loopId: "4",
        iterId: i,
        status: "succeeded",
        startedAt: 0,
        finishedAt: 100,
        durationMs: 100,
        tokens: { in: 0, out: 0, total: 0 },
        costUsd: 0,
        exitCode: 0,
        processSignal: null,
        preview: `iter ${i}`,
        resultPath: null,
        childSessionPath: "/tmp/s.jsonl",
      });
    }
    const pruned = store.prune("4", 2);
    expect(pruned).toBe(3);
    expect(store.listIterations("4").map((it) => it.iterId)).toEqual([5, 4]);
  });

  it("prune bounds retain to a positive integer (L4)", () => {
    for (const i of [1, 2, 3]) {
      store.finalize({
        loopId: "5",
        iterId: i,
        status: "succeeded",
        startedAt: 0,
        finishedAt: 100,
        durationMs: 100,
        tokens: { in: 0, out: 0, total: 0 },
        costUsd: 0,
        exitCode: 0,
        processSignal: null,
        preview: `iter ${i}`,
        resultPath: null,
        childSessionPath: "/tmp/s.jsonl",
      });
    }
    // Negative retain: kept as the original no-op behaviour.
    expect(store.prune("5", -5)).toBe(0);
    // NaN retain: kept as the original no-op behaviour.
    expect(store.prune("5", Number.NaN)).toBe(0);
    // Fractional retain: floored to 2 (the fractional part is dropped).
    expect(store.prune("5", 2.7)).toBe(1);
    expect(store.listIterations("5").map((it) => it.iterId)).toEqual([3, 2]);
  });
});
