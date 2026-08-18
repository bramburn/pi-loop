import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorManager } from "../src/monitor-manager.js";
import { createMockPi } from "./helpers/mock-pi.js";
import { createMockChildProcess, createSequentialSpawn } from "./helpers/mock-spawn.js";

// Regression tests for the cross-platform kill helper inside MonitorManager.
//
// On Windows, `subprocess.kill("SIGTERM")` and `subprocess.kill("SIGKILL")` both
// throw `EINVAL` because those POSIX signals don't exist there — the only valid
// kill form is the no-arg call (which routes to TerminateProcess). On POSIX the
// named signals are honored verbatim.
//
// These tests exercise the helper via a mock child process so they run on every
// platform (no real `sh`/`bash` required). The companion
// `monitor-manager.test.ts` suite, which spawns real processes, is gated to
// Unix-only because the manager hardcodes `sh -c <command>`.

describe("MonitorManager killProc (cross-platform)", () => {
  let manager: MonitorManager;
  let pi: any;

  beforeEach(() => {
    pi = createMockPi().pi;
  });

  afterEach(async () => {
    for (const m of manager.list()) {
      if (m.status === "running") await manager.stop(m.id);
    }
    vi.restoreAllMocks();
  });

  it("stop() invokes the child kill exactly once with the platform-correct signal", async () => {
    const proc = createMockChildProcess({ exitCode: 0 });
    const killSpy = vi.fn(() => {
      // Emit close on next microtask so stop() resolves its await.
      queueMicrotask(() => proc.emit("close", 0));
      return true;
    });
    proc.kill = killSpy as unknown as typeof proc.kill;

    manager = new MonitorManager(pi, createSequentialSpawn(proc));
    const entry = manager.create("cross-platform kill test");

    await manager.stop(entry.id);

    expect(killSpy).toHaveBeenCalledTimes(1);
    if (process.platform === "win32") {
      // No-arg kill → TerminateProcess on Windows.
      expect(killSpy.mock.calls[0]).toEqual([]);
    } else {
      // POSIX honors the named signal.
      expect(killSpy.mock.calls[0]).toEqual(["SIGTERM"]);
    }
  });

  it("stop() swallows EINVAL thrown by Windows-style kill (regression test)", async () => {
    // Simulate the exact Windows failure mode: `kill("SIGTERM")` throws EINVAL
    // because the signal is unsupported. The helper must catch and call the
    // no-arg form instead.
    const proc = createMockChildProcess({ exitCode: 0 });
    let attempted = 0;
    proc.kill = ((signal?: string) => {
      attempted += 1;
      if (signal !== undefined) {
        const err = new Error("kill EINVAL") as NodeJS.ErrnoException;
        err.code = "EINVAL";
        err.errno = -4071;
        err.syscall = "kill";
        throw err;
      }
      queueMicrotask(() => proc.emit("close", 0));
      return true;
    }) as unknown as typeof proc.kill;

    manager = new MonitorManager(pi, createSequentialSpawn(proc));
    const entry = manager.create("windows e2e simulation");

    await expect(manager.stop(entry.id)).resolves.toBe(true);
    // The first attempt throws on every platform when a signal is provided;
    // the helper falls back to the no-arg form. The first attempt's throw is
    // also what we want to confirm does NOT propagate to the caller.
    expect(attempted).toBeGreaterThanOrEqual(1);
  });

  it("stop() does not throw when the process has already exited", async () => {
    // On any platform, a child that's already gone must not crash stop() —
    // the wrapper calls `proc.kill()` which can race with the natural close.
    const proc = createMockChildProcess({ exitCode: 0 });
    proc.kill = (() => {
      const err = new Error(" ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    }) as unknown as typeof proc.kill;

    manager = new MonitorManager(pi, createSequentialSpawn(proc));
    const entry = manager.create("already-exited simulation");

    await expect(manager.stop(entry.id)).resolves.toBe(true);
  });
});
