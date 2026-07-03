## Problem

Several small gaps around documentation, validation, and UX polish:

1. **G-12 (No `subject` length validation in TaskCreate — LOW)**: `tasks-command.ts` truncates to 80 chars but the `TaskCreate` tool parameter has no length limit documented or enforced. Long subjects may cause UI/layout issues.

2. **G-15 (Event filter format undocumented — LOW)**: `TriggerSystem.matchesFilter()` supports `regex:` prefix and JSON object filter formats, but the parameter is typed as `string?` with no user-facing documentation on which format to use.

3. **G-16 (No `/tasks` interactive menu — LOW)**: Unlike `/loop` which has a full interactive menu (create/pause/resume/delete), `/tasks` only accepts a single subject argument and jumps to `viewNativeTasks()` with no top-level selection. (Also covered in G-48.)

## Files Affected

- `src/commands/tasks-command.ts`
- `src/tools/native-task-tools.ts`
- `src/types.ts`
- `src/trigger-system.ts`

## Acceptance Criteria

- [ ] G-12: Add length limit documentation to `TaskCreate` subject param (e.g., 200 chars max)
- [ ] G-15: Document event filter formats in tool descriptions: `regex:<pattern>` and JSON object
- [ ] G-16: Add `/tasks` interactive top-level menu (or mark as covered by G-48 umbrella issue)
