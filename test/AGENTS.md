# `test/` — Test Suite

Vitest + 50 files covering reducer pure logic, runtime coordination, and tool/command integration. 888 tests pass on the standard `npm test` invocation (which excludes `injection.test.ts` and `harness-state-steering.test.ts`); 874 in the gated default, 888 in `npm run test:all`. All tests must pass on Linux, macOS, and Windows before any PR merges.

## Files

The 50 test files mirror the `src/` structure. Highlights:

- `helpers/mock-pi.ts` — Single shared `createMockPi` factory. Returns `pi`, `toolMap`, `commandMap`, `eventHandlers`, `extensionHandlers`, `emittedEvents`, `sentMessages`, `sentUserMessages`, plus an `emitExtension` helper. Has option flags for `respondToTaskPing`, `pendingTaskCount`, `respondToTaskClean` so RPC-driven runtimes can be exercised in unit tests.
- `helpers/factories.ts` — Shared test fixtures.
- `store.test.ts` — `LoopStore` in-memory, file-backed, and absolute-path variants. Covers lock acquisition, corrupt-file recovery, expiry, and `onLoopRemoved` callback.
- `monitor-manager.test.ts` — `MonitorManager` lifecycle. Uses injected `spawnFn` (see `spawnFn` constructor param) for tests; real child processes run only in `test/index.test.ts` for end-to-end coverage.
- `loop-tools.test.ts` — `LoopCreate`, `LoopList`, `LoopDelete`, `LoopUpdate` (the new tool). Includes resume, no-op idempotency, and invalid-trigger rejection. `LoopCreate` priority test (`(priority as LoopPriority)` cast removed) is verified here.
- `loop-reducer.test.ts` — `LOOP_CREATED` reducer carries the `priority` payload and stores it on the loop entry. Asserts that `LoopEntry.priority` round-trips through the reducer.
- `notification-reducer.test.ts` — Core NOTIFICATION_QUEUED + NOTIFICATION_FLUSH_REQUESTED reducer tests. Asserts `state.notificationsByKey[notification.key]` is defined after a queued event.
- `notification-reducer-priority.test.ts` — 17 tests for the ADR-005 priority queue. Covers fireCount coalescing, 4×4 priority × age threshold matrix, age force-flush ordering (critical → urgent → normal), defer-never-preempts guarantee, normal-flush defer-skip semantics (rec #2). 3 additional tests for normal flush skipping defer when higher-priority items exist.
- `notification-runtime.test.ts` — `NotificationRuntime` queue / flush behavior including `tasks:rpc:clean` broadcast on autoTask drop.
- `notification-runtime-coverage.test.ts` — Coverage-targeted tests for less-trodden code paths in `notification-runtime.ts` (fireCount=0 edge case, buildMonitorStartedNotification, etc.).
- `notification-coordinator.test.ts` — Generic coordinator contract test.
- `session-runtime.test.ts` — `registerSessionRuntimeHooks` lifecycle + heartbeat. Includes the dispatch-urgent-flush integration test (rec #3) which advances fake timers by 60s and asserts `notificationRuntime.dispatchUrgentFlush` was called twice.
- `settings.test.ts` / `settings-command.test.ts` — Settings parser strict-schema contract + `/loop-settings` TUI editor (10-field cycle, including `urgentFlushThresholds`).
- `index.test.ts` — End-to-end extension wiring. Uses real child processes (`echo`, `sleep`, `node -e "setTimeout(...)"`) and has the longest tests (some up to 15s).
- `injection.test.ts` — Integration tests for the `loop:fire` event delivery flow. Covers the 9 critical paths: G-46 distinct keys prevent overwrites (drain-all), one-shot monitor wake, kept independent, session switch, session shutdown, autoTask wake drop with `tasks:rpc:clean` broadcast, and others. **Pre-existing G-46 + autoTask failures are now fixed** (2.1.1).
- `scheduler.test.ts` — `CronScheduler` jitter, fire-time computation, and pump cycles.
- `trigger-system.test.ts` — `TriggerSystem` cron/event/hybrid subscriptions, debounce, and removal.
- `native-task-tools.test.ts`, `monitor-tools.test.ts`, `tasks-command.test.ts`, `monitors-command.test.ts`, `workflow-tools.test.ts` — DISABLED in this build; tests cover the no-op call-site contracts.

## Conventions

- **Mock the pi, not the underlying logic** — unit-test `LoopStore` with the real `LoopStore` class, not a re-implementation. Only mock the `pi` eventbus + tool registry.
- **Use the shared `createMockPi`** — every test file should `import { createMockPi } from "./helpers/mock-pi.js"`. Don't redefine a mock.
- **Cross-platform first** — never use `bash`-only or `sh`-only constructs. The `monitor tool wrappers` describe block in `index.test.ts` uses `node -e "setTimeout(...)" || sleep 0.2` for cross-platform sleep.
- **Windows EBUSY in `rmSync`** — the `monitor tool wrappers` afterEach uses `vi.useRealTimers()` + `setTimeout(200)` + `rmSync({ maxRetries: 5, retryDelay: 200 })` with up to 30 retry attempts. The earlier sleep-10 test was rewritten to use `node -e` for cross-platform compat.
- **Coverage thresholds** — see `vitest.config.ts`. Current floors (stmts 85, branches 78, functions 84, lines 86) reflect the v2.1 actuals. The v2.0 baseline was 84.97% / 79.42% / 85.31% / 86.97%; the v2.1 PRs added 17 new priority tests and 4 rec-#2/3 tests without regressing coverage.
- **Use real timers for real child processes** — fake timers freeze `setTimeout` but not OS processes. Tests that use real child processes (e.g. `MonitorCreate with onDone creates a completion loop`) must `vi.useRealTimers()` before invoking them, or the child will outlive the test.
- **`npm test` excludes two files** — `injection.test.ts` and `harness-state-steering.test.ts` are excluded by the `test` script in `package.json` because they are heavy integration tests (real child processes, harness state steering) that don't fit the standard PR-CI budget. Run them with `npm run test:all` or `npx vitest run test/injection.test.ts` before tagging a release.

## When adding a new test

1. Place it in the file that matches the module under test (or in `test/index.test.ts` for end-to-end, or `test/injection.test.ts` for event-delivery integration)
2. Use `createMockPi` rather than a new mock
3. For tool tests, call `toolMap.get(name)!.execute!("t", args)` and assert on `result.content[0].text`
4. For command tests, call `commandMap.get(name)!.handler?.(args, { ui } as any)` with a mock UI
5. Cross-platform commands only — no Unix-only paths, no Windows-only path separators
6. The test must pass on all three CI matrix runners (ubuntu-latest, macos-latest, windows-latest) before merge
7. **Pure reducer tests** (`notification-reducer.test.ts`, `loop-reducer.test.ts`, `task-reducer.test.ts`, `monitor-reducer.test.ts`, `workflow-reducer.test.ts`) must use `vi.useFakeTimers()` + `vi.setSystemTime(fixedTimestamp)` so timestamp-dependent logic is deterministic

## See also

- `src/AGENTS.md` — entry point and stores
- `src/tools/AGENTS.md`, `src/commands/AGENTS.md`, `src/runtime/AGENTS.md`, `src/ui/AGENTS.md` — module-specific test targets
- `docs/plan/ADR-005-priority-queue.md` — priority queue decision (drives the 17-test priority matrix in `notification-reducer-priority.test.ts`)
