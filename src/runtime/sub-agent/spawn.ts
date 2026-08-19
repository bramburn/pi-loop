/**
 * Cross-platform child-process spawn for sub-agent loop iterations.
 *
 * The child runs an unmodified `pi` binary in non-interactive mode with its
 * own session file, prompt file, and bounded wall-clock timeout. Two-stage
 * kill (SIGTERM at T-30s, SIGKILL at T) gives the child a chance to flush
 * before being reaped.
 *
 * The returned handle exposes the pid, the child's session path, and a
 * wait()/kill() pair. Callers register an exit handler that finalises the
 * result.json (see `result-store.ts`) and enqueues a notification
 * (see `result-watcher.ts`).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const IS_WINDOWS = process.platform === "win32";

export type ResolvedSpawn = {
  /** The actual command to invoke. May be a resolved absolute path. */
  cmd: string;
  /** Args to prepend to the caller's args (e.g. powershell -File for .ps1). */
  prefixArgs: string[];
  /** True if Node should run this through a shell. Required for .cmd/.bat on Windows. */
  useShell: boolean;
};

/**
 * Decide how to invoke `bin` on the current platform.
 *
 * On Windows, `child_process.spawn("pi", ...)` does NOT consult PATHEXT and
 * fails with ENOENT even when `pi.cmd` or `pi.ps1` is on PATH — the npm-bin
 * shims that nvm4w installs are PowerShell scripts with no plain `.exe`, so
 * the OS cannot resolve them as executables. To make sub-agent spawns
 * robust, we:
 *   - if `bin` looks like a path, use the file directly (wrap in powershell
 *     for `.ps1`; use `shell: true` for `.cmd`/`.bat` since CreateProcess
 *     cannot run batch files directly);
 *   - if `bin` is a bare command name on Windows, run `where.exe` to resolve
 *     it via PATHEXT, then dispatch by extension.
 *
 * On POSIX the behaviour is unchanged: pass `bin` straight to spawn.
 *
 * Cached per `bin` so the scheduler doesn't re-resolve on every tick.
 */
const resolveCache = new Map<string, ResolvedSpawn>();

export function resolveSpawnTarget(bin: string): ResolvedSpawn {
  const cached = resolveCache.get(bin);
  if (cached) return cached;
  const out = resolveSpawnTargetUncached(bin);
  resolveCache.set(bin, out);
  return out;
}

function resolveSpawnTargetUncached(bin: string): ResolvedSpawn {
  if (!IS_WINDOWS) {
    return { cmd: bin, prefixArgs: [], useShell: false };
  }

  const looksLikePath = /[\\/]/.test(bin) || /^[a-zA-Z]:/.test(bin);
  const ext = extname(bin).toLowerCase();
  if (looksLikePath) {
    if (ext === ".ps1") {
      return { cmd: "powershell.exe", prefixArgs: ["-NoProfile", "-NonInteractive", "-File", bin], useShell: false };
    }
    if (ext === ".cmd" || ext === ".bat") {
      return { cmd: bin, prefixArgs: [], useShell: true };
    }
    return { cmd: bin, prefixArgs: [], useShell: false };
  }

  // Bare command name on Windows: resolve via where.exe (PATHEXT-aware).
  let resolved: string | null = null;
  try {
    const out = execFileSync("where.exe", [bin], { encoding: "utf-8", windowsHide: true });
    const candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (candidates.length > 0) {
      // PATHEXT priority for an actual executable: .exe > .cmd > .bat > .ps1.
      // .ps1 ranks last because it requires a powershell.exe wrapper.
      const rank: Record<string, number> = { ".exe": 4, ".cmd": 3, ".bat": 2, ".ps1": 1 };
      candidates.sort(
        (a, b) => (rank[extname(b).toLowerCase()] ?? 0) - (rank[extname(a).toLowerCase()] ?? 0),
      );
      resolved = candidates[0] ?? null;
    }
  } catch {
    // where.exe exits non-zero when the command is not found; fall through.
  }
  if (!resolved) {
    throw new Error(
      `Could not find "${bin}" on PATH. On Windows, child_process.spawn does not consult PATHEXT for bare command names. ` +
        `Set subAgent.piBinary in .pi/pi-loop-settings.json to an explicit path, e.g. "C:\\\\nvm4w\\\\nodejs\\\\pi.cmd" or "C:\\\\nvm4w\\\\nodejs\\\\pi.ps1".`,
    );
  }
  const rExt = extname(resolved).toLowerCase();
  if (rExt === ".ps1") {
    return { cmd: "powershell.exe", prefixArgs: ["-NoProfile", "-NonInteractive", "-File", resolved], useShell: false };
  }
  if (rExt === ".cmd" || rExt === ".bat") {
    return { cmd: resolved, prefixArgs: [], useShell: true };
  }
  return { cmd: resolved, prefixArgs: [], useShell: false };
}

export interface SpawnRequest {
  loopId: string;
  iterId: number;
  /** Project root or scope root. The child runs in this directory. */
  cwd: string;
  /** Path to the per-iteration session file (created empty if missing). */
  childSessionPath: string;
  /** Path to the prompt file the child reads via @file syntax. */
  promptPath: string;
  /** Optional model override. Omit to inherit from the parent. */
  model?: string;
  /** Optional thinking level. Omit to inherit. */
  thinking?: "off" | "low" | "medium" | "high";
  /** Wall-clock timeout in milliseconds. */
  iterationTimeoutMs: number;
  /** Path to the pi binary. Default "pi". */
  piBinary?: string;
  /** Extra env vars to pass to the child. */
  envOverrides?: Record<string, string>;
  /** Loop prompt (used to seed the prompt file). */
  prompt: string;
  /** Loop name shown to the child. */
  loopName: string;
}

export interface SpawnHandle {
  pid: number;
  childSessionPath: string;
  resultPath: string;
  startedAt: number;
  kill(signal?: NodeJS.Signals): void;
  wait(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  /**
   * True once the wall-clock timeout has fired and the handle's internal
   * two-stage kill (SIGTERM at T-30s, SIGKILL at T) has been triggered.
   * The result-watcher uses this to distinguish a "timeout" from a user-
   * initiated "cancel": a SIGTERM/SIGKILL exit with `killedByTimer === true`
   * is a timeout; otherwise it is a cancel.
   */
  killedByTimer: boolean;
}

function ensureParent(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export async function spawnSubAgent(req: SpawnRequest): Promise<SpawnHandle> {
  ensureParent(req.childSessionPath);
  ensureParent(req.promptPath);
  // Touch the session file so the child can `--session-file` against it.
  writeFileSync(req.childSessionPath, "", { flag: "a" });
  // Write the prompt file (header + prompt). The child reads it via @file.
  const header = [
    `You are running iteration ${req.iterId} of a recurring loop named "${req.loopName}".`,
    "",
    "The loop's prompt is:",
    "",
    req.prompt,
    "",
    "When you finish, write your final answer to .result.md (relative to your cwd).",
    "",
    "Then exit. Do not start a REPL. Do not run sub-agents of your own (the subagent tool is denied).",
    "",
  ].join("\n");
  writeFileSync(req.promptPath, header, { flag: "w", encoding: "utf-8" });

  const args = [
    "--session-file", req.childSessionPath,
    "--prompt", `@${req.promptPath}`,
    "--non-interactive",
    "--no-extensions",
  ];
  if (req.model) args.push("--model", req.model);
  if (req.thinking) args.push("--thinking", req.thinking);
  if (req.iterationTimeoutMs > 0) {
    args.push("--max-duration-ms", String(req.iterationTimeoutMs));
  }

  const bin = req.piBinary || "pi";
  const target = resolveSpawnTarget(bin);
  const allArgs = [...target.prefixArgs, ...args];
  const child: ChildProcess = spawn(target.cmd, allArgs, {
    cwd: resolve(req.cwd),
    env: { ...process.env, ...(req.envOverrides ?? {}), PI_LOOP_SUB_AGENT_LOOP_ID: req.loopId, PI_LOOP_SUB_AGENT_ITER_ID: String(req.iterId) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
    ...(target.useShell ? { shell: true } : {}),
  });

  const startedAt = Date.now();
  // Two-stage kill: SIGTERM at T-30s, SIGKILL at T.
  const handle: SpawnHandle = {
    pid: child.pid ?? -1,
    childSessionPath: req.childSessionPath,
    resultPath: join(dirname(req.childSessionPath), "result.json"),
    startedAt,
    killedByTimer: false,
    kill: (signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (IS_WINDOWS) {
        // Terminate the whole process tree: with `shell: true` for .cmd/.bat,
        // or with powershell.exe wrapping for .ps1, the actual child pi is
        // a grandchild of `child.pid`. TerminateProcess on the parent alone
        // does not cascade. taskkill /T walks the tree.
        try {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          // Process already gone; nothing to do.
        }
        return;
      }
      child.kill(signal ?? "SIGTERM");
    },
    wait: () => new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
        clearTimeout(outerTimer);
        resolve({ exitCode: code, signal: sig });
      };
      child.once("exit", (code, sig) => onExit(code, sig as NodeJS.Signals | null));
    }),
  };
  const outerTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    handle.killedByTimer = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGKILL");
    }, 30_000).unref();
  }, Math.max(1, req.iterationTimeoutMs));
  outerTimer.unref();

  return handle;
}
