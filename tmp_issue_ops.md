## Problem

Several operational gaps affect loop lifecycle correctness and store reliability:

1. **G-08 (Hybrid cron timer not cancelled on event fire — LOW)**: In `TriggerSystem.handleHybridFire`, when an event fires it sets a debounce timer and calls `fireLoop()` once (after debounce). The cron scheduler's timer remains armed. When cron fires via `pump()`, `fireLoop()` is called again but guards prevent duplicate fires. However, the cron timer is not explicitly cancelled — the design is implicit rather than intentional.

2. **G-09 (onDone loop orphaned cleanup — LOW)**: When `MonitorCreate` is called with `onDone`, it creates a one-shot loop via `getStore().create()`. The loop is stored but if the monitor completes before the tool returns, the loop may fire immediately or be orphaned. No cleanup mechanism exists for orphaned onDone loops.

3. **G-11 (maxFires not enforced for non-recurring loops in pump() — LOW)**: `scheduler.ts` `pump()` checks `maxFires` for recurring loops but non-recurring loops skip this check entirely. A non-recurring loop with `maxFires: 5` fires once regardless. This was noted as closed in the reducer but the scheduler path needs verification.

4. **G-14 (File lock retry busy-wait — MEDIUM)**: `ReducerBackedStore` uses a busy-wait loop for lock retries instead of `setTimeout` callback pattern. This is CPU-intensive. AGENTS.md specifies `LOCK_RETRY_MS`/`LOCK_MAX_RETRIES` but the implementation should be audited against the pattern in `pi-tasks`.

5. **G-25 (Silent corrupt-file reset — MEDIUM)**: If the JSON store file is corrupted, `load()` silently starts fresh, losing all data. No backup, no error message to user. BindingsStore follows the same pattern.

## Files Affected

- `src/trigger-system.ts`
- `src/scheduler.ts`
- `src/monitor-completion-coordinator.ts`
- `src/reducer-backed-store.ts`
- `src/runtime/bindings-store.ts`

## Acceptance Criteria

- [ ] G-08: Document or fix the hybrid cron timer cancellation behavior
- [ ] G-09: Add orphaned onDone loop cleanup in `MonitorOnDoneRuntime`
- [ ] G-11: Verify maxFires enforcement in scheduler pump() covers non-recurring loops
- [ ] G-14: Audit and fix file lock retry to use setTimeout callback pattern (copy from pi-tasks)
- [ ] G-25: Add backup on corrupt file detection (rename to `.corrupt.<ts>` before starting fresh)
