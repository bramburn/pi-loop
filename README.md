<p align="center">
<h1 align="center">@pi-loop</h1>
<h6 align="center">Cron and event loops for the pi coding agent. Background monitors, scheduled re-wakes, pi-tasks integration.</h6>
</p>

## Install

```bash
pi install @trevonistrevon/pi-loop
```

## Quick start

```
LoopCreate trigger="5m" prompt="Check if the build passed"
LoopCreate trigger="tool_execution_start" prompt="Log the tool being used" triggerType="event"
LoopList
LoopDelete id="1"
```

```
MonitorCreate command="tail -n0 -f build.log" description="Watch build"
MonitorList
MonitorStop monitorId="1"
```

## Commands

`/loop [interval] [prompt]` — interactive loop creation.

```
/loop                         # menu
/loop 5m check the deploy     # 5-minute cron loop
```

## Tools

| Tool | What it does |
|---|---|
| `LoopCreate` | Schedule a prompt on a cron timer, a pi event, or both with debounce |
| `LoopList` | Show active loops with IDs, triggers, and next-fire times |
| `LoopDelete` | Delete or pause a loop |
| `MonitorCreate` | Run a background command, stream output as `monitor:output` events |
| `MonitorList` | Show monitors with status, uptime, and output line count |
| `MonitorStop` | Stop a monitor (SIGTERM → 5s → SIGKILL) |

Trigger types: `cron` (`5m`, `1h`, `0 9 * * 1-5`), `event` (any pi event source), or `hybrid` (both, debounced).

## pi-tasks

Works with [@tintinweb/pi-tasks](https://github.com/tintinweb/pi-tasks). Pass `autoTask: true` on `LoopCreate` and each loop fire auto-creates a tracked task. Detection happens over pi's event bus — no manual wiring.

## Widget

Active loops and monitors show in a persistent TUI widget above the editor.

## Configuration

| Variable | Effect | Default |
|---|---|---|
| `PI_LOOP` | Store path. `off` to disable, absolute or project-relative path | `.pi/loops/loops.json` |
| `PI_LOOP_SCOPE` | `memory` (ephemeral), `session` (per-session file), `project` (shared) | `session` |
| `PI_LOOP_DEBUG` | Debug logging to stderr | unset |

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
