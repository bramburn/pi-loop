## Release 1.0.0

First release of @bramburn/pi-loop on the bramburn fork. This is the package renamed from @trevonistrevon/pi-loop.

### Breaking changes
- Package renamed from @trevonistrevon/pi-loop to @bramburn/pi-loop. Update your imports and package.json.
- Master branch renamed to bramburn/pi-loop (was forked from trvon/pi-loop).

### Features added since fork
- Cross-platform shell + signal handling for MonitorCreate/Stop (Windows compatible)
- Cross-platform CI matrix (Linux, macOS, Windows × Node 20/22)
- LoopUpdate tool — change loop trigger/prompt/maxFires in place
- LoopResume via LoopDelete action=resume
- MonitorDelete tool — bypass 30s auto-prune
- TaskPrune tool — bulk-delete completed tasks
- /monitors command — list and manage background processes
- /tasks top-level menu (Create task / View tasks)
- PI_LOOP_TASK_THRESHOLD env var for backlog worker threshold
- Documented event filter format (regex: and JSON formats)
- subject maxLength=80 in TaskCreate
- LoopStore trigger leak cleanup (G-06, G-07)
- AGENTS.md throughout (src/, src/runtime/, src/tools/, src/commands/, src/ui/, test/)

### Bug fixes
- MonitorCreate previously failed on Windows (used hardcoded sh -c)
- SIGTERM was a no-op on Windows (now uses taskkill)
- Tests skip Unix-only commands on Windows (G-23)
- Corrupt store files preserved as .corrupt.<ts> for recovery (G-25)

### Verification
- 371/371 tests pass on Linux, macOS, and Windows
- All 6 CI matrix jobs green
- Coverage: statements 83.6%, branches 74.7%, functions 94.4%, lines 85.9%

Refs: closes all 25 gaps in userflow/GAPS.md (G-01 through G-25)
