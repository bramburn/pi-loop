/**
 * Node Process Hygiene and Cleanup - Loop 5
 *
 * Monitors node.exe processes, tracks CPU usage over time,
 * and terminates only processes that are both OLD and IDLE.
 * Protects pi.dev/Tabby processes at all costs.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const STATE_FILE = process.env.NODE_HYGIENE_STATE || path.join(".pi", "fruit-loops", "loop5_node_state.json");
const MAX_SAMPLES = 10;
const MAX_KILL_LOG = 50;

export interface TrackedProcess {
  commandline: string;
  creation_date: string;
  cpu_samples: number[];
  protected: boolean;
}

export interface KillLogEntry {
  pid: number;
  commandline: string;
  age_minutes: number;
  max_cpu_sample: number;
  killed_at: string;
}

export interface NodeHygieneState {
  last_run: string;
  age_threshold_minutes: number;
  cpu_idle_threshold_percent: number;
  min_samples_before_kill: number;
  protected_patterns: string[];
  tracked_processes: Record<string, TrackedProcess>;
  kill_log: KillLogEntry[];
}

export function createDefaultState(): NodeHygieneState {
  return {
    last_run: new Date().toISOString(),
    age_threshold_minutes: 60,
    cpu_idle_threshold_percent: 2,
    min_samples_before_kill: 3,
    protected_patterns: [
      "pi.dev",
      "pi-dev",
      "tabby",
      "Tabby.exe",
      ".pi\\",
      "language-server",
      "lsp",
    ],
    tracked_processes: {},
    kill_log: [],
  };
}

export function loadState(): NodeHygieneState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as NodeHygieneState;
      if (
        typeof parsed.last_run === "string" &&
        typeof parsed.tracked_processes === "object" &&
        Array.isArray(parsed.kill_log)
      ) {
        return parsed;
      }
    }
  } catch (err) {
    console.error("[node-hygiene] State file corrupted, backing up and recreating: " + err);
    if (fs.existsSync(STATE_FILE)) {
      const backup = STATE_FILE + ".backup." + Date.now();
      fs.copyFileSync(STATE_FILE, backup);
    }
  }
  return createDefaultState();
}

function saveState(state: NodeHygieneState): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, STATE_FILE);
}

interface ProcessInfo {
  pid: string;
  creationDate: string;
  commandline: string;
}

function runWmic(cmd: string): string[] {
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.trim().split("\n").filter(line => line.trim());
  } catch (err) {
    console.error("[node-hygiene] WMIC command failed: " + err);
    throw new Error("WMIC command failed: " + err);
  }
}

function parseWmicCsv<T extends Record<string, string>>(lines: string[]): T[] {
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
  const results: T[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",");
    if (values.length !== headers.length) continue;

    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[j]?.trim() || "";
    }
    results.push(obj as T);
  }

  return results;
}

function fetchNodeProcesses(): ProcessInfo[] {
  const cmd = "wmic process where \"Name='node.exe'\" get ProcessId,CreationDate,CommandLine /format:csv";
  const lines = runWmic(cmd);
  const parsed = parseWmicCsv<{ processid: string; creationdate: string; commandline: string }>(lines);

  return parsed
    .filter(p => p.processid && p.processid !== "ProcessId")
    .map(p => ({
      pid: p.processid,
      creationDate: p.creationdate,
      commandline: p.commandline || "(unknown)",
    }));
}

function fetchCpuUsage(): Map<string, number> {
  const cmd = "wmic path Win32_PerfFormattedData_PerfProc_Process where \"Name='node'\" get IDProcess,PercentProcessorTime /format:csv";
  const lines = runWmic(cmd);
  const parsed = parseWmicCsv<{ idprocess: string; percentprocessortime: string }>(lines);

  const cpuMap = new Map<string, number>();
  for (const p of parsed) {
    if (p.idprocess && p.idprocess !== "IDProcess") {
      const cpu = parseInt(p.percentprocessortime, 10);
      cpuMap.set(p.idprocess, Number.isNaN(cpu) ? 0 : cpu);
    }
  }
  return cpuMap;
}

export function isProtected(commandline: string, patterns: string[]): boolean {
  const lower = commandline.toLowerCase();
  for (const pattern of patterns) {
    if (lower.includes(pattern.toLowerCase())) {
      return true;
    }
  }
  return false;
}

export function getAgeMinutes(creationDate: string): number {
  try {
    const match = creationDate.match(/^(\d{14})(\.\d+)?([+-]\d{3})?/);
    if (!match) return 0;

    const year = parseInt(match[1].slice(0, 4), 10);
    const month = parseInt(match[1].slice(4, 6), 10) - 1;
    const day = parseInt(match[1].slice(6, 8), 10);
    const hour = parseInt(match[1].slice(8, 10), 10);
    const minute = parseInt(match[1].slice(10, 12), 10);
    const second = parseInt(match[1].slice(12, 14), 10);

    const created = new Date(year, month, day, hour, minute, second);
    const now = new Date();
    return Math.floor((now.getTime() - created.getTime()) / 60000);
  } catch {
    return 0;
  }
}

function killProcess(pid: number): boolean {
  try {
    execSync("taskkill /PID " + pid + " /F", {
      windowsHide: true,
      timeout: 10000,
    });
    return true;
  } catch (err) {
    console.error("[node-hygiene] Failed to kill PID " + pid + ": " + err);
    return false;
  }
}

export async function runNodeHygiene(): Promise<string> {
  const startTime = Date.now();
  const lines: string[] = [];

  const log = (msg: string) => {
    const timestamp = new Date().toISOString();
    lines.push("[" + timestamp + "] " + msg);
    console.error("[node-hygiene] " + msg);
  };

  try {
    log("Loading state...");
    const state = loadState();

    log("Fetching node.exe processes...");
    let processes: ProcessInfo[];
    let cpuMap: Map<string, number>;

    try {
      processes = fetchNodeProcesses();
      log("Found " + processes.length + " node.exe processes");
    } catch (err) {
      log("FATAL: Could not enumerate processes: " + err);
      return lines.join("\n");
    }

    try {
      cpuMap = fetchCpuUsage();
      log("Fetched CPU usage for " + cpuMap.size + " processes");
    } catch (err) {
      log("WARNING: Could not fetch CPU usage: " + err);
      cpuMap = new Map();
    }

    log("Reconciling process state...");
    const currentPids = new Set(processes.map(p => p.pid));

    for (const proc of processes) {
      const pid = proc.pid;
      const cpu = cpuMap.get(pid) ?? 0;
      const protected_flag = isProtected(proc.commandline, state.protected_patterns);

      if (state.tracked_processes[pid]) {
        const tracked = state.tracked_processes[pid];
        tracked.cpu_samples.push(cpu);
        if (tracked.cpu_samples.length > MAX_SAMPLES) {
          tracked.cpu_samples = tracked.cpu_samples.slice(-MAX_SAMPLES);
        }
        tracked.protected = protected_flag;
      } else {
        state.tracked_processes[pid] = {
          commandline: proc.commandline,
          creation_date: proc.creationDate,
          cpu_samples: [cpu],
          protected: protected_flag,
        };
        log("  + Tracking PID " + pid + ": " + proc.commandline.slice(0, 80));
        if (protected_flag) {
          log("    (PROTECTED)");
        }
      }
    }

    for (const pid of Object.keys(state.tracked_processes)) {
      if (!currentPids.has(pid)) {
        log("  - Removing stale PID " + pid + " from tracking");
        delete state.tracked_processes[pid];
      }
    }

    log("Evaluating kill candidates...");
    const candidates: Array<{ pid: string; tracked: TrackedProcess; age_minutes: number }> = [];

    for (const [pid, tracked] of Object.entries(state.tracked_processes)) {
      if (tracked.protected) {
        log("  PID " + pid + ": PROTECTED (skipping)");
        continue;
      }

      const age_minutes = getAgeMinutes(tracked.creation_date);
      const sample_count = tracked.cpu_samples.length;
      const max_cpu = Math.max(...tracked.cpu_samples);

      const meets_age = age_minutes >= state.age_threshold_minutes;
      const meets_samples = sample_count >= state.min_samples_before_kill;
      const meets_idle = max_cpu <= state.cpu_idle_threshold_percent;

      const status = (meets_age && meets_samples && meets_idle) ? "KILL" : "skip";

      log("  PID " + pid + ": age=" + age_minutes + "m, samples=" + sample_count + ", max_cpu=" + max_cpu + "% -> " + status);

      if (meets_age && meets_samples && meets_idle) {
        candidates.push({ pid, tracked, age_minutes });
      }
    }

    log("Executing " + candidates.length + " termination(s)...");
    for (const { pid, tracked, age_minutes } of candidates) {
      const max_cpu = Math.max(...tracked.cpu_samples);
      log("  Killing PID " + pid + ": " + tracked.commandline.slice(0, 60) + "...");

      if (killProcess(parseInt(pid, 10))) {
        state.kill_log.push({
          pid: parseInt(pid, 10),
          commandline: tracked.commandline,
          age_minutes,
          max_cpu_sample: max_cpu,
          killed_at: new Date().toISOString(),
        });

        delete state.tracked_processes[pid];
        log("    -> Killed successfully");
      } else {
        log("    -> Kill failed (may have exited)");
      }
    }

    if (state.kill_log.length > MAX_KILL_LOG) {
      state.kill_log = state.kill_log.slice(-MAX_KILL_LOG);
    }

    state.last_run = new Date().toISOString();
    saveState(state);
    log("State saved");

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log("Complete in " + elapsed + "s");

    return lines.join("\n");

  } catch (err) {
    log("FATAL ERROR: " + err);
    return lines.join("\n");
  }
}

const isMain = process.argv[1]?.endsWith("node-hygiene.ts") ||
               process.argv[1]?.endsWith("node-hygiene.js");
if (isMain) {
  runNodeHygiene().then(output => {
    console.log(output);
    process.exit(0);
  }).catch(err => {
    console.error("Fatal: " + err);
    process.exit(1);
  });
}
