export type LoopDeletionReason = "task_backlog_empty";

export interface LoopDeletionTombstone {
  id: string;
  reason: LoopDeletionReason;
  deletedAt: number;
  prompt: string;
  pendingCount?: number;
}

export type LoopDeletionTombstoneInput = Omit<LoopDeletionTombstone, "id" | "deletedAt" | "prompt">;

export type LoopStatus = "active" | "paused" | "paused_cap" | "paused_budget" | "paused_failure" | "completed";
export type LoopPriority = "defer" | "normal" | "urgent" | "critical";

/**
 * Loop execution mode. "in-process" (default) is the v2.x behaviour: each fire
 * becomes a turn in the parent session. "sub-agent" spawns a fresh child pi
 * process with its own context window; only a one-line summary enters the
 * parent. See `docs/PRD/sub-agent.md` for the full design.
 */
export type LoopIsolation = "in-process" | "sub-agent";

/**
 * Per-loop overrides for the sub-agent runtime. Mirrors the global
 * `subAgent` block in `.pi/pi-loop-settings.json`; per-loop values win
 * at spawn time.
 */
export interface LoopSubAgentConfig {
  /** Model for the child. Omit to inherit the parent's model. */
  model?: string;
  /** Thinking level for the child. Omit to inherit. */
  thinking?: "off" | "low" | "medium" | "high";
  /**
   * Tool allowlist for the child. Omit to use the parent's full tool surface
   * MINUS the `subagent` tool (which is always denied, to prevent recursion).
   * Use this field to restrict the child to a smaller toolset.
   */
  tools?: readonly string[];
  /** Wall-clock timeout for one iteration. Default 10 min. */
  iterationTimeoutMs?: number;
  /** Soft token budget per iteration. Default 30,000 in + 6,000 out. */
  iterationTokenBudget?: { in: number; out: number };
  /** Hard cumulative token budget across all iterations of this loop. */
  maxTokens?: number;
  /** Max number of iterations. Omit for unlimited. */
  maxIterations?: number;
  /** Working directory for the child. Defaults to the parent's cwd. */
  cwd?: string;
  /** Tags the child's session file with a label for FleetView. */
  label?: string;
  /** How many iterations to keep on disk before pruning. Default 50. */
  retainIterations?: number;
}

/**
 * Status of a single sub-agent iteration, as stored in result.json.
 */
export type SubAgentStatus =
  | "running"
  | "succeeded"
  | "succeeded_by_criteria"
  | "failed"
  | "failed_by_criteria"
  | "timeout"
  | "orphaned"
  | "cancelled";

/**
 * One iteration of a sub-agent loop. Written by the parent to
 * `<loopScope>/sub-agent-results/<loopId>/iter-<N>/result.json` after the
 * child process exits.
 */
export interface SubAgentResult {
  schemaVersion: 1;
  loopId: string;
  iterId: number;
  status: SubAgentStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tokens: { in: number; out: number; total: number };
  costUsd: number;
  exitCode: number | null;
  processSignal: NodeJS.Signals | null;
  resultPath: string | null;
  preview: string;
  errorMessage?: string;
  model?: string;
  thinking?: string;
  childSessionPath: string;
}

export interface CronTrigger {
  type: "cron";
  schedule: string;
}

export interface EventTrigger {
  type: "event";
  source: string;
  filter?: string;
}

export interface HybridTrigger {
  type: "hybrid";
  cron: string;
  event: { source: string; filter?: string };
  debounceMs: number;
}

export interface DynamicTrigger {
  type: "dynamic";
}

export type Trigger = CronTrigger | EventTrigger | HybridTrigger | DynamicTrigger;

export interface DynamicLoopState {
  goal: string;
  state?: string;
  metrics?: string;
  doneCriteria?: string;
  iteration: number;
  nextWakeAt?: number;
  awaitingUpdate?: boolean;
  lastUpdatedAt?: number;
}

export type WorkflowTerminalStatus = "completed" | "paused";

export interface WorkflowTaskDefinition {
  subject: string;
  description: string;
}

export interface WorkflowStateDefinition {
  prompt: string;
  task?: WorkflowTaskDefinition;
  on?: Record<string, string>;
  terminal?: WorkflowTerminalStatus;
  maxAttempts?: number;
}

export interface WorkflowDefinition {
  version: 1;
  initialState: string;
  states: Record<string, WorkflowStateDefinition>;
}

export interface WorkflowTransitionRecord {
  from: string;
  to: string;
  outcome: string;
  evidence?: string;
  at: number;
  sequence: number;
}

export interface WorkflowRunState {
  definition: WorkflowDefinition;
  currentState: string;
  transitionSeq: number;
  stateEnteredAt: number;
  attemptsByState: Record<string, number>;
  activeTaskId?: string;
  lastTransition?: WorkflowTransitionRecord;
}

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
  priority?: LoopPriority;
  dynamic?: DynamicLoopState;
  workflow?: WorkflowRunState;
  /**
   * Storage scope, mainly used for cross-repo shared loops. Defaults to
   * "project" when missing (back-compat for stored entries written before
   * share was introduced). Set explicitly by `LoopStore.promote` (writes
   * "shared") and `LoopStore.adopt` (writes "project"). The widget renders
   * a `[shared]` marker when this is "shared".
   */
  scope?: "project" | "session" | "shared";
  /**
   * Execution mode. "in-process" is the v2.x default (each fire becomes a
   * turn in the parent session). "sub-agent" spawns a fresh child pi process
   * with its own context window; only a one-line summary enters the parent.
   * See `docs/PRD/sub-agent.md`.
   */
  isolation?: LoopIsolation;
  /** Free-text description of the loop's purpose. Documentation only. */
  goal?: string;
  /** Regex matched against the child's result.md; success when matched. */
  successCriteria?: string;
  /** Regex matched against the child's result.md; failure when matched. */
  failureCriteria?: string;
  /** Path to a JSON file the child reads/writes for cross-iteration state. */
  stateFile?: string;
  /**
   * Per-loop overrides for the sub-agent runtime. Only meaningful when
   * `isolation === "sub-agent"`. Deep-merged with the global `subAgent`
   * settings block at spawn time.
   */
  subAgent?: LoopSubAgentConfig;
  /** Cumulative tokens consumed by this loop's sub-agent iterations. */
  cumulativeTokens?: number;
  /** Cumulative cost (USD) of this loop's sub-agent iterations. */
  cumulativeCostUsd?: number;
  /** Number of iterations completed. */
  iterCount?: number;
  /** Number of consecutive failed iterations. */
  consecutiveFailures?: number;
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
  lastOutputAt?: number;
  outputRatePerMinute?: number;
  progress?: MonitorProgress;
}

export interface MonitorProgress {
  current?: number;
  total?: number;
  message?: string;
  source: "jsonl" | "agent";
  updatedAt: number;
}

export interface MonitorProcess {
  entry: MonitorEntry;
  pid: number;
  proc: import("node:child_process").ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
  completionCallbacks: Array<() => void>;
  lastOutputEventAt: number;
  lastProgressChangeAt: number;
  progressChangeTimer?: ReturnType<typeof setTimeout>;
  pendingOutputLines: number;
  latestOutputLine?: string;
  outputBuckets: Array<{ second: number; count: number }>;
  stdoutDecoder: import("node:string_decoder").StringDecoder;
  stderrDecoder: import("node:string_decoder").StringDecoder;
  stdoutRemainder: string;
  stderrRemainder: string;
}
