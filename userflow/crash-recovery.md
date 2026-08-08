# User Flow — Crash Recovery for Paused Loops

> **pi-loop v2.0** adds a crash-recovery prompt: when the user restarts a
> session after a crash (`event.reason === "resume"`), paused loops prompt
> for resume. Mirrors pragmaxim's `extensions/goal.ts:3437`.

## Entry point

`session_start` handler in `src/runtime/session-runtime.ts`:

```ts
pi.on("session_start", async (event, ctx) => {
  // ... existing setup ...
  if (event?.reason === "resume") {
    await offerResumePausedLoops(ctx);
  }
});
```

## What users see

When the user restarts after a crash with paused loops, they see one confirm prompt per loop:

```
Resume paused loop #5?    [Yes] [No]
weekly report
```

- **Yes** → loop is resumed (`getStore().resume(id)`), added to `triggerSystem`, widget repainted.
- **No** → loop stays paused; no other state changes.

If there are multiple paused loops, the user is prompted sequentially.

## Conditions

The prompt fires only when **all** of these are true:

- `event.reason === "resume"` (crash recovery, not fresh start).
- `ctx.hasUI === true` (not headless / RPC mode).
- At least one loop is in `paused` status.

The prompt is **skipped** when:

- The session is fresh (no `event.reason`).
- The session is a `reason === "new"` switch.
- No loops are paused.
- The session is headless (`ctx.hasUI === false`).

## Data flow

```
session_start(reason: 'resume')
  → offerResumePausedLoops(ctx)
    → getStore().list().filter(status === 'paused')
    → for each paused loop:
      → ctx.ui.confirm("Resume paused loop #N?", prompt.slice(0, 80))
        → user picks
          → if accepted: getStore().resume(id) → triggerSystem.add(resumed) → ctx.ui.notify("Loop #N resumed")
          → if declined: continue to next paused loop
```

## Why not auto-resume?

Auto-resuming on crash recovery risks losing the user's intent. They may have intentionally paused the loop before the crash. The prompt gives them a moment to decide.

## Why not block on first paused loop?

Sequential prompting lets the user decide per-loop. A single "resume all paused?" dialog would lose granularity (some may be paused deliberately, some may be temporary).

## Testing

- `test/session-runtime.test.ts` — 5 new tests:
  - `session_start with reason 'resume' prompts per paused loop`
  - `session_start with reason 'resume' does NOT prompt when no paused loops`
  - `session_start WITHOUT reason does NOT prompt (fresh start)`
  - `user declining the resume prompt leaves the loop paused`
  - `user accepting the resume prompt activates the loop`

## Interaction with `/loop-list`

The user can also inspect paused loops at any time via `/loop-list` and resume them manually with `/loop-resume <id>`. The crash-recovery prompt is just a convenience for the post-crash case.
