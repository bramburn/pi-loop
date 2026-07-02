# `test/` — Test Suite

Vitest + 30 files covering reducer pure logic, runtime coordination, and tool/command integration. All tests must pass on Linux, macOS, and Windows before any PR merges.

## Files

The 30 test files mirror the `src/` structure. Highlights:

- `helpers/mock-pi.ts` — Single shared `createMockPi` factory. Returns `pi`, `toolMap`, `commandMap`, `eventHandlers`, `extensionHandlers`, `emittedEvents`, `sentMessages`, `sentUserMessages`, plus an `emitExtension` helper.
- `helpers/factories.ts` — Shared test fixtures.
- `store.test.ts` — `LoopStore` in-memory, file-backed, and absolute-path variants. Covers lock acquisition, corrupt-file recovery, expiry, and `onLoopRemoved` callback.
- `monitor-manager.test.ts` — `MonitorManager` lifecycle. Uses injected `spawnFn` (see `spawnFn` constructor param) for tests; real child processes run only in `test/index.test.ts` for end-to-end coverage.
- `loop-tools.test.ts` — `LoopCreate`, `LoopList`, `LoopDelete`, `LoopUpdate` (the new tool). Includes resume, no-op idempotency, and invalid-trigger rejection.
- `native-task-tools.test.ts` — `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskDelete`, `TaskPrune`.
- `monitors-command.test.ts` — `/monitors` interactive menu.
- `index.test.ts` — End-to-end extension wiring. Uses real child processes (`echo`, `sleep`, `node -e "setTimeout(...)"`) and has the longest tests (some up to 15s).
- `scheduler.test.ts` — `CronScheduler` jitter, fire-time computation, and pump cycles.
- `trigger-system.test.ts` — `TriggerSystem` cron/event/hybrid subscriptions, debounce, and removal.

## Conventions

- **Mock the pi, not the underlying logic** — unit-test `LoopStore` with the real `LoopStore` class, not a re-implementation. Only mock the `pi` eventbus + tool registry.
- **Use the shared `createMockPi`** — every test file should `import { createMockPi } from "./helpers/mock-pi.js"`. Don't redefine a mock.
- **Cross-platform first** — never use `bash`-only or `sh`-only constructs. The `monitor tool wrappers` describe block in `index.test.ts` uses `node -e "setTimeout(...)" || sleep 0.2` for cross-platform sleep.
- **Windows EBUSY in `rmSync`** — the `monitor tool wrappers` afterEach uses `vi.useRealTimers()` + `setTimeout(200)` + `rmSync({ maxRetries: 5, retryDelay: 200 })` with up to 30 retry attempts. The earlier sleep-10 test was rewritten to use `node -e` for cross-platform compat.
- **Coverage thresholds** — see `vitest.config.ts`. Current floors (stmts 80, branches 70, functions 93, lines 82) reflect the current actuals; raise as coverage is grown.
- **Use real timers for real child processes** — fake timers freeze `setTimeout` but not OS processes. Tests that use real child processes (e.g. `MonitorCreate with onDone creates a completion loop`) must `vi.useRealTimers()` before invoking them, or the child will outlive the test.

## When adding a new test

1. Place it in the file that matches the module under test (or in `test/index.test.ts` for end-to-end)
2. Use `createMockPi` rather than a new mock
3. For tool tests, call `toolMap.get(name)!.execute!("t", args)` and assert on `result.content[0].text`
4. For command tests, call `commandMap.get(name)!.handler?.(args, { ui } as any)` with a mock UI
5. Cross-platform commands only — no Unix-only paths, no Windows-only path separators
6. The test must pass on all three CI matrix runners (ubuntu-latest, macos-latest, windows-latest) before merge

## See also

- `src/AGENTS.md` — entry point and stores
- `src/tools/AGENTS.md`, `src/commands/AGENTS.md`, `src/runtime/AGENTS.md`, `src/ui/AGENTS.md` — module-specific test targets
