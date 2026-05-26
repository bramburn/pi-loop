# Changelog

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
