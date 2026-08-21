# pi-loop Development Guidelines

## Overview
`pi-loop` is a pi extension providing cron/event-based agent re-wake loops and background process monitoring. Modeled after Claude Code's `/loop`, `CronCreate`, and `MonitorCreate` tools.

In its current v2.1 build, the `Monitor*` tools, `Task*` tools, `/monitors`, `/tasks`, and `workflow-tools` are **unregistered** (per the upstream constraint that this build runs without `pi-monitor`, `pi-tasks`, and `pi-workflow`). The extension entry point still imports them defensively and exports stub callbacks, so re-enabling is a wiring change, not a refactor. The remaining surface — `LoopCreate` / `LoopList` / `LoopUpdate` / `LoopPause` / `LoopResume` / `LoopInspect`, `/loop`, `/loop-resume`, `/loop-settings`, the above-editor widget, and the priority-aware notification queue — is fully functional.

## Stack
- TypeScript 6.x (strict, ES2022 target, bundler module resolution)
- `typebox` for tool parameter validation
- `vitest` for tests
- `biome` for linting (linter: on, formatter: off)
- npm packaging as `@bramburn/pi-loop`

## Architecture
```
src/
├── index.ts              # Extension entry: 4 loop tools + /loop + /loop-resume + widget + /loop-settings
├── types.ts              # LoopKind, Trigger, LoopEntry (with priority), MonitorEntry, Workflow types
├── store.ts              # File-backed CRUD (.pi/loops/loops.json) with file locking
├── scheduler.ts          # Timer-based cron scheduler with jitter + 7-day expiry
├── trigger-system.ts     # Unified trigger engine: cron timers + pi event subscriptions + hybrid
├── monitor-manager.ts    # ChildProcess tracking, output buffering, event emission, stop
├── loop-parse.ts         # Human interval → cron expression, next-fire computation, jitter
├── settings.ts           # v2.0 unified settings + UrgentFlushThresholds (priority queue)
├── migration/            # v1 → v2 migration tooling
│   └── v1-to-v2.ts       # One-shot idempotent migration from tasks-config.json + PI_LOOP_* env vars
├── telemetry/            # Sentry integration (opt-in via SENTRY_DSN)
│   ├── sentry.ts         # initSentry, captureException, addBreadcrumb, log*, scrubPii, wrapToolExecute
│   └── index.ts          # Public re-exports
├── tools/                # Tool registration and tool-visibility gating
│   ├── loop-tools.ts     # LoopCreate (with priority) / LoopList / LoopUpdate / LoopPause / LoopResume / LoopInspect
│   ├── workflow-tools.ts # Workflow state-machine tools (DISABLED in this build)
│   ├── monitor-tools.ts  # MonitorCreate / MonitorList / MonitorStop / MonitorDelete (DISABLED)
│   ├── native-task-tools.ts  # Native task CRUD (DISABLED in this build)
│   └── tool-visibility.ts # syncLoopTools — gates LLM tool set on loop state
├── runtime/              # Long-running behaviour
│   ├── session-runtime.ts    # Session lifecycle hooks + keybindings + crash recovery + heartbeat
│   ├── notification-runtime.ts  # Priority queue + drain-all flush + REQUEST_URGENT_FLUSH dispatch
│   ├── bindings-store.ts     # Per-session loop bindings (multi-terminal isolation)
│   ├── monitor-ondone-runtime.ts  # One-shot monitor:done cleanup
│   ├── native-task-rpc.ts    # Cross-extension task RPC bridge
│   ├── task-rpc.ts           # TaskRuntimeBridge (RPC + native fallback)
│   ├── task-mutations.ts     # createTask / claimTask / heartbeatTask
│   ├── task-backlog-runtime.ts # Auto task worker loop at backlog threshold
│   ├── task-provider-runtime.ts # pi-tasks presence detection
│   ├── task-events.ts        # Native task event emitters
│   ├── scope.ts              # LoopScope resolution (loopScope/taskScope from settings)
│   └── fruit-loops/node-hygiene.ts # DEPRECATED legacy node cleanup
├── commands/             # Slash-command handlers
│   ├── loop-command.ts    # /loop [interval] [prompt] + /loop-resume [id]
│   ├── loop-edit-command.ts # editLoopInteractive() + pickLoopForEdit() reused by /loop's Edit action
│   ├── settings-command.ts # /loop-settings (TUI editor for unified settings + urgentFlushThresholds)
│   ├── tasks-command.ts    # /tasks (DISABLED in this build)
│   └── monitors-command.ts # /monitors (DISABLED in this build)
├── ui/                   # TUI components
│   ├── widget.ts         # LoopWidget — above-editor Component registered via setWidget("loops", ..., {placement:"aboveEditor"})
│   ├── widget-render.ts  # Pure renderWidgetLines(state, theme, width) — clamp + tree
│   ├── overlays.ts       # showLoopListOverlay (Ctrl+Shift+L) — scrollable list, "a" toggles my/all
│   ├── escape-dialog.ts  # showEscapeDialog — 3-option modal (cancel/skip/continue)
│   └── tool-renderer.ts  # renderToolCall / renderToolResult / toolArg / hideToolTranscript
├── rpc/                  # Cross-extension RPC plumbing
│   └── cross-extension-rpc.ts
├── workflow-reducer.ts   # State machine for workflow runs (validate/create/transition)
├── reducer-backed-store.ts # Atomic-write persistence pattern (tmp + rename)
├── notification-reducer.ts # NOTIFICATION_QUEUED coalescing + REQUEST_URGENT_FLUSH priority aging
├── auto-clear.ts         # Auto-clear completed native tasks
├── api.ts                # Public API surface (cross-extension consumers)
├── coordinator.ts        # Generic reducer+effects coordinator used by notification runtime
├── loop-format.ts        # Trigger / workflow / transition formatting helpers
├── loop-reducer.ts       # LOOP_CREATED + LOOP_PAUSED + LOOP_DELETED + LOOP_DYNAMIC_UPDATED
├── task-reducer.ts       # Task reducer (native task fallback)
├── task-store.ts         # TaskStore (file-backed CRUD)
├── task-types.ts         # TaskEntry / TaskStatus types
├── notification-coordinator.test.ts (test) # coordinator contract test
└── docs/plan/            # Architecture decision records (ADRs)
    ├── ADR-001-widget-key-naming.md
    ├── ADR-002-tool-visibility-call-site.md
    ├── ADR-003-settings-file-schema.md
    ├── ADR-004-overlay-keybindings.md
    └── ADR-005-priority-queue.md
```

## Conventions (mirror pi-tasks)
- No comments unless answering "why", never "what"
- `debug(...)` helper gated on `settings.debug` (configured via `/loop-settings`); logs to stderr
- `textResult(msg)` helper for uniform tool output
- All tool params use `Type.Object()` with description strings
- Tool descriptions follow Claude Code format: `## When to Use`, `## When NOT to Use`
- Cross-extension communication via `pi.events` with `requestId` + reply channels
- File-backed stores use atomic write (write tmp → rename) + pid-based file locking
- The above-editor widget is registered with `ctx.ui.setWidget(KEY, factory, {placement: "aboveEditor"})` and re-rendered via `tui.requestRender()`. Never re-register the factory on every update — that defeats the TUI's dirty model.
- Tests co-located in `test/`, named `<module>.test.ts`

## v2.0 Configuration (Unified Settings File)

**All runtime configuration lives in `.pi/pi-loop-settings.json`** with a strict JSON schema (unknown keys cause a startup error). The v1.x scattered config — `.pi/tasks-config.json` plus `PI_LOOP_SCOPE` / `PI_LOOP` / `PI_LOOP_DEBUG` / `PI_LOOP_TASK_THRESHOLD` / `PI_LOOP_TASK_WORKER_THRESHOLD` env vars — is captured once on first v2 startup by `src/migration/v1-to-v2.ts` and never read at runtime again. Edit via `/loop-settings`.

Schema (all fields required, defaults from `DEFAULT_SETTINGS` in `src/settings.ts`):

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `loopScope` | `"memory" \| "session" \| "project"` | `"project"` | Where loop state is persisted |
| `taskScope` | `"memory" \| "session" \| "project"` | `"session"` | Where task state is persisted |
| `debug` | `boolean` | `false` | Verbose stderr logging |
| `autoClear` | `"never" \| "on_list_complete" \| "on_task_complete"` | `"on_list_complete"` | When completed tasks are swept |
| `sortOrder` | `"id" \| "status" \| "recent" \| "oldest"` | `"id"` | Task list order |
| `hiddenAt` | `"top" \| "bottom"` | `"bottom"` | Where completed tasks fold in the widget |
| `maxVisible` | integer ≥ 1 | `10` | Max tasks shown in widget |
| `showAll` | `boolean` | `false` | Show all tasks regardless of `maxVisible` |
| `taskThreshold` | integer ≥ 1 | `5` | Backlog-worker loop auto-creation threshold |
| `urgentFlushThresholds` | `UrgentFlushThresholds` | `{defer:86400000, normal:300000, urgent:30000, critical:0}` | Priority-aging thresholds (ADR-005) |

## Priority Queue (ADR-005)

Each `LoopEntry` carries an optional `priority: "defer" | "normal" | "urgent" | "critical"` (default `"normal"`). Loop fires produce `ReducerNotification` entries that carry `fireCount`, `firstFireAt`, `lastFireAt`, and `priority` metadata. Two delivery paths exist:

- **`REQUEST_URGENT_FLUSH`** (heartbeat, every 30s in `session-runtime.ts`): force-delivers by priority (critical → urgent → normal), skipping `defer` and items whose age is below their per-priority threshold.
- **`NOTIFICATION_FLUSH_REQUESTED`** (normal idle flush, e.g. on `agent_end`): drains the queue end-to-end via the empty-queue guard at the top of `flushPendingNotifications`. Defer-priority items are skipped when any non-defer item is queued, so defer is shielded from priority inversion on both flush paths.

The heartbeat pump in `session-runtime.ts` calls `notificationRuntime.dispatchUrgentFlush()` alongside `pumpLoops()`. Both run on every 30s tick. `urgentFlushThresholds` controls the age at which each priority level is force-delivered. `deliverNotification` does **not** mutate `agentRunning` — that state is owned strictly by the `agent_start` / `agent_end` hooks; setting it during delivery would block the drain loop.

`cleanDoneTasks` emits `tasks:rpc:clean` with a unique requestId when an `autoTask` wake is dropped because `hasPendingTasks() === 0`. This is part of the public RPC contract even when the native task system is disabled (the broadcast is harmless with no listener).

## /loop-settings TUI limitation

The cyclic TUI editor only rotates the `defer` threshold (1h → 24h → 7d). The other three thresholds (`critical`, `urgent`, `normal`) are advanced tuning knobs expected to be set via direct JSON editing of `.pi/pi-loop-settings.json`. This is intentional: `critical` should almost always stay at `0`, and exposing a naive cycle UI for `urgent`/`normal` invites accidental misconfiguration.

## Loop Persistence Scope

`settings.loopScope` controls where loops and native fallback tasks are stored. The default is **`project`** so loops persist across chat sessions and survive process restarts, mirroring pi-goal-x's `.pi/goals/` pattern.

| Scope | Location (relative to cwd) | Survives session switch? | Survives process restart? |
|-------|----------------------------|--------------------------|---------------------------|
| `project` (default) | `.pi/loops/loops.json`, `.pi/tasks/tasks.json` | yes | yes |
| `session` | `.pi/loops/loops-<sessionId>.json`, `.pi/tasks/tasks-<sessionId>.json` | no | no |
| `memory` | in-process only | no | no |

Change scope via `/loop-settings` (no env var override). For per-session isolation across concurrent worktrees, use `session`; for disposable scratch work, use `memory`.

After a process restart in project scope, cron loops re-arm automatically via the 30s heartbeat pump in `session-runtime.ts`. **Event/hybrid trigger subscriptions do NOT auto-re-arm** — call `/loop-resume <id>` to re-bind them. The resume path is idempotent: it re-arms the trigger whether or not the stored loop is paused.

## LoopDelete was removed

There is no `LoopDelete` tool. Deletion is a **user-driven action**; trigger it from the `/loop` command's View-loops menu (`x Delete`), or from internal code paths (e.g. taskBacklog queue-drain auto-deletion) that call `LoopStore.delete` directly. The LLM has no way to delete a loop — it can only pause, resume, update, or ask the user to delete via `/loop`.

If you need to re-introduce a deletion tool in the future, do **not** expose it to the LLM. The LLM lacks the "user explicitly authorized this" signal that deletion requires.

## Tool Schema Discipline
- Tool calls must use the exact schema field names from the tool definition. Do not invent aliases.
- Example: `TaskUpdate` uses `id`, not `taskId`.
- When a tool validation error clearly indicates an immediately recoverable schema mismatch, correct it silently and retry. Do not emit user-facing chatter like "retrying with the correct shape" unless the recovery itself changes the user's understanding.
- When adding or revising tool prompt guidance, include concrete parameter-name reminders for commonly miscalled tools.

## File Locking Pattern
Copy TaskStore from pi-tasks: `O_EXCL` lockfile, stale PID detection, `LOCK_RETRY_MS`/`LOCK_MAX_RETRIES`

## Loop Persistence Scope
`settings.loopScope` controls where loops and native fallback tasks are stored. The default is **`project`** so loops persist across chat sessions and survive process restarts, mirroring pi-goal-x's `.pi/goals/` pattern.

| Scope | Location (relative to cwd) | Survives session switch? | Survives process restart? |
|-------|----------------------------|--------------------------|---------------------------|
| `project` (default) | `.pi/loops/loops.json`, `.pi/tasks/tasks.json` | yes | yes |
| `session` | `.pi/loops/loops-<sessionId>.json`, `.pi/tasks/tasks-<sessionId>.json` | no | no |
| `memory` | in-process only | no | no |

Use `/loop-settings` to change scope. There is no env-var override in v2.0.

After a process restart in project scope, cron loops re-arm automatically via the 30s heartbeat pump in `session-runtime.ts`. **Event/hybrid trigger subscriptions do NOT auto-re-arm** — call `/loop-resume <id>` to re-bind them. The resume path is idempotent: it re-arms the trigger whether or not the stored loop is paused.

## Per-Session Loop Bindings

Multiple pi terminals in the same repo each pick a disjoint subset of stored loops to arm, so parallel agents can split work without one terminal firing another terminal's loops. The mechanism is a per-session bindings file at `<cwd>/.pi/loops/bindings-<sessionId>.json` containing `{ "loopIds": ["1","3","7"] }`. Each session owns its own file (no contention with other terminals).

- **Fresh-session default is strict isolation**: if the bindings file does not exist on first start, the session arms **zero** loops and emits a one-time notify: `'No bindings for this session — run /loop-resume to choose which loops this terminal arms.'`. This is a deliberate behavior change — the extension no longer auto-arms every active loop in the project store on session start.
- **`/loop-resume <id>` (one-shot)**: re-arms the loop and writes the id into the bindings file in a single call.
- **`/loop-resume` (no args)** opens a simple picker: every stored loop is shown as `* #N [status] prompt (trigger)`. Selecting a row re-arms that loop; `< Back` exits without changing anything.
- **Concurrent-session invariant**: two terminals in the same repo write only their own bindings files; the shared `.pi/loops/loops.json` registry is read by all sessions and written through the existing `LoopStore.withLock`. Trigger subscriptions are process-local — terminal A's `triggerSystem.add(#5)` does NOT cause terminal B to fire `#5`.

Implementation: `src/runtime/bindings-store.ts` (BindingsStore class), `src/runtime/scope.ts` (`resolveBindingsPath`), `src/runtime/session-runtime.ts` (`showPersistedLoops` filters arm-list by bindings), `src/commands/loop-command.ts` (simple picker + bindings-aware one-shot).
## Trigger Types
Three trigger types, all stored as `LoopEntry.trigger`:
- `{ type: "cron", schedule: "*/5 * * * *" }` — timer-based
- `{ type: "event", source: "tool_execution_start", filter?: "regex:..." | '{"key":"value"}' }` — eventbus-based
- `{ type: "hybrid", cron: "...", event: { source, filter? }, debounceMs: 30000 }` — both with debounce

All cron/hybrid loops are dynamic: they track their next fire time but only deliver on agent idle (`agent_end`/`turn_start`) rather than wall-clock timers.

## Re-wake via In-Memory Pending Notifications
When a loop fires, the scheduler calls `onLoopFire()` which emits `pi.events("loop:fire", ...)`. The extension buffers a pending notification in memory, re-checks whether the wake is still relevant, and only then injects a `pi.sendMessage()` custom message to wake the agent. Do not rely on early queued follow-up user messages for loop delivery; those are not extension-cancelable once handed to pi's queue.

All loops are idle-driven. Cron and hybrid loops track their next fire time but only deliver when the agent becomes idle (via `agent_end`/`turn_start`), resetting their timer from the actual delivery point.

## Monitor Streaming via PI Events
Monitor stdout/stderr lines are emitted as `pi.events("monitor:output", { monitorId, line, timestamp })`. Tool consumers subscribe to these events. Completion emits `"monitor:done"` / `"monitor:error"`.

## pi-tasks Integration
When `@tintinweb/pi-tasks` is present, `LoopCreate` with `autoTask: true` fires an RPC to create a task. Communication via `pi.events`:
- `tasks:rpc:ping` on init → detect pi-tasks presence
- `tasks:ready` listener → late-binding detection
- `tasks:rpc:create` → auto-create task when loop fires (if `autoTask: true`)

## /loop Self-Paced Mode
When no interval is specified in `/loop prompt`, the loop runs in self-paced mode. The agent receives the prompt, acts on it, and uses `LoopCreate`/`LoopUpdate` to schedule the next iteration. The loop fires once, then the agent decides the next interval dynamically (matching Claude Code's dynamic interval behavior).

## /loop Edit Action

Edit is integrated into the `/loop` View loops menu, not exposed as a separate command. From `/loop` → View loops, each loop's actions menu now shows `Edit`, `- Pause` (or `* Resume`), `x Delete`, and `< Back`. Selecting `Edit` runs the same cyclic field form (`prompt`, `trigger`, `priority`, `recurring`, `maxFires`, `readOnly`, `autoTask`) previously exposed by the standalone `/loop-edit` command. `Save & Exit` persists via `LoopStore.updateMetadata` (extended to accept all editable fields, with structural `triggerEquals` to avoid spurious re-arms). If `trigger` is in `changedFields` AND the loop is active, the trigger is removed and re-added so the new schedule/event source takes effect immediately. Paused loops persist-only — they are not re-armed. `maxFires` clearing uses `LoopStore.clearMaxFires` (TS erases `undefined` keys in `updateMetadata`). The shared edit logic lives in `src/commands/loop-edit-command.ts` (exports `editLoopInteractive` and `pickLoopForEdit`); `loop-command.ts` calls them from the per-loop actions menu.

## Testing
- `vitest` with `describe`/`it` blocks
- In-memory stores for unit tests, `tmpdir` for file-backed tests
- Fake timers (`vi.useFakeTimers`) for scheduler tests
- Mock pi eventbus for monitor-manager tests
- `vitest run` in CI, `vitest` for watch mode

## Limits
- Maximum 25 active loops
- Maximum 25 running monitors
- 7-day expiry on recurring loops
- 5-minute default cron interval for self-paced mode

## Telemetry (Sentry)

Crash analytics is **opt-in**. End users set `SENTRY_DSN` to enable; without it, every callsite in `src/telemetry/sentry.ts` is a no-op (verified by `test/telemetry/sentry.test.ts`).

**Public API (from `src/telemetry/index.ts`):**

| Function | Purpose | Notes |
|---|---|---|
| `initSentry(opts)` | Boot Sentry with PII scrubbing, capture logs, install process handlers | Returns `false` if `SENTRY_DSN` unset |
| `captureException(err, ctx?)` | Forward an error to Sentry | No-op when not initialized |
| `addBreadcrumb(msg, data?)` | Emit a structured breadcrumb | No-op when not initialized |
| `logInfo / logDebug / logWarn / logError` | Pipe structured logs via Sentry's `logger` | No-op when not initialized |
| `flushSentry(timeoutMs?)` | Flush buffered events (e.g. on shutdown) | No-op when not initialized |
| `wrapToolExecute(name, fn)` | Wrap a tool's `execute` with parallel-storm guard + breadcrumb + capture + rethrow | Used at the `pi.registerTool` boundary in `src/index.ts` |
| `recordParallelCall(name)` / `checkParallelStorm(name)` / `resetParallelGuard()` | Per-tool sliding-window call counter (2 calls / 1s) | Throws on the 3rd call to prevent TUI freeze |
| `scrubPii(input)` | Recursive PII redactor (paths, env, DSN, sensitive keys) | Used by `beforeSend` / `beforeBreadcrumb` / `beforeSendLog` |

**PII scrubbing rules** (in `scrubPii`):
- Strip `C:\...` and `/Users|...`, `/home|...`, `/root|...` paths from strings
- Strip `process.env.*` references
- Strip Sentry DSN URLs (`https://<key>@<org>.ingest.<region>.sentry.io/<id>`)
- Redact values under keys: `prompt`, `message`, `text`, `body`, `content`, `description`
- Redact `filename` and `abs_path` fields in stack frames

**Env vars (full list in `.env.example`):** `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_DEBUG`, `SENTRY_CAPTURE_LOGS`.

**Out of scope:** source-map upload via auth tokens, server-side PII rules (rely on Sentry's defaults), CI-side secret wiring (no production deploy of this package).

## Git Branching & Pull Request Protocol

> **Rule #1 — `master` is off-limits.** Direct commits and pushes to `master` are strictly prohibited. Every change must enter via pull request.

### 1. Branching Strategy

Before starting any task, always start from an up-to-date `master`:

```bash
git checkout master && git pull origin master
```

Create a new dedicated branch with a descriptive name using the appropriate prefix:

| Prefix | Use for |
|--------|---------|
| `feat/<feature-name>` | New features and enhancements |
| `fix/<issue-name>` | Bug fixes |
| `refactor/<target-name>` | Refactoring without behaviour change |
| `docs/<update-name>` | Documentation-only changes |

```bash
git checkout -b feat/my-new-feature
```

### 2. Commit Standards

- Make **focused, atomic commits** — one logical change per commit.
- Write clear, concise commit messages following [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short summary>

[optional body — explain WHY, not WHAT]

[optional footer — issue #N, BREAKING CHANGE]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`

**Examples:**

```
feat: add user authentication flow
fix: resolve ENOENT on Windows subprocess spawn
docs: update AGENTS.md with branching protocol
chore: remove stale wt-subagent-runtime worktree reference
```

### 3. Pull Request & Publishing Workflow

When the work is ready for review:

1. **Push the branch** to the remote:
   ```bash
   git push -u origin feat/my-new-feature
   ```

2. **Open a pull request** against `master` using the GitHub CLI:
   ```bash
   gh pr create --base master --title "feat: add user authentication flow"
   ```

   The PR body **must** include:
   - **Summary of changes** — what does this PR do?
   - **Motivation / Context** — why is this change needed?
   - **Verification / Testing** — how was it tested? Steps to reproduce the fix or verify the feature.

3. **Request review** from at least one maintainer. Address feedback on the branch.

4. **Merge** the PR once approved. Use the merge commit strategy:
   ```bash
   gh pr merge <N> --merge --delete-branch
   ```

### 4. Housekeeping

- **Never force-push** (`git push --force`) to shared branches — it rewrites history and breaks teammates' local state.
- **After a PR is merged**, clean up your local branch:
  ```bash
  git checkout master && git pull origin master && git branch -d feat/my-new-feature
  ```

### 5. Release Flow (special case)

For releasing a new npm version, the release branch naming convention is `release/<version>` (e.g. `release/2.6.4`). Follow the full release checklist in the **Publishing to npm** section below.

### What NOT to do

- **Do not `git push` directly to `master`** — the branch is protected; the push will be rejected.
- **Do not force-push to shared branches** — it breaks history for everyone.
- **Do not push a tag without first merging the release commit to `master`** — CI picks up the tag and the branch tip; a tag on a non-merged commit publishes a version that doesn't match `master`. Since `master` is protected, the commit must arrive via PR merge first.
- **Do not run `npm publish` locally** — it conflicts with the CI OIDC trusted publisher (403 on re-publish; risk of publishing without provenance if a stale `NODE_AUTH_TOKEN` is present).

## Publishing to npm

The repo has a CI publish workflow at `.github/workflows/publish.yml` that auto-publishes to npm on every `v*.*.*` tag push using **OIDC Trusted Publishing** — no `NPM_TOKEN` secret is required. The OIDC token issued by GitHub Actions is exchanged for a short-lived npm token by the registry at publish time. The trusted-publisher config (set on https://www.npmjs.com) binds the workflow file name and the `environment` to the repo:

- Workflow file: `publish.yml`
- Environment: `npm-publish`
- Permissions: `id-token: write` + `environment: npm-publish` on the job

### Release flow (npx version bump)

1. **Bump version** in `package.json` (semver: `major.minor.patch`).
2. **Update `CHANGELOG.md`** with a new entry above the current top entry. Reference the PRs that landed since the last release.
3. **Commit on a release branch** off `master` (e.g. `release/2.1.1`) with a descriptive message.
4. **Push the branch** and **open a PR** against `master`.
5. **Merge the PR** with `gh pr merge <N> --merge --delete-branch` (the `--delete-branch` flag cleans up the remote branch).
6. **Tag the merged commit** on master: `git tag -a v<version> -m "v<version>: <summary>"` and `git push origin v<version>`.
7. **CI takes over**: the `publish.yml` workflow runs `npm ci`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, then `npm publish --provenance --access public`. The OIDC token issued by GitHub Actions is exchanged for a short-lived npm token via the `npm-publish` environment — no `NPM_TOKEN` secret is required and no OTP is needed. The publish step sets `NPM_CONFIG_PROVENANCE=true` so the tarball carries an SLSA provenance attestation signed by the OIDC identity.
8. **Verify**: `npm view @bramburn/pi-loop` shows the new version as `latest`.

### Package contents — `package.json` `files` whitelist

The package MUST declare a `files` whitelist in `package.json`. Without it, `npm publish` includes the entire cwd (excluding `.gitignore`/`.npmignore` entries, but those do not exclude the `wt/` worktree directory by default). One accidental publish shipped 18.5 MB of `wt/` content when the intended payload was ~1.6 MB.

The current whitelist is:
```json
{
  "files": [
    "dist",
    "src",
    "docs",
    "userflow",
    "README.md",
    "CHANGELOG.md",
    "LICENSE"
  ]
}
```

`src/` is included because `pi.extensions` points to `./src/index.ts` (TypeScript source is loaded directly by the pi runtime). `dist/` is included for any consumer that prefers the compiled output. `wt/`, `test/`, `node_modules/`, `.github/`, `coverage/` are all excluded.

## Research workspace — `research-wt/`

`research-wt/` is a vendor-style clone workspace for read-only upstream research. It is **ignored by `.gitignore`** (never committed; the inner `.git` is treated as a vendored dependency, not as a submodule).

| Subfolder | Source | Purpose |
|-----------|--------|---------|
| `research-wt/pi-subagents/` | https://github.com/nicobailon/pi-subagents (cloned) | Reference implementation for child-agent delegation, async/background run lifecycle, mission records, schedules, FleetView, and the `background-work` provider contract. Used as the primary architectural reference for the in-flight sub-agent PRD (see `docs/PRD/sub-agent.md`). |

Conventions for the research workspace:

- **Read-only by intent.** Do not edit, format, lint, or commit anything under `research-wt/`. If the upstream is useful, port the idea into `src/` and write a fresh test.
- **Re-clone, don't rebase.** If the vendored copy drifts, delete the folder and `git clone` again. Never `git pull` inside `research-wt/pi-subagents/`.
- **Citation in the PRD.** When porting a pattern, cite the source file path in `research-wt/pi-subagents/...` next to the ported snippet in `docs/PRD/`.
- **Update before reusing.** If `research-wt/` predates a meaningful upstream release, re-clone before drafting a new PRD that depends on it.

### Local sanity check before tagging

`npm run lint && npm run typecheck && npm test && npm run build` mirrors the CI pipeline. The full test suite (`npm run test:all`) includes `injection.test.ts` and `harness-state-steering.test.ts` which `npm test` excludes — run the full suite before tagging to catch integration regressions. Verify `npm pack --dry-run` shows the expected file count (currently ~228) and size (~1.6 MB unpacked) before pushing the tag.

### What NOT to do (Publishing)

- **Do not skip the `files` whitelist.** Without it, `wt/` (27 MB of worktrees) ends up in the published tarball. See the whitelist above.
