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
├── index.ts              # Extension entry: 6 tools + /loop /loops commands + widget
├── types.ts              # LoopKind, Trigger spec, LoopEntry, MonitorEntry, LoopConfig
├── store.ts              # File-backed CRUD (.pi/loops/loops.json) with file locking
├── scheduler.ts          # Timer-based cron scheduler with jitter + 7-day expiry
├── trigger-system.ts     # Unified trigger engine: cron timers + pi event subscriptions + hybrid
├── monitor-manager.ts    # ChildProcess tracking, output buffering, event emission, stop
├── loop-parse.ts         # Human interval → cron expression, next-fire computation, jitter
└── ui/
    └── widget.ts         # Persistent widget: active loops + monitors
```

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

## Loop Persistence Scope
`PI_LOOP_SCOPE` controls where loops and native fallback tasks are stored. The default is **`project`** so loops persist across chat sessions and survive process restarts, mirroring pi-goal-x's `.pi/goals/` pattern.

| Scope | Location (relative to cwd) | Survives session switch? | Survives process restart? |
|-------|----------------------------|--------------------------|---------------------------|
| `project` (default) | `.pi/loops/loops.json`, `.pi/tasks/tasks.json` | yes | yes |
| `session` | `.pi/loops/loops-<sessionId>.json`, `.pi/tasks/tasks-<sessionId>.json` | no | no |
| `memory` | in-process only | no | no |

Override with `PI_LOOP_SCOPE=session` for per-session isolation, `PI_LOOP_SCOPE=memory` to disable on-disk persistence entirely, or `PI_LOOP=/abs/path` (or `PI_LOOP=./relative.json`) to pin a custom location.

After a process restart in project scope, cron loops re-arm automatically via the 30s heartbeat pump in `session-runtime.ts`. **Event/hybrid trigger subscriptions do NOT auto-re-arm** — call `/loop-resume <id>` (or `LoopDelete({id, action: "resume"})`) to re-bind them. The resume path is idempotent: it re-arms the trigger whether or not the stored loop is paused.

## Per-Session Loop Bindings

Multiple pi terminals in the same repo each pick a disjoint subset of stored loops to arm, so parallel agents can split work without one terminal firing another terminal's loops. The mechanism is a per-session bindings file at `<cwd>/.pi/loops/bindings-<sessionId>.json` containing `{ "loopIds": ["1","3","7"] }`. Each session owns its own file (no contention with other terminals).

- **Fresh-session default is strict isolation**: if the bindings file does not exist on first start, the session arms **zero** loops and emits a one-time notify: `'No bindings for this session — run /loop-resume to choose which loops this terminal arms.'`. This is a deliberate behavior change — the extension no longer auto-arms every active loop in the project store on session start.
- **`/loop-resume <id>` (one-shot)**: re-arms the loop and writes the id into the bindings file in a single call.
- **`/loop-resume` (no args)** opens the **governor** picker: every stored loop is shown as `[x] #N [status] prompt (trigger)` where the checkbox reflects THIS session's binding state. Selecting a row toggles its in-memory binding; `< OK` commits and exits; `< Continue` opens a `ui.confirm` diff preview (`Arm: #5, #9 / Disarm: #7`); `< Cancel` discards pending changes and exits.
- **Concurrent-session invariant**: two terminals in the same repo write only their own bindings files; the shared `.pi/loops/loops.json` registry is read by all sessions and written through the existing `LoopStore.withLock`. Trigger subscriptions are process-local — terminal A's `triggerSystem.add(#5)` does NOT cause terminal B to fire `#5`.

Implementation: `src/runtime/bindings-store.ts` (BindingsStore class), `src/runtime/scope.ts` (`resolveBindingsPath`), `src/runtime/session-runtime.ts` (`showPersistedLoops` filters arm-list by bindings), `src/commands/loop-command.ts` (governor + bindings-aware one-shot).
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
