# Plan: Implement Promote a Loop to Shared

- **Plan for:** `specs/promote-loop-to-shared.md` (commit `67d36e6`, status `reviewed`)
- **Generated:** 2026-08-13
- **Status:** draft (planning only — no code change ships with this commit)
- **Last updated:** 2026-08-13 — Q1-Q5 Product Decisions resolved
- **Source spec file:line counts:** 14 ACs, 5 Product Decisions (all resolved), 6 Verification tasks

---

## Overview

Implement the `promote-loop-to-shared` feature as specified: a fourth `LoopScope` value (`"shared"`) plus `LoopStore.promote` / `LoopStore.adopt` methods, surfaced through a new `/loop-settings` Shared loops sub-screen and a `Promote to shared` row in `/loop`'s View loops menu, with a `[shared]` widget marker for adopted loops.

The plan decomposes the spec into 8 ordered build steps with no forward references, integrates the 6 Verification tasks as discrete gates, and incorporates the 5 resolved Product Decisions (Q1-Q5) as documented below. **12 of 14 ACs are implementable; 2 (AC-11, AC-12) are explicitly declined per the Q3 / Q4 decisions.**

---

## Scope

**In scope:**

- File-by-file changes in `src/settings.ts`, `src/runtime/scope.ts`, `src/store.ts`, `src/commands/settings-command.ts`, `src/commands/loop-command.ts`, `src/ui/widget-render.ts`, `src/trigger-system.ts` (read-only reuse; one method call site)
- New unit tests in `test/loop-tools.test.ts` or a new `test/shared-store.test.ts`
- New TUI integration tests in `test/settings-command.test.ts` (if it exists) or a new file

**Out of scope:**

- Rewriting or amending the source spec at `specs/promote-loop-to-shared.md`
- Implementing `specs/edit-shows-full-prompt.md` (separate goal)
- Modifying the merged `LoopPause` / `LoopResume` / `LoopDelete` shape from PR #78 (`da7856b`)
- Adding new top-level slash commands (per Q2 decision: unified picker, no new commands)
- Session-runtime auto-merge of shared loops into LoopList (Q3 declined; Step 7 dropped)
- Push-sync on shared-loop edits (Q4 declined; no cross-repo writeback)
- Any code change to `src/runtime/session-runtime.ts` (Step 7 is removed entirely)

---

## Resolved decisions (2026-08-13)

| Q | Decision | Resolution | Plan impact |
|---|---|---|---|
| Q1 | Shared store location | **(a) `<homedir>/.pi/loops/shared.json`** | Step 2 uses homedir default. `PI_LOOP_SHARED_PATH` env override implemented as a non-default extension (so AC-10 is achievable without changing defaults). |
| Q2 | UI surface | **(a) Unified picker** | Step 4 builds one sub-screen with per-row action labels. No new slash commands. |
| Q3 | Adoption model | **(a) Explicit adopt** | Step 7 (session-runtime auto-merge) is **dropped entirely**. Each repo must run `Adopt from shared` to surface shared loops in its LoopList. AC-11 not implemented. |
| Q4 | Sync model | **(a) Pull-only** | No push-sync wiring. Editing a shared loop in repo B creates a new project-scoped loop with a fresh id; the shared entry is unchanged. AC-12 not implemented. |
| Q5 | Multi-repo triggering | **(b) Auto-delete on promote** | Step 3 extended: after `LoopStore.promote(id)` copies the entry to the shared store, it also calls `store.delete(id)` and `triggerSystem.remove(id)` to tear down the source. The source repo's loop is removed; only repos that Adopt fire. AC-13 unblocked. |

**Note on Q5:** This is a destructive default. After promote, the source repo's loop is **gone** — not paused, not archived. The user can re-create it locally via Adopt (which copies the shared entry into the project store and re-arms the trigger) but this is an explicit re-pull, not an undo.

---

## File-by-file change list

| File | Change | Source step |
|---|---|---|
| `src/settings.ts` | Extend `LoopScope` union (line 16) with `"shared"`; extend `asScope` validator (line 104) to accept `"shared"` | Step 1, AC-14 |
| `src/runtime/scope.ts` | Add `"shared"` branch in `resolveLoopStorePath` (lines 13-23) resolving to `<homedir>/.pi/loops/shared.json`; add `PI_LOOP_SHARED_PATH` env override (default-off; AC-10 path) | Step 2 |
| `src/store.ts` | Add `LoopStore.promote(id)` (destructive per Q5: copies to shared, then `delete(id)` + `triggerSystem.remove(id)`); add `LoopStore.adopt(sharedId)` (copies from shared into project + `triggerSystem.add(entry)`); reuse `ReducerBackedStore` locking | Step 3, AC-1, AC-3, AC-4, AC-8, AC-9, AC-13 |
| `src/commands/settings-command.ts` | Add `Shared loops` menu entry to the cyclic editor (lines 106-145); open a new sub-screen listing project + shared loops with `Promote to shared` / `Adopt from shared` actions | Step 4, AC-5 |
| `src/commands/loop-command.ts` | Add `Promote to shared` row to per-loop actions menu (lines 171-216) | Step 5, AC-6 |
| `src/ui/widget-render.ts` | Add `[shared]` marker to the prompt summary (line 117) when the loop's `scope` field is `"shared"` | Step 6, AC-7 |
| `src/types.ts` | Add OPTIONAL `scope?: "project" \| "session" \| "shared"` field to `LoopEntry` (lines 91-108); back-compat default = `"project"` | Cross-cutting |
| `src/trigger-system.ts` | Reuse existing `.add()` and `.remove()` methods — no code change; call sites change in step 3 | Read-only reuse |

**AC-2 is OBSOLETE under the Q5 decision.** The original spec's AC-2 ("source project loop still active after promote") contradicts the destructive-promote default. With Q5 = auto-delete on promote, AC-2's expected behavior reverses: the source entry is removed. Step 3 therefore does NOT verify AC-2; the implementation produces the opposite outcome by design.

**AC-11 and AC-12 are explicitly NOT implemented.** Their corresponding Product Decisions (Q3 = explicit adopt, Q4 = pull-only) were answered with the negative option. These ACs remain in the source spec as `[BLOCKED]` text but are not built in v1.

---

## Ordered task breakdown

### Step 0 — Gate: VT-1 homedir cross-platform check

- Confirm `node:os.homedir()` returns a stable path on Windows / macOS / Linux.
- If it fails, surface as a Verification failure (fact check, not a product decision).
- **PAUSE** if it fails; proceed to step 1 only if it passes.

### Step 1 — Schema extension (`src/settings.ts`)

- Extend `LoopScope` union (line 16) with `"shared"`.
- Extend `asScope` validator (line 104) to accept `"shared"`.
- **AC-14 verification gate** (VT-3): `parseSettings` rejects unknown values; with `"shared"` added it accepts. Run both positive and negative cases.

### Step 2 — `resolveLoopStorePath` shared branch (`src/runtime/scope.ts`)

- Add `"shared"` branch resolving to `<homedir>/.pi/loops/shared.json` (default per Q1).
- Add `PI_LOOP_SHARED_PATH` env override: if set, use that path instead. Default-off (AC-10 implementation path; users opt-in via env).
- **AC-10 verification**: with `PI_LOOP_SHARED_PATH` set, the shared store resolves to that path.

### Step 3 — `LoopStore.promote` / `LoopStore.adopt` (`src/store.ts`)

- Add `LoopStore.promote(id)` (DESTRUCTIVE per Q5):
  1. Read source entry via `store.get(id)`.
  2. Refuse if id collision in shared store (AC-8).
  3. Open a temporary `LoopStore` for the shared path; apply `LOOP_CREATED` to write the copy.
  4. Tear down source: `triggerSystem.remove(id)` (CONFIRMED ordering at `src/store.ts` delete path).
  5. Apply `LOOP_DELETED` to source store.
  6. Return success.
- Add `LoopStore.adopt(sharedId)`:
  1. Open a temporary `LoopStore` for the shared path; read the entry.
  2. Refuse if id collision in current project store (AC-9).
  3. Apply `LOOP_CREATED` to current project store.
  4. Call `triggerSystem.add(entry)` to arm locally.
- **AC-3 verification**: a second `LoopStore` instance reading the shared path sees the entry.
- **AC-4 verification**: a second repo's `adopt` results in trigger armed locally.
- **VT-2 gate** (file-lock concurrency): stress-test two-process adoption.

### Step 4 — `/loop-settings` Shared loops sub-screen (`src/commands/settings-command.ts`)

- Add `Shared loops` entry to the cyclic settings menu.
- Sub-screen lists `Project loops` (active + paused) and `Shared loops` (every entry in the shared store) side-by-side.
- Action per row: `Promote to shared` (project section) or `Adopt from shared` (shared section).
- **AC-5**: both actions reachable from this surface.

### Step 5 — `/loop` View loops Promote action (`src/commands/loop-command.ts`)

- Add `Promote to shared` row to per-loop actions menu (lines 171-216).
- **AC-6**: consistent with `Edit` / `- Pause` / `* Resume` / `x Delete` shape.
- Calls the same `LoopStore.promote(id)` introduced in Step 3.

### Step 6 — Widget `[shared]` marker (`src/ui/widget-render.ts`)

- Render `[shared]` next to loops where `scope === "shared"` (or where the adopt method has set the marker).
- **VT-4 gate** (widget budget): confirm the marker fits when project + shared copies share the same id (less likely under Q5 destructive promote since the source is deleted, but defensive check).

### Step 7 — DROPPED (per Q3 = explicit adopt)

- Session-runtime auto-merge of shared-store entries is **not implemented**.
- Each repo must explicitly Adopt to surface a shared loop locally.
- Step 7 is intentionally absent from the build order.

### Step 8 — Tests

- **VT-5** (unit tests in `test/loop-tools.test.ts` or new `test/shared-store.test.ts`):
  - Promote then read from a second `LoopStore` instance pointing at the shared path.
  - Promote refuses on id collision.
  - **Q5 verification**: source entry is gone after promote (NOT present in the project store).
  - Adopt refuses on local id collision.
  - Shared store's file lock survives concurrent adoption from another process.
- **VT-6** (TUI integration tests in `test/settings-command.test.ts` or new file):
  - `/loop-settings` shows `Shared loops` entry.
  - Sub-screen lists project loops on top, shared below.
  - Project loop → `Promote to shared` action visible.
  - Shared loop → `Adopt from shared` action visible.

---

## AC-to-task traceability matrix

| AC | Step | File(s) | Verifies via | Status |
|---|---|---|---|---|
| AC-1 (loop written to shared path with same fields) | 3 | `src/store.ts`, `src/runtime/scope.ts` | VT-5 unit test | implementable |
| AC-2 (source still active after promote) | — | — | — | **OBSOLETE** (Q5 reverses expected behaviour) |
| AC-3 (second LoopStore reads shared) | 3 | `src/store.ts`, `src/reducer-backed-store.ts` | VT-5 unit test | implementable |
| AC-4 (second repo adopts, trigger armed) | 3 | `src/store.ts`, `src/trigger-system.ts` | VT-5 unit test + manual smoke | implementable |
| AC-5 (/loop-settings sub-screen) | 4 | `src/commands/settings-command.ts` | VT-6 TUI integration test | implementable |
| AC-6 (/loop Promote action) | 5 | `src/commands/loop-command.ts` | VT-6 TUI integration test | implementable |
| AC-7 (widget [shared] marker) | 6 | `src/ui/widget-render.ts` | VT-4 widget budget | implementable |
| AC-8 (promote refuses on collision) | 3 | `src/store.ts` | VT-5 unit test | implementable |
| AC-9 (adopt refuses on local collision) | 3 | `src/store.ts` | VT-5 unit test | implementable |
| AC-10 (PI_LOOP_SHARED_PATH override) | 2 | `src/runtime/scope.ts` | VT-5 unit test | implementable (UNBLOCKED by Q1) |
| AC-11 (auto-merge into LoopList) | — | — | — | **NOT IMPLEMENTED** (Q3 declined) |
| AC-12 (push-sync edits) | — | — | — | **NOT IMPLEMENTED** (Q4 declined) |
| AC-13 (auto-delete on promote) | 3 | `src/store.ts` | VT-5 unit test | implementable (UNBLOCKED by Q5) |
| AC-14 (strict schema rejects unknown) | 1 | `src/settings.ts` | VT-3 schema migration | implementable |

Effective AC count: **12 implementable, 1 obsolete, 2 explicitly declined, 0 still [BLOCKED].**

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

- [x] **Q1, Q2, Q3, Q4, Q5** answered (locked in 2026-08-13)
- [ ] **VT-1** passed (homedir cross-platform)
- [ ] **VT-3** passed (schema migration accepts `"shared"`)
- [x] Plan updated on `master` with Q1-Q5 resolutions (this commit)
- [ ] Branch is up to date with the spec-review commit `67d36e6` (and `da7856b` for the pause/resume refactor)
- [ ] Working tree is clean (`git status`)
- [ ] `npm run typecheck && npm run lint && npm test` is green on master baseline

When the builder starts, the execution order is:

1. Run step 0 (VT-1 gate)
2. Run step 1 (schema) + step 1 gate (VT-3)
3. Run step 2 (scope resolver with homedir default + env override)
4. Run step 3 (destructive `promote` + `adopt`) + step 3 gate (VT-2)
5. Run step 4 (settings sub-screen)
6. Run step 5 (loop Promote action)
7. Run step 6 (widget marker) + step 6 gate (VT-4)
8. (Step 7 DROPPED — Q3 = explicit adopt)
9. Run step 8 (tests, covering VT-5 + VT-6, plus Q5 destructive-promote assertion)
10. Self-review against every AC-1..14 (marking AC-11, AC-12 as deliberately not built; AC-2 as obsolete)
11. Open PR against `master`
12. After merge: tag as `v2.4.0` (or next semver bump) per the project's release flow

**No PAUSE markers** — Q1-Q5 are resolved and the builder can run end-to-end without further input.
