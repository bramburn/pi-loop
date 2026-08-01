# pi-loop Development Guidelines

## Overview

`pi-loop` is a pi extension providing cron/event-based agent re-wake loops and background process monitoring. Modeled after Claude Code's `/loop`, `CronCreate`, and `MonitorCreate` tools.

## Stack

- TypeScript 6.x (strict, ES2022 target, bundler module resolution)
- `typebox` for tool parameter validation
- `vitest` for tests
- `biome` for linting (linter: on, formatter: off)
- npm packaging as `@trevonistrevon/pi-loop`

## Architecture

```
src/
├── index.ts                          # Extension entry: tool/command registration, session wiring, native task fallback timer
├── api.ts                            # Public subpath (@trevonistrevon/pi-loop/api): RPC channels/DTOs, TaskStore, scope resolvers
├── types.ts                          # LoopKind, Trigger spec, LoopEntry, MonitorEntry, LoopConfig
├── task-types.ts                     # TaskEntry, TaskStatus, TaskStoreData
├── store.ts                          # File-backed CRUD (.pi/loops/loops.json) with file locking
├── task-store.ts                     # File-backed CRUD for native fallback tasks (.pi/tasks/tasks.json)
├── reducer-backed-store.ts           # Shared atomic-write + pid-lock persistence layer for reducer-driven stores
├── coordinator.ts                    # ReducerSource/ReducerEvent/ReducerEffect plumbing shared by *-reducer/*-coordinator modules
├── loop-reducer.ts                   # Pure loop state transitions, incl. maxFires/expiry checks
├── monitor-reducer.ts                # Pure monitor state transitions
├── notification-reducer.ts           # Pure pending-notification state transitions
├── task-reducer.ts                   # Pure native task state transitions
├── monitor-completion-coordinator.ts # Reduces monitor "onDone" completion into a fire effect
├── task-backlog-coordinator.ts       # Reduces pending-task counts into auto-create/auto-clean effects
├── scheduler.ts                      # Timer-based cron scheduler with jitter + 7-day expiry
├── trigger-system.ts                 # Unified trigger engine: cron timers + pi event subscriptions + hybrid
├── monitor-manager.ts                # ChildProcess tracking, output buffering, event emission, stop
├── loop-parse.ts                     # Human interval → cron expression, next-fire computation, jitter
├── rpc/                               # VENDORED — canonical copy shared verbatim with pi-orca; see "Cross-extension RPC" below
│   ├── channels.ts                   # TASKS_RPC/SUBAGENTS_RPC/TASK_EVENTS channel constants + wire DTOs
│   └── cross-extension-rpc.ts        # rpcCall (client), rpcProbe (detection), handleRpc (server), PROTOCOL_VERSION, RpcError
├── runtime/                          # Extension-init-time wiring, one module per concern
│   ├── loop-events.ts                # Auto-delete payload types for backlog-drained loops
│   ├── monitor-ondone-runtime.ts     # Coordinator wiring for MonitorCreate's onDone → loop fire
│   ├── native-task-rpc.ts            # tasks:rpc:* server: ping/pending/create/clean/update over the native TaskStore
│   ├── notification-runtime.ts       # Pending-notification buffering + idle-driven delivery
│   ├── scope.ts                      # PI_LOOP_SCOPE → loop/task store path resolution
│   ├── session-runtime.ts            # Session-switch hooks, store (re)binding
│   ├── task-backlog-runtime.ts       # Auto-create/auto-clean backlog worker evaluation
│   ├── task-events.ts                # emitNativeTaskEvent: tasks:created/started/completed/reopened/updated/deleted
│   ├── task-mutations.ts             # Shared mutation service: mutate → emit event → widget → backlog, used by RPC server and tools
│   └── task-rpc.ts                   # Client bridge: probes pi-tasks, falls back to native TaskStore for autoTask/pending/clean
├── tools/                            # Tool implementations
│   ├── loop-tools.ts                 # LoopCreate/LoopList/LoopDelete
│   ├── monitor-tools.ts              # MonitorCreate/MonitorList/MonitorStop
│   ├── native-task-tools.ts          # TaskCreate/TaskList/TaskGet/TaskUpdate/TaskDelete (fallback only)
│   └── tool-result.ts                # textResult() helper
├── commands/
│   ├── loop-command.ts               # /loop interactive loop creation
│   └── tasks-command.ts              # /tasks native task viewer/manager
└── ui/
    └── widget.ts                     # Persistent widget: active loops + monitors + task summary
```

## Cross-extension RPC

`src/rpc/` is a **vendored** module: the canonical copy is maintained here and copied verbatim into the sibling `pi-orca` repo. If you edit `channels.ts` or `cross-extension-rpc.ts`, copy the change to `pi-orca` and bump the `VENDOR_REV` comment at the top of both files in both repos — the two copies must never drift.

The wire contract is request/reply over `pi.events`: a caller emits `{ requestId, ...params }` on a channel (e.g. `tasks:rpc:create`), the server replies on `<channel>:reply:<requestId>` with an envelope, `{success:true,data}` or `{success:false,error}`. `rpcCall` resolves/rejects that promise, `rpcProbe` swallows the rejection into `undefined` for presence detection, `handleRpc` is the server-side helper that turns a handler function into a channel subscription with automatic envelope wrapping. `PROTOCOL_VERSION` (currently `2`) is returned in ping replies so callers can gate on server capability.

`pi-loop`'s native tasks RPC server (`src/runtime/native-task-rpc.ts`) registers at extension init — not behind the native-tool-registration fallback timer — so early cross-extension calls never race it. It stands down (silent no-op via `isEnabled`) once an external `pi-tasks` is detected.

## Public API surface

External consumers must import `@trevonistrevon/pi-loop/api` (`src/api.ts`), never a deep `src/...` path. The package `exports` map in `package.json` enforces this — deep imports fail to resolve. `src/api.ts` re-exports the RPC channel constants/DTOs, `rpcCall`/`rpcProbe`/`handleRpc`/`RpcError`/`PROTOCOL_VERSION`, `TaskStore`, `TaskEntry`/`TaskStatus`, `resolveLoopStorePath`/`resolveTaskStorePath`, and `NATIVE_TASKS_PROVIDER`. Anything not re-exported there is internal and may change without notice.

## Conventions (mirror pi-tasks)

- No comments unless answering "why", never "what"
- `debug(...)` helper gated on `PI_LOOP_DEBUG` env var, logs to stderr
- `textResult(msg)` helper for uniform tool output
- All tool params use `Type.Object()` with description strings
- Tool descriptions follow Claude Code format: `## When to Use`, `## When NOT to Use`
- Cross-extension communication via `pi.events` with `requestId` + reply channels
- File-backed stores use atomic write (write tmp → rename) + pid-based file locking
- Runtime tracker UI uses `UICtx.setStatus()` for compact single-line state
- Tests co-located in `test/`, named `<module>.test.ts`

## Tool Schema Discipline

- Tool calls must use the exact schema field names from the tool definition. Do not invent aliases.
- Example: `TaskUpdate` uses `id`, not `taskId`.
- When a tool validation error clearly indicates an immediately recoverable schema mismatch, correct it silently and retry. Do not emit user-facing chatter like "retrying with the correct shape" unless the recovery itself changes the user's understanding.
- When adding or revising tool prompt guidance, include concrete parameter-name reminders for commonly miscalled tools.

## File Locking Pattern

Copy TaskStore from pi-tasks: `O_EXCL` lockfile, stale PID detection, `LOCK_RETRY_MS`/`LOCK_MAX_RETRIES`

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

`pi-loop` probes for `@tintinweb/pi-tasks` at init via `tasks:rpc:ping` (see "Cross-extension RPC" above) and again on a `tasks:ready` listener for late binding. When an external provider answers, `LoopCreate` with `autoTask: true` calls `tasks:rpc:create` to create a tracked task on fire. When no external provider answers, `pi-loop`'s own native RPC server (`src/runtime/native-task-rpc.ts`) serves all five verbs — `ping`/`pending`/`create`/`clean`/`update` — against the native `TaskStore`, and `autoTask: true` creates a native task directly instead of over RPC.

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
