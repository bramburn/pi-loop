# Loop Governor + Per-Session Bindings — Design Note

> Embedded verbatim into the PR body at ship time. Captures the UX, file format, default behavior, and isolation invariant the user agreed to.

## Governor UX

**Row format**: `[x] #N [status] prompt (trigger)` where `[x]` reflects the current session's binding state (not just whether the trigger is armed in-process).

Examples:
- `[x] #1 [active] Check if the build passed (cron: */5 * * * *)`
- `[ ] #2 [active] Log the tool being used (event: tool_execution_start)`
- `[x] #3 [paused] Old reminder (cron: 0 9 * * 1-5)`

**Sentinels** at the bottom of the picker (after all loop rows):
- `< OK` — commit all pending toggles, write bindings file, apply triggerSystem.add/remove, exit
- `< Continue` — open `ui.confirm` with a diff preview; OK applies, Cancel returns to picker
- `< Cancel` — discard pending toggles, exit without writing

**Confirm dialog wording**:
- Title: `Apply changes?`
- Body: `Arm: #5, #9\nDisarm: #7` (or `No changes` if the user toggled nothing on Continue)

## Bindings file format

Per-session file at `<cwd>/.pi/loops/bindings-<sessionId>.json`:

```json
{
  "loopIds": ["1", "3", "7"]
}
```

Plain JSON, no atomic-write lock needed — single-owner file per session. Created lazily on first write. String IDs match the LoopStore's `entries: Map<string, LoopEntry>`.

## BindingsStore API

```ts
class BindingsStore {
  constructor(path: string | undefined, scope: LoopScope);
  load(): void;             // reads file into Set<string>; no-op if path undefined (memory scope)
  save(): void;             // writes current Set to file as {loopIds: string[]}; no-op if memory scope
  has(id: string): boolean; // O(1) check
  add(id: string): void;    // adds + saves immediately
  remove(id: string): void; // removes + saves immediately
  list(): string[];         // sorted snapshot
  clear(): void;            // empties + saves
  size(): number;
}
```

## Strict-isolation default

When `session-runtime.ts:showPersistedLoops()` runs on a fresh session (no bindings file), it:
1. Calls `bindingsStore.load()` → empty Set
2. Calls `bindingsStore.save()` → creates `{loopIds: []}` file
3. Sets `bindingsInitialized = true`
4. Emits one-time notify: `"No bindings for this session — run /loop-resume to choose which loops this terminal arms."` (info level)
5. Arms **zero** loops

On subsequent session_restart/turn_start, the file exists and is loaded silently with no notify.

This is a deliberate behavior change from prior versions, where every session armed every active loop on start. It is loud: AGENTS.md, README.md, and this PR body all call it out.

## Concurrent-session invariant

Two terminals in the same repo with different session IDs have independent bindings files:
- Terminal A (sessionId=`abc`) writes only `.pi/loops/bindings-abc.json`
- Terminal B (sessionId=`xyz`) writes only `.pi/loops/bindings-xyz.json`
- Each session's `session-runtime.ts:showPersistedLoops()` reads only its own bindings file
- Trigger subscriptions are process-local — Terminal A's `triggerSystem.add(#5)` does NOT cause Terminal B to fire `#5`
- The shared project store `.pi/loops/loops.json` is read by all sessions for the loop registry; writes (LoopCreate / LoopDelete / LoopUpdate) go through `LoopStore.withLock` which provides atomic write + stale-PID detection (existing behavior, unchanged)

Test invariant: simulate two sessions by instantiating two `LoopStore` + `BindingsStore` pairs in the same process; bind `#5` in session A; verify session B's `bindings.has("5") === false`.

## /loop-resume <id> one-shot path

```
/loop-resume 5
  → store.get("5")                          (must exist)
  → bindingsStore.add("5") + save()         (writes bindings-<sessionId>.json)
  → triggerSystem.add(entry)                (re-binds subscription if not already armed)
  → ui.notify("Loop #5 re-armed and bound to this session", "info")
  → return (one call, no picker)
```

## Governor commit path

```
Governor loops via ui.select:
  - User toggles rows → updates in-memory Set<string> pending
  - User picks < OK → pending applied: bindings.save + triggerSystem.add/remove per row; ui.notify summary; return
  - User picks < Continue → ui.confirm("Apply changes?", "Arm: #5, #9\nDisarm: #7")
      - OK → apply pending; ui.notify summary; return
      - Cancel → discard pending; return to picker
  - User picks < Cancel → discard pending; return
  - User picks Esc / undefined → discard pending; return

No store.status mutation anywhere in the governor path.
```