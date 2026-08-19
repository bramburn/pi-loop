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

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
  const child: ChildProcess = spawn(bin, args, {
    cwd: resolve(req.cwd),
    env: { ...process.env, ...(req.envOverrides ?? {}), PI_LOOP_SUB_AGENT_LOOP_ID: req.loopId, PI_LOOP_SUB_AGENT_ITER_ID: String(req.iterId) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
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
