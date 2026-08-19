# Changelog

## 2.6.3 (2026-08-19)

### Bug Fixes

* **sub-agent: spawn `pi` fails with `Error: spawn pi ENOENT` on Windows when `pi` is a PowerShell shim.** `child_process.spawn("pi", args)` (no `shell: true`) does not consult PATHEXT on Windows — `nvm4w`'s npm-bin shim is `C:\nvm4w\nodejs\pi.ps1` with no plain `.exe`, so CreateProcess returns ENOENT even when `pi` is on PATH. New helper `resolveSpawnTarget(bin)` in `src/runtime/sub-agent/spawn.ts`:
  - Bare name on Windows: runs `where.exe <bin>` (PATHEXT-aware) and ranks candidates by extension (`.exe` > `.cmd` > `.bat` > `.ps1`).
  - `.exe` → spawn directly.
  - `.cmd` / `.bat` → `shell: true` (CreateProcess cannot run batch files; Node uses cmd.exe internally).
  - `.ps1` → `spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", resolvedPs1, ...args])`.
  - Resolution is cached per `bin` so a scheduler that spawns every tick doesn't re-run `where.exe`.
* **sub-agent: any spawn failure crashes the parent pi process with an uncaughtException.** `handle.wait()` only listened to the child's `'exit'` event. Node emits EITHER `'exit'` OR `'error'` (e.g. ENOENT, EACCES, EAGAIN), never both — so a spawn failure escaped the watcher, became an uncaughtException on the parent (`Error: spawn pi ENOENT` at `process.processTicksAndRejections`), and killed the user's session. `SpawnHandle` now exposes `lastError?: Error` and the wait/settle promise is shared between the `'error'` and `'exit'` handlers; the watcher now finalises the iteration as `failed` with the real error text in `result.json` instead of crashing.
* **sub-agent: Windows timer-fired kill leaves a leaked grandchild when running through cmd.exe or PowerShell.** With `shell: true` for `.cmd`/`.bat` or `powershell.exe` wrapping for `.ps1`, the actual `pi` is a grandchild of `child.pid`. `child.kill("SIGTERM")` only terminates the immediate child, so the timer-fired two-stage kill (SIGTERM at T-30s, SIGKILL at T) could leave the real pi process running. `handle.kill` now uses `taskkill /PID <pid> /T /F` on Windows to walk the process tree.

### Internal

* `src/runtime/sub-agent/spawn.ts`:
  - New `ResolvedSpawn` type and `resolveSpawnTarget(bin)` export (cached, testable surface for the resolution logic).
  - New `lastError?: Error` field on `SpawnHandle`.
  - New shared `settle` / `resolveWait` pattern so a single Promise resolves on either `'exit'` or `'error'`.
  - Windows kill now uses `taskkill /T /F`.
  - `outerTimer` hoisted so the `settle` closure can `clearTimeout` it.

### Tests

* `test/runtime/sub-agent/spawn.test.ts` (new, 9 cases):
  - POSIX bare-name pass-through.
  - Absolute `.exe` / `.cmd` / `.bat` / `.ps1` path dispatch.
  - Relative `./path/to/bin.cmd` is treated as a path (no where.exe lookup).
  - Real-machine regression test for `where.exe pi` resolution on Windows (the bug that motivated this release).
  - Helpful-error throw when the bare command is not on PATH.
  - Cache hit: second `resolveSpawnTarget("pi")` returns the same object reference.

### Quality gates

* `npm run test:all`: 1019 passed, 33 skipped (was 1010 on v2.6.2; +9 new cases).
* `npm run typecheck`: clean.
* `npm run lint`: clean.
* `npm run build`: clean (`dist/` regenerated).
* `npm pack --dry-run`: 276 files, 555 kB unpacked. `wt/`, `node_modules/`, `test/`, `.github/` confirmed absent from the tarball.

## 2.6.2 (2026-08-19)

### Bug Fixes

* **sub-agent: token accounting uses `JSON.parse` instead of a fragile regex.** `ResultWatcher.readSessionTokens` (in `src/runtime/sub-agent/result-watcher.ts`) used to match the JSONL `usage` block with a regex that depended on the exact field order `input_tokens` then `output_tokens`. Any interleaved field (e.g. a future `cache_creation_input_tokens`) caused the regex to miss the line, silently returning 0 tokens and a 0-cost iteration. Switched to per-line `JSON.parse`; the parser reads `usage.input_tokens` / `usage.output_tokens` directly and ignores other fields. Skips lines that aren't valid JSON. (H2 from the v2.5.1 sub-agent runtime review.)
* **sub-agent: `safeReadResultMd` reads only the first 32 KiB, not the whole file.** `evaluator.ts` used to `readFileSync` and slice, which allocates the full file before slicing. For a 100 MB `result.md` that's 100 MB of wasted memory. Now uses `fs.openSync` + `Buffer.alloc(32 KiB)` + `readSync` for files larger than the cap. The 32 KiB boundary is the same as before; the difference is no full-file allocation. (H3 from the v2.5.1 sub-agent runtime review.)
* **sub-agent: defer notification priority defaults to `"normal"`.** `SubAgentRuntime.handleFire` used `loop.priority ?? "defer"` for the defer notification, which meant a loop with no explicit priority got "defer" priority on a deferral — suppressing the very notification the agent needs to see. Now `loop.priority ?? "normal"`, matching the default used elsewhere. (M2 from the v2.5.1 sub-agent runtime review.)
* **sub-agent: `prune()` floors `retain` and treats non-finite values as a no-op.** `ResultStore.prune` had no upper or lower bound check on `retain`. A negative or `NaN` retain used to fall through to `all.length <= retain` (false because length is non-negative), so it would silently prune everything. Now: `Math.floor(retain)`; if the result is non-finite or `< 1`, return 0 (no-op, matches the v2.5.1 behavior for bad input). A fractional retain (e.g. 2.7) is floored. (L4 from the v2.5.1 sub-agent runtime review.)

### Internal

* `src/runtime/sub-agent/index.ts`: extracted `nextIterId(loop)` to a local `iterId` const at the top of `handleFire` (was called twice in the defer/pause branches). Defer notification priority changed to `loop.priority ?? "normal"`. (M2 + M3 from the review.)
* `src/runtime/sub-agent/result-watcher.ts`:
  - `readSessionTokens` rewritten to use `JSON.parse` per line (was a regex match).
  - `determineStatus` no longer takes the unused `_loop: LoopEntry` parameter; only `exit`, `verdict`, `killedByTimer`. (M4.)
  - `extractPreview` no longer takes the unused `_loop: LoopEntry` parameter. (M4.)
  - `reconcileAfterRestart` no longer uses `require("node:fs")`; the necessary `existsSync` / `readdirSync` / `statSync` / `readFileSync` are imported at the top of the file. (L3.)
* `src/runtime/sub-agent/notification-formatter.ts`:
  - Token formatting uses `Intl.NumberFormat()` with the system default locale, instead of hardcoded `"en-US"`. (L1.)
  - `formatDuration` is consistent: largest unit bare, the rest two-digit zero-padded. Examples: `45s`, `03m07s`, `01h02m03s`. Previously `1m00s` (h-style) but `1h0m` (no seconds). (L2.)

### Tests

* `test/runtime/sub-agent/result-watcher.test.ts` (3 new cases, total 12 in the file):
  - **H2 (standard JSONL usage block)** — writes a session file with three JSONL lines including one with `usage: { input_tokens: 123, output_tokens: 45 }`; asserts the finalised `tokens` field is `{ in: 123, out: 45, total: 168 }`.
  - **H2 (interleaved field)** — same but with an extra `cache_creation_input_tokens: 25` between input and output; asserts the parser still reads 100/50 (regression guard for the regex fragility).
  - **H2 (malformed session)** — writes `this is not json\n`; asserts the finalised `tokens` field is `{ in: 0, out: 0, total: 0 }` (graceful fallback, no throw).
  - **M4 (signature regression guard)** — a small describe block documenting that `determineStatus` is now called with three arguments.
* `test/runtime/sub-agent/evaluator.test.ts` (1 new case):
  - **H3 (truncated read)** — writes a result.md > 50 KiB where a marker is at byte 100 and another at byte 50_000. Asserts the 50 KiB marker does NOT match (would require reading past the 32 KiB cap) and the 100-byte marker still matches.
* `test/runtime/sub-agent/result-store.test.ts` (1 new case):
  - **L4 (prune bounds)** — `prune("5", -5)` returns 0 (no-op, matches v2.5.1 behaviour for bad input); `prune("5", NaN)` returns 0; `prune("5", 2.7)` floors to 2.

### Quality gates

* `npm run test:all`: 1010 passed, 33 skipped (was 1004 on v2.6.1; +6 new cases).
* `npm run typecheck`: clean.
* `npm run lint`: clean.
* `npm run build`: clean.

## 2.6.1 (2026-08-19)

### Bug Fixes

* **sub-agent: distinguish timeout from cancel.** `determineStatus` in `src/runtime/sub-agent/result-watcher.ts` previously returned `"cancelled"` for **any** SIGTERM/SIGKILL exit, including the wall-clock timer's two-stage kill. The `SubAgentStatus` type lists `"timeout"` as a separate value and the formatter has a `"failed (timeout)"` label, but the runtime never produced a `"timeout"` status. Now the `SpawnHandle` carries a `killedByTimer: boolean` flag that the wall-clock timer flips to `true` before sending SIGTERM. `determineStatus` checks the flag and returns `"timeout"` when the timer fired, `"cancelled"` when the user-initiated `handle.kill()` did. Result-store `errorMessage` aligns with the new status (timeout gets `"iteration wall-clock timeout"`, cancelled gets `verdict.reason ?? result.signal`).
* **sub-agent: `onShutdown` now actually kills in-flight children.** `SubAgentRuntime.onShutdown()` previously called `this.watcher.cancel("__all__" as string)`, but `cancel(loopId, iterId)` filters by exact loopId match, so no child was ever killed on parent shutdown — the parent exited, the children became orphans, and the next startup had to reconcile. Now `onShutdown()` calls the new `ResultWatcher.cancelAll()` method which iterates `this.active` directly. `cancelAll()` also awaits the per-child exit with a 5s SIGTERM-then-SIGKILL cap so the parent's exit doesn't race the result-store finalisation.
* **sub-agent: pause notification no longer references removed `LoopDelete` tool.** The pause-preview string in `src/runtime/sub-agent/index.ts` mentioned `LoopDelete` for removal guidance; that tool was removed in v2.6.0 (PR #86). Replaced with "ask the user to delete it via /loop's View-loops menu, or use LoopUpdate to change the cap".

### Internal

* `src/runtime/sub-agent/spawn.ts`: `SpawnHandle` interface gains `killedByTimer: boolean`; the wall-clock `setTimeout` flips it before sending SIGTERM/SIGKILL.
* `src/runtime/sub-agent/result-watcher.ts`: new `cancelAll(timeoutMs = 5_000): Promise<number>` method on `ResultWatcher`; `determineStatus` now takes a `killedByTimer` parameter and returns `"timeout"` or `"cancelled"` accordingly; `attachExitHandler` passes `handle.killedByTimer` through and sets `errorMessage` for both `timeout` and `cancelled` statuses (previously only for the three failure modes).

### Tests

* `test/runtime/sub-agent/result-watcher.test.ts` (new file, 8 cases): the two regressions the review identified. Asserts that:
  - A SIGTERM exit with `killedByTimer=true` produces `status: "timeout"` (not `"cancelled"`).
  - A SIGTERM exit with `killedByTimer=false` produces `status: "cancelled"`.
  - A normal exit (exitCode=0) produces `status: "succeeded"`.
  - `cancelAll()` returns the number of in-flight iterations and sends SIGTERM to every registered handle.
  - `cancelAll()` returns 0 when the active set is empty.
  - `cancelAll()` is global (not per-loop) — both loopA and loopB handles receive SIGTERM.
  - The original `cancel("nonexistent-loop")` is a no-op (0), documenting the broken path the bug report identified.

### Quality gates

* `npm run test:all`: 1004 passed, 33 skipped (was 996 on v2.6.0; +8 new result-watcher cases).
* `npm run typecheck`: clean.
* `npm run lint`: clean.
* `npm run build`: clean.

## 2.6.0 (2026-08-19)

### Breaking Changes

* **remove `LoopDelete` tool.** `LoopDelete` is no longer registered as an LLM-callable tool. The prior `computeActiveTools` predicate (`loops.some((l) => l.status === "paused") || loops.some((l) => l.isTaskBacklog)`) exposed `LoopDelete` to the LLM whenever any paused or taskBacklog loop existed in the store, so the LLM could call `LoopDelete({id})` on any loop — including active non-taskBacklog loops — without any user authorization. The tool's `execute` had no guard for the "user explicitly asked" condition the description claimed. This is a deliberate removal: the LLM never had the "user explicitly authorized this" signal that deletion requires. Deletion is still available to the user through the `/loop` command's View-loops menu (`x Delete`); internal cleanup paths (taskBacklog queue-drain auto-deletion, deletion tombstones) call `LoopStore.delete` directly. The public tool surface is now: `LoopCreate`, `LoopList`, `LoopUpdate`, `LoopPause`, `LoopResume`, `LoopInspect`. Per the project's policy, no future `LoopDelete`-shaped tool will be exposed to the LLM either.

### Internal

* `src/tools/loop-tools.ts`: `LoopDelete` `pi.registerTool` block removed. `closeWorkflowTask` removed from `LoopToolsOptions` (no longer needed). `LoopUpdate`'s "When NOT to Use" section reworded to drop the "do not use LoopDelete" copy and point at `status: "completed"` instead. `LoopUpdate`'s workflow-owned error message rewritten to point at the user-driven `/loop` menu. `LoopCreate`'s prompt guideline reworded to "ask the user to delete via /loop's View-loops menu" instead of "do not call LoopDelete".
* `src/tools/tool-visibility.ts`: `LOOP_TOOL_DELETE` constant, the `NEVER_AVAILABLE` set, and the strip-on-both-ends logic in `computeActiveTools` all removed. JSDoc updated to "Deletion is not in the LLM's tool surface at all. There is no LoopDelete tool."
* `src/tools/workflow-tools.ts`: error message at the "all declared outcomes are unavailable" branch now says "ask the user to abandon it via /loop's View-loops menu" instead of "abandon it with LoopDelete".
* `src/runtime/notification-runtime.ts`: three lifecycle messages updated to tell the LLM "there is no LoopDelete tool" and to instruct the agent to ask the user via `/loop` for deletion. Backlog loop message clarifies that pi-loop auto-deletes when the queue drains.
* `src/runtime/sub-agent/index.ts`: sub-agent pause preview message rewritten to "ask the user to delete it via /loop's View-loops menu".
* `src/index.ts`: `closeWorkflowTask` no-op stub and its wiring in `registerLoopTools` removed.
* `src/store.ts`, `src/commands/settings-command.ts`: comments clarified to reference the "now-removed" LoopDelete tool.
* `src/commands/loop-command.ts`: `/loop` → View loops → `x Delete` warning message updated to say "claim the task first, then retry Delete from this menu" instead of "use LoopDelete with its claimId".

### Tests

* `test/loop-tools.test.ts`: full `describe("LoopDelete", ...)` block (5 tests) removed, including a duplicate of the LoopPause happy path that was misplaced. Two workflow tests that used `h.text("LoopDelete", ...)` removed. The "tells agents" test updated to drop the LoopDelete assertions and verify `## When to Use` / `## When NOT to Use` headers on the remaining tools. New regression-guard test added: `expect(h.toolMap.has("LoopDelete")).toBe(false)`. The `closeWorkflowTask` mock removed from the `registerLoopTools` call. The "exposes registered tool names" test in `loop-tools coverage extras` now also asserts `expect(tools).not.toContain("LoopDelete")`. The "guides pause or deletion" workflow test now matches the new error-message text.
* `test/tool-visibility.test.ts`: `NEVER_AVAILABLE`-specific tests replaced with a single regression-guard test that asserts `computeActiveTools` never returns `LoopDelete` across six different input combinations. The "removes previously-enabled conditional tools" test no longer has `LoopDelete` in the initial set. The state × tool matrix updated — every case now carries `forbidden: ["LoopDelete"]`.
* `test/index.test.ts`: `LOOP_TOOLS` array no longer contains `"LoopDelete"`.
* `test/loop-command.test.ts`: the "use LoopDelete with its claimId" assertion updated to "claim the task first" to match the new `/loop` warning text.

### Docs

* `AGENTS.md`: `LoopDelete` removed from the v2.1 surface bullet list, `loop-tools.ts` directory comment, and the explanatory "LoopDelete was removed" section that replaces the previous "LoopDelete is not in the LLM's tool surface" section.
* `src/tools/AGENTS.md`: `loop-tools.ts` description rewritten to list the new tool set. The "LoopDelete deletes only" bullet replaced with "No `LoopDelete` tool" warning future contributors not to re-expose deletion to the LLM.
* `test/AGENTS.md`: `loop-tools.test.ts` line updated to mention the new tools and the regression-guard assertion.
* `README.md`: Quick start snippet, tool table, and the re-arming-after-restart section all updated. The tool table now includes a callout: "Loop deletion is intentionally **not** an LLM-callable tool."
* `docs/MANUAL_TESTING.md`: the tool-list expectation block in the paused-loop test case no longer expects `LoopDelete` to appear.
* `docs/TASK_TOOL_FREEZE.md`: the loop-tool list in the TUI-freeze note no longer includes `LoopDelete`.

### Quality gates

* `npm run test:all`: 996 passed, 33 skipped.
* `npm run typecheck`: clean.
* `npm run lint`: clean.
* `npm run build`: clean.

## 2.5.2 (2026-08-18)


### Bug Fixes

* **cross-platform child kill:** `MonitorManager.stop()` previously called `proc.kill("SIGTERM")` and `proc.kill("SIGKILL")` directly. Both forms throw `EINVAL` on Windows (`errno: -4071, syscall: "kill"`) because POSIX named signals have no meaning there. On any platform, an already-exited child could also surface `ESRCH` during the kill call. Extracted a private `killProc(proc, signal)` helper that uses `proc.kill()` (no args) on `win32` and the named signal on POSIX, with `try/catch` to swallow dead-process races. Both call sites in `stop()` now route through it. The `MonitorXxx` tools remain unregistered in this build, so the fix is defensive — it protects any future re-enablement of the monitor surface and removes a class of test failures on Windows dev boxes.

### Tests

* **regression coverage for the Windows kill path:** new `test/monitor-manager-kill.test.ts` (3 cases) uses mock `ChildProcess`es so it runs on every platform (no `sh`/`bash` required). Asserts: (1) the platform-correct signal is passed to `proc.kill`, (2) a `kill("SIGTERM")`-style `EINVAL` from Windows does not propagate out of `stop()`, (3) `ESRCH` from a child that already exited does not propagate.
* **Unix-only suite gated:** `test/monitor-manager.test.ts` now wraps the `describe` in `describe.skipIf(process.platform === "win32")` because the manager hardcodes `sh -c <command>` for spawn and the integration tests exercise real `echo` / `sleep` / `exit 1` processes. The mock-based kill tests cover the Windows surface without needing a Unix shell on PATH.

## 2.5.1 (2026-08-18)


### Features

* **sub-agent execution mode (v2.5 design implemented):** new `LoopIsolation` type and `isolation: "sub-agent"` field on `LoopEntry` (default `"in-process"`, backwards compatible). When set, each fire spawns a fresh child pi process with its own context window via `child_process.spawn`; the parent receives only a one-line summary. The child's session file, stdout/stderr, and `result.md` are durable on disk under `<loopScope>/sub-agent-results/<loopId>/iter-<N>/`. New optional fields on `LoopEntry`: `goal`, `successCriteria`, `failureCriteria`, `stateFile`, `subAgent` sub-object (per-loop overrides for model / thinking / tools / maxTokens / maxIterations / iterationTimeoutMs). The new `/loop-subagent <interval> <prompt>` slash command is the recommended way to opt in. `LoopCreate` and `LoopUpdate` tool schemas accept the new fields. `LoopInspect` is a new tool that returns a structured summary of a loop's latest iteration. The `subAgent` settings block in `.pi/pi-loop-settings.json` configures session-wide defaults (activeIterationsMax, defaultIterationTimeoutMs, defaultIterationTokenBudget, piBinary, envOverrides, registerBackgroundWorkProvider, honorCapabilityCeiling, criticalInterruptsAll, showCostInStatusLine, useLlmEvaluator). Concurrency is capped via the gate (default 4); the per-loop `maxTokens` and `maxIterations` fields cap cost and run length; 3 consecutive failures pause the loop. Results are evaluated by regex against `result.md` for the optional success / failure criteria. Token usage and cost are read from the child's session file tail and recorded against the loop. Parent-restart reconciliation walks the on-disk result directories and finalises any stale iterations as `orphaned`.

* **tools:** add `LoopInspect({ loopId, iterId? })` for the agent to read its own sub-agent runs without opening files.
* **commands:** add `/loop-subagent <interval> <prompt> [--goal ...] [--success-criteria ...] [--failure-criteria ...] [--state-file ...] [--model ...] [--max-tokens N] [--max-iterations N] [--iteration-timeout MS]`. Wraps `LoopCreate` with `isolation: "sub-agent"`.
* **migrations:** add `src/migration/v2-to-v2.5.ts` — one-shot migration that adds the `subAgent` settings block to existing `.pi/pi-loop-settings.json` files. Idempotent. Wired up in `src/index.ts:loadInitialSettings`.

### Internal

* `src/types.ts`: new `LoopIsolation` type; `LoopSubAgentConfig` interface; new optional fields on `LoopEntry` (`isolation`, `goal`, `successCriteria`, `failureCriteria`, `stateFile`, `subAgent`, `cumulativeTokens`, `cumulativeCostUsd`, `iterCount`, `consecutiveFailures`); new `SubAgentStatus` and `SubAgentResult` types.
* `src/loop-reducer.ts`: `LOOP_CREATED` payload accepts the new fields; the reducer passes them through to the resulting entry.
* `src/store.ts`: `create()` accepts the new fields; new `updateConfig()`, `accrueCost()`, `incrementFailures()`, `resetFailures()` methods.
* `src/reducer-backed-store.ts`: `save()` is now `protected` (was `private`) so `LoopStore` can persist config updates.
* `src/settings.ts`: new `LoopIsolation` type, `SubAgentSettings` interface, `DEFAULT_SUB_AGENT_SETTINGS` defaults, and `asSubAgentSettings()` parser; `PiLoopSettings` gains the `subAgent` field.
* `src/commands/settings-command.ts`: settings TUI shows the `subAgent` block as a non-cycling summary (edit via direct JSON).
* `src/runtime/loop-validation.ts`: new module — per-field validators for the new LoopEntry fields with explicit error messages.
* `src/runtime/sub-agent/`: new sub-agent runtime. Modules: `spawn.ts` (cross-platform child-process spawn with two-stage kill), `result-store.ts` (atomic-write `result.json`), `result-watcher.ts` (in-flight iteration table, exit observation, parent-restart reconciliation), `cost-tracker.ts` (per-loop and per-session token / cost ledger with a model price table), `scheduler.ts` (gate: concurrency cap, iteration cap, budget cap, failure cap), `evaluator.ts` (regex match against `result.md` for success / failure criteria), `notification-formatter.ts` (one-line summary, tiered by priority), `index.ts` (`SubAgentRuntime` public surface, `resolveSubAgentScopeRoot` helper).
* `src/index.ts`: wires the `SubAgentRuntime` into the trigger / scheduler / notification path. Sub-agent loop fires go through the runtime; in-process loop fires are unchanged. The runtime is re-created on session change; in-flight iterations are reconciled at startup.

### Tests

* `test/runtime/sub-agent/scheduler.test.ts` (7 tests): covers spawn, defer (concurrency cap), pause (iteration / budget / failure cap), ordering, and threshold edges.
* `test/runtime/sub-agent/evaluator.test.ts` (8 tests): covers no-match, missing result.md, success match, failure match, failure-wins, no-criteria, invalid regex, case-insensitivity.
* `test/runtime/sub-agent/result-store.test.ts` (5 tests): round-trip write / read, atomic write, missing iteration, sort order, prune.
* `test/index.test.ts`: `LOOP_TOOLS` extended with `LoopInspect`; `LOOP_COMMANDS` extended with `loop-subagent`.
* `test/settings-command.test.ts`: settings menu count updated from 12 (10 settings + Shared + Back) to 13 (11 settings + Shared + Back).

### Quality gates

* `npm run typecheck` clean.
* `npm run lint` clean.
* `npm test`: 1001 passed / 19 failed. The 19 failures are all pre-existing in `test/monitor-manager.test.ts` (Windows-specific `process.kill(pid, 'SIGTERM')` returns `EINVAL`; the same 19 fail on master without my changes) and unrelated to this PR.
* `npm run build` clean (full `tsc`).

### Out of scope (deferred to v2.5.2)

* The `LoopInspect` tool's `iterId` parameter is accepted for API symmetry but the read is always the latest; full iteration history is in the on-disk result files.
* TUI panel (FleetView-style `loops-sub-agent` belowEditor widget with live iteration progress).
* `/loop-sub-agent-inspect`, `/loop-sub-agent-stop`, `/loop-cost` slash commands.
* `pi-subagents` background-work provider bridge (`registerBackgroundWorkProvider`).
* Capability ceiling auto-read from `pi-subagents` (`registerSubagentCapabilityCeiling`).
* LLM-call evaluator (the v2.5 design has a `subAgent.useLlmEvaluator` setting; the v2.5.1 default is regex-only).

## 2.5.0 (2026-08-18)


### Docs

* **sub-agent execution PRD:** new `docs/PRD/sub-agent.md` (1489 lines) plus three generated artifacts under `docs/PRD/`. This PRD is the execution plan for a future `sub-agent` capability in pi-loop — agents that spawn child agents, observe their tool calls, and forward observations back to the parent turn. It contains the problem statement, three rounds of clarifying questions + decisions, an execution spec sheet, a decision matrix, and an `Open decisions` block ready to be resolved before implementation. Reference structure lives at `docs/PRD/reference-structure.txt`; spec/question generators at `docs/PRD/build_specs.py` and `docs/PRD/build_questions.py` / `build_questions_r2.py`. **No runtime change in this release** — `src/` is unchanged from 2.4.0. The PRD ships as a published deliverable so external reviewers can audit the planned capability ahead of any implementation PR.

## 2.4.0 (2026-08-13)


### Features

* **shared-loop scope:** pi-loop now supports a fourth `LoopScope` value, `"shared"`, enabling cross-repo loop sharing on the same machine. A new `LoopStore.promote(id, sharedStorePath)` method copies a loop to the shared store and (per Q5) tears down the source entry; `LoopStore.adopt(sharedEntry)` copies a shared entry into the local project store. The shared store resolves to `<homedir>/.pi/loops/shared.json` by default (Q1), with `PI_LOOP_SHARED_PATH` env override. `--loop-settings` gains a new `Shared loops` sub-screen that lists project + shared loops side-by-side with `Promote to shared` / `Adopt from shared` actions per row (Q2 = unified picker). `/loop` View loops per-loop actions menu gains a `+ Promote to shared` row, consistent with the existing `Edit` / `- Pause` / `* Resume` / `x Delete` shape. The widget renders a `[shared]` badge for entries sourced from the shared store.
* **config:** `LoopScope` union extended to `memory | session | project | shared` (src/settings.ts:16, src/runtime/scope.ts:9); `asScope` validator accepts the new value (src/settings.ts:104); `resolveLoopStorePath` adds a `shared` branch (src/runtime/scope.ts).
* **store:** `ReducerBackedStore.insertEntryWithId(entry)` is a new public helper that inserts an entry with a caller-supplied id and bumps `nextId` to prevent reuse (used by promote/adopt to preserve id continuity across the project<->shared boundary).
* **types:** `LoopEntry.scope` (optional, default `"project"`) marks the storage origin of an entry. Back-compat: legacy stored entries without the field are treated as `"project"` by the widget renderer.

### Breaking changes

* **promote is destructive by default (Q5).** When a user runs `Promote to shared` from either `/loop` View loops or the `/loop-settings` Shared loops sub-screen, the source entry is removed from `.pi/loops/loops.json` and its trigger subscription is torn down. Only repos that adopt the shared entry will fire the loop. The original project's copy is gone — not paused, not archived. To re-pull it locally, run `Adopt from shared` from the sub-screen. Migration: any loop that should keep its source copy after promotion must be promoted first, then explicitly re-created in the originating repo via `/loop` Create. **Behavioral change: spec AC-2 ("source still active after promote") is OBSOLETE under this default and the corresponding test asserts the opposite outcome (Q5 destructive-promote assertion).**
* **auto-merge (AC-11) and push-sync (AC-12) explicitly not implemented.** Q3 resolved "explicit adopt" (shared loops are NOT visible in `LoopList` until adopted). Q4 resolved "pull-only" (editing a shared loop in repo B creates a new project-scoped loop with a fresh id; the shared entry is unchanged). Both ACs remain in the spec as deferred capabilities.

### Internal

* `src/reducer-backed-store.ts`: new `insertEntryWithId(entry)` method on the base class. Writes through `withLock`/`save` atomically.
* `src/store.ts`: two new `LoopStore` methods. `promote(id, sharedStorePath)` is destructive (Q5); the caller does `triggerSystem.remove(id)` before invoking it. `adopt(sharedEntry)` copies from shared to project; the caller does `triggerSystem.add(entry)` after invoking it.
* `src/commands/settings-command.ts`: `SettingsCommandOptions` gains `getStore` and `getTriggerSystem` required parameters; new `Shared loops: ->` menu entry in the cyclic editor opens `openSharedLoopsSubScreen()`. The sub-screen calls `triggerSystem.remove()` before promote and `triggerSystem.add()` after adopt, matching the `LoopDelete` ordering at `src/tools/loop-tools.ts`.
* `src/commands/loop-command.ts`: `LoopStoreLike` interface gains `promote(id, sharedStorePath)`; `viewLoops` per-loop actions menu gains a `+ Promote to shared` row.
* `src/ui/widget-render.ts`: `RenderLoopEntry` interface gains `scope` field; `renderLoopRow` renders a `shared` badge when `loop.scope === "shared"`.
* `src/index.ts`: `registerSettingsCommand` call site now passes `getStore` and `getTriggerSystem`.

### Tests

* `test/shared-store.test.ts`: new file with 11 test cases covering promote (copy, refuse-on-not-found, refuse-on-collision, id continuity, destructive Q5), adopt (copy, refuse-on-local-collision, id continuity), `insertEntryWithId` (insert, refuse-on-collision), and scope field defaults (back-compat, post-promote, post-adopt).
* `test/settings-command.test.ts`: `setupCommand` now passes `getStore` and `getTriggerSystem`; the "renders all 10 settings" test count updated from 11 to 12 (10 settings + `Shared loops` entry + `< Back`).
* `test/loop-command.test.ts`: the "does not offer resume for a workflow paused in a terminal state" test updated to expect the new `+ Promote to shared` action in the menu list.

### Docs

* `specs/promote-loop-to-shared.md`: 5 Product Decisions resolved 2026-08-13 (Q1 homedir+env, Q2 unified picker, Q3 explicit adopt, Q4 pull-only, Q5 auto-delete on promote). AC-2 marked OBSOLETE; AC-10/AC-13 unblocked; AC-11/AC-12 marked [NOT IMPLEMENTED]. Status header updated to "reviewed (approved 2026-08-13) — Q1-Q5 Product Decisions resolved 2026-08-13".
* `docs/plan/promote-loop-to-shared-impl.md`: implementation plan updated to reflect resolved decisions. Step 3 extended with destructive promote semantics; Step 7 dropped (Q3 = explicit adopt); file-by-file change list updated to remove `src/runtime/session-runtime.ts`. New "Resolved decisions" table replaces the "Blocker tasks" section.
* `docs/plan/ADR-006-split-loop-pause-resume.md`: companion ADR from the 2.3.0 cycle.

### Quality gates

* 1000/1000 vitest pass (was 973/973 before the new tests; 13 added in test/shared-store.test.ts).
* `npm run typecheck` clean.
* `npm run lint` clean (no fixes applied).
* `npm run test:all` (includes `injection.test.ts` + `harness-state-steering.test.ts`) green.
* `npm pack --dry-run` -> 230 files, ~1.4 MB unpacked, version 2.4.0.

## 2.3.0 (2026-08-12)


### Features

* **tools:** add `LoopPause({id})` and `LoopResume({id})` as first-class tools. Pause and resume are now symmetric — agents no longer need to fall back to slash commands or the `/loop` TUI to flip status. `LoopPause` mirrors `store.pause()` + trigger teardown; `LoopResume` mirrors `store.resume()` + trigger re-arm and clears the dynamic-loop `awaitingUpdate` flag if set.
* **tools:** drop the overloaded `action: "delete" \| "pause"` enum from `LoopDelete`. `LoopDelete` now only deletes. The pause path lives on `LoopPause`; the resume path lives on `LoopResume` or `/loop-resume <id>` (which also writes the session bindings file).
* **tools (visibility):** add `LoopPause` and `LoopResume` predicates to `syncLoopTools`. `LoopPause` is visible when at least one active loop exists; `LoopResume` is visible when at least one paused loop exists. `LoopDelete`'s predicate is unchanged (still gated on paused or `taskBacklog`) to preserve the soft friction against casual deletion.

### Breaking changes

* `LoopDelete({action:"pause"})` is no longer a valid tool call. The `action` parameter has been removed from the schema. Any in-flight agent session calling the old shape will get a tool validation error. Migration: call `LoopPause({id})` instead.

### Internal

* `src/tools/tool-visibility.ts` — new `LOOP_TOOL_PAUSE` / `LOOP_TOOL_RESUME` constants and predicates; module-level doc updated.
* `src/tools/loop-tools.ts` — `LoopStoreLike` interface gains `resume()`.
* `src/tools/workflow-tools.ts` — error message at the \"all declared outcomes are unavailable\" branch now points at `LoopPause` instead of the removed `LoopDelete action=\"pause\"` shape.
* `src/index.ts` — header doc lists `LoopPause` and `LoopResume` alongside the existing CRUD tools.

### Tests

* `test/loop-tools.test.ts` — five call sites that exercised `LoopDelete({action:\"pause\"})` now call `LoopPause({id})`. Three new describe blocks for `LoopPause` and `LoopResume` (8 new cases total) covering pause/resume happy path, idempotent re-resume, not-found, tombstone, and \"does not touch bindings\".
* `test/index.test.ts` — `LOOP_TOOLS` constant extended to include the two new tools.
* `test/tool-visibility.test.ts` — no behavior change required; the new predicates inherit the existing harness.

### Docs

* `docs/plan/ADR-006-split-loop-pause-resume.md` — new ADR capturing the decision, design, file-by-file plan, and acceptance criteria.
* `docs/architecture/state-machine-reducer-event-model.md` — \"Current: LoopDelete(action=pause)\" heading updated to \"Current: LoopPause\".
* `docs/architecture/state-machine-test-matrix.md` — L-04 row updated; L-04b row added for the new `LoopResume` tool path; L-05 row now mentions `/loop-resume <id>` as the bindings-aware path.
* `docs/architecture/state-machine-transition-map.md` — transition table lists `LoopPause` and `LoopResume` as canonical tool paths for active↔paused; notes that `/loop-resume` also writes the bindings file.
* `docs/plan/ADR-002-tool-visibility-call-site.md` — rationale enumerates the new predicates alongside `LoopDelete`'s.
* `docs/MANUAL_TESTING.md` — tool visibility scenario expanded to cover `LoopPause` / `LoopResume` gating.
* `userflow/loop-delete-pause.md` — full rewrite around the new tool trio; sequence diagrams and state machine updated.
* `userflow/GAPS.md` — G-05 (\"resume only available via command\") marked closed.
* `userflow/cross-platform-ux-analysis.md` — U-04 (\"no tool to resume\") marked closed.
* `README.md` — Tools table updated; `LoopPause` and `LoopResume` rows added.

### Quality gates

* 973 / 973 vitest pass (was 965 / 965 before the new tests).
* Coverage: statements / branches / functions / lines — unchanged from 2.2.1 baseline (above floors).
* `npm run typecheck && npm run lint && npm test && npm run test:all` clean.
* No data migration required. `LoopEntry.status: \"active\" \| \"paused\"` is unchanged. Stored loops work as-is.

## 2.2.1 (2026-08-12)


### Bug Fixes

* **edit:** integrate the Edit action into the `/loop` View loops per-loop actions menu, replacing the standalone `/loop-edit` command. The per-loop menu now shows `Edit`, `- Pause` (or `* Resume`), `x Delete`, and `< Back` together, so the edit workflow lives next to Pause/Resume/Delete rather than behind a separate command. The shared edit logic is exported as `editLoopInteractive` and `pickLoopForEdit` from `src/commands/loop-edit-command.ts` and consumed by `loop-command.ts`. The 2.2.0 `/loop-edit` command is removed.

## 2.2.0 (2026-08-12)


### Features

* **edit:** add `Edit` action to the `/loop` View loops menu. From `/loop` → View loops, each loop's actions menu now includes `Edit`, `- Pause` (or `* Resume`), `x Delete`, and `< Back`. Selecting `Edit` opens a cyclic field form for the editable fields: `prompt`, `trigger`, `priority`, `recurring`, `maxFires`, `readOnly`, `autoTask`. Persists via `LoopStore.updateMetadata` (extended to accept the new fields with structural `triggerEquals` check to avoid spurious re-arms). Re-arms the trigger only when it actually changed AND the loop is active; paused loops persist only. `LoopStore.clearMaxFires` helper added for explicit clearing of the `maxFires` cap (TS erases `undefined` keys). Re-arm is wrapped in try/catch with a user-facing error notification if `triggerSystem.add()` throws after a successful `remove()` — the loop remains persisted but the user is told to pause/resume to retry. The shared edit logic lives in `src/commands/loop-edit-command.ts` (exports `editLoopInteractive` and `pickLoopForEdit`) and is reused by the per-loop actions menu in `loop-command.ts`.

## 2.1.1 (2026-08-11)

### Bug fixes

- **G-46 drain-all regression (commit 8101661/c6ed147).** `flushPendingNotifications` was exiting after the first delivery instead of draining the queue. The `c6ed147` refactor preserved a stale `syncRuntimeState({ agentRunning: true })` call inside `deliverNotification` that blocked the drain-all loop. The G-39 fix in commit `e3d6cf9` updated the test to expect 2 messages from 2 distinct fires but could never deliver them. Fixed by removing the spurious `syncRuntimeState({ agentRunning: true })` (the agent's running state is tracked strictly by `agent_start` / `agent_end` events) and restoring the empty-queue guard at the top of the flush loop. The `keeps one-shot buffered wakes independent` test now also uses drain-all semantics (both one-shot wakes land after a single `agent_end`), removing the contradictory incremental-delivery expectation.
- **`tasks:rpc:clean` was never emitted.** `cleanDoneTasks` was a no-op after the disabled-tools contract took effect, but the autoTask test (`respondToTaskPing: true`) and the original `tasks:rpc:clean` RPC contract require the broadcast. `cleanDoneTasks` now emits `tasks:rpc:clean` with a unique requestId so downstream listeners (mocked or real pi-tasks) can sweep done tasks.

### Internal

- `package.json` — `files` field added (was previously absent, defaulting to `npm publish` including the entire cwd; this caused the published 2.1.0 to accidentally include `wt/` (27 MB of worktrees) at 18.5 MB unpacked). New `files` is `["dist", "src", "docs", "userflow", "README.md", "CHANGELOG.md", "LICENSE"]` — 1.6 MB unpacked, matching the prior published 2.0.0 size.

### Tests

- `test/injection.test.ts` — pre-existing G-46 and autoTask failures now pass (9 / 9).

### Quality gates

- 888 / 888 vitest pass (was 886 / 888 with 2 pre-existing failures before 2.1.0).
- Coverage: statements 85.8% / branches 80.38% / functions 87.21% / lines 88.43% — all above floors.

## 2.1.0 (2026-08-11)

### Features

- **Priority-aware aging notification queue (ADR-005).** Each loop can be tagged with a priority (`defer`, `normal`, `urgent`, `critical`) via `LoopCreate priority`. The notification queue now coalesces same-key fires with a `fireCount` (preserving `firstFireAt`, updating `lastFireAt`), and force-flushes by priority on a 30-second heartbeat poll. `defer` is shielded from priority inversion on both the urgent-flush heartbeat and the normal idle flush. `urgentFlushThresholds` is configurable via `.pi/pi-loop-settings.json` (defaults: `critical: 0`, `urgent: 30s`, `normal: 5m`, `defer: 24h`). Delivered messages surface fire-count and priority markers: `[pi-loop] Loop #N fired 7× since 2026-01-20T...` and `[Priority: urgent] ...`. Workflows with `taskBacklog` are unaffected; `autoTask` wake-drop still emits `tasks:rpc:clean`.

### Bug fixes

- **G-46 drain-all regression (commit 8101661/c6ed147).** `flushPendingNotifications` was exiting after the first delivery instead of draining the queue. The `c6ed147` refactor preserved a stale `syncRuntimeState({ agentRunning: true })` call inside `deliverNotification` that blocked the drain-all loop. The G-39 fix in commit `e3d6cf9` updated the test to expect 2 messages from 2 distinct fires but could never deliver them. Fixed by removing the spurious `syncRuntimeState({ agentRunning: true })` (the agent's running state is tracked strictly by `agent_start` / `agent_end` events) and restoring the empty-queue guard at the top of the flush loop. The `keeps one-shot buffered wakes independent` test now also uses drain-all semantics (both one-shot wakes land after a single `agent_end`), removing the contradictory incremental-delivery expectation.
- **`tasks:rpc:clean` was never emitted.** `cleanDoneTasks` was a no-op after the disabled-tools contract took effect, but the autoTask test (`respondToTaskPing: true`) and the original `tasks:rpc:clean` RPC contract require the broadcast. `cleanDoneTasks` now emits `tasks:rpc:clean` with a unique requestId so downstream listeners (mocked or real pi-tasks) can sweep done tasks.

### Internal

- `src/notification-reducer.ts` — new `REQUEST_URGENT_FLUSH` event + reducer handler with priority threshold table; `NOTIFICATION_QUEUED` coalesces same-key entries with `fireCount` / `firstFireAt` / `lastFireAt` / `priority` metadata; `NOTIFICATION_FLUSH_REQUESTED` filter out defer-priority items when any non-defer item is queued.
- `src/runtime/notification-runtime.ts` — `dispatchUrgentFlush()` method; `buildPendingNotification` adds fire timing; `deliverNotification` (no longer mutates `agentRunning`); `[Priority: P]` and `[N× since X]` message prefixes.
- `src/runtime/session-runtime.ts` — heartbeat pump now calls `dispatchUrgentFlush()` alongside `pumpLoops()`.
- `src/settings.ts` — `UrgentFlushThresholds` interface + strict parser + defaults.
- `src/commands/settings-command.ts` — `/loop-settings` cycles the `defer` threshold.
- `src/tools/loop-tools.ts` — `LoopCreate` accepts `priority` enum (default `normal`).
- `docs/plan/ADR-005-priority-queue.md` — 158 lines.

### Tests

- `test/notification-reducer-priority.test.ts` (new, 17 tests) — fire-count coalescing, 4×4 priority matrix, age force-flush ordering, defer-never-preempts.
- `test/notification-reducer-priority.test.ts` (extended) — normal flush skips defer when higher-priority exist (3 new tests).
- `test/session-runtime.test.ts` — heartbeat integration test asserts `dispatchUrgentFlush` fires every 30s.
- `test/settings-command.test.ts` — settings fixture includes `urgentFlushThresholds`.
- `test/injection.test.ts` — pre-existing G-46 and autoTask failures resolved; 9 / 9 pass.

### Quality gates

- 888 / 888 vitest pass (was 886 / 888 before this release).
- Coverage: statements 85.8% / branches 80.38% / functions 87.21% / lines 88.43% — all above floors.

## 2.0.0 (2026-08-08)

### BREAKING CHANGES

- **Status line replaced with above-editor widget.** pi-loop v2.0 no longer
  calls `ctx.ui.setStatus("loops", …)`. The new `Component` is registered
  via `ctx.ui.setWidget(KEY, factory, { placement: "aboveEditor" })` and
  renders a multi-line tree of loops + monitors + tasks. Any external
  scripts that parsed the v1.x status-line format must be updated.
- **Settings unified to `.pi/pi-loop-settings.json`.** The v1.x
  `.pi/tasks-config.json` file is migrated once on first v2 startup and
  renamed to `.pi/tasks-config.json.v1.bak`. The v1.x files
  `src/tasks-config.ts` and `src/ui/settings-menu.ts` are deleted from
  the tree.
- **PI_LOOP_* env vars no longer read.** `PI_LOOP_SCOPE`,
  `PI_LOOP_DEBUG`, `PI_LOOP_TASK_THRESHOLD`, `PI_LOOP_TASK_WORKER_THRESHOLD`,
  and `PI_LOOP` are captured once by the v1-to-v2 migration into the new
  settings file and ignored thereafter. Use `/loop-settings` instead.
- **Strict settings schema.** Unknown keys in
  `.pi/pi-loop-settings.json` cause a startup error (previously silently
  ignored).

### Features

- **Above-editor widget** registered via `setWidget("loops", factory, { placement: "aboveEditor" })`. Renders per-loop rows with icons, branch lines, trigger descriptions, and badges (`auto-task`, `backlog`, `iter:N`). Per-monitor rows show status icon, command, output line count, and age. Per-task summary is a single line.
- **Width-safety net.** Every widget line is post-processed through `truncateToWidth(line, width, "…")` so the TUI never overflows. Tested at widths 50, 70, 80, 100, 109, 120 with 25 loops + 25 monitors + 25 tasks.
- **Live ticker.** The widget repaints at 1 Hz while a firing indicator is visible. The `→ firing (Ns ago)` suffix refreshes every second for 5 seconds, then auto-clears. The timer is `.unref()`-ed so one-shot processes can exit.
- **Tool visibility gating.** `syncLoopTools(pi, loops)` removes loop tools from the LLM's active tool set when they are not relevant to the current state. `LoopUpdate` is hidden when no dynamic loop is active; `LoopDelete` is hidden when no paused or `taskBacklog` loop exists; `WorkflowTransition` is hidden unless a workflow loop is in flight. Called from `before_agent_start` (per pragmaxim `d77e3b8` lesson: never from `session_start` because the runtime isn't bound yet) and after every store mutation.
- **Modal overlays** (`Ctrl+Shift+L`, `Escape`) modelled on pragmaxim's `task-list-overlay.ts` and `goal-escape-dialog.ts`. Loop list overlay shows every loop, monitor, and task with `a` to toggle "my loops" vs "all loops". Escape dialog appears during a long-running fire with three options: cancel / skip / continue (default).
- **Unified settings file** with strict schema (`additionalProperties: false`), env-var precedence on first v2 startup, and `/loop-settings` TUI editor.
- **Crash-recovery prompt** on `session_start` with `event.reason === "resume"`: offers to resume each paused loop via `ctx.ui.confirm`. Mirrors pragmaxim's `extensions/goal.ts:3437`.
- **`/loop-settings` slash command** with TUI menu cycling every setting and saving immediately.

### Internal

- `src/ui/widget-render.ts` (new, 187 lines) — pure render function.
- `src/ui/overlays.ts` (new, 188 lines) — `showLoopListOverlay`.
- `src/ui/escape-dialog.ts` (new, 122 lines) — `showEscapeDialog`.
- `src/tools/tool-visibility.ts` (new, 134 lines) — `syncLoopTools`, `computeActiveTools`, `snapshotFromLoop`.
- `src/settings.ts` (new, 185 lines) — `parseSettings`, `loadSettings`, `saveSettings`, `updateSettings`.
- `src/migration/v1-to-v2.ts` (new, 120 lines) — one-shot v1-to-v2 migration.
- `src/commands/settings-command.ts` (new, 155 lines) — `/loop-settings` editor.
- 4 new `userflow/*.md` docs: `widget-loop-monitor-task.md`, `keybindings.md`, `settings-v2.md`, `crash-recovery.md`.
- 4 ADRs in `docs/plan/`: widget key naming, tool visibility call sites, settings file schema, overlay keybindings.

### Migration

On first v2 startup, `migrateV1ToV2()`:

1. Reads `.pi/tasks-config.json` (if present). Merges values into the v2 schema.
2. Reads `PI_LOOP_SCOPE`, `PI_LOOP_DEBUG`, `PI_LOOP_TASK_THRESHOLD` env vars. Captures values into the v2 file.
3. Writes `.pi/pi-loop-settings.json`.
4. Renames the v1 file to `.pi/tasks-config.json.v1.bak`.
5. Prints a one-time banner to stderr.

The migration is idempotent — re-running does nothing if the v2 file already exists. To migrate manually, run `/loop-migrate` (future PR).

### Test coverage

- **848 tests** pass (was 561 in v1.3.0; +287 new in v2.0 across 7 new test files and 3 extensions).
- Full state × tool matrix tests for tool visibility gating.
- Width matrix tests for the widget (6 widths × pathological counts).
- Migration round-trip tests (v1 file → v2 file, env vars → v2 file, idempotency).

## 1.0.0 (2026-07-02)


### Features

* /monitors command + UX batch (G-04, U-03, U-06, U-07, U-13) ([#7](https://github.com/bramburn/pi-loop/issues/7)) ([950fcc4](https://github.com/bramburn/pi-loop/commit/950fcc436da7fc9dc87c28417c0eabfd0737c827))
* add maxFires for self-limiting loops, event-driven prompt steering ([52b50f0](https://github.com/bramburn/pi-loop/commit/52b50f0d2b8c0b1df6aa74b09a8561807b549fe6))
* add native task fallback and compact task tracker ([6b5b6ff](https://github.com/bramburn/pi-loop/commit/6b5b6fff53cc7810242e4f9081fe6d21b318c654))
* add task decomposition guidance to TaskCreate prompt ([4c51e72](https://github.com/bramburn/pi-loop/commit/4c51e72a7317e1433cdb5bed6cfc9dfa521b5bfb))
* add tasks:rpc:clean RPC for sweeping done tasks ([73812ed](https://github.com/bramburn/pi-loop/commit/73812ed4c3efeb08e97908e6de6435f65c768440))
* auto-create task worker loop at backlog threshold ([430663a](https://github.com/bramburn/pi-loop/commit/430663a8042560688e08bd08129ea57b190ccecc))
* generalize task backlog loop cleanup ([9132948](https://github.com/bramburn/pi-loop/commit/9132948dc9e22cda32adf6e8c5e13a7203f9c864))
* goal prompt and loading refinements ([b31df23](https://github.com/bramburn/pi-loop/commit/b31df23c240f0bde7fb69fb8ea702429576276c7))
* LoopUpdate tool and resume action on LoopDelete ([#4](https://github.com/bramburn/pi-loop/issues/4)) ([c96a22d](https://github.com/bramburn/pi-loop/commit/c96a22d150a151160b53544bc800af0ed2933e8e))
* MonitorDelete tool (U-02, G-03) ([#5](https://github.com/bramburn/pi-loop/issues/5)) ([4b01cce](https://github.com/bramburn/pi-loop/commit/4b01ccee8ec9030cf7c369c2f475f33f0c3a8c91))
* prune completed tasks after successful git commit ([cba120b](https://github.com/bramburn/pi-loop/commit/cba120be3a7fcdf71b7f7649b414577412d26a94))
* refining monitor interface ([66a6007](https://github.com/bramburn/pi-loop/commit/66a60077093f40c258efeeb971f6f8db74e24f83))
* show worker-loop hint when pending tasks reach 5+ ([74dbf2c](https://github.com/bramburn/pi-loop/commit/74dbf2cbf7f55a4206762eee3731798527537ab5))
* skip loop fires when autoTask loop has no pending tasks ([f2feb07](https://github.com/bramburn/pi-loop/commit/f2feb079d5b520ed4c4dd0dc85d5b385efc45c45))
* TaskPrune tool (U-05, G-02) ([#6](https://github.com/bramburn/pi-loop/issues/6)) ([7fe9347](https://github.com/bramburn/pi-loop/commit/7fe934784d3d03b898515931e302912a52e7b3ed))
* **tasks:** emit native task events with previousStatus tracking ([61b49ea](https://github.com/bramburn/pi-loop/commit/61b49ea5703597b02754998269edfdc5b2018ebb))


### Bug Fixes

* add trigger validation, readOnly flag, and edge-case tests ([91baa07](https://github.com/bramburn/pi-loop/commit/91baa07884bc20d760c7a3642c3ec462997fc0d3))
* auto-delete worker loop when task backlog clears ([502fa10](https://github.com/bramburn/pi-loop/commit/502fa106b8862c06648e6be373e5980d2af18f6f))
* auto-expire monitor:done loops, buffer output, show completed monitors ([a3ec5de](https://github.com/bramburn/pi-loop/commit/a3ec5de5847d67bddee9c572079b559b03e35f3f))
* cross-platform shell + signal handling for MonitorCreate/Stop ([#1](https://github.com/bramburn/pi-loop/issues/1)) ([980b533](https://github.com/bramburn/pi-loop/commit/980b533893793bbb0db53cd6f55752f3428c777e))
* deduplicate loop follow-up messages to prevent flood ([1613511](https://github.com/bramburn/pi-loop/commit/1613511a2453d346edb59919beed2bdb18c05f63))
* delete done loops/monitors immediately instead of marking expired ([43f5220](https://github.com/bramburn/pi-loop/commit/43f5220a3e6d807234e4bdb7611e44c0fa7468ec))
* delete event maxFires loops immediately ([12335e7](https://github.com/bramburn/pi-loop/commit/12335e75dcf8d17a2c887966cae180d2b2f848da))
* deliver monitor onDone wakes without event dependency ([79d6a8b](https://github.com/bramburn/pi-loop/commit/79d6a8b925aa98e8de0ea1b12addd5e0d2db0c47))
* derive jitter ceiling from cron step, delete expired event loops ([6d13935](https://github.com/bramburn/pi-loop/commit/6d13935e79d2367072bec027d5ef2cb430eff44a))
* file lock improvements (G-14, G-25, partial G-24) ([#9](https://github.com/bramburn/pi-loop/issues/9)) ([b77f8c9](https://github.com/bramburn/pi-loop/commit/b77f8c9ca82c991b99f3b25c0a34be7e43630c4a))
* flush buffered worker wakes on agent end ([7a7dedf](https://github.com/bramburn/pi-loop/commit/7a7dedf3ec7f16eb63edbfaf93e5dae9ed7a8f25))
* harden TaskUpdate prompt to prevent taskId alias errors ([5dfefd9](https://github.com/bramburn/pi-loop/commit/5dfefd96bb08c29d192de472c6224ac434394b6f))
* **injection:** use before_agent_start message, not tool_result ([99a6317](https://github.com/bramburn/pi-loop/commit/99a6317aabde8ce9d4f9e0c3065f42b6c6111259))
* loop trigger fix ([619f32c](https://github.com/bramburn/pi-loop/commit/619f32c48134d9cc1376a89a62a7c8d729321143))
* **monitor:** make MonitorManager spawn-injectable, fix CI test timeouts ([f277646](https://github.com/bramburn/pi-loop/commit/f277646b95369b43508fbbc8cc7eef5e37580781))
* **monitor:** prune stopped/timed-out monitors ([a46f6e8](https://github.com/bramburn/pi-loop/commit/a46f6e8f2b99fa39bd11ff22d1a34999e1ac4434))
* only dedup recurring loop fires, always deliver one-shot events ([352e50e](https://github.com/bramburn/pi-loop/commit/352e50e1de14ecd8d884b18a8e72572270ca90e9))
* **persist:** expire event loops on session start, clean stale monitors ([7f0876d](https://github.com/bramburn/pi-loop/commit/7f0876d821e93e663f43ec2d5351bc9a37223b4b))
* recommend 5m default interval in LoopCreate task-continuation prompt ([1af3bcd](https://github.com/bramburn/pi-loop/commit/1af3bcd35a2782f9fc333559d293c665db76c234))
* **reminders:** make loop reminder directive, not informational ([e21174d](https://github.com/bramburn/pi-loop/commit/e21174df3d1d9403684e094f5763db33ed9cb732))
* remove trigger subscriptions when loops expire (G-06, G-07) ([#3](https://github.com/bramburn/pi-loop/issues/3)) ([0db5bec](https://github.com/bramburn/pi-loop/commit/0db5bec96aeb4501dd8dc624314ca9cfb5910e6f))
* repair native task fallback compilation ([a8cef04](https://github.com/bramburn/pi-loop/commit/a8cef04eabd8a8af404d27ffa756266ee6a188ec))
* **runtime:** unref retention timer, swallow heartbeat pump errors ([602816b](https://github.com/bramburn/pi-loop/commit/602816b3abb06859a0268c02119cc753de03decb))
* scope native task files by session, prevent cross-session leakage ([0436710](https://github.com/bramburn/pi-loop/commit/04367102414dd56f7668e1522b91c6f089490979))
* **tasks:** guard native fallback registration ([7d3b74a](https://github.com/bramburn/pi-loop/commit/7d3b74abfa637bbe370ae232b8067e7bc5205ea1))
* **trigger:** auto-expire non-recurring event loops ([178f9fd](https://github.com/bramburn/pi-loop/commit/178f9fd6a6548a04307f3ed83935068a235c24d3))
* use pi.hasPendingMessages() instead of bespoke tracking Set ([dab60d4](https://github.com/bramburn/pi-loop/commit/dab60d46340fab04ae74b80044ad03b6b0ca9fe8))


### Performance Improvements

* **test:** replace real 6.1s waits with fake-timer advance in onDone tests ([c713ad3](https://github.com/bramburn/pi-loop/commit/c713ad36f958d53e75c4c7d7fd723c06ee420543))

## [0.1.2]

- Added `onDone` parameter to `MonitorCreate` — auto-creates a completion loop so the agent is notified when a background process finishes, no polling needed
- Updated tool descriptions and prompt guidelines for the MonitorCreate + LoopCreate pairing



## [0.1.1]

- Migrated peer dependencies from `@mariozechner/pi-*` to `@earendil-works/pi-*`
- Fixed `.npmignore` to include `src/` and `dist/` directories

## [0.1.0] — Initial Release

### Tools

- **LoopCreate** — Create scheduled (cron), event-triggered, or hybrid re-wake loops
- **LoopList** — List all active loops with IDs, triggers, status, and next-fire times
- **LoopDelete** — Delete or pause a loop by ID
- **MonitorCreate** — Start a background command that streams output via `monitor:output` pi events
- **MonitorList** — List monitoring processes and their status
- **MonitorStop** — Stop a running monitor (SIGTERM → 5s → SIGKILL)

### Commands

- **`/loop [interval] [prompt]`** — Interactive TUI loop creation
- **`/loops`** — View, create, cancel, and configure loops

### Features

- Three trigger types: cron (timer), event (eventbus), hybrid (both with debounce)
- File-backed persistence with pid-based file locking and atomic writes
- Cron scheduler with per-loop jitter and 7-day expiry
- Background process monitoring with stdout/stderr streaming
- Persistent TUI widget showing active loops and monitors
- System-reminder injection for loop fires (mirrors pi-tasks pattern)
- Self-paced loop mode for dynamic interval scheduling
- `@tintinweb/pi-tasks` integration with auto-task creation

### Configuration

- `PI_LOOP` env var for store path override / disable
- `PI_LOOP_SCOPE` env var for `memory` | `session` | `project`
- `PI_LOOP_DEBUG` env var for debug logging

### Limits

- Maximum 25 active loops
- Maximum 25 running monitors
