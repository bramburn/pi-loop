# ADR-003 — Unified Settings File Schema

- **Status:** Accepted
- **Date:** 2026-08-08
- **Branch:** `feat/tui-and-tool-visibility-v2`
- **Goal phase:** Phase 0 (pre-implementation), implementation in Phase 4

## Context

pi-loop v1.x has settings scattered across three places:

1. `src/tasks-config.ts` — `TasksConfig` interface, persisted to `.pi/tasks-config.json`. Fields: `taskScope`, `sortOrder`, `maxVisible`, `showAll`, `hiddenAt`, `autoClearCompleted`.
2. `src/runtime/scope.ts` — `LoopScope` resolved from `PI_LOOP_SCOPE` env var only (no file).
3. Other env vars — `PI_LOOP` (custom path), `PI_LOOP_DEBUG`, `PI_LOOP_TASK_THRESHOLD`, `PI_LOOP_TASK_WORKER_THRESHOLD`.

This fragmentation means:

- The user has no single file to back up or share between machines.
- A new setting (e.g., a `crossfadeMs` for the widget) requires touching multiple files.
- The `/tasks` → "Settings" TUI menu only edits `TasksConfig`. Loop-scope settings are invisible.
- Migration from v1 to v2 is risky because settings live in three places.

pragmaxim's pi-goal-x v0.18.5 ships a single `.pi/pi-goal-x-settings.json` file with strict schema, env-var overrides, and a `/goal-settings` TUI editor. They committed to this in `0.15.0` (unified settings file replacing two separate files).

## Decision

**Adopt pragmaxim's pattern: a single `.pi/pi-loop-settings.json` file with strict JSON-schema validation. Replace `tasks-config.ts` entirely. Drop all `PI_LOOP_*` env vars as configuration sources.**

Schema (strict, `additionalProperties: false`):

```typescript
export interface PiLoopSettings {
  loopScope: "memory" | "session" | "project";
  taskScope: "memory" | "session" | "project";
  debug: boolean;
  autoClear: "never" | "on_list_complete" | "on_task_complete";
  sortOrder: "id" | "status" | "recent" | "oldest";
  hiddenAt: "top" | "bottom";
  maxVisible: number;
  showAll: boolean;
  taskThreshold: number;
}
```

Loading precedence (top wins):

1. Defaults (hardcoded)
2. `.pi/pi-loop-settings.json` file values
3. **No env-var override** — per the user's "clean break" decision

The `PI_LOOP_*` env vars are **removed entirely** from the runtime. Their previous behaviour is folded into the settings file via the one-shot migration on first v2 startup.

The `/loop-settings` slash command opens a TUI editor that cycles every setting and saves immediately.

### Migration on first v2 startup

- If `.pi/tasks-config.json` exists: parse it, merge into defaults, write `.pi/pi-loop-settings.json`, rename old file to `.pi/tasks-config.json.v1.bak`.
- Print a one-time banner: `pi-loop v2.0 migrated your config to .pi/pi-loop-settings.json. The v1 file is at .pi/tasks-config.json.v1.bak.`
- Idempotent: re-running does nothing.

### Strict schema enforcement

- `parseSettings()` throws on unknown keys.
- The error message lists the unknown keys: `Unknown pi-loop-settings.json key(s): foo, bar`.
- The extension surfaces this as `ctx.ui.notify(..., "error")` on startup; the extension does not crash.

## Consequences

**Positive:**

- Single source of truth for all settings.
- Easy backup (`cp .pi/pi-loop-settings.json ~/backup/`).
- TUI editor covers every setting.
- Strict schema catches typos (`maxVisibl: 50` → error, not silent ignore).
- Migration is automatic and idempotent.

**Negative:**

- Clean break: users with `PI_LOOP_SCOPE=memory` in their shell rc must remove it and use `/loop-settings` instead. Documented in CHANGELOG and the v2.0 release notes.
- `PI_LOOP` (custom path) support is dropped entirely. Users with custom paths must move their loops into the default `.pi/loops/` location.
- The migration only fires when `tasks-config.json` is at the canonical path. Custom paths print a warning directing users to `/loop-migrate` (a one-shot helper command).

**Neutral:**

- `tasks-config.ts` is deleted. `ui/settings-menu.ts` is deleted. Both are replaced by `src/settings.ts` and `src/commands/settings-command.ts`.
- The new file location follows pragmaxim's convention (`.pi/<extension>-settings.json`).

## Alternatives considered

- **Loose schema (current `tasks-config.ts` style)** — Rejected. Silent ignores hide bugs.
- **Env vars win over file** — Rejected per user's "clean break" decision. Migration captures env-var values into the file once; subsequent env-var settings are ignored.
- **Keep env vars as fallback** — Rejected. Two sources of truth causes split-brain behaviour.
- **YAML instead of JSON** — Rejected. JSON is more strict, simpler to validate, and consistent with pragmaxim.

## Implementation notes

```ts
// src/settings.ts
const ALLOWED_KEYS = new Set([
  "loopScope", "taskScope", "debug", "autoClear",
  "sortOrder", "hiddenAt", "maxVisible", "showAll", "taskThreshold",
]);

export function parseSettings(raw: unknown): PiLoopSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULTS;
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter(k => !ALLOWED_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`Unknown pi-loop-settings.json key(s): ${unknown.join(", ")}`);
  }
  return { ...DEFAULTS, ...validatedFields(record) };
}

export function loadSettings(cwd: string): PiLoopSettings {
  const path = join(cwd, ".pi", "pi-loop-settings.json");
  if (!existsSync(path)) return DEFAULTS;
  try {
    return parseSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    console.error("[pi-loop] settings parse error:", err instanceof Error ? err.message : String(err));
    return DEFAULTS;
  }
}

export function saveSettings(cwd: string, settings: PiLoopSettings): void {
  const path = join(cwd, ".pi", "pi-loop-settings.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2));
}
```

```ts
// src/migration/v1-to-v2.ts
export function migrateV1ToV2(cwd: string, env: NodeJS.ProcessEnv): { migrated: boolean; banner?: string } {
  const settingsPath = join(cwd, ".pi", "pi-loop-settings.json");
  if (existsSync(settingsPath)) return { migrated: false }; // already migrated

  const v1Path = join(cwd, ".pi", "tasks-config.json");
  if (!existsSync(v1Path)) return { migrated: false }; // no v1 config to migrate

  const v1Config = JSON.parse(readFileSync(v1Path, "utf8"));
  const merged: PiLoopSettings = {
    ...DEFAULTS,
    taskScope: v1Config.taskScope ?? DEFAULTS.taskScope,
    sortOrder: v1Config.sortOrder ?? DEFAULTS.sortOrder,
    maxVisible: v1Config.maxVisible ?? DEFAULTS.maxVisible,
    showAll: v1Config.showAll ?? DEFAULTS.showAll,
    hiddenAt: v1Config.hiddenAt ?? DEFAULTS.hiddenAt,
    autoClear: v1Config.autoClearCompleted ?? DEFAULTS.autoClear,
    loopScope: env.PI_LOOP_SCOPE as LoopScope ?? DEFAULTS.loopScope,
    debug: env.PI_LOOP_DEBUG === "1" || env.PI_LOOP_DEBUG === "true",
    taskThreshold: parseInt(env.PI_LOOP_TASK_THRESHOLD ?? "", 10) || DEFAULTS.taskThreshold,
  };

  saveSettings(cwd, merged);
  renameSync(v1Path, `${v1Path}.v1.bak`);
  return {
    migrated: true,
    banner: `pi-loop v2.0 migrated your config to .pi/pi-loop-settings.json. The v1 file is at .pi/tasks-config.json.v1.bak.`,
  };
}
```

## References

- `research/pi-goal-x/REPORT.md` §1.5 — Unified settings file
- `research/pi-goal-x/PLAN.md` §3 Phase 4 — Settings unification
- pragmaxim `extensions/goal-settings.ts` — Reference implementation
- `src/tasks-config.ts` — Replaced
- `src/ui/settings-menu.ts` — Replaced
