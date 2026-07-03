# Gap Analysis

## Methodology

Gaps identified by comparing documented user flows against actual implementation in `src/`.

---

## G-01: No `LoopUpdate` Tool

**Severity: High**

Loops cannot be modified after creation. No tool exists to update `prompt`, `trigger`, or other fields.

**Workaround**: Delete and recreate the loop.

```typescript
// Desired (not implemented):
LoopUpdate({
  id: "1",
  trigger: "10m",        // Change interval
  prompt: "New prompt",   // Change prompt
  maxFires: 20,         // Change limit
})
```

**Affected flows**: All loop create flows lack a corresponding "Edit" step.

---

## G-02: No `TaskPrune` Tool

**Severity: Medium**

`TaskStore.pruneCompleted()` exists and removes all `completed` tasks, but no tool exposes this functionality.

**Workaround**: Delete tasks one-by-one via `TaskDelete`.

```typescript
// Desired (not implemented):
TaskPrune({ reason: "manual" })  // Deletes all completed tasks
```

**Affected flows**: [Task List](./task-list.md) has no way to bulk-clear done tasks.

---

## G-03: No `MonitorDelete` Tool

**Severity: Medium**

Monitors persist in the store after completion/error/stopped. No tool to permanently remove a monitor from the list.

**Workaround**: None — monitors accumulate indefinitely.

```typescript
// Desired (not implemented):
MonitorDelete({ monitorId: "1" })
```

**Affected flows**: [Monitor List](./monitor-list.md) will show stale completed monitors forever.

---

## G-04: No `/monitors` Interactive Command

**Severity: Medium**

Loops have `/loop` for interactive management. Monitors have no equivalent interactive command — only the tool interface.

```bash
# Works:
/loop
# Does not exist:
/monitors
```

**Affected flows**: [Monitor List](./monitor-list.md), [Monitor Stop](./monitor-stop.md) lack command-line interaction.

---

## G-05: `resume` Only Available via Command, Not Tool

**Severity: Low**

Pausing is available via `LoopDelete(id, "pause")`, but resuming requires the interactive `/loop` command interface.

```typescript
// Works:
LoopDelete({ id: "1", action: "pause" })

// Does not exist:
LoopResume({ id: "1" })  // <-- missing
```

**Affected flows**: [Loop Delete/Pause](./loop-delete-pause.md) cannot resume a loop programmatically.

---

## G-06: `expireEventLoops` Doesn't Remove Triggers

**Severity: High**

When event/hybrid loops expire on session resume (`expireEventLoops`), the loop is deleted from the store, but the **event subscription is not removed** from the TriggerSystem.

```typescript
// store.ts - expireEventLoops
this.applyReducerEvent({ type: "LOOP_EXPIRED", ... });
// Missing: triggerSystem.remove(id) — event subscription leaks
```

**Impact**: Stale event subscriptions accumulate in `eventSubscriptions` Map across sessions. Memory leak + potential spurious fires if events continue.

**Affected flows**: [Loop Create — Event Trigger](./loop-create-event.md) expiry behavior.

---

## G-07: `clearExpired` Doesn't Remove Triggers

**Severity: High**

Same issue as G-06. `clearExpired()` deletes expired loops from the store but never calls `triggerSystem.remove(id)`.

```typescript
// store.ts - clearExpired
this.applyReducerEvent({ type: "LOOP_EXPIRED", ... });
// Missing: triggerSystem.remove(id) — cron timer leaks
```

**Impact**: Cron timer handles leak. `fireTimes` Map in CronScheduler grows stale entries.

**Affected flows**: [Loop Create — Cron Trigger](./loop-create-cron.md) expiry behavior.

---

## G-08: Hybrid Loop — Cron Timer Not Explicitly Cancelled on Event Fire

**Severity: Low**

In `TriggerSystem.handleHybridFire`, when an event fires it sets a debounce timer and calls `fireLoop()` once (after debounce). The cron scheduler's timer remains armed. When cron fires via `pump()`, `fireLoop()` is called again, but `fireLoop` guards against stale/active checks, so the second call is idempotent. The debounce prevents duplicate agent wakes.

However, the cron timer **is not explicitly cancelled** — it fires and `fireLoop()` finds the loop already active. Not a bug, but the design is implicit rather than intentional.

**Affected flows**: [Loop Create — Hybrid Trigger](./loop-create-hybrid.md) debounce behavior.

---

## G-09: `onDone` Loop Registered But Not Tracked for Cleanup

**Severity: Low**

When `MonitorCreate` is called with `onDone`, it creates a one-shot loop via `getStore().create()` and calls `handleMonitorDoneLoop()`. The loop is stored but:

1. Not added to TriggerSystem (intentional — callback-driven)
2. No expiry/cleanup mechanism for orphaned onDone loops (if monitor completes before tool returns)
3. If monitor is already done when `MonitorCreate` returns, the loop would fire immediately

**Affected flows**: [Monitor Create](./monitor-create.md) — onDone loop lifecycle.

---

## G-10: No Task Tool When pi-tasks Is Present

**Severity: High**

**DEFERRED in @bramburn/pi-loop 1.0.1 — rationale**: changing the fallback to coexist with pi-tasks is an architectural decision. The current design uses the native task store as an exclusive fallback for when pi-tasks is absent. Making both task systems active simultaneously would require deduplication logic to prevent the same task from being tracked twice (once by pi-tasks, once by native), which is a non-trivial design choice that needs a separate proposal and user feedback. Defer to a focused follow-up PR.
```

**Impact**: Users of native task fallback have a 6-second delay before tools appear, and cannot use native tasks alongside pi-tasks.

**Affected flows**: All [Native Task Flows](./task-create.md) are conditional.

---

## G-11: `maxFires` Not Enforced for Non-Recurring Loops in `pump()`

**Severity: Low**

In `scheduler.ts`, the `pump()` method checks `maxFires` for recurring loops but non-recurring loops are handled differently:

```typescript
// scheduler.ts - pump()
if (fresh.recurring && fresh.maxFires && (fresh.fireCount ?? 0) >= fresh.maxFires) {
  this.store.delete(id);
  this.fireTimes.delete(id);
  // A non-recurring loop (fresh.recurring = false) skips this check
}
```

Non-recurring loops fire once and are deleted regardless of `maxFires`. Setting `maxFires: 5` on a non-recurring loop has no effect.

**Affected flows**: Loop creation with `recurring: false, maxFires: N` combination.

---

## G-12: No Input Validation for `subject` Length in TaskCreate

**Severity: Low**

`tasks-command.ts` truncates to 80 chars (`trimmed.slice(0, 80)`), but the tool `TaskCreate` has no length limit on `subject`. Long subjects may cause UI/layout issues.

**Affected flows**: [Task Create](./task-create.md) via `/tasks` command.

---

## G-13: Widget Monitor Count Not Interactive

**DEFERRED in @bramburn/pi-loop 1.0.1 — rationale**: making the widget interactive requires the underlying pi TUI framework to support clickable status-bar items. The current `LoopWidget.setStatus` API is a one-way text render with no callback mechanism. A proper implementation needs TUI framework support that doesn't exist in the current `ExtensionUIContext` shape. Defer to a focused follow-up PR that addresses the TUI abstraction first.**Severity: Low**

Widget shows `Monitors: 2 >` but is not clickable. No way to open MonitorList from the widget.

```typescript
// ui/widget.ts - setStatus only shows count
setStatus(`${loops.length}/${MAX_LOOPS} loops | ${running}/${MAX_MONITORS} monitors`);
```

**Affected flows**: [Monitor List](./monitor-list.md) cannot be accessed from widget.

---

## G-14: No Retry Logic for File Lock Acquisition

**Severity: Medium**

`ReducerBackedStore` uses file locking but the retry behavior is unclear. AGENTS.md specifies `LOCK_RETRY_MS`/`LOCK_MAX_RETRIES` pattern but actual implementation needs verification.

**Related file**: `src/reducer-backed-store.ts` — needs audit.

---

## G-15: Event Filter `regex:` Prefix Inconsistency

**Severity: Low**

`TriggerSystem.matchesFilter()` treats `regex:` prefix specially, but the filter parameter in `EventTrigger` is typed as `string?` with no documented format.

```typescript
// Works:
{ type: "event", source: "x", filter: "regex:.*task.*" }

// Also works (JSON):
{ type: "event", source: "x", filter: '{"key":"value"}' }
```

Users have no guidance on which format to use.

**Affected flows**: [Loop Create — Event Trigger](./loop-create-event.md) — filter parameter.

---

## G-16: No `/tasks` Interactive Command

**Severity: Low**

Unlike `/loop` which has a full interactive command menu (create/pause/resume/delete), the `/tasks` command lacks an interactive top-level menu. It only accepts a single subject argument.

```bash
# Works:
/tasks my task subject

# Does not exist (no interactive menu):
/tasks
# → jumps straight to viewNativeTasks() but no top-level selection menu
```

The `/loop` command shows "Loop" menu on bare invocation. `/tasks` should have equivalent.

**Affected flows**: [Task List](./task-list.md), [Task Create](./task-create.md)

---

## G-17: `maxFires` Not Enforced for Event-Triggered Loops

**Severity: Medium**

`scheduler.ts` `pump()` enforces `maxFires` for cron/hybrid loops, but event-triggered loops fire via `TriggerSystem.fireLoop()` which has its own `atMaxFires` check — however this only runs when `fireLoop()` is called. If a loop is paused and resumed, the `fireCount` may not be reliably tracked across state transitions.

Additionally, `fireLoop()` checks `atMaxFires(fresh)` AFTER incrementing fireCount, meaning the fire that hits the cap still fires:

```typescript
// src/trigger-system.ts - fireLoop()
this.onFire(current);          // Fires regardless of maxFires
const fresh = this.store.get(entry.id);
if (fresh.recurring && atMaxFires(fresh)) {  // THEN checks
  this.remove(fresh.id);
  this.store.delete(fresh.id);
}
```

The last allowed fire always fires before deletion.

**Affected flows**: [Loop Create — Event Trigger](./loop-create-event.md)

---

## G-18: `AUTO_TASK_WORKER_THRESHOLD` Not Configurable

**Severity: Low**

The threshold of 5 tasks (`AUTO_TASK_WORKER_THRESHOLD = 5`) that triggers auto task worker loop creation is hardcoded. No environment variable or configuration option to adjust it.

**Affected flows**: [Auto Task Worker Loop](./auto-task-worker.md)

---

## G-19: Native Task Events Don't Fire for pi-tasks Integration

**Severity: Medium**

`emitNativeTaskEvent()` in `src/runtime/task-events.ts` emits events like `tasks:created`, `tasks:started`, etc. These are the same event names that pi-tasks uses. When pi-tasks is present, native task events may conflict with or be ignored by pi-tasks event handlers.

The `isTasksAvailable()` flag gates native task creation, but the event emission is not gated — events are always emitted from `emitNativeTaskEvent()` even when pi-tasks is active.

**Affected flows**: [Task Create](./task-create.md), [Task Update](./task-update.md)

---

## G-20: Widget Shows Internal `monitor:done` Loops in Count

**Severity: Low**

`LoopWidget.computeStatus()` filters loops via `isStatusVisibleLoop()` which correctly hides `monitor:done` event loops:

```typescript
function isStatusVisibleLoop(loop: LoopEntry): boolean {
  if (loop.status !== "active") return false;
  if (loop.recurring) return true;
  return !(loop.trigger.type === "event" && loop.trigger.source === "monitor:done");
}
```

However, `LoopList` tool has no equivalent filter — it shows ALL loops including `monitor:done` internal loops. This may confuse users who see loops in `LoopList` that aren't in the widget.

**Affected flows**: [Monitor Create](./monitor-create.md), [Loop List](./loop-list.md)

---

---

## G-21: `sh -c` Hardcoded — MonitorCreate Fails on Windows

**Severity: Critical**

`monitor-manager.ts` uses `spawn("sh", ["-c", command])` unconditionally. `sh` does not exist on Windows.

```typescript
// src/monitor-manager.ts line 101
const child = this.spawnFn("sh", ["-c", command], {...});
```

On Windows, the correct pattern is `spawn("cmd", ["/c", command])`. The code needs `process.platform` detection or a cross-platform library like `execa`.

**Affected flows**: [Monitor Create](./monitor-create.md), [Monitor Stop](./monitor-stop.md)

---

## G-22: SIGTERM/SIGKILL Don't Work on Windows

**Severity: High**

`proc.kill("SIGTERM")` on Windows sends a `TERM` signal that most Windows processes don't handle. The process continues running. `proc.kill("SIGKILL")` maps to `TerminateProcess()` which works, but SIGTERM is ineffective.

**Affected flows**: [Monitor Stop](./monitor-stop.md)

---

## G-23: Test Suite Uses Unix-Only Commands

**Severity: High**

`test/monitor-manager.test.ts` uses `echo`, `sleep`, `exit`, `bash` commands that don't exist on Windows.

**Affected files**: `test/monitor-manager.test.ts`

---

## G-24: Busy-Wait Lock Retry on Windows

**Severity: Medium**

`reducer-backed-store.ts` uses a busy-wait loop for lock retries:

```typescript
const start = Date.now();
while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
```

This is CPU-intensive and inefficient. Should use `setTimeout` callback pattern.

**Affected flows**: All file-backed stores (loops, tasks, goals)

---

## G-25: Silent Corrupt-File Reset

**Severity: Medium**

If the JSON store file is corrupted, `load()` silently starts fresh, losing all data:

```typescript
} catch { /* corrupt file — start fresh */ }
```

No backup, no error message to user.

**Affected flows**: [Session Lifecycle](./session-lifecycle.md)

---

8. **G-36 (High, Bindings)**: First-ever `session_switch` creates an orphaned BindingsStore at `undefined` path via `setSessionId(undefined)`, then immediately swaps to the correct one. On subsequent `before_agent_start` calls, the orphaned undefined-path store is still in memory. More critically: if another terminal creates the bindings file between session_switch and the Governor opening, the current terminal's BindingsStore has stale in-memory data and never reloads. Fix: remove `setSessionId(undefined)` from session_switch; it serves no purpose since `_sessionId` starts as `undefined` at extension load.

## Gap Summary Table

| ID | Severity | Gap | Files Affected |
|----|----------|-----|----------------|
| G-01 | ~~High~~ **Open — #42** | No `LoopUpdate` tool | `src/tools/loop-tools.ts` |
| G-02 | ~~Medium~~ **Open — #45** | No `TaskPrune` tool | `src/tools/native-task-tools.ts` |
| G-03 | ~~Medium~~ **Open — #44** | No `MonitorDelete` tool | `src/tools/monitor-tools.ts` |
| G-04 | ~~Medium~~ **Open — #42** | No `/monitors` command | `src/commands/` |
| G-05 | ~~Low~~ **Open — #42** | No `LoopResume` tool | `src/tools/loop-tools.ts` |
| G-06 | ~~High~~ **Closed in code** | `expireEventLoops` leaks triggers — `onLoopRemoved?.(id)` called in store.ts | `src/store.ts` |
| G-07 | ~~High~~ **Closed in code** | `clearExpired` leaks triggers — `onLoopRemoved?.(id)` called in store.ts | `src/store.ts` |
| G-08 | ~~Medium~~ **Open — #46** | Hybrid cron timer not cancelled on event — debounce implicit, not explicit | `src/trigger-system.ts`, `src/scheduler.ts` |
| G-09 | ~~Low~~ **Open — #46** | onDone loop orphaned cleanup — monitor completes before tool returns | `src/tools/monitor-tools.ts` |
| G-10 | ~~High~~ **Open — #45** | Tasks unavailable when pi-tasks present | `src/index.ts` |
| G-11 | ~~Low~~ **Open — #46** | `maxFires` enforcement for non-recurring loops in scheduler pump() needs verification | `src/scheduler.ts` |
| G-12 | ~~Low~~ **Open — #47** | No `subject` length validation in TaskCreate | `src/commands/tasks-command.ts` |
| G-13 | Low | Widget monitor count not interactive | `src/ui/widget.ts` |
| G-14 | ~~Medium~~ **Open — #46** | File lock retry busy-wait — should use setTimeout callback pattern | `src/reducer-backed-store.ts` |
| G-15 | ~~Low~~ **Open — #47** | Event filter format undocumented — regex: and JSON object formats not described | `src/types.ts`, `src/trigger-system.ts` |
| G-16 | ~~Low~~ **Open — #47** | No `/tasks` interactive menu — jumps to viewNativeTasks with no top-level selection | `src/commands/tasks-command.ts` |
| G-17 | ~~Medium~~ **Closed in code** | `maxFires` checked before `onFire()` in trigger-system.ts | `src/trigger-system.ts` |
| G-18 | ~~Low~~ **Open — #45** | AUTO_TASK_WORKER_THRESHOLD not configurable — hardcoded to 5 | `src/runtime/task-backlog-runtime.ts` |
| G-19 | ~~Medium~~ **Open — #45** | Native task events conflict with pi-tasks — not gated by isTasksAvailable() | `src/runtime/task-events.ts` |
| G-20 | Low | LoopList shows internal monitor:done loops | `src/tools/loop-tools.ts` |
| G-21 | ~~Critical~~ **Open — #44** | `sh -c` hardcoded — MonitorCreate fails on Windows | `src/monitor-manager.ts` |
| G-22 | ~~High~~ **Open — #44** | SIGTERM doesn't work on Windows — needs taskkill/TerminateProcess | `src/monitor-manager.ts` |
| G-23 | ~~High~~ **Closed #8** | Test suite uses Unix-only commands | `test/monitor-manager.test.ts` |
| G-24 | ~~Medium~~ **Open — #46** | Busy-wait lock retry (G-14 duplicate, tracked in #46) | `src/reducer-backed-store.ts` |
| G-25 | ~~Medium~~ **Open — #46** | Silent corrupt-file reset — no backup, no user error message | `src/reducer-backed-store.ts` |
| G-26 | ~~High~~ **Closed #18** | Governor Continue with no pending toggles exits picker | `src/commands/loop-command.ts` |
| G-27 | ~~High~~ **Closed #23** | `session_switch` calls `showPersistedLoops` before `setSessionId` — wrong bindings armed | `src/runtime/session-runtime.ts` |
| G-28 | ~~Medium~~ **Closed #24/#30** | Governor stale loop list — applyPending now warns on orphaned loops | `src/commands/loop-command.ts` |
| G-29 | ~~Medium~~ **Open — #28** | Governor Continue diff lacks prompt context — should show loop prompt alongside ID | `src/commands/loop-command.ts` |
| G-30 | ~~Low~~ **Closed #20** | Governor does not warn when arming a paused loop — visual ~ marker + warning on arm | `src/commands/loop-command.ts` |
| G-31 | ~~Low~~ **Open — #27** | Governor shows all project loops — can't distinguish other terminals' loops | `src/commands/loop-command.ts` |
| G-32 | ~~Low~~ **Open — #25** | Governor lacks Refresh sentinel | `src/commands/loop-command.ts` |
| G-33 | ~~Low~~ **Closed #26** | Governor doesn't show event source or debounce for hybrid loops | `src/commands/loop-command.ts` — full hybrid spec now shown in Governor + /loop view-loops |
| G-34 | ~~Low~~ **Closed #22** | No `/loop-bindings` read-only diagnostic command | `src/commands/loop-command.ts` |
| G-35 | ~~Low~~ **Closed #21** | Governor picker has "Disarm all" sentinel | `src/commands/loop-command.ts` |
| G-36 | ~~High~~ **Open — #29** | First session_switch creates orphaned undefined-path BindingsStore | `src/runtime/session-runtime.ts`, `src/index.ts` |
| G-37 | ~~Medium~~ **Closed #30/#24/#36** | Governor applyPending silently skips deleted loops — warning now emitted + orphaned bindings removed | `src/commands/loop-command.ts` |
| G-38 | ~~Low~~ **Closed #31** | Governor Continue preview warns about paused loops in pending arm list | `src/commands/loop-command.ts` |
| G-39 | ~~Low~~ **Open — #32** | session_switch always creates two BindingsStore instances | `src/runtime/session-runtime.ts` |
| G-40 | ~~Low~~ **Closed #33** | BindingsStore lacks a reload() method for external consumers | `src/runtime/bindings-store.ts` |
| G-41 | ~~Medium~~ **Closed #34** | LoopCreate auto-binds the creating terminal's session | `src/commands/loop-command.ts` |
| G-42 | ~~Low~~ **Open — #35** | Human-readable debounceMs format in Governor + /loop rows | `src/commands/loop-command.ts` |
| G-43 | ~~Medium~~ **Closed #37** | Governor Continue+OK with XOR-noop pending exits silently — dirty flag captured before applyPending | `src/commands/loop-command.ts` |
| G-44 | ~~Low~~ **Open — #45** | Governor cannot distinguish which loops are owned by other terminals in project scope | `src/commands/loop-command.ts` |
| G-45 | High **Open — #38** | TriggerSystem.add / CronScheduler.add register duplicate listeners/timers — fireLoop fires twice | `src/trigger-system.ts`, `src/scheduler.ts` |
| G-46 | Medium **Open — #39** | Recurring loop notification key is loop:<id> — intermediate fires overwritten in queue | `src/runtime/notification-runtime.ts` |
| G-47 | Low **Open — #40** | widget.dispose() never called on session_shutdown — stale status bar after session ends | `src/runtime/session-runtime.ts` |
| G-48 | Medium **Open — #42** | Governor workflow missing LoopUpdate/LoopResume tools + /monitors + /tasks interactive menus | `src/tools/`, `src/commands/` |
| G-49 | Medium **Open — #46** | Operational gaps: hybrid debounce design, onDone orphans, maxFires, lock retry, corrupt file | `src/` |
| G-50 | Low **Closed — #19** | Governor Continue diff shows committed Armed (unchanged) alongside pending changes — prevents false alarm for users with pre-existing bindings | `src/commands/loop-command.ts` |

---

## High-Priority Fixes

### Critical (2026-07-03 review)

1. **G-21 + G-22 (#44, Critical/High)**: MonitorCreate/MonitorStop fail on Windows:
   - Replace `spawn("sh", ["-c", ...])` with `process.platform === "win32" ? "cmd" : "sh"` + args, or use `cross-spawn`/`execa`.
   - Replace `proc.kill("SIGTERM")` with `taskkill /PID <pid>` or `TerminateProcess()` on Windows.

2. **G-45 (#38, Critical)**: `TriggerSystem.add()` and `CronScheduler.add()` have no duplicate-guard. Calling `add()` twice registers duplicate `pi.events.on()` listeners and duplicate `setTimeout` timers. Fix: check `eventSubscriptions.get(source)?.has(entry.id)` and `fireTimes.has(entry.id)` before registering.

3. **G-46 (#39, Medium)**: Recurring loop notification key is `loop:<id>` — every fire overwrites the previous in `notificationsByKey`. Fix: use `loop:<id>:<timestamp>` as the key for all notifications.

### High-Priority (Governor + Bindings)

4. **G-26 + G-27 + G-28 (closed #18/#23/#24/#30)**: Governor bugs — Continue with no pending exits picker, session_switch arms wrong bindings, applyPending silently skips deleted loops. All three now fixed.

5. **G-36 (#29, High)**: First-ever `session_switch` creates orphaned undefined-path BindingsStore. Fix: remove `setSessionId(undefined)` from session_switch — `_sessionId` starts as `undefined` at extension load.

6. **G-48 (#42, Medium)**: Implement `LoopUpdate`, `LoopResume`, `/monitors`, and `/tasks` interactive menus.

7. **G-49 (#46, Medium)**: Operational gaps — hybrid cron debounce design (G-08), onDone orphan cleanup (G-09), maxFires non-recurring enforcement (G-11), file lock busy-wait (G-14/G-24), silent corrupt-file reset (G-25).

8. **G-45 (#45, Medium)**: Task system gaps — native tasks coexist with pi-tasks (G-10), configurable threshold (G-18), gated event emission (G-19), Governor terminal annotation (G-44).

### Deferred

9. **G-06 + G-07**: Add `triggerSystem.remove(id)` calls — closed in code via `onLoopRemoved` callback chain.

10. **G-10**: Consider making native tasks coexist alongside pi-tasks (needs design proposal).

11. **G-17**: `maxFires` enforcement review — closed in code (checked before `onFire()` in trigger-system.ts).

12. **G-23**: Test suite Unix-only commands — closed #8 (cross-platform test compatibility).

13. **G-13**: Widget monitor count not interactive — deferred (TUI framework doesn't support clickable status-bar items).
