# `src/` — Extension Core

This directory contains the entry point and the types that all other modules depend on.

## Files

- `index.ts` — Extension entry point registered with pi. Wires tools, commands, runtime hooks, BindingsStore init, monitor manager, widget, and the task-loops bridge. **Edit with care** — changes ripple to every test.
- `types.ts` — `LoopEntry`, `MonitorEntry`, `Trigger` variants (`CronTrigger` / `EventTrigger` / `HybridTrigger`), `TaskEntry`, `LoopPriority` (`"defer" | "normal" | "urgent" | "critical"`), `DynamicLoopState`, `WorkflowRunState`. Pure types, no runtime logic. Documented JSDoc on `EventTrigger.filter` formats.
- `store.ts` — `LoopStore`: file-backed `Map<id, LoopEntry>` with reducer-driven mutation and lock-protected `withLock` boundaries. `create()` accepts `priority?` and forwards to the `LOOP_CREATED` reducer.
- `task-store.ts` — `TaskStore`: same shape as LoopStore, for native task fallback.
- `monitor-manager.ts` — `MonitorManager`: spawns child processes, streams output via `monitor:output` events, auto-prunes 30s after terminal state. Exposes platform-aware `getShellInvocation` and `terminateProcess`.
- `notification-reducer.ts` — Pure reducer: `NOTIFICATION_QUEUED` (coalesces same-key entries: increments `fireCount`, preserves `firstFireAt`, updates `lastFireAt`), `NOTIFICATION_FLUSH_REQUESTED` (drains, skips defer when non-defer present), `REQUEST_URGENT_FLUSH` (force-delivers by priority past threshold; never preempts defer), `NOTIFICATION_RUNTIME_UPDATED` (syncs `agentRunning`/`hasPendingMessages`). Exports `UrgentFlushThresholds` re-exported from `settings.ts`.
- `auto-clear.ts` — `createAutoClearManager` for sweeping completed native tasks. Falls back to `{ ...DEFAULT_SETTINGS }` on settings load failure.
- `api.ts` — Public API surface for cross-extension consumers.
- `coordinator.ts` — Generic reducer+effects coordinator (`createCoordinator<TResult>`). Used by `notification-runtime.ts` to drive the notification reducer through a typed effect dispatch loop.
- `loop-format.ts` — Trigger / workflow transition formatting helpers used by the widget and the notification message body.

## Conventions

- **Pure types in `types.ts`** — do not export runtime values from here.
- **Reducer-based mutation** — entity stores apply reducer events; the reducer is the single source of truth.
- **No `any`** in production code. If you need a type for a stub, define a `Like` interface in the consuming module.
- **Cross-platform** — assume Windows, macOS, Linux. Use `path.join`, `homedir()`, and the platform-detection helpers in `monitor-manager.ts`. No `sh -c` literal, no `rm -rf`, no `process.platform === "linux"` checks except in genuinely platform-specific code.

## Cross-cutting concerns

- `LoopStore.onLoopRemoved` callback — every place that deletes loops must invoke this so `TriggerSystem` cleans up its subscriptions (closed G-06/G-07).
- 25-loop and 200-task caps live here. Increase the constants only after auditing the 7-day expiry + per-session cap policy.
- `monitor:done` completion loops are stored in `LoopStore` but **not** in `TriggerSystem` — they are delivered via the callback in `MonitorOnDoneRuntime`. Do not `triggerSystem.add()` them.
- **LoopEntry.priority is optional** — old stored loops (loaded from `.pi/loops/loops.json`) have `priority: undefined`. The notification reducer treats `undefined` as `"normal"` for the threshold lookup. Do not assume the field is present when reading from disk.
- **`LoopPriority` is the single source of truth** for both the loop entry, the `LoopFireEvent`, and the `ReducerNotification`. The settings thresholds use the same literal union. Any new priority level must be added to all three places plus the `urgentFlushThresholds` interface and the `PRIORITY_ORDER` map in the reducer.

## See also

- `runtime/AGENTS.md` — long-running hooks and coordinator-based runtimes
- `tools/AGENTS.md` — tool registration and the typebox schema discipline
- `commands/AGENTS.md` — slash-command UX
