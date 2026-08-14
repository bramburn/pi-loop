# Plan: Implement Promote a Loop to Shared

- **Plan for:** `specs/promote-loop-to-shared.md` (commit `67d36e6`, status `reviewed`)
- **Generated:** 2026-08-13
- **Status:** draft (planning only — no code change ships with this commit)
- **Source spec file:line counts:** 14 ACs, 5 Product Decisions, 6 Verification tasks

---

## Overview

Implement the `promote-loop-to-shared` feature as specified: a fourth `LoopScope` value (`"shared"`) plus `LoopStore.promote` / `LoopStore.adopt` methods, surfaced through a new `/loop-settings` Shared loops sub-screen and a `Promote to shared` row in `/loop`'s View loops menu, with a `[shared]` widget marker for adopted loops.

The plan decomposes the spec into 8 ordered build steps with no forward references, integrates the 6 Verification tasks as discrete gates, and surfaces the 5 Product Decisions (Q1-Q5) as blocker tasks the builder must pause on before proceeding past step 1 / 3 / 4 / 7 (depending on the answer).

---

## Scope

**In scope:**

- File-by-file changes in `src/settings.ts`, `src/runtime/scope.ts`, `src/store.ts`, `src/commands/settings-command.ts`, `src/commands/loop-command.ts`, `src/ui/widget-render.ts`, `src/runtime/session-runtime.ts`, `src/trigger-system.ts` (read-only reuse; one method call site)
- New unit tests in `test/loop-tools.test.ts` or a new `test/shared-store.test.ts`
- New TUI integration tests in `test/settings-command.test.ts` (if it exists) or a new file
- Optional `src/tools/loop-tools.ts` extension (only if Q3 lands on auto-merge)

**Out of scope:**

- Rewriting or amending the source spec at `specs/promote-loop-to-shared.md`
- Implementing `specs/edit-shows-full-prompt.md` (separate goal)
- Modifying the merged `LoopPause` / `LoopResume` / `LoopDelete` shape from PR #78 (`da7856b`)
- Adding new top-level slash commands (per constraint: extend `/loop-settings` and `/loop` first)
- Any of the 5 Product Decisions (each is a downstream blocker)

---

## File-by-file change list

| File | Change | Source step |
|---|---|---|
| `src/settings.ts` | Extend `LoopScope` union (line 16) with `"shared"`; extend `asScope` validator (line 174); strict-schema whitelist (line 87) — no change needed (it whitelists keys, not enum values) | Step 1 |
| `src/runtime/scope.ts` | Add `"shared"` branch in `resolveLoopStorePath` (lines 13-23) resolving to `<homedir>/.pi/loops/shared.json`; optional `PI_LOOP_SHARED_PATH` env override (gated on Q1) | Step 2, AC-10 |
| `src/store.ts` | Add `LoopStore.promote(id, targetScope)` method (non-destructive copy); add `LoopStore.adopt(sharedId, sourceStore)` method (inverse); reuse `ReducerBackedStore` locking | Step 3, AC-1, AC-2, AC-3, AC-4, AC-8, AC-9 |
| `src/commands/settings-command.ts` | Add `Shared loops` menu entry to the cyclic editor (lines 106-145); open a new sub-screen listing project + shared loops with `Promote to shared` / `Adopt from shared` actions | Step 4, AC-5 |
| `src/commands/loop-command.ts` | Add `Promote to shared` row to per-loop actions menu (lines 171-216) | Step 5, AC-6 |
| `src/ui/widget-render.ts` | Add `[shared]` marker to the prompt summary (line 117) when the loop's `scope` field is `"shared"` | Step 6, AC-7 |
| `src/runtime/session-runtime.ts` | In boot path (lines 183-217), optionally load shared-store entries and merge into runtime view (gated on Q3) | Step 7, AC-11 |
| `src/types.ts` | Add OPTIONAL `scope?: "project" \| "session" \| "shared"` field to `LoopEntry` (line 46-65); back-compat default = `"project"` | Cross-cutting |
| `src/trigger-system.ts` | Reuse existing `.add()` and `.remove()` methods — no code change; call sites change in step 3 | Read-only reuse |

---

## Ordered task breakdown

### Step 0 — Gate: VT-1 homedir cross-platform check

- Confirm `node:os.homedir()` returns a stable path on Windows / macOS / Linux.
- If not, surface as a Verification failure to the user (not a product decision; this is a fact check).
- **PAUSE** if it fails; proceed to step 1 only if it passes.

### Step 1 — Schema extension (`src/settings.ts`)

- Extend `LoopScope` union (line 16) with `"shared"`.
- Extend `asScope` validator (line 174) to accept `"shared"`.
- **AC-14 verification gate** (VT-3): `parseSettings` rejects unknown values; with `"shared"` added it accepts. Run both positive and negative cases.

### Step 2 — `resolveLoopStorePath` shared branch (`src/runtime/scope.ts`)

- Add `"shared"` branch resolving to `<homedir>/.pi/loops/shared.json`.
- Conditional: include `PI_LOOP_SHARED_PATH` env override ONLY IF Q1 approves env-override option (default = homedir only).

### Step 3 — `LoopStore.promote` / `LoopStore.adopt` (`src/store.ts`)

- Add `LoopStore.promote(id)`: copy the loop entry to the shared store. Non-destructive (source store entry preserved). Refuses on id collision (AC-8).
- Add `LoopStore.adopt(sharedId)`: copy from shared store into current project store. Refuses on local id collision (AC-9). Calls `triggerSystem.add(entry)` so the trigger arms locally.
- **AC-2 verification**: source entry still `status="active"` after promote.
- **AC-3 verification**: a second `LoopStore` instance reading the shared path sees the entry.
- **VT-2 gate** (file-lock concurrency): stress-test two-process adoption.

### Step 4 — `/loop-settings` Shared loops sub-screen (`src/commands/settings-command.ts`)

- Add `Shared loops` entry to the cyclic settings menu.
- Sub-screen lists `Project loops` (active + paused) and `Shared loops` (every entry in the shared store) side-by-side.
- Action per row: `Promote to shared` (project section) or `Adopt from shared` (shared section).
- **AC-5**: both actions reachable from this surface.

### Step 5 — `/loop` View loops Promote action (`src/commands/loop-command.ts`)

- Add `Promote to shared` row to per-loop actions menu (lines 171-216).
- **AC-6**: consistent with `Edit` / `- Pause` / `* Resume` / `x Delete` shape.

### Step 6 — Widget `[shared]` marker (`src/ui/widget-render.ts`)

- Render `[shared]` next to loops where `scope === "shared"` (or where the adopt method has set the marker).
- **VT-4 gate** (widget budget): confirm the marker fits when project + shared copies share the same id.

### Step 7 — Session-runtime shared-load (`src/runtime/session-runtime.ts`)

- In boot path (lines 183-217), optionally merge shared-store entries into the runtime view.
- **GATED ON Q3**: only enabled if Q3 approves auto-merge. Otherwise skip this step entirely (step 4's explicit adopt handles the cross-repo case).

### Step 8 — Tests

- **VT-5** (unit tests in `test/loop-tools.test.ts` or new `test/shared-store.test.ts`):
  - Promote then read from a second `LoopStore` instance pointing at the shared path.
  - Promote refuses on id collision.
  - Adopt refuses on local id collision.
  - Shared store's file lock survives concurrent adoption from another process.
- **VT-6** (TUI integration tests in `test/settings-command.test.ts` or new file):
  - `/loop-settings` shows `Shared loops` entry.
  - Sub-screen lists project loops on top, shared below.
  - Project loop → `Promote to shared` action visible.
  - Shared loop → `Adopt from shared` action visible.

---

## AC-to-task traceability matrix

| AC | Step | File(s) | Verifies via |
|---|---|---|---|
| AC-1 (loop written to shared path with same fields) | 3 | `src/store.ts`, `src/runtime/scope.ts` | VT-5 unit test |
| AC-2 (source still active after promote) | 3 | `src/store.ts` | VT-5 unit test |
| AC-3 (second LoopStore reads shared) | 3 | `src/store.ts`, `src/reducer-backed-store.ts` | VT-5 unit test |
| AC-4 (second repo adopts, trigger armed) | 3 | `src/store.ts`, `src/trigger-system.ts`, `src/runtime/session-runtime.ts` | VT-5 unit test + manual smoke |
| AC-5 (/loop-settings sub-screen) | 4 | `src/commands/settings-command.ts` | VT-6 TUI integration test |
| AC-6 (/loop Promote action) | 5 | `src/commands/loop-command.ts` | VT-6 TUI integration test |
| AC-7 (widget [shared] marker) | 6 | `src/ui/widget-render.ts` | VT-4 widget budget |
| AC-8 (promote refuses on collision) | 3 | `src/store.ts` | VT-5 unit test |
| AC-9 (adopt refuses on local collision) | 3 | `src/store.ts` | VT-5 unit test |
| **AC-10 [BLOCKED: Q1]** | 2 (conditional) | `src/runtime/scope.ts`, `src/settings.ts` | VT-5 unit test (env override) |
| **AC-11 [BLOCKED: Q3]** | 7 (conditional) | `src/runtime/session-runtime.ts`, `src/tools/loop-tools.ts` | VT-5 unit test |
| **AC-12 [BLOCKED: Q4]** | 3 (conditional) | `src/store.ts`, `src/commands/loop-edit-command.ts` | VT-5 unit test |
| **AC-13 [BLOCKED: Q5]** | 3 (conditional) | `src/store.ts` | VT-5 unit test |
| AC-14 (strict schema rejects unknown) | 1 | `src/settings.ts` | VT-3 schema migration |

All 14 ACs covered. 4 are [BLOCKED] pending Product Decision answers.

---

## Blocker tasks — PAUSE EXECUTION until user answers

### Resolve Q1: Shared store location

- **Options:**
  - (a) Default `<homedir>/.pi/loops/shared.json` (matches `src/store.ts:8` baseDir pattern)
  - (b) Configurable via `PI_LOOP_SHARED_PATH` env var
  - (c) Workspace-declared in `.pi/pi-loop-settings.json` (new `sharedPath` field)
- **Proposed default (from spec):** (a) homedir default.
- **Maps to:** AC-10.
- **PAUSE EXECUTION — user must answer before builder proceeds past step 2.**

### Resolve Q2: UI surface

- **Options:**
  - (a) Unified picker with both `Promote to shared` and `Adopt from shared` actions per row (action label changes per section)
  - (b) Two distinct sub-screens reached from separate menu entries
- **Proposed default (from spec):** (a) unified picker.
- **Maps to:** none directly (UX call).
- **PAUSE EXECUTION — user must answer before builder proceeds past step 4.**

### Resolve Q3: Adoption model

- **Options:**
  - (a) Explicit adopt: shared loops are NOT visible in `LoopList` until adopted
  - (b) Auto-merge: shared loops auto-appear in every repo's `LoopList` (but not armed until adopted or auto-armed)
- **Proposed default (from spec):** (a) explicit adopt.
- **Maps to:** AC-11.
- **PAUSE EXECUTION — user must answer before builder proceeds past step 7 (step 7 is conditional on Q3).**

### Resolve Q4: Sync model

- **Options:**
  - (a) Pull-only: editing a shared loop in repo B creates a new project-scoped loop, doesn't update the shared entry
  - (b) Push-sync: editing a shared loop in any repo writes back to the shared store (cross-repo edit)
- **Proposed default (from spec):** (a) pull-only.
- **Maps to:** AC-12.
- **PAUSE EXECUTION — user must answer before builder proceeds past step 3 with push-sync wiring.**

### Resolve Q5: Multi-repo triggering on promote

- **Options:**
  - (a) Project-store copy keeps firing after promotion (source repo's loop continues)
  - (b) Project-store copy is automatically paused/deleted after promotion (only repos that adopt fire)
- **Proposed default (from spec):** (a) keep firing.
- **Maps to:** AC-13.
- **PAUSE EXECUTION — user must answer before builder proceeds past step 3 with destructive promote wiring.**

---

## Verification task integration

| VT | Lands at | Description | File:line |
|---|---|---|---|
| VT-1 | Step 0 (gate) | homedir cross-platform stability | `src/store.ts:8` (homedir usage) |
| VT-2 | After step 3 | File-lock concurrency across two pi sessions | `src/reducer-backed-store.ts:39-72` |
| VT-3 | After step 1 | ADR-003 strict-schema migration accepts `"shared"` and rejects unknowns (AC-14) | `src/settings.ts:200-203` |
| VT-4 | After step 6 | Widget render budget fits `[shared]` marker | `src/ui/widget-render.ts:117` |
| VT-5 | Step 8 | Unit tests for promote, adopt, collisions, file-lock survival | `test/loop-tools.test.ts` or new `test/shared-store.test.ts` |
| VT-6 | Steps 4 + 5 + step 8 | TUI integration tests for sub-screen and per-loop menu | `test/settings-command.test.ts` or new file |

---

## Ready-to-build checklist

Before the builder agent picks this plan up, confirm:

- [ ] **Q1, Q2, Q3, Q4, Q5** answered (or accepted at proposed defaults)
- [ ] **VT-1** passed (homedir cross-platform)
- [ ] **VT-3** passed (schema migration accepts `"shared"`)
- [ ] Plan committed on `master` (no code changes ride along)
- [ ] Branch is up to date with `67d36e6` (and `da7856b` for the pause/resume refactor)
- [ ] Working tree is clean (`git status`)
- [ ] `npm run typecheck && npm run lint && npm test` is green on master baseline

When the builder starts, the execution order is:

1. Run step 0 (VT-1 gate)
2. Run step 1 (schema) + step 1 gate (VT-3)
3. Run step 2 (scope resolver) — **PAUSE for Q1 answer before completing**
4. Run step 3 (store methods) + step 3 gate (VT-2) — **PAUSE for Q5 answer if destructive promote is desired**
5. Run step 4 (settings sub-screen) — **PAUSE for Q2 answer before completing**
6. Run step 5 (loop Promote action)
7. Run step 6 (widget marker) + step 6 gate (VT-4)
8. Run step 7 (session-runtime shared-load) — **PAUSE for Q3 answer, optionally skip entirely**
9. Run step 8 (tests, covering VT-5 + VT-6)
10. **PAUSE for Q4 answer** if push-sync is desired (step 3 may need follow-up wiring)
11. Self-review against every AC-1..14
12. Open PR against `master`
13. After merge: tag as `v2.4.0` (or next semver bump) per the project's release flow