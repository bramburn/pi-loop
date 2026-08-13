# Spec: Promote a Loop to Shared (cross-repo accessible)

- **Slug:** promote-loop-to-shared
- **Status:** reviewed (approved by human 2026-08-13)
- **Generated:** 2026-08-13
- **Source:** greenfield specification; not yet implemented
- **Owning layer(s):** commands layer (`src/commands/settings-command.ts`, `src/commands/loop-command.ts`); settings + scope layer (`src/settings.ts`, `src/runtime/scope.ts`); runtime boot path (`src/runtime/session-runtime.ts`)
- **Related journeys:** none yet — create `specs/journeys/shared-loop-promote.md` after approval
- **Related specs:** none
- **Depends on:**
  - `LoopScope` enum at `src/settings.ts:8`
  - `resolveLoopStorePath` at `src/runtime/scope.ts:13-23`
  - `LoopStore` file persistence at `src/reducer-backed-store.ts`
  - `LoopEntry` shape at `src/types.ts:46-65`
  - `/loop-settings` cyclic editor at `src/commands/settings-command.ts:106-145`

## Overview

Pi-loop today has three scopes for loops: `memory`, `session`, and `project` (CONFIRMED at `src/settings.ts:8`). All three are rooted inside the working directory's `.pi/` tree (CONFIRMED at `src/runtime/scope.ts:17-23`). Loops defined in one repo are invisible to every other repo on the same machine, even when authored for cross-cutting work (organisation-wide cron jobs, codebase-wide event triggers, shared task-backlog workers).

This spec proposes a fourth scope — `shared` — plus a `LoopStore.promote` action and an **`/loop-settings` sub-screen** ("Shared loops") that lists every project-scoped and shared loop, with Promote and Adopt actions so users can move loops across the project↔shared boundary without leaving the settings surface they already know.

The "promote" action **copies** the loop entry to the shared store (non-destructive: the project-store copy survives). The "adopt" action **copies** a shared loop into the current project's store so it appears in `LoopList` and fires locally.

## User stories

### Story: Promote a project loop to shared

As an engineer authoring a cron loop in repo A's `.pi/loops/loops.json`
I want an option in `/loop-settings` → "Shared loops" to promote that loop
So that every other repo on my machine sees the loop in its listing and can adopt it locally.

#### Happy path

1. User runs `/loop-settings` from repo A.
   [CONFIRMED: `/loop-settings` is registered at `src/commands/settings-command.ts:106`]
2. Settings menu lists the existing cyclic fields plus a new `Shared loops` entry. User selects it.
   [TARGET]
3. The new sub-screen lists two sections: `Project loops` (every active + paused loop in repo A) and `Shared loops` (every loop in the shared store).
   [TARGET]
4. User picks `#4` (their cron loop) from the project section. The action menu shows `Promote to shared`, `Adopt from shared` (hidden when not in shared section), `< Back`.
   [TARGET]
5. User selects `Promote to shared`. The system writes a copy of loop #4 to `<homedir>/.pi/loops/shared.json` (CONFIRMED baseDir pattern at `src/store.ts:8`), updates the in-memory store metadata so the project copy is marked `scope="shared-copy"` for display, and notifies the user.
   [TARGET]
6. User switches to repo B in another terminal, runs `/loop-settings` → `Shared loops`, sees loop `#4` listed under `Shared loops`.
   [TARGET]

#### Edge cases

- Given another loop with the same id already exists in the shared store, Promote refuses and shows `Loop #N already exists in the shared store. Use "Adopt from shared" or rename first.`
  [TARGET]
- Given the shared store file is missing, the sub-screen shows `Shared loops\n(none)`.
  [TARGET]
- Given the shared store file is unreadable (permissions), the sub-screen shows `Cannot read shared store at <path>: <reason>` and falls back to project-only.
  [TARGET]
- Given the loop has an active trigger subscription, promote does NOT re-arm it in any other repo — Promote is a storage-level copy, not a live subscription.
  [GAP: question 5]
- Given the loop has `workflow` state, the workflow is preserved verbatim in the shared copy.
  [CONFIRMED: `LoopEntry.workflow` shape at `src/types.ts:79-87`]
- Given the loop has `dynamic` state, the same.
  [CONFIRMED: `LoopEntry.dynamic` shape at `src/types.ts:67-77`]

### Story: Adopt a shared loop into the current project

As an engineer working in repo B
I want to adopt a shared loop into repo B's local `.pi/loops/loops.json`
So that repo B's `LoopList` shows the loop and the trigger is armed locally.

#### Happy path

1. From `/loop-settings` → `Shared loops` → `#4` in the `Shared loops` section, user selects `Adopt from shared`.
   [TARGET]
2. The system copies the loop into the current project's store. The trigger system calls `triggerSystem.add(entry)` so the adopted loop fires on this repo's schedule.
   [CONFIRMED: `triggerSystem.add` exists at `src/trigger-system.ts`; arming contract at `src/runtime/session-runtime.ts:208-213`]
3. The shared entry remains in the shared store. Each repo adopts independently and the shared store is the source of truth, not a duplication.
   [TARGET]

#### Edge cases

- Given the current project already has a loop with the same id, Adopt refuses and shows `Loop #N already exists in this project. Resolve the duplicate first.`
  [TARGET]
- Given the shared store entry was promoted from this exact project originally and the project copy is still untouched, Adopt still works — it re-imports the same content. The trigger re-arms cleanly.
  [TARGET]
- Given the user adopts but does not bind it to this session, the loop is in the project store but invisible to this terminal until `/loop-resume <id>` is run.
  [CONFIRMED: per-session bindings behaviour at `src/runtime/session-runtime.ts:187-211`]

### Story: Promote / Adopt surface area is symmetric and visible

As an engineer reviewing the loop ecosystem
I want both Promote and Adopt to be reachable from `/loop` View loops AND from `/loop-settings` Shared loops
So that I don't have to remember which surface owns which action.

#### Happy path

1. `/loop` → `View loops` → `#N` → `Actions` shows `Promote to shared` when the loop is in the project store. Selecting it promotes (same behaviour as the `/loop-settings` sub-screen).
   [TARGET]
2. `/loop-settings` → `Shared loops` shows the same Promote action. Selecting it promotes.
   [TARGET]
3. The widget renders shared-adopted loops with a `[shared]` suffix in the prompt summary so it's clear at a glance which loops cross the project boundary.
   [CONFIRMED: widget rendering pattern at `src/ui/widget-render.ts:117`]

## Target behaviour

| Behaviour | Tag | Evidence / rationale |
|-----------|-----|----------------------|
| `LoopScope` union gains a fourth value `"shared"` | TARGET | current 3-value union at `src/settings.ts:8` |
| `parseSettings` accepts the new `"shared"` value (extending the `asScope` validator) | TARGET | current validator at `src/settings.ts:174-180`; strict schema at `src/settings.ts:200-203` |
| `resolveLoopStorePath` resolves `"shared"` to `<homedir>/.pi/loops/shared.json` | TARGET | `resolveLoopStorePath` at `src/runtime/scope.ts:13-23`; baseDir pattern at `src/store.ts:8` |
| `LoopStore.promote(id, targetScope)` copies an entry to a destination store (non-destructive) | TARGET | store class at `src/store.ts:14` |
| `LoopStore.adopt(sharedId, sourceStore, targetStore)` is the inverse — pull a shared loop into the project store | TARGET | inverse symmetry |
| `/loop-settings` adds a `Shared loops` menu entry that opens a project+shared listing | TARGET | existing cyclic editor at `src/commands/settings-command.ts:106-145`; sub-screen via an extra `ui.select` call |
| Shared loops sub-screen exposes `Promote to shared` and `Adopt from shared` actions on each row | TARGET | mirrors existing `/loop` → `View loops` → per-loop actions menu at `src/commands/loop-command.ts:171-216` |
| `/loop` → `View loops` adds a `Promote to shared` action | TARGET | per-loop actions menu at `src/commands/loop-command.ts:171-216` |
| Loop widget renders shared-adopted loops with a `[shared]` marker in the prompt summary | TARGET | widget render at `src/ui/widget-render.ts:117` |
| Per-session bindings treat shared-adopted loops like any other project loop (must be explicitly re-armed with `/loop-resume <id>`) | CONFIRMED | binding semantics at `src/runtime/session-runtime.ts:187-211` |
| File lock + atomic write of the shared store uses the existing reducer-backed-store pattern | CONFIRMED | atomic-write contract at `src/reducer-backed-store.ts:39-72` |
| Trigger re-arm after adoption follows the same `remove` + `add` ordering used by `editLoopInteractive` | CONFIRMED | re-arm path at `src/commands/loop-edit-command.ts:265-272` |
| Where the shared store physically lives (`homedir()`-based default vs. env-overridable path vs. workspace-declared path) | GAP | only the human can decide the cross-machine semantics — see Product decisions Q1 |
| Promote vs. Adopt UI in the same picker menu OR separate pickers per action | GAP | UX call — see Product decisions Q2 |
| Whether shared loops should auto-appear in `LoopList` for repos that haven't explicitly adopted | GAP | this is the core "shared" semantics — see Product decisions Q3 |
| Whether a shared-loop change in repo A "pushes" to repo B's adopted copy (sync model) or is pull-only | GAP | sync semantics — see Product decisions Q4 |
| Whether the trigger subscription in repo A is automatically torn down after promotion, or whether the original loop keeps firing locally | GAP | multi-repo firing model — see Product decisions Q5 |

## Data and integrations

- **Tables/entities:** reuses existing `LoopEntry` shape — no schema change required (CONFIRMED at `src/types.ts:46-65`). A new field `scope?: "project" | "session" | "shared"` is OPTIONAL on `LoopEntry` and defaults to the store's scope at write time.
- **API endpoints:** none
- **External services:** none
- **Background jobs/workers:** the existing `session-runtime` boot path (`src/runtime/session-runtime.ts:183-217`) needs to optionally load the shared store and merge its entries into the runtime view.
- **Config:**
  - `LoopScope` enum gains `"shared"` — strict-schema migration in `parseSettings` (`src/settings.ts:172-186`).
  - Optional env override `PI_LOOP_SHARED_PATH` (absolute path) — fallback to `homedir()/.pi/loops/shared.json` (CONFIRMED baseDir pattern at `src/store.ts:8`).

## Dependencies

- **Depends on:**
  - `LoopScope` union at `src/settings.ts:8` — extend
  - `asScope` validator at `src/settings.ts:174-180` — extend
  - `parseSettings` strict-schema migration at `src/settings.ts:200-203` — extend
  - `resolveLoopStorePath` at `src/runtime/scope.ts:13-23` — add shared branch
  - `LoopStore` class at `src/store.ts:14` — add `promote` and `adopt` methods
  - `ReducerBackedStore` file locking at `src/reducer-backed-store.ts` — reuse (no change)
  - `/loop-settings` editor at `src/commands/settings-command.ts:106-145` — add Shared-loops entry
  - `/loop` View loops menu at `src/commands/loop-command.ts:171-216` — add Promote action
  - Session boot loop loading at `src/runtime/session-runtime.ts:183-217` — optionally load shared entries
  - Widget renderer at `src/ui/widget-render.ts:117` — add `[shared]` marker
- **Depended on by:** none identified

## Open questions for human review

### Product decisions (block approval — only a human can answer)

1. **Shared store location.**
   - Default `homedir()/.pi/loops/shared.json` (CONFIRMED pattern at `src/store.ts:8`) — same user, same machine, all repos.
   - Configurable via `PI_LOOP_SHARED_PATH` env var — each repo can declare a different shared location (workspace-style).
   - Workspace-declared in `.pi/pi-loop-settings.json` (a new `sharedPath` field) — version-controlled with the repo.
   - **Default if no answer:** `homedir()/.pi/loops/shared.json` because it matches the existing `homedir()`-based pattern in `src/store.ts:8`.

2. **UI surface — same picker or separate sub-screens?**
   - One unified picker with both Promote and Adopt actions per row (action label changes based on whether the loop is in the project section or the shared section).
   - Two distinct sub-screens reached from separate menu entries.
   - **Default if no answer:** unified picker — fewer menu layers, consistent with the existing per-loop actions menu shape at `src/commands/loop-command.ts:171-216`.

3. **Adoption model — explicit vs. auto-merge.**
   - Explicit adopt: shared loops are NOT visible in `LoopList` until the user adopts them.
   - Auto-merge: shared loops auto-appear in every repo's `LoopList` but are NOT armed until adopted (or auto-armed, see Q4).
   - **Default if no answer:** explicit adopt. Matches the current "opt-in per session via `/loop-resume`" mental model (CONFIRMED at `src/runtime/session-runtime.ts:187-211`).

4. **Sync model — push vs. pull on shared-store edits.**
   - Pull-only: shared loops are snapshots; editing a shared loop in repo B creates a new project-scoped loop, doesn't update the shared entry.
   - Push: editing a shared loop in any repo writes back to the shared store (cross-repo edit).
   - **Default if no answer:** pull-only. Push semantics require a multi-writer conflict resolution story that is out of scope for v1.

5. **Multi-repo triggering on promote.**
   - Project-store copy keeps firing after promotion (source repo's loop continues).
   - Project-store copy is automatically paused/deleted after promotion (only repos that adopt fire).
   - **Default if no answer:** project-store copy keeps firing. Reduces surprise; lets the user opt out of cross-repo triggering by deleting the source loop after promotion.

### Verification tasks (do not block approval — become build-queue items)

1. Confirm `homedir()` from `node:os` returns the same value on Windows / macOS / Linux so the default shared-store path is stable across machines.
2. Confirm the file-locking pattern in `ReducerBackedStore` (`src/reducer-backed-store.ts:39-72`) holds when two pi sessions in different repos both adopt a shared loop concurrently (cross-process file contention).
3. Verify ADR-003 settings-schema migration is needed to add `"shared"` to the `LoopScope` union (strict schema at `src/settings.ts:200-203` rejects unknown enum values — extend the validator).
4. Confirm the existing widget render budget at `src/ui/widget-render.ts:117` still fits the additional `[shared]` marker when project and shared copies share the same id.
5. Add unit tests in `test/loop-tools.test.ts` (or a new `test/shared-store.test.ts`) covering: promote-then-read from a second `LoopStore` instance pointing at the shared path; promote refuses on id collision; adopt refuses on local id collision; the shared store's file lock survives a concurrent adoption from another process.
6. Add TUI integration tests in `test/settings-command.test.ts` (if it exists; otherwise a new file) covering: `/loop-settings` shows a `Shared loops` entry; the sub-screen lists project loops on top and shared loops below; selecting a project loop shows `Promote to shared`; selecting a shared loop shows `Adopt from shared`.

## Acceptance criteria

- **AC-1:** After promotion, the loop entry exists at `<homedir>/.pi/loops/shared.json` with the same `id`, `prompt`, `trigger`, `status`, `priority`, `recurring`, `maxFires`, `autoTask`, `taskBacklog`, `readOnly`, `expiresAt`, `dynamic`, and `workflow` fields as the source entry. Verified by reading the shared file after the action.
  [TARGET]
- **AC-2:** After promotion, the source project's `.pi/loops/loops.json` still contains the loop with `status="active"` (no destructive removal under the default copy-promote semantics from Product Decision #1 / Q5).
  [TARGET]
- **AC-3:** A second `LoopStore` instance pointing at the shared path (or a second repo on the same machine after `/loop-settings` → `Shared loops`) reads back the promoted loop with the same id and shape — no manual sync step required.
  [TARGET]
- **AC-4:** A second repo that adopts the shared loop has the loop entry in its own `.pi/loops/loops.json` and the trigger subscribed via `triggerSystem.add` — verified by listing and asserting the trigger arm count.
  [TARGET]
- **AC-5:** `/loop-settings` opens a `Shared loops` sub-screen that lists project-scoped and shared loops side-by-side, with `Promote to shared` available for project loops and `Adopt from shared` available for shared loops.
  [TARGET]
- **AC-6:** `/loop` → `View loops` → per-loop actions menu gains a `Promote to shared` row, consistent with the existing `Edit` / `- Pause` / `* Resume` / `x Delete` shape.
  [TARGET]
- **AC-7:** The widget renders a `[shared]` marker next to a loop that was adopted from the shared store, so the user can tell at a glance which loops cross project boundaries.
  [TARGET]
- **AC-8:** Promote refuses to overwrite an existing shared entry with the same id — error message is `Loop #N already exists in the shared store.`
  [TARGET]
- **AC-9:** Adopt refuses to overwrite an existing project entry with the same id — error message is `Loop #N already exists in this project.`
  [TARGET]
- **AC-10:** [BLOCKED: question 1] If `PI_LOOP_SHARED_PATH` (or the `sharedPath` setting) is configured, the shared store resolves to that path instead of the default.
  [GAP: question 1]
- **AC-11:** [BLOCKED: question 3] If auto-merge is approved, shared loops auto-appear in every repo's `LoopList` without explicit adopt.
  [GAP: question 3]
- **AC-12:** [BLOCKED: question 4] If push-sync is approved, editing a shared loop in any repo writes back to the shared store and is visible to subsequent adopters.
  [GAP: question 4]
- **AC-13:** [BLOCKED: question 5] If "auto-delete on promote" is approved, the source project's loop entry is removed after promotion and its trigger subscription is torn down via `triggerSystem.remove`.
  [GAP: question 5]
- **AC-14:** The settings file schema validation (`parseSettings`) rejects the new `"shared"` value as long as the schema whitelist is not extended — verifying strict-schema behaviour before the schema upgrade is shipped.
  [TARGET]

## Adjacent proposals

- **Per-workspace shared store** — A `.pi/pi-loop-shared.json` declaring the shared path per repo, so a workspace of repos can opt into a workspace-wide shared store. Out of scope; capture as a separate spec once the home/user-level default lands.
- **Pull-push sync model** — Bi-directional edits to shared loops across repos. Requires conflict resolution; out of scope for v1.
- **Shared tasks** — Same surface for `taskScope` (today the only scopes are `memory` | `session` | `project` — see `src/settings.ts:8`). Natural follow-up; same file-locking and migration story applies.
- **Shared widgets / status footer** — `LoopWidget` (`src/ui/widget.ts`) currently renders per-session state. Sharing the widget summary across repos would require a network/shared-memory IPC layer; out of scope.

## Desired changes (always include — even on greenfield)

Not applicable — this proposal does not touch an existing reverse-engineered spec. `specs/` currently contains only `specs/edit-shows-full-prompt.md` (also proposed, also awaiting review); both specs are independent and don't overlap.