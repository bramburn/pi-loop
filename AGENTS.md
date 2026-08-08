# pi-loop Development Guidelines

## Overview
`pi-loop` is a pi extension providing cron/event-based agent re-wake loops and background process monitoring. Modeled after Claude Code's `/loop`, `CronCreate`, and `MonitorCreate` tools.

## Stack
- TypeScript 6.x (strict, ES2022 target, bundler module resolution)
- `typebox` for tool parameter validation
- `vitest` for tests
- `biome` for linting (linter: on, formatter: off)
- npm packaging as `@bramburn/pi-loop`

## Architecture
```
src/
├── index.ts              # Extension entry: 4 loop tools + /loop + /loop-resume + widget + /loop-settings
├── types.ts              # LoopKind, Trigger spec, LoopEntry, MonitorEntry, LoopConfig
├── store.ts              # File-backed CRUD (.pi/loops/loops.json) with file locking
├── scheduler.ts          # Timer-based cron scheduler with jitter + 7-day expiry
├── trigger-system.ts     # Unified trigger engine: cron timers + pi event subscriptions + hybrid
├── monitor-manager.ts    # ChildProcess tracking, output buffering, event emission, stop
├── loop-parse.ts         # Human interval → cron expression, next-fire computation, jitter
├── settings.ts           # v2.0 unified settings (parseSettings, loadSettings, saveSettings, updateSettings)
├── migration/            # v1 → v2 migration tooling
│   └── v1-to-v2.ts       # One-shot idempotent migration from tasks-config.json + PI_LOOP_* env vars
├── telemetry/            # Sentry integration (opt-in via SENTRY_DSN)
│   ├── sentry.ts         # initSentry, captureException, addBreadcrumb, log*, scrubPii, wrapToolExecute
│   └── index.ts          # Public re-exports
├── tools/                # Tool registration and tool-visibility gating
│   ├── loop-tools.ts     # LoopCreate / LoopList / LoopUpdate / LoopDelete / WorkflowTransition
│   ├── workflow-tools.ts # Workflow state-machine tools
│   ├── monitor-tools.ts  # MonitorCreate / MonitorList / MonitorStop / MonitorDelete
│   ├── native-task-tools.ts  # Native task CRUD (pi-tasks fallback)
│   └── tool-visibility.ts # syncLoopTools — gates LLM tool set on loop state
├── runtime/              # Long-running behaviour
│   ├── session-runtime.ts    # Session lifecycle hooks + keybindings + crash recovery
│   ├── notification-runtime.ts  # Fire / monitor-wake buffering + delivery
│   ├── bindings-store.ts     # Per-session loop bindings (multi-terminal isolation)
│   ├── monitor-ondone-runtime.ts  # One-shot monitor:done cleanup
│   ├── native-task-rpc.ts    # Cross-extension task RPC bridge
│   ├── task-rpc.ts           # TaskRuntimeBridge (RPC + native fallback)
│   ├── task-mutations.ts     # createTask / claimTask / heartbeatTask
│   ├── task-backlog-runtime.ts # Auto task worker loop at backlog threshold
│   ├── task-provider-runtime.ts # pi-tasks presence detection
│   ├── task-events.ts        # Native task event emitters
│   ├── scope.ts              # LoopScope resolution (loopScope/taskScope from settings)
│   └── fruit-loops/node-hygiene.ts # DEPRECATED legacy node cleanup
├── commands/             # Slash-command handlers
│   ├── loop-command.ts    # /loop [interval] [prompt] + /loop-resume [id]
│   ├── settings-command.ts # /loop-settings (TUI editor for unified settings)
│   ├── tasks-command.ts    # /tasks (native task viewer + CRUD)
│   └── monitors-command.ts # /monitors (manage background processes)
├── ui/                   # TUI components
│   ├── widget.ts         # LoopWidget — above-editor Component registered via setWidget("loops", ..., {placement:"aboveEditor"})
│   ├── widget-render.ts  # Pure renderWidgetLines(state, theme, width) — clamp + tree
│   ├── overlays.ts       # showLoopListOverlay (Ctrl+Shift+L) — scrollable list, "a" toggles my/all
│   ├── escape-dialog.ts  # showEscapeDialog — 3-option modal (cancel/skip/continue)
│   └── tool-renderer.ts  # renderToolCall / renderToolResult / toolArg / hideToolTranscript
├── rpc/                  # Cross-extension RPC plumbing
│   └── cross-extension-rpc.ts
├── workflow-reducer.ts   # State machine for workflow runs (validate/create/transition)
├── reducer-backed-store.ts # Atomic-write persistence pattern (tmp + rename)
└── docs/plan/            # v2.0 architecture decision records (ADRs)
    ├── ADR-001-widget-key-naming.md
    ├── ADR-002-tool-visibility-call-site.md
    ├── ADR-003-settings-file-schema.md
    └── ADR-004-overlay-keybindings.md
```

## Conventions (mirror pi-tasks)
- No comments unless answering "why", never "what"
- `debug(...)` helper gated on `settings.debug` (configured via `/loop-settings`); logs to stderr
- `textResult(msg)` helper for uniform tool output
- All tool params use `Type.Object()` with description strings
- Tool descriptions follow Claude Code format: `## When to Use`, `## When NOT to Use`
- Cross-extension communication via `pi.events` with `requestId` + reply channels
- File-backed stores use atomic write (write tmp → rename) + pid-based file locking
- The above-editor widget is registered with `ctx.ui.setWidget(KEY, factory, {placement: "aboveEditor"})` and re-rendered via `tui.requestRender()`. Never re-register the factory on every update — that defeats the TUI's dirty model.
- Tests co-located in `test/`, named `<module>.test.ts`

## v2.0 Configuration (Unified Settings File)

**All runtime configuration lives in `.pi/pi-loop-settings.json`** with a strict JSON schema (unknown keys cause a startup error). The v1.x scattered config — `.pi/tasks-config.json` plus `PI_LOOP_SCOPE` / `PI_LOOP` / `PI_LOOP_DEBUG` / `PI_LOOP_TASK_THRESHOLD` / `PI_LOOP_TASK_WORKER_THRESHOLD` env vars — is captured once on first v2 startup by `src/migration/v1-to-v2.ts` and never read at runtime again. Edit via `/loop-settings`.

Schema (all fields required, defaults from `DEFAULT_SETTINGS` in `src/settings.ts`):

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `loopScope` | `"memory" \| "session" \| "project"` | `"project"` | Where loop state is persisted |
| `taskScope` | `"memory" \| "session" \| "project"` | `"session"` | Where task state is persisted |
| `debug` | `boolean` | `false` | Verbose stderr logging |
| `autoClear` | `"never" \| "on_list_complete" \| "on_task_complete"` | `"on_list_complete"` | When completed tasks are swept |
| `sortOrder` | `"id" \| "status" \| "recent" \| "oldest"` | `"id"` | Task list order |
| `hiddenAt` | `"top" \| "bottom"` | `"bottom"` | Where completed tasks fold in the widget |
| `maxVisible` | integer ≥ 1 | `10` | Max tasks shown in widget |
| `showAll` | `boolean` | `false` | Show all tasks regardless of `maxVisible` |
| `taskThreshold` | integer ≥ 1 | `5` | Backlog-worker loop auto-creation threshold |

## Loop Persistence Scope

`settings.loopScope` controls where loops and native fallback tasks are stored. The default is **`project`** so loops persist across chat sessions and survive process restarts, mirroring pi-goal-x's `.pi/goals/` pattern.

| Scope | Location (relative to cwd) | Survives session switch? | Survives process restart? |
|-------|----------------------------|--------------------------|---------------------------|
| `project` (default) | `.pi/loops/loops.json`, `.pi/tasks/tasks.json` | yes | yes |
| `session` | `.pi/loops/loops-<sessionId>.json`, `.pi/tasks/tasks-<sessionId>.json` | no | no |
| `memory` | in-process only | no | no |

Change scope via `/loop-settings` (no env var override). For per-session isolation across concurrent worktrees, use `session`; for disposable scratch work, use `memory`.

After a process restart in project scope, cron loops re-arm automatically via the 30s heartbeat pump in `session-runtime.ts`. **Event/hybrid trigger subscriptions do NOT auto-re-arm** — call `/loop-resume <id>` (or `LoopDelete({id, action: "resume"})`) to re-bind them. The resume path is idempotent: it re-arms the trigger whether or not the stored loop is paused.

## Tool Schema Discipline
- Tool calls must use the exact schema field names from the tool definition. Do not invent aliases.
- Example: `TaskUpdate` uses `id`, not `taskId`.
- When a tool validation error clearly indicates an immediately recoverable schema mismatch, correct it silently and retry. Do not emit user-facing chatter like "retrying with the correct shape" unless the recovery itself changes the user's understanding.
- When adding or revising tool prompt guidance, include concrete parameter-name reminders for commonly miscalled tools.

## File Locking Pattern
Copy TaskStore from pi-tasks: `O_EXCL` lockfile, stale PID detection, `LOCK_RETRY_MS`/`LOCK_MAX_RETRIES`

## Loop Persistence Scope
`settings.loopScope` controls where loops and native fallback tasks are stored. The default is **`project`** so loops persist across chat sessions and survive process restarts, mirroring pi-goal-x's `.pi/goals/` pattern.

| Scope | Location (relative to cwd) | Survives session switch? | Survives process restart? |
|-------|----------------------------|--------------------------|---------------------------|
| `project` (default) | `.pi/loops/loops.json`, `.pi/tasks/tasks.json` | yes | yes |
| `session` | `.pi/loops/loops-<sessionId>.json`, `.pi/tasks/tasks-<sessionId>.json` | no | no |
| `memory` | in-process only | no | no |

Use `/loop-settings` to change scope. There is no env-var override in v2.0.

After a process restart in project scope, cron loops re-arm automatically via the 30s heartbeat pump in `session-runtime.ts`. **Event/hybrid trigger subscriptions do NOT auto-re-arm** — call `/loop-resume <id>` (or `LoopDelete({id, action: "resume"})`) to re-bind them. The resume path is idempotent: it re-arms the trigger whether or not the stored loop is paused.

## Per-Session Loop Bindings

Multiple pi terminals in the same repo each pick a disjoint subset of stored loops to arm, so parallel agents can split work without one terminal firing another terminal's loops. The mechanism is a per-session bindings file at `<cwd>/.pi/loops/bindings-<sessionId>.json` containing `{ "loopIds": ["1","3","7"] }`. Each session owns its own file (no contention with other terminals).

- **Fresh-session default is strict isolation**: if the bindings file does not exist on first start, the session arms **zero** loops and emits a one-time notify: `'No bindings for this session — run /loop-resume to choose which loops this terminal arms.'`. This is a deliberate behavior change — the extension no longer auto-arms every active loop in the project store on session start.
- **`/loop-resume <id>` (one-shot)**: re-arms the loop and writes the id into the bindings file in a single call.
- **`/loop-resume` (no args)** opens a simple picker: every stored loop is shown as `* #N [status] prompt (trigger)`. Selecting a row re-arms that loop; `< Back` exits without changing anything.
- **Concurrent-session invariant**: two terminals in the same repo write only their own bindings files; the shared `.pi/loops/loops.json` registry is read by all sessions and written through the existing `LoopStore.withLock`. Trigger subscriptions are process-local — terminal A's `triggerSystem.add(#5)` does NOT cause terminal B to fire `#5`.

Implementation: `src/runtime/bindings-store.ts` (BindingsStore class), `src/runtime/scope.ts` (`resolveBindingsPath`), `src/runtime/session-runtime.ts` (`showPersistedLoops` filters arm-list by bindings), `src/commands/loop-command.ts` (simple picker + bindings-aware one-shot).
## Trigger Types
Three trigger types, all stored as `LoopEntry.trigger`:
- `{ type: "cron", schedule: "*/5 * * * *" }` — timer-based
- `{ type: "event", source: "tool_execution_start", filter?: "regex:..." | '{"key":"value"}' }` — eventbus-based
- `{ type: "hybrid", cron: "...", event: { source, filter? }, debounceMs: 30000 }` — both with debounce

All cron/hybrid loops are dynamic: they track their next fire time but only deliver on agent idle (`agent_end`/`turn_start`) rather than wall-clock timers.

## Re-wake via In-Memory Pending Notifications
When a loop fires, the scheduler calls `onLoopFire()` which emits `pi.events("loop:fire", ...)`. The extension buffers a pending notification in memory, re-checks whether the wake is still relevant, and only then injects a `pi.sendMessage()` custom message to wake the agent. Do not rely on early queued follow-up user messages for loop delivery; those are not extension-cancelable once handed to pi's queue.

All loops are idle-driven. Cron and hybrid loops track their next fire time but only deliver when the agent becomes idle (via `agent_end`/`turn_start`), resetting their timer from the actual delivery point.

## Monitor Streaming via PI Events
Monitor stdout/stderr lines are emitted as `pi.events("monitor:output", { monitorId, line, timestamp })`. Tool consumers subscribe to these events. Completion emits `"monitor:done"` / `"monitor:error"`.

## pi-tasks Integration
When `@tintinweb/pi-tasks` is present, `LoopCreate` with `autoTask: true` fires an RPC to create a task. Communication via `pi.events`:
- `tasks:rpc:ping` on init → detect pi-tasks presence
- `tasks:ready` listener → late-binding detection
- `tasks:rpc:create` → auto-create task when loop fires (if `autoTask: true`)

## /loop Self-Paced Mode
When no interval is specified in `/loop prompt`, the loop runs in self-paced mode. The agent receives the prompt, acts on it, and uses `LoopCreate`/`LoopUpdate` to schedule the next iteration. The loop fires once, then the agent decides the next interval dynamically (matching Claude Code's dynamic interval behavior).

## Testing
- `vitest` with `describe`/`it` blocks
- In-memory stores for unit tests, `tmpdir` for file-backed tests
- Fake timers (`vi.useFakeTimers`) for scheduler tests
- Mock pi eventbus for monitor-manager tests
- `vitest run` in CI, `vitest` for watch mode

## Limits
- Maximum 25 active loops
- Maximum 25 running monitors
- 7-day expiry on recurring loops
- 5-minute default cron interval for self-paced mode

## Telemetry (Sentry)

Crash analytics is **opt-in**. End users set `SENTRY_DSN` to enable; without it, every callsite in `src/telemetry/sentry.ts` is a no-op (verified by `test/telemetry/sentry.test.ts`).

**Public API (from `src/telemetry/index.ts`):**

| Function | Purpose | Notes |
|---|---|---|
| `initSentry(opts)` | Boot Sentry with PII scrubbing, capture logs, install process handlers | Returns `false` if `SENTRY_DSN` unset |
| `captureException(err, ctx?)` | Forward an error to Sentry | No-op when not initialized |
| `addBreadcrumb(msg, data?)` | Emit a structured breadcrumb | No-op when not initialized |
| `logInfo / logDebug / logWarn / logError` | Pipe structured logs via Sentry's `logger` | No-op when not initialized |
| `flushSentry(timeoutMs?)` | Flush buffered events (e.g. on shutdown) | No-op when not initialized |
| `wrapToolExecute(name, fn)` | Wrap a tool's `execute` with parallel-storm guard + breadcrumb + capture + rethrow | Used at the `pi.registerTool` boundary in `src/index.ts` |
| `recordParallelCall(name)` / `checkParallelStorm(name)` / `resetParallelGuard()` | Per-tool sliding-window call counter (2 calls / 1s) | Throws on the 3rd call to prevent TUI freeze |
| `scrubPii(input)` | Recursive PII redactor (paths, env, DSN, sensitive keys) | Used by `beforeSend` / `beforeBreadcrumb` / `beforeSendLog` |

**PII scrubbing rules** (in `scrubPii`):
- Strip `C:\...` and `/Users|...`, `/home|...`, `/root|...` paths from strings
- Strip `process.env.*` references
- Strip Sentry DSN URLs (`https://<key>@<org>.ingest.<region>.sentry.io/<id>`)
- Redact values under keys: `prompt`, `message`, `text`, `body`, `content`, `description`
- Redact `filename` and `abs_path` fields in stack frames

**Env vars (full list in `.env.example`):** `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_DEBUG`, `SENTRY_CAPTURE_LOGS`.

**Out of scope:** source-map upload via auth tokens, server-side PII rules (rely on Sentry's defaults), CI-side secret wiring (no production deploy of this package).
