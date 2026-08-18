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
LoopDelete id="1"
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

## Tools

| Tool | What it does |
|---|---|
| `LoopCreate` | Schedule a prompt on a cron timer, a pi event, or both with debounce |
| `LoopUpdate` | Update progress for a dynamic goal loop (self-paced mode) |
| `LoopList` | Show active loops with IDs, triggers, and next-fire times |
| `LoopPause` | Pause a loop without removing it (preserves history, trigger, ID) |
| `LoopResume` | Resume a paused loop (re-adds the trigger; does not touch session bindings) |
| `LoopDelete` | Permanently delete a loop |
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

Cron loops re-arm themselves automatically **only if they are bound to this session** (see Per-Session Bindings below). Event/hybrid loops do **not** auto-re-arm their trigger subscriptions — use `/loop-resume <id>` (programmatic equivalent: `LoopDelete({id, action: "resume"})`) to re-bind them.

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
