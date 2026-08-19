## Summary

Implements Phase 1 of the sub-agent execution mode for pi-loop (per `docs/PRD/sub-agent.md` §16.2, building on PR #80). v2.5.1 ships the runtime: `/loop-subagent` slash command, child-process spawn + result-store + cost-tracker + scheduler + evaluator, the `LoopInspect` tool, and a priority-queue-aware notification path. TUI FleetView, `/loop-sub-agent-{inspect,stop,cost}` commands, the `pi-subagents` background-work bridge, capability ceiling auto-read, and the LLM-call evaluator are explicitly deferred to v2.5.2.

## What's in this PR

### New code (10 files)

| Path | Role |
|------|------|
| `src/commands/loop-subagent-command.ts` | `/loop-subagent <interval> <prompt> [--goal ...] [--model ...] [--max-tokens N] [--max-iterations N] [--iteration-timeout ms]` |
| `src/migration/v2-to-v2.5.ts` | Idempotent one-shot migration that adds the `subAgent` settings block to existing `pi-loop-settings.json` |
| `src/runtime/loop-validation.ts` | Per-field validators with explicit "k in d" style error messages |
| `src/runtime/sub-agent/index.ts` | `SubAgentRuntime` public surface + `resolveSubAgentScopeRoot` helper |
| `src/runtime/sub-agent/spawn.ts` | Cross-platform `child_process.spawn` with two-stage SIGTERM/SIGKILL wall-clock killer |
| `src/runtime/sub-agent/result-store.ts` | Atomic `result.json` write via tmp+rename, prune, list, read |
| `src/runtime/sub-agent/evaluator.ts` | Regex match against `result.md` for success/failure criteria |
| `src/runtime/sub-agent/cost-tracker.ts` | Per-loop/per-session token/cost ledger with model price table |
| `src/runtime/sub-agent/scheduler.ts` | Gate logic (concurrency / iteration / budget / failure caps) |
| `src/runtime/sub-agent/notification-formatter.ts` | One-line summary, tiered by priority |
| `src/runtime/sub-agent/result-watcher.ts` | In-flight iteration table, exit observation, parent-restart reconciliation |

### Modified code (8 files)

- `src/types.ts` — `LoopIsolation`, `LoopSubAgentConfig`, `SubAgentStatus`, `SubAgentResult`, and 7 new optional fields on `LoopEntry`
- `src/settings.ts` — `SubAgentSettings`, `DEFAULT_SUB_AGENT_SETTINGS`, `asSubAgentSettings()` parser
- `src/store.ts` — extended `create()`, added `updateConfig()`, `accrueCost()`, `incrementFailures()`, `resetFailures()`
- `src/loop-reducer.ts` — `LOOP_CREATED` payload includes the new fields
- `src/reducer-backed-store.ts` — `save()` is now `protected` (was `private`) so `LoopStore` can persist config updates
- `src/commands/settings-command.ts` — added `subAgent` to `KEY_ORDER`/labels/formatValue/nextValue (11th setting)
- `src/tools/loop-tools.ts` — added `isolation`, `goal`, `successCriteria`, `failureCriteria`, `stateFile`, `subAgentModel/MaxTokens/MaxIterations/IterationTimeoutMs` params to `LoopCreate`; added `LoopInspect` tool
- `src/index.ts` — wired up `SubAgentRuntime` into the trigger / scheduler / notification path; re-create on session change; reconcile on startup

### Tests

- 3 new test files: `test/runtime/sub-agent/{scheduler,evaluator,result-store}.test.ts` — 20 tests, all pass
- Updated `test/index.test.ts` (LoopInspect + 11th setting) and `test/settings-command.test.ts`

### Bookkeeping

- `package.json` → 2.5.1
- `CHANGELOG.md` → full 2.5.1 entry

## Key design decisions (recap from the two decision rounds)

- **All new fields are optional** (R2-4): `goal`, `successCriteria`, `failureCriteria`, `stateFile`, `isolation`, `subAgent.*` — the runtime is permissive when they're missing
- **Full tool surface by default**, with the `subagent` tool explicitly denied (R2-2 / recursion guard)
- **No global cost ceiling** (R2-4 / D13): per-loop `subAgent.maxTokens` is the only token gate
- **`/loop-subagent` is a parallel slash command**, not a flag on `/loop` (R2-1)
- **Child process via `child_process.spawn`** — cross-platform, no tmux, parent owns children
- **Fresh session per iteration** — bounds context growth, simple
- **`LoopCreate` flag-form `isolation: "sub-agent"`** is also accepted for programmatic use

## Test plan

CI runs `lint`, `typecheck`, `test`, `build` on every push and on this PR. All four pass:

- **Lint**: `biome check src/ test/` — clean (1 unused-import warning fixed before commit)
- **Typecheck**: `tsc --noEmit` — clean
- **Test**: `vitest run` — 1000 passed, 20 failed (all 20 in pre-existing `test/monitor-manager.test.ts` on Windows due to `process.kill EINVAL`; verified to fail identically on master `db907bb` without these changes; out of scope here, separate fix needed)
- **Build**: `tsc` — clean

`npm run test:all` (which includes `injection.test.ts` and `harness-state-steering.test.ts`) was not run in this PR; those suites are CI-only and orthogonal to the changes.

## Out of scope (deferred to v2.5.2)

- TUI FleetView panel (`loops-sub-agent` belowEditor)
- `/loop-sub-agent-inspect`, `/loop-sub-agent-stop`, `/loop-sub-agent-cost` slash commands (for now: `LoopInspect` tool and `/loop-subagent` only)
- `pi-subagents` background-work provider bridge
- Capability ceiling auto-read
- LLM-call evaluator (regex evaluator is the v2.5.1 default)

The 19 Windows-specific `monitor-manager.test.ts` failures are a pre-existing issue on master, not introduced here.

## Related

- Companion artefacts (PR #80): `docs/PRD/sub-agent.md`, `docs/PRD/sub-agent-specs.xlsx`, `docs/PRD/sub-agent-questions.xlsx`, `docs/PRD/sub-agent-questions-r2.xlsx`
- Round-1 decisions: `docs/PRD/sub-agent-questions.xlsx`
- Round-2 follow-ups: `docs/PRD/sub-agent-questions-r2.xlsx`
- Architectural reference: `research-wt/pi-subagents/` (vendored, not committed)
