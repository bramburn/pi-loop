# `src/` — Extension Core

This directory contains the entry point and the types that all other modules depend on.

## Files

- `index.ts` — Extension entry point registered with pi. Wires tools, commands, runtime hooks, BindingsStore init, monitor manager, widget, and the task-loops bridge. **Edit with care** — changes ripple to every test.
- `types.ts` — `LoopEntry`, `MonitorEntry`, `Trigger` variants (`CronTrigger` / `EventTrigger` / `HybridTrigger`), `TaskEntry`. Pure types, no runtime logic. Documented JSDoc on `EventTrigger.filter` formats.
- `store.ts` — `LoopStore`: file-backed `Map<id, LoopEntry>` with reducer-driven mutation and lock-protected `withLock` boundaries.
- `task-store.ts` — `TaskStore`: same shape as LoopStore, for native task fallback.
- `monitor-manager.ts` — `MonitorManager`: spawns child processes, streams output via `monitor:output` events, auto-prunes 30s after terminal state. Exposes platform-aware `getShellInvocation` and `terminateProcess`.

## Conventions

- **Pure types in `types.ts`** — do not export runtime values from here.
- **Reducer-based mutation** — entity stores apply reducer events; the reducer is the single source of truth.
- **No `any`** in production code. If you need a type for a stub, define a `Like` interface in the consuming module.
- **Cross-platform** — assume Windows, macOS, Linux. Use `path.join`, `homedir()`, and the platform-detection helpers in `monitor-manager.ts`. No `sh -c` literal, no `rm -rf`, no `process.platform === "linux"` checks except in genuinely platform-specific code.

## Cross-cutting concerns

- `LoopStore.onLoopRemoved` callback — every place that deletes loops must invoke this so `TriggerSystem` cleans up its subscriptions (closed G-06/G-07).
- 25-loop and 200-task caps live here. Increase the constants only after auditing the 7-day expiry + per-session cap policy.
- `monitor:done` completion loops are stored in `LoopStore` but **not** in `TriggerSystem` — they are delivered via the callback in `MonitorOnDoneRuntime`. Do not `triggerSystem.add()` them.

## See also

- `runtime/AGENTS.md` — long-running hooks and coordinator-based runtimes
- `tools/AGENTS.md` — tool registration and the typebox schema discipline
- `commands/AGENTS.md` — slash-command UX
