# User Flow — Unified Settings (v2.0)

> **pi-loop v2.0** replaces the v1.x scattered config (3 files, 4 env vars)
> with a single strict-schema file at `.pi/pi-loop-settings.json`.

## Entry points

- Extension startup → `migrateV1ToV2()` runs once (idempotent).
- `/loop-settings` slash command → opens the TUI editor.
- Manual edit of `.pi/pi-loop-settings.json` → reload on next startup.

## Settings schema

```typescript
{
  loopScope: "memory" | "session" | "project";
  taskScope: "memory" | "session" | "project";
  debug: boolean;
  autoClear: "never" | "on_list_complete" | "on_task_complete";
  sortOrder: "id" | "status" | "recent" | "oldest";
  hiddenAt: "top" | "bottom";
  maxVisible: number;     // positive integer
  showAll: boolean;
  taskThreshold: number;  // positive integer
}
```

Strict schema: unknown keys cause a startup error listing the bad keys.

## What users see

### `/loop-settings`

```
Settings
  Loop storage: project (shared across sessions)
  Task storage: session (isolated per terminal)
  Debug logging: false
  Auto-clear completed: on_list_complete (after all tasks done)
  Widget sort order: id (creation order)
  Overflow hidden at: bottom (completed at bottom)
  Max visible tasks: 10
  Show all tasks: false
  Backlog worker threshold: 5
  < Back
```

Selecting an option cycles the value and saves immediately.

## v1 → v2 migration

On first v2 startup, `migrateV1ToV2()`:

1. Reads `.pi/tasks-config.json` (if it exists). Merges values into the v2 schema.
2. Reads `PI_LOOP_SCOPE`, `PI_LOOP_DEBUG`, `PI_LOOP_TASK_THRESHOLD`, `PI_LOOP_TASK_WORKER_THRESHOLD` env vars (if set). Captures values into the v2 file.
3. Writes `.pi/pi-loop-settings.json`.
4. Renames the v1 file to `.pi/tasks-config.json.v1.bak`.
5. Prints a one-time banner:

   ```
   pi-loop v2.0 migrated your config to .pi/pi-loop-settings.json. The v1 file is at .pi/tasks-config.json.v1.bak.
   ```

The migration is idempotent — re-running does nothing if the v2 file already exists.

## Data flow

```
/loop-settings
  → ui.select("Settings", [...choices])
    → user picks a setting
      → nextValue(key, current) cycles the value
        → saveSettings(cwd, updated)
          → writeFileSync(.pi/pi-loop-settings.json)
            → ctx.ui.notify("Loop storage -> memory", "info")
```

## Env var removal (clean break)

The following env vars are **no longer read** in v2.0:

| Env var | v2 replacement |
|---------|---------------|
| `PI_LOOP_SCOPE` | `settings.loopScope` via `/loop-settings` |
| `PI_LOOP_DEBUG` | `settings.debug` via `/loop-settings` |
| `PI_LOOP_TASK_THRESHOLD` | `settings.taskThreshold` via `/loop-settings` |
| `PI_LOOP_TASK_WORKER_THRESHOLD` | `settings.taskThreshold` |
| `PI_LOOP` (custom path) | **Dropped** — use project scope |

Migration captures env-var values into the file once. Subsequent env-var settings are ignored.

## Testing

- `test/settings.test.ts` — 15 tests covering parseSettings strict schema, load/save round-trip, defaults fallback, malformed JSON, unknown keys.
- `test/migration.test.ts` — 13 tests covering idempotency, v1 capture, env var capture, conflict resolution (env wins), corrupt v1 fallback, banner messaging.

## Why a unified file?

- One source of truth: easy backup (`cp .pi/pi-loop-settings.json ~/backup/`).
- Easy to share between machines.
- Strict schema catches typos at startup, not at runtime.
- TUI editor covers every setting.
