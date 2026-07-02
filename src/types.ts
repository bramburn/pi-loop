export type LoopStatus = "active" | "paused";

export interface CronTrigger {
  type: "cron";
  schedule: string;
}

export interface EventTrigger {
  type: "event";
  source: string;
  /**
   * Optional filter for matching event payloads.
   * Two formats:
   *  - "regex:pattern" — tests JSON.stringify(data) against the regex
   *  - JSON object string — compares top-level keys to expected values
   *    e.g., '{"monitorId":"abc123"}' matches events where data.monitorId === "abc123"
   */
  filter?: string;
}

export interface HybridTrigger {
  type: "hybrid";
  cron: string;
  event: {
    source: string;
    /**
     * Optional filter for the event portion. See EventTrigger.filter for
     * accepted formats ("regex:..." or JSON object string).
     */
    filter?: string;
  };
  debounceMs: number;
}

export type Trigger = CronTrigger | EventTrigger | HybridTrigger;

export interface LoopEntry {
  id: string;
  prompt: string;
  trigger: Trigger;
  status: LoopStatus;
  recurring: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  autoTask?: boolean;
  taskBacklog?: boolean;
  readOnly?: boolean;
  maxFires?: number;
  fireCount?: number;
}

export interface LoopStoreData {
  nextId: number;
  loops: LoopEntry[];
}

export interface MonitorEntry {
  id: string;
  command: string;
  description?: string;
  timeout: number;
  status: "running" | "completed" | "error" | "stopped";
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  outputLines: number;
  outputBuffer: string[];
}

export interface MonitorProcess {
  entry: MonitorEntry;
  pid: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
  completionCallbacks: Array<() => void>;
}
