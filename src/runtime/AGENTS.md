# `src/runtime/` — Long-Running Behaviour

Runtimes coordinate behaviour that crosses tool/command boundaries: session lifecycle, notification delivery, monitor-completion wakes, task backlog, and the pi-tasks RPC bridge.

## Files

- `session-runtime.ts` — `registerSessionRuntimeHooks` wires `turn_start`, `before_agent_start`, `agent_start`, `agent_end`, `session_shutdown`, `session_switch`, and `tool_execution_end` (for git-commit pruning). Also runs the 30s `HEARTBEAT_MS` interval that pumps `CronScheduler`.
- `notification-runtime.ts` — Buffers loop fires until the agent is idle, then delivers them via `pi.sendMessage({ deliverAs: "steer", triggerTurn: true })`. Uses a coordinator with a `NOTIFICATION_RUNTIME_UPDATED` reducer so flush + idle checks are atomic.
- `task-backlog-runtime.ts` — Owns the auto task worker loop (`AUTO_TASK_WORKER_PROMPT`) lifecycle. Threshold is `AUTO_TASK_WORKER_THRESHOLD` (5) and is overridable via the `PI_LOOP_TASK_THRESHOLD` env var.
- `task-rpc.ts` — Bridges native task tools to `@tintinweb/pi-tasks` over the event bus when pi-tasks is loaded.
- `task-events.ts` — Defines `emitNativeTaskEvent` for the `tasks:*` family of events.
- `monitor-ondone-runtime.ts` — Wires `MonitorManager.onComplete` callbacks to `LoopStore.delete` so the one-shot `monitor:done` wake loop is cleaned up after delivery.
- `scope.ts` — `resolveLoopStorePath` and `resolveTaskStorePath` based on `PI_LOOP_SCOPE` and `PI_LOOP` env vars. Default scope is `project` so loops and tasks persist across sessions under `.pi/loops/loops.json` and `.pi/tasks/tasks.json` (mirrors pi-goal-x's `.pi/goals/` pattern).

## Conventions

- **Coordinators, not raw promises** — the runtimes that have multi-step state (notification, task backlog, monitor on-done) all use `createCoordinator` with a reducer + effect handlers. Don't reach for `Promise.all` / ad-hoc `await` chains when you can express the flow as reducer events.
- **Lock ordering** — never invoke `triggerSystem.remove(id)` from inside a `LoopStore.withLock()` body. `expireEventLoops` / `clearExpired` / `clearAll` collect removed IDs and invoke `onLoopRemoved` *after* releasing the lock to avoid deadlocks (closed G-06/G-07).
- **30s heartbeat** — `HEARTBEAT_MS` is wall-clock. Without it, a loop whose fire time elapses while the agent is idle would never fire. The timer is `unref()`-ed so `pi -p` (one-shot) can exit.

## Cross-cutting concerns

- The `agent_end` hook is the *only* place where buffered loop wakes are delivered and the task backlog is cleaned up. Do not call `flushPendingNotifications` or `cleanupTaskBacklogLoops` from anywhere else.
- The `tool_execution_end` handler triggers `cleanDoneTasks` on `git commit`. This is a heuristic — false positives will sweep tasks the user didn't intend to prune.

## See also

- `src/AGENTS.md` — core types and stores
- `src/tools/AGENTS.md` — tools that call into runtimes
- `userflow/notification-coordinator.md` — notification flow walkthrough
