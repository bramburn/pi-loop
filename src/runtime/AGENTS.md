# `src/runtime/` — Long-Running Behaviour

Runtimes coordinate behaviour that crosses tool/command boundaries: session lifecycle, notification delivery, monitor-completion wakes, task backlog, and the pi-tasks RPC bridge.

## Files

- `session-runtime.ts` — `registerSessionRuntimeHooks` wires `turn_start`, `before_agent_start`, `agent_start`, `agent_end`, `session_shutdown`, `session_switch`, and `tool_execution_end` (for git-commit pruning). Also runs the 30s `HEARTBEAT_MS` interval that calls `pumpLoops()` AND `notificationRuntime.dispatchUrgentFlush()` on every tick — both are required because the scheduler pump advances cron timers, while the urgent flush checks priority aging thresholds.
- `notification-runtime.ts` — Buffers loop fires until the agent is idle, then drains the queue end-to-end via `pi.sendMessage({ deliverAs: "steer", triggerTurn: true })`. Uses a `createCoordinator<NotificationDispatchResult>` with a `NOTIFICATION_RUNTIME_UPDATED` reducer so flush + idle checks are atomic. **Drain semantics**: `flushPendingNotifications` loops until the queue is empty; defer-priority items are skipped when any non-defer item is queued (priority-shielded); autoTask drops call `cleanDoneTasks` and return `delivered: false` so the loop continues. `dispatchUrgentFlush()` is the `REQUEST_URGENT_FLUSH` entry point used by the heartbeat. `deliverNotification` does NOT mutate `agentRunning` — that flag is owned by `agent_start` / `agent_end` hooks; setting it during delivery would block the drain loop.
- `task-backlog-runtime.ts` — Owns the auto task worker loop (`AUTO_TASK_WORKER_PROMPT`) lifecycle. Threshold is `AUTO_TASK_WORKER_THRESHOLD` (5) and is overridable via the `PI_LOOP_TASK_THRESHOLD` env var.
- `task-rpc.ts` — Bridges native task tools to `@tintinweb/pi-tasks` over the event bus when pi-tasks is loaded.
- `task-events.ts` — Defines `emitNativeTaskEvent` for the `tasks:*` family of events.
- `monitor-ondone-runtime.ts` — Wires `MonitorManager.onComplete` callbacks to `LoopStore.delete` so the one-shot `monitor:done` wake loop is cleaned up after delivery.
- `scope.ts` — `resolveLoopStorePath` and `resolveTaskStorePath` based on `PI_LOOP_SCOPE` and `PI_LOOP` env vars. Default scope is `project` so loops and tasks persist across sessions under `.pi/loops/loops.json` and `.pi/tasks/tasks.json` (mirrors pi-goal-x's `.pi/goals/` pattern).
- `bindings-store.ts` — `BindingsStore` class for per-session loop bindings. Persists `{loopIds: string[]}` at `.pi/loops/bindings-<sessionId>.json` so multiple pi terminals in the same repo can arm disjoint subsets. Atomic write via tmp + rename; corrupt-file recovery via `.corrupt.<ts>` rename (mirrors G-25).

## Conventions

- **Coordinators, not raw promises** — the runtimes that have multi-step state (notification, task backlog, monitor on-done) all use `createCoordinator` with a reducer + effect handlers. Don't reach for `Promise.all` / ad-hoc `await` chains when you can express the flow as reducer events.
- **Lock ordering** — never invoke `triggerSystem.remove(id)` from inside a `LoopStore.withLock()` body. `expireEventLoops` / `clearExpired` / `clearAll` collect removed IDs and invoke `onLoopRemoved` *after* releasing the lock to avoid deadlocks (closed G-06/G-07).
- **30s heartbeat** — `HEARTBEAT_MS` is wall-clock. Without it, a loop whose fire time elapses while the agent is idle would never fire. The timer is `unref()`-ed so `pi -p` (one-shot) can exit.
- **Drain-all flush** — `flushPendingNotifications` and `dispatchUrgentFlush` both drain the queue end-to-end. The `agentRunning` flag is owned exclusively by `agent_start` / `agent_end` hooks; `deliverNotification` must NOT mutate it (G-46 regression). The drain loop's termination condition is the empty-queue guard at the top of the while loop, NOT an exit-after-success check.
- **fireCount semantics** — when two fires of the same loop arrive in the same millisecond (same timestamp-in-key), the reducer coalesces them: increments `fireCount`, preserves `firstFireAt`, updates `lastFireAt`, keeps the existing priority. The delivered message body is prefixed `[pi-loop] Loop #N fired N× since <ISO>` when `fireCount > 1`.
- **tasks:rpc:clean broadcast** — `cleanDoneTasks` emits `tasks:rpc:clean` with a unique requestId whenever called. This is part of the public RPC contract; the broadcast is harmless even when the native task system is disabled (no listener).

## Cross-cutting concerns

- The `agent_end` hook is the *only* place where buffered loop wakes are delivered and the task backlog is cleaned up. Do not call `flushPendingNotifications` or `cleanupTaskBacklogLoops` from anywhere else.
- The `tool_execution_end` handler triggers `cleanDoneTasks` on `git commit`. This is a heuristic — false positives will sweep tasks the user didn't intend to prune.
- The 30s heartbeat in `session-runtime.ts` calls BOTH `pumpLoops()` and `notificationRuntime.dispatchUrgentFlush()`. Removing either breaks a different contract: `pumpLoops` advances cron timers, `dispatchUrgentFlush` checks priority aging. Do not collapse them into a single call.
- `dispatchUrgentFlush` reads thresholds via the `getFlushThresholds` callback passed in `NotificationRuntimeOptions`. The callback is wired in `index.ts` to call `loadSettings(process.cwd()).urgentFlushThresholds` on each invocation so `/loop-settings` threshold changes propagate within 30s without an extension restart.

## See also

- `src/AGENTS.md` — core types and stores
- `src/tools/AGENTS.md` — tools that call into runtimes
- `src/notification-reducer.ts` — pure reducer logic (state transitions, no I/O)
- `userflow/notification-coordinator.md` — notification flow walkthrough
- `docs/plan/ADR-005-priority-queue.md` — priority queue decision record
