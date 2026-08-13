# ADR-006: Split Loop Pause and Resume into First-Class Tools

**Status:** Accepted (implementation pending)
**Date:** 2026-08-12
**Author:** pi-loop implementation
**Branch:** `refactor/split-loop-pause-resume`

---

## Context

The `LoopDelete` tool is currently overloaded with an `action: "delete" | "pause"` enum (`src/tools/loop-tools.ts:516`). Pause is offered as a "softer" alternative to delete via the same tool, even though it is a semantically distinct operation. The result is a confusing API surface with multiple code paths to the same end state:

| Surface | Pause | Resume |
|---|---|---|
| Tool | `LoopDelete({id, action:"pause"})` | none |
| Tool (dynamic only) | `LoopUpdate({status:"paused"})` | `LoopUpdate({status:"continue"})` |
| Command | none | `/loop-resume <id>` |
| Command (TUI) | `/loop` → View loops → `- Pause` | `/loop` → View loops → `* Resume` |
| Picker | none | `/loop-resume` (no args) |

This produces three concrete problems:

1. **Asymmetric surfaces.** Pause is reachable from a tool (`LoopDelete({action:"pause"})`), but resume is not. Resume exists only in slash commands and the TUI menu. The asymmetry forces the LLM down different paths for two operations that should be symmetric.
2. **Doc drift.** `src/tools/AGENTS.md:23` claims `LoopDelete` supports `action: "delete" | "pause" | "resume"`. The actual schema is `["delete", "pause"]` and the execute body has no `"resume"` branch. The doc and the code disagree.
3. **Action-noun coupling.** `LoopDelete({action:"pause"})` reads as "delete, but pause instead" — a soft fallback to deletion. The user intent is "pause this loop", which has nothing to do with delete. The coupling leaks delete semantics (tombstone lookup, claim validation) into what should be a clean state flip.

Two design axes are currently conflated under one verb:

- **Status flip** (active ↔ paused). Just a flag on `LoopEntry.status`.
- **Session binding** (this terminal arms this loop or not). Tracked in `.pi/loops/bindings-<sessionId>.json`.

`/loop-resume <id>` does both. `LoopDelete({action:"pause"})` does only the first. The TUI `* Resume` row does both. The current code paths do not make this distinction explicit.

---

## Decision

1. **`LoopDelete` deletes only.** Drop the `action` parameter. The schema becomes `{ id, claimId? }` where `claimId` is still required for workflow loops with active tasks.
2. **Add `LoopPause({id})` as a first-class tool.** Mirrors the existing `store.pause(id)` reducer path. Status flip + trigger teardown.
3. **Add `LoopResume({id})` as a first-class tool.** Mirrors the existing `store.resume(id)` reducer path. Status flip + trigger re-arm + dynamic-loop `awaitingUpdate` clear. Does **not** touch the session bindings file (that remains the `/loop-resume <id>` command's job).
4. **Keep `/loop-resume` as the canonical *enable-after-restart* command.** Its picker mode (no args) stays. Its one-shot form (with id) stays. Both still update the session bindings file.
5. **Keep the `/loop` TUI `- Pause` / `* Resume` rows.** They already call `store.pause/resume` directly. They now coexist with the new tools rather than being the only way to flip state.
6. **Keep `LoopUpdate({status:"continue"|"paused"})` for dynamic loops.** This is a *workflow-outcome* pause/resume, semantically distinct from user-driven halt. Stays on `LoopUpdate`.
7. **No data migration.** `LoopEntry.status: "active" | "paused"` is unchanged. Stored loops work as-is. Only the tool-callable API surface moves.

### Tool schemas

```ts
// LoopPause
pi.registerTool({
  name: "LoopPause",
  parameters: Type.Object({
    id: Type.String({ description: "Loop ID to pause" }),
  }),
  execute(_id, { id }) {
    const entry = getStore().pause(id);
    if (!entry) { /* tombstone / not-found branches */ }
    getTriggerSystem().remove(id);
    updateWidget();
    return textResult(`Loop #${id} paused`, { kind: "loop", action: "pause", tone: "warning", ... });
  },
});

// LoopResume
pi.registerTool({
  name: "LoopResume",
  parameters: Type.Object({
    id: Type.String({ description: "Loop ID to resume" }),
  }),
  execute(_id, { id }) {
    const before = getStore().get(id);
    if (!before) { /* not-found */ }
    const entry = getStore().resume(id) ?? before;
    getTriggerSystem().add(entry);
    if (entry.trigger.type === "dynamic") onDynamicLoopActivated?.(entry);
    updateWidget();
    return textResult(`Loop #${id} resumed`, { kind: "loop", action: "resume", tone: "success", ... });
  },
});
```

### Visibility gating (per ADR-002)

| Tool | Predicate |
|---|---|
| `LoopCreate`, `LoopList` | always available |
| `LoopUpdate` | at least one `active` dynamic loop exists |
| `LoopPause` | at least one `active` loop exists |
| `LoopResume` | at least one `paused` loop exists |
| `LoopDelete` | at least one `paused` loop OR at least one `taskBacklog` loop exists (unchanged — preserves the "don't casually delete an active cron loop" friction) |
| `WorkflowTransition` | at least one workflow loop is in flight (unchanged) |

`LoopDelete` keeps its current predicate deliberately: the soft friction (pause-then-delete) is intentional and avoids accidental churn on active loops.

---

## Consequences

### Positive

- Symmetric `LoopPause` / `LoopResume` tools; LLM has one obvious way to express each intent.
- `LoopDelete` becomes single-purpose and matches its name. Doc and code agree.
- `LoopResume` is now tool-callable; agents no longer need to fall back to slash commands.
- Visibility predicate for `LoopPause` / `LoopResume` removes the cases where the LLM sees `LoopDelete` but cannot do anything useful with it (e.g., a paused loop visible but no resume path).

### Negative / accepted

- **Breaking change for any caller that uses `LoopDelete({action:"pause"})`.** Five test sites in `test/loop-tools.test.ts` must migrate. The schema change will surface a `tool validation error` to any in-flight agent session — this is expected and the migration is mechanical.
- **One more tool to register.** Tool count goes from 4 (loop CRUD) to 6. Acceptable; visibility gating ensures the LLM only sees what's relevant.

### Neutral

- `/loop-resume` keeps its session-bindings side effect. The new `LoopResume` tool does **not** touch bindings. This is the correct split: tool = pure state flip, command = state flip + session wiring.

---

## Implementation plan

The branch is `refactor/split-loop-pause-resume`. All changes below land on it.

### 1. Code (`src/`)

**`src/tools/loop-tools.ts`** — primary change
- Drop the `action` parameter from `LoopDelete` schema and execute body.
- Add `LoopPause` tool block.
- Add `LoopResume` tool block.
- Update `LoopDelete` description and `renderCall` (currently reads `toolArg(args, "action")`).
- Update `LoopStoreLike` interface to expose the new helpers if needed (probably not — `pause` and `resume` are already there).

**`src/tools/tool-visibility.ts`**
- Add `LOOP_TOOL_PAUSE = "LoopPause"`, `LOOP_TOOL_RESUME = "LoopResume"`.
- Update `CONDITIONAL_TOOLS` with the new predicates.
- Update the module-level doc comment.

**`src/tools/workflow-tools.ts:109`**
- Replace `Pause this workflow with LoopDelete action="pause", or abandon it with LoopDelete.` with `Pause this workflow with LoopPause, or abandon it with LoopDelete.`

**`src/tools/AGENTS.md`**
- Fix the stale line 23: `LoopDelete is overloaded — supports action: "delete" | "pause" | "resume"` → `LoopDelete deletes only. LoopPause and LoopResume are the soft alternatives. LoopUpdate owns dynamic-loop lifecycle (continue / completed / paused).`
- Update the `When adding a new tool` list example if relevant.

**`src/index.ts:8`**
- Update header doc: `LoopDelete    — Delete or pause a loop by ID` → `LoopDelete    — Delete a loop by ID`.

**`src/runtime/notification-runtime.ts:186`**
- No code change needed; the existing message `Do not call LoopDelete or pause it merely because this run finished` is correct and now resolves to `LoopPause` for the "pause" path.

### 2. Tests (`test/`)

**`test/loop-tools.test.ts`** — five call-site migrations
- L228, L243, L485: `LoopDelete({id:"1", action:"pause"})` → `LoopPause({id:"1"})`.
- L798: same migration in the `pauses a loop without removing it` test. Rename the `it()` description to `pauses a loop via LoopPause without removing it`.
- L814: same migration in the tombstone test. Rename the `it()` to `LoopPause reports auto-deletion tombstones for already deleted loops`.
- Add new test cases for `LoopResume` (resumes a paused loop, no-op on already-active, not-found, tombstone).

**`test/tool-visibility.test.ts`**
- Rename the two `LoopDelete` predicate tests to keep them but assert the new `LoopPause` / `LoopResume` predicates instead.
- Add tests: `adds LoopPause when at least one active loop exists`, `adds LoopResume when at least one paused loop exists`, `does not add LoopPause when all loops are paused`, `does not add LoopResume when no paused loop exists`.
- Update the `state x tool matrix` table to include `LoopPause` / `LoopResume` in the `all-loop mix` expected set.

**`test/tool-renderer.test.ts:64`**
- No change. The `action: "pause"` field on the display details is rendering metadata, not a tool call. Both `LoopPause` and `LoopDelete({action:"pause"})` could share it.

### 3. Architecture docs (`docs/`)

**`docs/architecture/state-machine-reducer-event-model.md:545`**
- `### Current: LoopDelete(action=pause)` → `### Current: LoopPause`.

**`docs/architecture/state-machine-test-matrix.md:50`**
- Update the table entry: `L-04 | pause active loop | active | LoopDelete(action=pause) | paused, unsubscribed, disarmed` → `L-04 | pause active loop | active | LoopPause | paused, unsubscribed, disarmed`.

**`docs/architecture/state-machine-transition-map.md:114`**
- Update the table entry: `LoopDelete(action=pause) / interactive pause` → `LoopPause / interactive pause`.

**`docs/plan/ADR-002-tool-visibility-call-site.md:26`**
- Update the rationale: `LoopDelete only when at least one loop is paused OR when at least one taskBacklog loop exists` stays, but add the new `LoopPause` / `LoopResume` predicates alongside it.

**`docs/MANUAL_TESTING.md:149,157`**
- Update the visibility scenarios to include `LoopPause` / `LoopResume` gating.

### 4. User-flow docs (`userflow/`)

**`userflow/loop-delete-pause.md`** — rewrite
- The doc is currently about `LoopDelete({action:"pause"})`. Rewrite to focus on `LoopPause` as the primary tool path; demote `LoopDelete` to a footnote about what to use instead when truly done with the loop.

**`userflow/GAPS.md:86,90`**
- The "Pausing is available via `LoopDelete(id, "pause")`, but resuming requires the interactive `/loop` command interface" gap is now closed. Strike or update the entries.

**`userflow/cross-platform-ux-analysis.md:269`**
- Update the "no tool to resume" line to reflect the new shape.

### 5. Top-level docs

**`README.md:69`**
- Update the table: `LoopDelete | Delete or pause a loop` → `LoopDelete | Delete a loop` and add two rows for `LoopPause` and `LoopResume`.

**`CHANGELOG.md`**
- Add a new version entry at the top (next minor: 2.3.0).
- Sections: Features (add LoopPause, add LoopResume, drop LoopDelete action enum), Internal (test + doc migration notes), Tests (count delta), Quality gates.

### 6. Archive files (`docs/archive/`)

`docs/archive/gap-analysis.md` and `docs/archive/repomix-loop-resume-bindings.md` are repomix outputs / historical snapshots — no edits required. Leaving them as-is keeps the historical record intact.

---

## Acceptance criteria

1. `LoopDelete` schema has no `action` parameter; `LoopDelete({action:"pause"})` returns a tool validation error.
2. `LoopPause` and `LoopResume` are registered tools and visible to the LLM under the right predicates.
3. `LoopResume` updates `status` to `"active"` and re-adds to `triggerSystem`. It does **not** touch the session bindings file.
4. `LoopPause` updates `status` to `"paused"` and removes from `triggerSystem`.
5. Tool visibility tests cover the new `LoopPause` / `LoopResume` predicates.
6. All five test sites in `test/loop-tools.test.ts` migrated to `LoopPause({id:"1"})`.
7. `npm run typecheck && npm run lint && npm test` passes locally.
8. `/loop` TUI Pause/Resume rows still work (no behavior change in `commands/loop-command.ts`).
9. `/loop-resume <id>` and `/loop-resume` (no args) still work.
10. `LoopUpdate({status:"continue"|"paused"})` still works for dynamic loops.
11. CHANGELOG entry, README table, and architecture docs reflect the new shape.

---

## Order of operations

1. Create branch `refactor/split-loop-pause-resume` (done).
2. Write this ADR (done).
3. Add `LoopPause` and `LoopResume` tool registrations (additive — no breakage yet).
4. Update `tool-visibility.ts` predicates.
5. Add `LoopPause` / `LoopResume` test cases.
6. Migrate the five `LoopDelete({action:"pause"})` test calls to `LoopPause({id})`.
7. Drop the `action` parameter from `LoopDelete` schema and execute body (the breaking change).
8. Update tool descriptions, `src/index.ts` header doc, `src/tools/AGENTS.md`, `src/tools/workflow-tools.ts:109`.
9. Update architecture and user-flow docs.
10. Update README and add CHANGELOG entry.
11. Run `npm run typecheck && npm run lint && npm test && npm run test:all`.
12. Verify `npm pack --dry-run` shows the expected file count.
13. Open PR against `master`.

---

## Out of scope

- `/loop` TUI Pause/Resume menu rows (`src/commands/loop-command.ts:204,209`).
- `/loop-resume` command and its bindings side effect.
- `LoopUpdate({status:"continue"|"paused"})` for dynamic loops.
- Store shape (`LoopEntry.status: "active" | "paused"`).
- Settings schema.
- Telemetry.
- Any data migration (none needed).