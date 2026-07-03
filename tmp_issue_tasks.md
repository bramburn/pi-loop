## Problem

The native task integration has several unresolved gaps that affect usability and reliability:

1. **G-10 (Tasks unavailable when pi-tasks is present — HIGH)**: When `@tartbin/pi-tasks` is present, native task tools are suppressed entirely. Users cannot use native tasks alongside pi-tasks. The current design is an exclusive fallback; coexistence would need deduplication logic.

2. **G-18 (AUTO_TASK_WORKER_THRESHOLD not configurable — LOW)**: The threshold of 5 tasks that triggers auto task-worker loop creation is hardcoded at `AUTO_TASK_WORKER_THRESHOLD = 5` in `task-backlog-runtime.ts`. No environment variable or config to adjust.

3. **G-19 (Native task events conflict with pi-tasks — MEDIUM)**: `emitNativeTaskEvent()` in `task-events.ts` emits events like `tasks:created`, `tasks:started`, etc. These are the same event names pi-tasks uses. When pi-tasks is present, native task events may conflict or be ignored by pi-tasks event handlers. Event emission is not gated by `isTasksAvailable()`.

4. **G-44 (Governor terminal-count annotation missing — LOW)**: The Governor picker shows all project loops but cannot distinguish which loops are created/armed by other terminals in project scope. No visual annotation showing other-terminal bindings.

## Files Affected

- `src/index.ts`
- `src/runtime/task-backlog-runtime.ts`
- `src/runtime/task-events.ts`
- `src/commands/loop-command.ts`

## Acceptance Criteria

- [ ] G-10: Design proposal for native tasks coexisting alongside pi-tasks (or document as intentional deferred)
- [ ] G-18: `AUTO_TASK_WORKER_THRESHOLD` exposed as env var `PI_LOOP_TASK_WORKER_THRESHOLD`
- [ ] G-19: Native task events gated by `isTasksAvailable()` check before emission
- [ ] G-44: Governor rows annotated with per-session binding count (e.g., `bound in 2 other sessions`)
