# Cross-Platform & UX Analysis

## Methodology

This document identifies gaps and improvements by:
1. Forward pass: Entry points → data structures → storage → runtime → effects
2. Backward pass: Effects → runtime → storage → data structures → entry points
3. Cross-platform audit: Linux, macOS, Windows compatibility
4. UX audit: User-facing gaps, ergonomics, discoverability

---

## Cross-Platform Issues

### X-01: `sh -c` Hardcoded — Windows Incompatible

**Severity: Critical**

```typescript
// src/monitor-manager.ts line 101
const child = this.spawnFn("sh", ["-c", command], {
  stdio: ["ignore", "pipe", "pipe"],
  signal: abortController.signal,
  env: { ...process.env },
});
```

`sh` does not exist on Windows. This makes `MonitorCreate` completely non-functional on Windows.

**Root cause**: The code uses `sh -c` unconditionally, but Windows uses `cmd.exe` or `powershell.exe`. Many CLIs on Windows are `.cmd`/`.bat` wrappers that require `cmd.exe` to execute.

**Perplexity research confirms**: On Windows, `spawn('npm')` with `shell: false` fails for `.cmd`/`.bat` wrappers unless using `cmd.exe`. The correct cross-platform pattern is:

```typescript
// Cross-platform pattern (e.g., using cross-spawn or execa)
const cp = spawn(
  process.platform === "win32" ? "cmd" : "sh",
  process.platform === "win32" ? ["/c", command] : ["-c", command],
  { stdio: ["ignore", "pipe", "pipe"] }
);
```

**Recommended fix**: Use `process.platform` to select the correct shell:

| Platform | Shell | Args |
|----------|-------|------|
| `win32` | `cmd.exe` | `["/c", command]` |
| `darwin` | `/bin/sh` | `["-c", command]` |
| `linux` | `/bin/sh` | `["-c", command]` |

Or use a library like `execa` or `cross-spawn` which handles this automatically.

**Affected flows**: [Monitor Create](./monitor-create.md), [Monitor Stop](./monitor-stop.md)

---

### X-02: SIGTERM/SIGKILL Don't Work on Windows

**Severity: High**

```typescript
// src/monitor-manager.ts lines 250-254
bp.proc.kill("SIGTERM");
await new Promise<void>((resolve) => {
  const timer = setTimeout(() => {
    try { bp.proc.kill("SIGKILL"); } catch { /* already dead */ }
    resolve();
  }, 5000);
  bp.proc.on("close", () => { clearTimeout(timer); resolve(); });
});
```

On Windows, `proc.kill("SIGTERM")` sends `TERM` which most Windows processes don't handle. The process continues running. `SIGKILL` on Windows is not a real signal — it calls `TerminateProcess()` which does kill the process, but the semantics differ.

**Recommended fix**: On Windows, use `taskkill` or `TerminateProcess()` instead:

```typescript
async function killProcess(proc: ChildProcess, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  if (process.platform === "win32") {
    if (signal === "SIGTERM") {
      // On Windows, SIGTERM doesn't work — use taskkill or TerminateProcess
      exec(`taskkill /PID ${proc.pid} /T`, () => {});
    } else {
      // SIGKILL → TerminateProcess equivalent
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    }
  } else {
    proc.kill(signal);
  }
}
```

**Note**: The current code catches errors on SIGKILL (`catch { /* already dead */ }`) so Windows users may see the process actually killed by SIGKILL (TerminateProcess), but SIGTERM won't work as expected.

**Affected flows**: [Monitor Stop](./monitor-stop.md)

---

### X-03: Test Suite Uses Unix-Only Commands

**Severity: High**

`test/monitor-manager.test.ts` uses Unix commands that don't work on Windows without WSL or Git Bash:

```typescript
// test/monitor-manager.test.ts
manager.create("echo hello world", "test monitor");
manager.create("sleep 30", "long running", 300000);
manager.create("exit 1", "error test");
manager.create("bash -c 'trap \"\" SIGTERM; while true; do sleep 1; done'");
```

These tests would fail on a native Windows environment.

**Recommended fix**: Either:
1. Skip platform-specific tests with `process.platform` checks
2. Use cross-platform equivalents (`timeout` command on Windows, or Node.js `setTimeout` mock)
3. Document that tests require Unix-like environment (WSL/MSYS/Git Bash)

**Affected files**: `test/monitor-manager.test.ts`

---

### X-04: `.pi` Dot Directory on Windows

**Severity: Low**

```typescript
// src/store.ts, src/task-store.ts
const LOOPS_DIR = join(homedir(), ".pi", "loops");
const TASKS_DIR = join(homedir(), ".pi", "tasks");
```

On Unix: `~/.pi/loops` → `/home/user/.pi/loops`
On Windows: `C:\Users\user\.pi\loops` → Works but conventionally Windows apps use `%APPDATA%` or `%LOCALAPPDATA%`

**Current behavior**: Works technically, but Windows users may not expect dotfiles in their home directory.

**Recommendation**: Acceptable as-is. Node.js conventions support this. Could add `PI_LOOP_DIR` override for users who want AppData. Document the Windows path.

---

### X-05: Path Separator Inconsistency

**Severity: Low**

```typescript
// src/runtime/scope.ts
const filePath = isAbsolute(listIdOrPath)
  ? listIdOrPath
  : join(config.baseDir, `${listIdOrPath}.json`);
```

`path.join()` handles separators correctly across platforms. However, `PI_LOOP_SCOPE=project` uses relative paths (`.pi/loops/`) which work on all platforms.

**No fix needed** — `path.join()` is already used correctly.

---

### X-06: File Locking — Stale PID on Windows

**Severity: Medium**

```typescript
// src/reducer-backed-store.ts
function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
```

`process.kill(pid, 0)` works on Windows (returns `true` for running processes), but **only for processes owned by the same user**. On Windows with admin/non-admin mixed processes, this may return errors.

Additionally, the lock retry uses **busy-waiting** on Windows which is inefficient:

```typescript
const start = Date.now();
while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
```

On Windows, `setTimeout` with a callback is the preferred approach.

---

## UX Issues

### U-01: No `LoopUpdate` Tool — Poor Ergonomics

**Severity: High**

Loops cannot be modified after creation. Users must delete and recreate to change any parameter.

**Impact**: Common workflow like "change this 5m loop to 10m" requires manual ID lookup, deletion, and recreation with new parameters.

**Recommendation**: Implement `LoopUpdate`:

```typescript
LoopUpdate({
  id: "1",
  trigger: "10m",           // Optional
  prompt: "New prompt",     // Optional
  maxFires: 20,           // Optional
  readOnly: true,          // Optional
})
```

---

### U-02: No `MonitorDelete` Tool — Accumulating Stale Monitors

**Severity: Medium**

Completed monitors persist in the list for 30 seconds (auto-prune) but then remain visible via `MonitorList` for that window. Users cannot manually delete them immediately.

**Current behavior**: Completed monitors show `exit=0` and last 5 lines. After 30 seconds, they're pruned automatically.

**UX improvement**: Add `MonitorDelete` to remove a monitor immediately:

```typescript
MonitorDelete({ monitorId: "1" })
// → Removes from store immediately, no 30s wait
```

---

### U-03: `/tasks` Lacks Interactive Top-Level Menu

**Severity: Low**

`/loop` shows an interactive menu on bare invocation:

```
/loop
→ Loop
  Create scheduled loop
  Create event-triggered loop
  View loops
  Settings
```

`/tasks` jumps directly to `viewNativeTasks()` without a top-level selection menu:

```typescript
// src/commands/tasks-command.ts
pi.registerCommand("tasks", {
  handler: async (args, ctx) => {
    const trimmed = args.trim();
    // No menu → jumps straight to implementation
    if (!trimmed) await viewNativeTasks(ctx.ui);
    // ...
  }
});
```

**Recommendation**: Add a top-level menu like `/loop`:

```
/tasks
→ Tasks
  Create task
  View tasks
```

---

### U-04: `LoopResume` Only Available via Command

**Severity: Low**

`LoopDelete(id, "pause")` pauses a loop, but there's no tool to resume it — only the `/loop` interactive command supports resume.

**Recommendation**: Add `LoopResume`:

```typescript
LoopResume({ id: "1" })
// → Changes status to "active", re-adds trigger
```

---

### U-05: No `TaskPrune` Tool

**Severity: Medium**

Completed tasks accumulate. The only way to clear them is to delete one-by-one or wait for `git commit` task pruning.

**Recommendation**: Add `TaskPrune`:

```typescript
TaskPrune({ reason: "manual" })
// → Deletes all completed tasks
```

---

### U-06: Event Filter Format Undocumented

**Severity: Low**

`EventTrigger.filter` accepts two formats but documentation is absent:

```typescript
// Regex format
{ type: "event", source: "tool_execution_end", filter: "regex:LoopCreate|TaskCreate" }

// JSON format
{ type: "event", source: "monitor:done", filter: '{"monitorId":"123"}' }
```

**Recommendation**: Document both formats in tool descriptions and add validation.

---

### U-07: `subject` Length Not Validated

**Severity: Low**

`TaskCreate.subject` has no length limit. Long subjects may cause UI/layout issues.

**Current behavior**: `/tasks` command truncates to 80 chars, but tool doesn't.

**Recommendation**: Add `maxLength: 80` to subject parameter schema.

---

### U-08: Widget Not Interactive

**Severity: Low**

```typescript
// src/ui/widget.ts
setStatus(`${loops.length}/${MAX_LOOPS} loops | ${running}/${MAX_MONITORS} monitors`);
```

Shows counts but not clickable. Users must use tools/commands to manage.

**Recommendation**: Consider making the widget clickable to open a quick menu (requires TUI integration).

---

### U-09: No Loop Fire History / Audit Trail

**Severity: Medium**

`LoopEntry.fireCount` tracks total fires, but there's no record of:
- When each fire occurred
- What happened during each fire
- Which fires were skipped (e.g., pending tasks)

**Recommendation**: Consider adding a fire log or at minimum exposing `fireCount` in `LoopList` output.

---

### U-10: `maxFires` Confusion for Non-Recurring Loops

**Severity: Low**

Setting `maxFires: 5` on a non-recurring loop has no effect — it fires once regardless.

```typescript
// src/scheduler.ts pump()
if (fresh.recurring && fresh.maxFires && ...) {
  this.store.delete(id);  // Only checked for recurring
}
```

**Recommendation**: Warn users or document that `maxFires` only applies to recurring loops. Better: support it for non-recurring too (fire at most N times).

---

### U-11: `autoTask` vs `taskBacklog` Confusion

**Severity: Medium**

Two similar-but-different options that users may confuse:

| Option | Purpose | Who uses it |
|--------|---------|-------------|
| `autoTask: true` | Loop creates a pi-tasks/native task on each fire | User-created loops |
| `taskBacklog: true` | Marks loop as backlog worker (auto-cleanup) | System-created |

**Recommendation**: Add clear distinction in tool descriptions. Consider renaming `taskBacklog` to `backlogWorker` for clarity.

---

### U-12: No Validation for Monitor `command` Parameter

**Severity: Low**

`MonitorCreate` accepts any shell command string with no validation. Empty strings, very long commands, or commands with unusual characters may cause issues.

**Recommendation**: Add basic validation (non-empty, reasonable length).

---

### U-13: Hardcoded `AUTO_TASK_WORKER_THRESHOLD = 5`

**Severity: Low**

The threshold for auto-creating the task worker loop is hardcoded. Users cannot tune it.

**Recommendation**: Expose as environment variable `PI_LOOP_TASK_THRESHOLD`.

---

## Memory / Resource Leaks

### M-01: `expireEventLoops` Doesn't Remove Trigger

**Severity: High** *(also in GAPS as G-06)*

```typescript
// src/store.ts - expireEventLoops()
this.applyReducerEvent({ type: "LOOP_EXPIRED", ... });
// Missing: triggerSystem.remove(id)
```

Event subscriptions accumulate in `TriggerSystem.eventSubscriptions` across sessions.

---

### M-02: `clearExpired` Doesn't Remove Trigger

**Severity: High** *(also in GAPS as G-07)*

```typescript
// src/store.ts - clearExpired()
this.applyReducerEvent({ type: "LOOP_EXPIRED", ... });
// Missing: triggerSystem.remove(id)
```

Cron timers accumulate in `CronScheduler.fireTimes` for expired loops.

---

### M-03: onDone Loop Orphaned if Monitor Completes Before Tool Returns

**Severity: Low**

```typescript
// src/tools/monitor-tools.ts
const doneLoop = getStore().create(doneTrigger, params.onDone, { recurring: false });
handleMonitorDoneLoop(doneLoop, entry.id);
```

If the monitor completes before `MonitorCreate` tool returns (extremely rare but possible), the onDone loop is registered but `MonitorOnDoneRuntime` may not receive the callback.

---

## Data Integrity Issues

### D-01: Race Condition in File Locking (Busy Wait)

**Severity: Medium**

```typescript
// src/reducer-backed-store.ts
while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
```

Busy-waiting is CPU-intensive and doesn't yield to other processes. On Windows with many concurrent operations, this may cause performance issues.

**Recommendation**: Use `setTimeout` callback pattern instead:

```typescript
setTimeout(() => { /* retry */ }, LOCK_RETRY_MS);
```

---

### D-02: Corrupt JSON File — Silent Reset

**Severity: Medium**

```typescript
// src/reducer-backed-store.ts load()
} catch { /* corrupt file — start fresh */ }
```

If the JSON file is corrupted, all loops/tasks are silently lost. No backup or recovery mechanism.

**Recommendation**: Before overwriting, rename the corrupt file to `.corrupt.<timestamp>` for manual recovery.

---

### D-03: No Atomicity for Multi-Store Operations

**Severity: Low**

If a session creates a loop and the process crashes before the file is saved, the loop is lost. The `withLock` pattern saves atomically per store, but there's no cross-store transaction.

**Example**: A loop with `autoTask: true` creates a task, but only the loop is saved before crash. On restart, loop exists but task doesn't.

**Recommendation**: Document this limitation. Consider a write-ahead log or batched saves.

---

## Completeness Gaps

### C-01: No `LoopUpdate` Tool

**Severity: High**

Already documented in GAPS (G-01). No way to modify a loop after creation.

---

### C-02: No `MonitorDelete` Tool

**Severity: Medium**

Already documented in GAPS (G-03). Completed monitors can only be removed via 30-second auto-prune.

---

### C-03: No `/monitors` Interactive Command

**Severity: Medium**

Already documented in GAPS (G-04). No command-line interface for monitor management.

---

### C-04: No `TaskPrune` Tool

**Severity: Medium**

Already documented in GAPS (G-02). No way to bulk-delete completed tasks.

---

### C-05: No `MonitorUpdate` Tool

**Severity: Low**

Monitors cannot have their `description` or `timeout` updated after creation. Minor UX gap.

---

## Testing Gaps

### T-01: No Cross-Platform Tests

**Severity: High**

Tests only run on the CI/build platform. No tests verify behavior on Linux, macOS, and Windows separately.

**Recommendation**: Add platform-specific test annotations:

```typescript
if (process.platform !== "win32") {
  it("SIGTERM graceful shutdown", ...)
}
```

---

### T-02: No Integration Tests for Store Locking

**Severity: Medium**

File locking has no test coverage. Race conditions, stale locks, and recovery scenarios are untested.

---

### T-03: No Tests for Event Filter Parsing

**Severity: Low**

`TriggerSystem.matchesFilter()` has no dedicated tests. Edge cases (regex errors, malformed JSON, etc.) are covered by integration tests only.

---

## Summary: Priority Fixes

### Must Fix (Critical/High)

| ID | Category | Issue |
|----|----------|-------|
| X-01 | Cross-platform | `sh -c` fails on Windows |
| X-02 | Cross-platform | SIGTERM doesn't work on Windows |
| X-03 | Cross-platform | Test suite uses Unix-only commands |
| M-01 | Memory leak | `expireEventLoops` leaks triggers |
| M-02 | Memory leak | `clearExpired` leaks timers |
| U-01 | UX | No `LoopUpdate` tool |
| C-01 | Completeness | No `LoopUpdate` tool (duplicate) |

### Should Fix (Medium)

| ID | Category | Issue |
|----|----------|-------|
| X-06 | Cross-platform | Stale PID detection on Windows |
| D-01 | Data integrity | Busy-wait file lock |
| D-02 | Data integrity | Silent corrupt-file reset |
| U-02 | UX | No `MonitorDelete` tool |
| U-05 | UX | No `TaskPrune` tool |
| C-02 | Completeness | No `MonitorDelete` tool |
| C-03 | Completeness | No `/monitors` command |
| C-04 | Completeness | No `TaskPrune` tool |
| T-01 | Testing | No cross-platform tests |
| T-02 | Testing | No store locking tests |

### Nice to Have (Low)

| ID | Category | Issue |
|----|----------|-------|
| X-04 | Cross-platform | `.pi` dot directory on Windows |
| U-03 | UX | `/tasks` no interactive menu |
| U-04 | UX | No `LoopResume` tool |
| U-06 | UX | Event filter format undocumented |
| U-07 | UX | `subject` length not validated |
| U-08 | UX | Widget not interactive |
| U-09 | UX | No loop fire history |
| U-10 | UX | `maxFires` confusing for non-recurring |
| U-11 | UX | `autoTask` vs `taskBacklog` confusion |
| U-12 | UX | No `command` validation |
| U-13 | UX | Hardcoded task threshold |
| M-03 | Memory | onDone loop orphan |
| D-03 | Data integrity | No cross-store atomicity |
| C-05 | Completeness | No `MonitorUpdate` tool |
| T-03 | Testing | No filter parsing tests |

---

## Relevant Files for Fixes

| File | Issues |
|------|--------|
| `src/monitor-manager.ts` | X-01, X-02 |
| `test/monitor-manager.test.ts` | X-03, T-01 |
| `src/reducer-backed-store.ts` | X-06, D-01, D-02 |
| `src/store.ts` | M-01, M-02 |
| `src/tools/loop-tools.ts` | U-01, U-04 |
| `src/tools/monitor-tools.ts` | U-02, C-02, U-12 |
| `src/tools/native-task-tools.ts` | U-05, C-04, U-07 |
| `src/commands/tasks-command.ts` | U-03 |
| `src/ui/widget.ts` | U-08 |
| `src/runtime/task-backlog-runtime.ts` | U-13 |
| `src/trigger-system.ts` | M-01, M-02, T-03 |
