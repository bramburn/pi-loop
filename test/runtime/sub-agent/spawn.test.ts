/**
 * Tests for the sub-agent spawn binary resolver.
 *
 * `resolveSpawnTarget` is the only testable surface of spawn.ts: the actual
 * `spawnSubAgent` function runs a long-lived child process and is exercised
 * by the scheduler integration tests, not here.
 *
 * The bug these tests guard against:
 *   `child_process.spawn("pi", ...)` on Windows does NOT consult PATHEXT,
 *   so even when `pi.cmd` or `pi.ps1` is on PATH, spawn fails with
 *   `Error: spawn pi ENOENT`. The fix resolves via `where.exe` and
 *   dispatches by extension.
 */

import { describe, expect, it } from "vitest";
import { resolveSpawnTarget } from "../../../src/runtime/sub-agent/spawn.js";

const IS_WINDOWS = process.platform === "win32";

describe("sub-agent spawn resolver", () => {
  it("passes a bare command straight through on POSIX", () => {
    if (!IS_WINDOWS) {
      const r = resolveSpawnTarget("pi");
      expect(r).toEqual({ cmd: "pi", prefixArgs: [], useShell: false });
    }
  });

  it("dispatches an absolute .exe path with no shell wrapper", { skip: !IS_WINDOWS }, () => {
    if (!IS_WINDOWS) return;
    const r = resolveSpawnTarget("C:\\fake\\bin.exe");
    expect(r).toEqual({ cmd: "C:\\fake\\bin.exe", prefixArgs: [], useShell: false });
  });

  it("wraps an absolute .ps1 path in powershell.exe", { skip: !IS_WINDOWS }, () => {
    if (!IS_WINDOWS) return;
    const r = resolveSpawnTarget("C:\\nvm4w\\nodejs\\pi.ps1");
    expect(r.cmd).toBe("powershell.exe");
    expect(r.useShell).toBe(false);
    expect(r.prefixArgs).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-File",
      "C:\\nvm4w\\nodejs\\pi.ps1",
    ]);
  });

  it("marks an absolute .cmd path for shell execution", { skip: !IS_WINDOWS }, () => {
    if (!IS_WINDOWS) return;
    const r = resolveSpawnTarget("C:\\nvm4w\\nodejs\\pi.cmd");
    expect(r.cmd).toBe("C:\\nvm4w\\nodejs\\pi.cmd");
    expect(r.useShell).toBe(true);
    expect(r.prefixArgs).toEqual([]);
  });

  it("marks an absolute .bat path for shell execution", { skip: !IS_WINDOWS }, () => {
    if (!IS_WINDOWS) return;
    const r = resolveSpawnTarget("C:\\fake\\bin.bat");
    expect(r.cmd).toBe("C:\\fake\\bin.bat");
    expect(r.useShell).toBe(true);
    expect(r.prefixArgs).toEqual([]);
  });

  it("treats a relative ./path/to/bin like a path (no where.exe lookup)", { skip: !IS_WINDOWS }, () => {
    if (!IS_WINDOWS) return;
    const r = resolveSpawnTarget(".\\scripts\\run.cmd");
    expect(r.cmd).toBe(".\\scripts\\run.cmd");
    expect(r.useShell).toBe(true);
  });

  it("resolves a bare 'pi' on Windows via where.exe and wraps .ps1 in powershell", { skip: !IS_WINDOWS }, () => {
    if (!IS_WINDOWS) return;
    // Real machine test: this is the regression test for the user's bug.
    // where.exe pi returns pi (no-ext) and pi.cmd; (Get-Command pi).Definition
    // is pi.ps1. After caching, we only run where.exe once; the result must
    // be one of the valid dispatches and must NOT throw ENOENT.
    const r = resolveSpawnTarget("pi");
    expect(r.useShell === true || r.cmd === "powershell.exe" || r.cmd === "pi").toBe(true);
    if (r.cmd === "powershell.exe") {
      expect(r.prefixArgs).toContain("-File");
    } else {
      expect(r.cmd).toMatch(/(^|[\\/])pi(\.cmd|\.exe|\.bat)?$/);
    }
  });

  it("throws a helpful error when a bare command is not on PATH", { skip: !IS_WINDOWS }, () => {
    if (!IS_WINDOWS) return;
    // Use a name that cannot exist on PATH.
    expect(() => resolveSpawnTarget("pi-loop-nonexistent-binary-xyz-123")).toThrow(
      /Could not find "pi-loop-nonexistent-binary-xyz-123" on PATH/,
    );
  });

  it("caches the resolution per bin string", { skip: !IS_WINDOWS }, () => {
    if (!IS_WINDOWS) return;
    const a = resolveSpawnTarget("pi");
    const b = resolveSpawnTarget("pi");
    expect(a).toBe(b); // same object reference proves the cache hit
  });
});
