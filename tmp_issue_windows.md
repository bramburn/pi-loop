## Problem

`MonitorManager` uses Unix-only shell patterns throughout, breaking all monitor functionality on Windows:

1. **G-21 (`sh -c` hardcoded — CRITICAL)**: `monitor-manager.ts` spawns with `spawn("sh", ["-c", command])`. `sh` does not exist on Windows. All monitor commands fail immediately with `ENOENT`.

2. **G-22 (SIGTERM ineffective on Windows — HIGH)**: `MonitorStop` calls `proc.kill("SIGTERM")` which most Windows processes don't handle. The process continues running; only SIGKILL (mapped to `TerminateProcess`) works as a last resort.

## Files Affected

- `src/monitor-manager.ts`

## Acceptance Criteria

- [ ] `spawn` uses `process.platform === "win32" ? "cmd" : "sh"` with appropriate args
- [ ] Or migrate to `cross-spawn` / `execa` for automatic cross-platform handling
- [ ] MonitorStop uses `taskkill` or `TerminateProcess` for graceful Windows shutdown
- [ ] Add a Windows CI runner or mock test for the platform detection path
