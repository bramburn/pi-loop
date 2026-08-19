<p align="center">
<h1 align="center">@bramburn/pi-loop</h1>
<h6 align="center">Cron and event loops for the pi coding agent. Scheduled re-wakes, idle-driven dynamic goal loops, event-triggered agents, and per-session bindings.</h6>
</p>

## Install

```bash
pi install npm:@bramburn/pi-loop
```

## Quick start

```text
LoopCreate trigger="5m" prompt="Check if the build passed"
LoopCreate trigger="tool_execution_start" prompt="Log the tool being used" triggerType="event"
LoopList
/loop           (then "View loops" → "x Delete" to delete a loop)
```

## Widget (v2.0)

pi-loop renders an above-editor widget showing every loop, monitor, and task at a glance:

```
  pi-loop · 3 loops · 1 monitor · 3 tasks
    ├─ * #1 [active] check deploy status (cron: */5 * * * *) → firing (2s ago)
    ├─ * #2 [active] tail logs (event: tool_execution_start)
    ├─ * #3 [active] weekly report (cron: 0 9 * * 1 · auto-task)
    ├─ > #5 [running] npm test --watch (42 lines, 3m)
  └─ 3 tasks: active: wire validator into tests
```

Render snapshots (text-based, generated from `renderWidgetLines`):

- [`docs/screenshots/widget-default-80-width-80.txt`](docs/screenshots/widget-default-80-width-80.txt) — 80-column terminal
- [`docs/screenshots/widget-wide-120-width-120.txt`](docs/screenshots/widget-wide-120-width-120.txt) — 120-column terminal
- [`docs/screenshots/widget-narrow-50-width-50.txt`](docs/screenshots/widget-narrow-50-width-50.txt) — width-safety net (clamped to 50 cols)

When a loop fires, the row shows `→ firing (Ns ago)` for 5 seconds, refreshing every second. Press `Ctrl+Shift+L` for a scrollable loop list overlay. Press `Escape` during a long-running fire to skip or cancel.

## Commands

`/loop [interval] [prompt]` — interactive loop creation.

```text
/loop                         # menu
/loop 5m check the deploy     # 5-minute cron loop
```

`/loop-resume <id>` — re-arm a stored loop by ID and re-add it to the trigger system. Use this after a session/process restart when a stored event/hybrid loop's trigger subscription was lost. Idempotent: re-arming an already-active loop just refreshes the trigger.

`/loop-settings` — open the unified settings TUI editor (loopScope, taskScope, debug, autoClear, sortOrder, hiddenAt, maxVisible, showAll, taskThreshold). Includes a `Shared loops` sub-screen for promoting loops to the cross-repo shared store and adopting shared loops into the current project.

```text
/loop-resume 5        # re-arm loop #5 by id
/loop-resume          # open a single-select picker of all stored loops
```

`/loop-resume` (no args) — open a simple picker listing every stored loop as `* #N [status] prompt (trigger)`. Pick a row to re-arm it, or `< Back` to exit without changing anything. Each terminal reads and writes its own `.pi/loops/bindings-<sessionId>.json` so parallel sessions do not interfere.

`/loop-fire [id]` — fire a stored loop's `prompt` as a fresh user message into the chat. Use it to manually trigger a loop's prompt out-of-band without waiting for its trigger to fire. No args opens a picker over all stored loops (active and paused); with an id, that loop fires directly. Sends `entry.prompt` only (no `[pi-loop]` wrapper, no `loop:fire` event, no `fireCount` bump). When the agent is idle, the message triggers a turn immediately; when the agent is busy, the message is queued with `deliverAs: "followUp"`.

```text
/loop-fire            # picker over all stored loops
/loop-fire 5          # fire loop #5's prompt directly
```

`/loop-subagent <interval> <prompt> [flags]` — create a [sub-agent loop](#sub-agent-execution-mode-v25). Each fire spawns a fresh child pi process with its own context window; the parent only sees a one-line summary.

```text
/loop-subagent 30m "check upstream pi-loop releases" \
  --goal "find a release newer than 2.5.0 and report the diff" \
  --success-criteria "found a newer release" \
  --failure-criteria "404 or network error" \
  --max-tokens 50000 --max-iterations 5

# Optional flags: --goal, --success-criteria, --failure-criteria,
#                 --state-file, --model, --max-tokens, --max-iterations,
#                 --iteration-timeout
```

## Tools

| Tool | What it does |
|---|---|
| `LoopCreate` | Schedule a prompt on a cron timer, a pi event, or both with debounce |
| `LoopUpdate` | Update progress for a dynamic goal loop (self-paced mode) |
| `LoopList` | Show active loops with IDs, triggers, and next-fire times |
| `LoopPause` | Pause a loop without removing it (preserves history, trigger, ID) |
| `LoopResume` | Resume a paused loop (re-adds the trigger; does not touch session bindings) |
| `LoopInspect` | Read the latest iteration summary (status, tokens, cost, preview) for a loop — used by the agent to read its own sub-agent runs without opening files |

> **Note:** Loop deletion is intentionally **not** an LLM-callable tool. Use `/loop` → View loops → `x Delete` to delete a loop. The LLM can pause, resume, and update loops, but only the user can delete.
| `MonitorCreate` | _(retired — see [Retired tools](#retired-tools))_ |
| `MonitorList` | _(retired)_ |
| `MonitorStop` | _(retired)_ |
| `TaskCreate` | _(retired — see [Retired tools](#retired-tools))_ |
| `TaskList` | _(retired)_ |
| `TaskUpdate` | _(retired)_ |
| `TaskDelete` | _(retired)_ |

Trigger types: `cron` (`5m`, `1h`, `0 9 * * 1-5`), `event` (any pi event source), or `hybrid` (both, debounced).

## Tasks

### With `pi-tasks`

Works with [@tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks). Pass `autoTask: true` on `LoopCreate` and each loop fire auto-creates a tracked task. Detection happens over pi's event bus — no manual wiring.

### Without `pi-tasks`

If `pi-tasks` does not respond during startup detection, `pi-loop` registers a native fallback task system for the session:

- session- or project-scoped task files under `.pi/tasks/` per `settings.taskScope`
- `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskDelete`
- `/tasks` interactive viewer
- above-editor widget task tracking (replaces the v1.x status-line task summary)


This fallback is session-sticky: `pi-loop` decides once at startup whether `pi-tasks` or native tasks own task management for that session.

## Sub-agent execution mode (v2.5)

When a loop's `isolation` is set to `"sub-agent"`, each fire spawns a **fresh child pi process** with its own context window, runs the prompt in isolation, and returns only a one-line summary to the parent. This is the right shape when a recurring check is too long, too noisy, or too stateful to share the parent's context.

Use it for: upstream monitoring, periodic refactors, scheduled test runs with result evaluation, any "run a task and tell me one line" loop where the parent should not see the full transcript.

### Quick start

```text
/loop-subagent 30m "check upstream pi-loop releases" \
  --goal "find a release newer than 2.5.0 and report the diff" \
  --success-criteria "found a newer release" \
  --failure-criteria "404 or network error" \
  --max-tokens 50000 --max-iterations 5
```

The child writes its session file, stdout/stderr, and a `result.md` to `<loopScope>/sub-agent-results/<loopId>/iter-<N>/`. The parent loop entry accumulates `cumulativeTokens` and `cumulativeCostUsd` across iterations and is auto-paused after 3 consecutive failures.

### What the parent sees

Each fire returns a single tiered line such as:

```text
[pi-loop sub-agent] #3 iter-7 SUCCESS · "found 2.5.3, 2 new commits, 1 breaking" · 12,348 tok · $0.018
```

Use `LoopInspect({ loopId, iterId? })` to read the structured summary (status, tokens, cost, preview, error). For the full `result.md` and the child's session file, the inspector returns the on-disk paths so the agent can open them directly.

### How it differs from a regular loop

| | In-process loop (`isolation: "in-process"`) | Sub-agent loop (`isolation: "sub-agent"`) |
|---|---|---|
| Where it runs | Parent's turn | Fresh child `pi` process |
| Context cost per fire | Full turn + tool calls in parent context | One summary line in parent context |
| Per-iteration artefacts | `entry.dynamic.state` in `.pi/loops/` | `<loopScope>/sub-agent-results/<id>/iter-N/` (session file, `result.md`, stdout/stderr) |
| Cost / token tracking | None | Per-iteration + cumulative on the loop entry |
| Self-evaluation | `LoopUpdate({ status, state, metrics, doneCriteria })` | Regex match against `result.md` (success / failure criteria) |
| Failure handling | `maxFires` budget | Auto-pause after 3 consecutive failures |

### Fields

| `LoopCreate` / `LoopUpdate` field | Effect |
|---|---|
| `isolation` | `"in-process"` (default) or `"sub-agent"` |
| `goal` | Long-form description of the loop's purpose (helps the child stay on-task) |
| `successCriteria` | Regex matched against `result.md`; fires match → `SUCCEEDED` |
| `failureCriteria` | Regex matched against `result.md`; fires match → `FAILED` (wins over success) |
| `stateFile` | Optional path the child reads/writes across iterations |
| `subAgent.model` | Per-loop model override |
| `subAgent.maxTokens` | Hard cap on tokens per iteration |
| `subAgent.maxIterations` | Hard cap on iterations before the loop is auto-paused |
| `subAgent.iterationTimeoutMs` | Per-iteration wall-clock cap (default from settings) |

Session-wide defaults live under the `subAgent` block in `.pi/pi-loop-settings.json` (see [Configuration](#configuration)).

### Restart safety

Sub-agent iterations are **durable on disk**. After a parent restart, `result-watcher` walks the on-disk result directories and finalises any in-flight iterations as `orphaned` so the next scheduler tick can proceed without losing state.

## Status line

`pi-loop` keeps a compact persistent status line in the TUI.

When active work exists, it shows a single focus-friendly line such as:

```text
1 loop · 1 monitor
2 tasks | active: Fix deploy polling
1 loop · 2 monitors · 3 tasks | next: Update README
```

When no loops, monitors, or native tasks are active, the status line clears completely.

Only task counts and the single active/next task are shown there so attention stays on what is currently happening. Use `LoopList`, `MonitorList`, and `/tasks` for detail.

## Configuration

**All configuration lives in `.pi/pi-loop-settings.json`** — see `userflow/settings-v2.md` for the full schema and migration guide. The v2.0 release removes the v1.x `PI_LOOP_*` environment variables (see `CHANGELOG.md` for the clean break). To change `loopScope`, `taskScope`, debug logging, auto-clear behaviour, sort order, or backlog threshold, run `/loop-settings` (no environment variables needed).

### `subAgent` block (v2.5+, sub-agent execution mode)

Session-wide defaults for [sub-agent loops](#sub-agent-execution-mode-v25). Edit the JSON directly (the cyclic TUI editor shows the block as a read-only summary).

| Field | Effect | Default |
|---|---|---|
| `defaultIsolation` | Default `isolation` for loops created without an explicit value | `"in-process"` |
| `activeIterationsMax` | Concurrency cap (in-flight sub-agent iterations in this session) | `4` |
| `defaultIterationTimeoutMs` | Per-iteration wall-clock cap when a loop doesn't override | `600000` (10 min) |
| `defaultIterationTokenBudget` | Default per-iteration soft token budget (`{ in, out }` in tokens) | `{ in: 30000, out: 6000 }` |
| `piBinary` | Path / name of the `pi` binary the child process spawns | `"pi"` |
| `envOverrides` | Extra env vars to inject into every child | `{}` |
| `registerBackgroundWorkProvider` | Register the runtime as a background-work provider on the host | `true` |
| `honorCapabilityCeiling` | If true, the child inherits the parent's capability ceiling | `true` |
| `criticalInterruptsAll` | If true, a `critical`-priority fire can preempt in-flight iterations | `false` |
| `showCostInStatusLine` | Show accumulated sub-agent cost in the widget status line | `true` |
| `useLlmEvaluator` | Use the LLM-evaluator (in addition to the regex evaluator) when a `result.md` is present | `false` |

A one-shot migration (`src/migration/v2-to-v2.5.ts`) inserts the default `subAgent` block into existing settings files on first v2.5+ load — idempotent.

| Sentry | Effect | Default |
|---|---|---|
| `SENTRY_DSN` | Enable anonymous crash + log reporting (Sentry). Set to your project DSN to opt in. | unset → telemetry disabled |
| `SENTRY_ENVIRONMENT` | Environment tag for events (e.g. `production`, `development`) | `development` |
| `SENTRY_TRACES_SAMPLE_RATE` | Performance transaction sample rate (`0.0`–`1.0`) | `0.1` |
| `SENTRY_CAPTURE_LOGS` | Pipe `debug()` output into Sentry logs | `true` |
| `SENTRY_DEBUG` | Verbose Sentry SDK debug logging to stderr | `false` |

In `project` scope (default), loop and task files are saved to `.pi/loops/loops.json` and `.pi/tasks/tasks.json` so they survive across chat sessions and process restarts in the same repository — mirroring pi-goal-x's `.pi/goals/` pattern. In `memory` scope nothing persists to disk.

### Recommended scope policy

`loopScope: project` is the default and best balance for normal use.

- `project` is the default: loops and tasks persist across sessions and process restarts in the same repo, so a 5m cron loop survives closing and reopening pi.
- `session` is best when you want each pi session isolated (e.g. concurrent worktrees, throwaway explorations). Loops disappear when the session ID changes.
- `memory` is best for disposable scratch work, tests, or situations where you explicitly do not want any persisted loop/task state.

### Re-arming loops after a restart

Cron loops re-arm themselves automatically **only if they are bound to this session** (see Per-Session Bindings below). Event/hybrid loops do **not** auto-re-arm their trigger subscriptions — use `/loop-resume <id>` to re-bind them.

### Per-session bindings (multi-terminal parallelism)

If you run two or three pi terminals in the same repo and want each one to fire a different subset of loops, use the bindings mechanism:

- Each terminal has its own `.pi/loops/bindings-<sessionId>.json` file listing the loop IDs it has chosen to arm.
- A fresh session (no bindings file yet) starts with **zero** loops armed (strict isolation). Run `/loop-resume <id>` to bind loops for this terminal.
- Terminal A binding loop #5 does **not** cause Terminal B to fire #5, because each session reads only its own bindings file and its trigger subscriptions are process-local.

This is a deliberate behavior change from previous versions, where every session armed every active loop on start.



## Crash analytics (opt-in)

`pi-loop` integrates with [Sentry](https://sentry.io/) for anonymous crash analytics and structured log capture. **Telemetry is strictly opt-in** — leaving `SENTRY_DSN` unset (the default) makes every Sentry callsite a no-op.

To enable reporting:

1. Apply for [Sentry for Open Source](https://sentry.io/for/open-source/) and create a project for `@bramburn/pi-loop`. Once approved, you'll receive a DSN like `https://publickey@o1234567.ingest.us.sentry.io/1234567`.
2. Set `SENTRY_DSN` in your shell environment (or add it to `.env` — see `.env.example`):
   ```bash
   export SENTRY_DSN=https://publickey@o1234567.ingest.us.sentry.io/1234567
   ```
3. Restart pi. The extension will initialize Sentry on load and start capturing:
   - Unhandled exceptions and unhandled promise rejections
   - Tool errors via the `wrapToolExecute` wrapper around every `pi.registerTool` call
   - Breadcrumbs on `session_switch`, `loop_fire`, and tool entry
   - Optional `debug()` log output (controlled by `SENTRY_CAPTURE_LOGS`)

All events are passed through a `beforeSend` hook that strips:
- Absolute filesystem paths (Windows + Unix user dirs)
- `process.env.*` references
- Sentry DSN literals
- Values under sensitive keys (`prompt`, `message`, `text`, `body`, `content`, `description`)
- Stack-frame `filename`/`abs_path` fields

The DSN itself is a *public* client identifier (it's shipped to browsers in Sentry's own SDK) — it only grants permission to *send* events, not to read them. Even so, the DSN is **never** committed to this repository. See `.env.example` for the full telemetry env-var matrix.

For the wider design rationale see [`docs/SENTRY.md`](docs/SENTRY.md).



## Retired tools

The Loop family is now active (see [Status](#install) and [Quick start](#quick-start)). The following tools and commands remain present in source but **not registered** in `src/index.ts` to keep the extension footprint minimal:

| File | What's in it |
|---|---|
| `src/tools/monitor-tools.ts` | `MonitorCreate`, `MonitorList`, `MonitorStop`, `MonitorDelete` |
| `src/tools/native-task-tools.ts` | `TaskCreate`, `TaskList`, `TaskGet`, `TaskClaim`, `TaskHeartbeat`, `TaskUpdate`, `TaskDelete`, `TaskPrune` |
| `src/tools/workflow-tools.ts` | Workflow step-execution tools |
| `src/commands/monitors-command.ts` | `/monitors` command |
| `src/commands/tasks-command.ts` | `/tasks` command |

The infrastructure that would back these tools is still in place: `src/monitor-manager.ts`, `src/task-store.ts`, `src/runtime/task-*.ts` coordinators. To re-enable any of them, add the matching `register*()` call to `src/index.ts` and provide the runtime stubs that the registered tools depend on.

## Limits

25 active loops, 25 running monitors. Recurring loops expire after 7 days.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — [LICENSE](./LICENSE)
