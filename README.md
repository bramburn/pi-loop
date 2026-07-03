<p align="center">
<h1 align="center">@bramburn/pi-loop</h1>
<h6 align="center">Cron and event loops for the pi coding agent. Background monitors, scheduled re-wakes, pi-tasks integration, and native task fallback.</h6>
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

```text
MonitorCreate command="tail -n0 -f build.log" description="Watch build"
MonitorCreate command="python train.py" onDone="Analyze results and report best loss"
MonitorList
MonitorStop monitorId="1"
```

When `pi-tasks` is not installed, `pi-loop` also exposes native task tools after startup detection:

```text
TaskCreate subject="Fix deploy polling" description="Switch deploy check to event-driven loop"
TaskList
TaskUpdate id="1" status="in_progress"
TaskDelete id="1"
```

## Commands

`/loop [interval] [prompt]` — interactive loop creation.

```text
/loop                         # menu
/loop 5m check the deploy     # 5-minute cron loop
```

`/loop-resume <id>` — re-arm a stored loop after a session/process restart. Use this when a project-scoped event/hybrid loop's trigger subscription was lost. Idempotent: also works on paused loops to unpause + re-arm.

```text
/loop-resume 5        # re-arm loop #5 by id
/loop-resume          # picker: choose from all stored loops
```

`/tasks` — interactive native task viewer/manager, only registered when `pi-tasks` is absent.

```text
/tasks                        # open native task viewer
/tasks Write README updates   # quick-create native task
```

## Tools

| Tool | What it does |
|---|---|
| `LoopCreate` | Schedule a prompt on a cron timer, a pi event, or both with debounce |
| `LoopList` | Show active loops with IDs, triggers, and next-fire times |
| `LoopDelete` | Delete or pause a loop |
| `MonitorCreate` | Run a background command, stream output as `monitor:output` events. Use `onDone` for auto-notify on completion |
| `MonitorList` | Show monitors with status, uptime, and output line count |
| `MonitorStop` | Stop a monitor (SIGTERM → 5s → SIGKILL) |
| `TaskCreate` | Create a native fallback task when `pi-tasks` is absent |
| `TaskList` | List native fallback tasks |
| `TaskUpdate` | Update native fallback task status/details |
| `TaskDelete` | Delete a native fallback task |

Trigger types: `cron` (`5m`, `1h`, `0 9 * * 1-5`), `event` (any pi event source), or `hybrid` (both, debounced).

## Tasks

### With `pi-tasks`

Works with [@tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks). Pass `autoTask: true` on `LoopCreate` and each loop fire auto-creates a tracked task. Detection happens over pi's event bus — no manual wiring.

### Without `pi-tasks`

If `pi-tasks` does not respond during startup detection, `pi-loop` registers a native fallback task system for the session:

- session- or project-scoped task files under `.pi/tasks/` depending on `PI_LOOP_SCOPE`
- `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskDelete`
- `/tasks` interactive viewer
- compact status-line task tracking

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

| Variable | Effect | Default |
|---|---|---|
| `PI_LOOP` | Store path override. `off` to disable, absolute or project-relative path | unset → derived from `PI_LOOP_SCOPE` |
| `PI_LOOP_SCOPE` | `memory` (ephemeral), `session` (per-session file), `project` (shared, persists across sessions) | `project` |
| `PI_LOOP_DEBUG` | Debug logging to stderr | unset |

In `project` scope (default), loop and task files are saved to `.pi/loops/loops.json` and `.pi/tasks/tasks.json` so they survive across chat sessions and process restarts in the same repository — mirroring pi-goal-x's `.pi/goals/` pattern. In `memory` scope nothing persists to disk.

### Recommended scope policy

`PI_LOOP_SCOPE=project` is the default and best balance for normal use.

- `project` is the default: loops and tasks persist across sessions and process restarts in the same repo, so a 5m cron loop survives closing and reopening pi.
- `session` is best when you want each pi session isolated (e.g. concurrent worktrees, throwaway explorations). Loops disappear when the session ID changes.
- `memory` is best for disposable scratch work, tests, or situations where you explicitly do not want any persisted loop/task state.

### Re-arming loops after a restart

Cron loops re-arm themselves automatically after a project-scope restart (the scheduler pumps every 30s via the heartbeat in `session-runtime.ts`). Event/hybrid loops do **not** auto-re-arm their trigger subscriptions — use `/loop-resume <id>` (programmatic equivalent: `LoopDelete({id, action: "resume"})`) to re-bind them.



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
