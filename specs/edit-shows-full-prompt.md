# Spec: Edit Shows Full Prompt

- **Slug:** edit-shows-full-prompt
- **Status:** proposed (awaiting human review)
- **Generated:** 2026-08-13
- **Source:** greenfield specification; not yet implemented
- **Owning layer(s):** commands layer (`src/commands/loop-edit-command.ts`)
- **Related journeys:** none yet — create `specs/journeys/edit-loop-prompt.md` after approval
- **Related specs:** none
- **Depends on:** upstream pi-coding-agent `ui.input(title, placeholder?, opts?)` — CONFIRMED at `C:\dev\pi\packages\coding-agent\src\core\extensions\types.ts:139`

## Overview

The Edit action in `/loop`'s View loops menu currently shows a loop's `prompt` truncated to 40, 50, 60, or 80 characters across four call sites in `src/commands/loop-edit-command.ts`. Long prompts (cron schedules, multi-step instructions, JSON snippets, copy-pasted body text) are silently cut off in both the cyclic field menu and the input dialog title, forcing users to retype from scratch or guess at unseen suffixes. This spec proposes removing all `prompt` truncation from the edit form so users can read the full current value and edit it accurately.

## User stories

### Story: Edit a loop's prompt without losing context

As a user editing an existing loop from the `/loop` View loops menu
I want the cyclic field row, the edit summary header, and the input dialog title to show the full prompt
So that I can read what I'm about to change and edit it accurately without retype-and-guess.

#### Happy path

1. User runs `/loop` → `View loops` → picks loop #7 → `Edit`.
   The cyclic field row shows `prompt: <FULL 240-char prompt>` (no `…` truncation).
   [TARGET]
2. The edit summary header above the row list shows `prompt: <FULL 240-char prompt>`.
   [TARGET]
3. User selects the `prompt:` row. The input dialog opens with title `Prompt (current: <FULL 240-char prompt>)` — every character visible.
   [TARGET]
4. User edits the visible text (adds a clause, fixes a typo, removes a step) and submits.
   [TARGET]
5. The new value is persisted via `LoopStore.updateMetadata` and the widget re-renders.
   [CONFIRMED: `src/commands/loop-edit-command.ts:257-262`]

#### Edge cases

- Given a prompt with embedded newlines (multi-line instructions), the title and summary render the newlines rather than collapsing to one line.
  [TARGET]
- Given a prompt longer than the terminal width, the title wraps across multiple lines in the TUI.
  [TARGET]
- Given a prompt that contains ASCII art / box-drawing characters, the wrap is character-accurate (no half-glyph truncation mid-line).
  [GAP: question 1]
- Given the user opens Edit on a fresh session with no stored loops, the cyclic field form is never reached (existing behaviour: empty picker shows `< Back`).
  [CONFIRMED: `src/commands/loop-edit-command.ts:181-185`]

### Story: Other edit fields are unaffected

As a user editing other fields (trigger, priority, recurring, maxFires, readOnly, autoTask) on the same loop
I want those row labels and inputs to behave exactly as they do today
So that this change is scoped to the prompt field only and doesn't regress other behaviours.

#### Happy path

1. After implementing AC-1 through AC-3, the `trigger:`, `priority:`, `recurring:`, `maxFires:`, `readOnly:`, `autoTask:` rows in the cyclic field menu still use their current truncation behaviour.
   [TARGET]
2. The `trigger` input dialog title still uses `truncate(describeTrigger(...), 40)` in the row label.
   [CONFIRMED: `src/commands/loop-edit-command.ts:222`]
3. Save & Exit still triggers `entryFromDraft` → `store.updateMetadata` → optional `triggerSystem.remove` + `add` only when trigger changed AND loop active.
   [CONFIRMED: `src/commands/loop-edit-command.ts:265-280`]

## Target behaviour

| Behaviour | Tag | Evidence / rationale |
|-----------|-----|----------------------|
| Cyclic menu row `prompt:` shows the full prompt text, no `…` truncation | TARGET | current `truncate(draft.prompt, 40)` at `src/commands/loop-edit-command.ts:213` |
| Edit summary header `prompt:` row shows the full prompt text | TARGET | current `truncate(draft.prompt, 60)` at `src/commands/loop-edit-command.ts:70` |
| Input dialog title `Prompt (current: <full>)` shows the full prompt text | TARGET | current `truncate(draft.prompt, 80)` at `src/commands/loop-edit-command.ts:233` |
| Reuse existing `entryFromDraft` + `store.updateMetadata` persistence path | CONFIRMED | `src/commands/loop-edit-command.ts:257-262` |
| Reuse existing `truncate` helper for non-prompt fields (trigger summary, pickers) | CONFIRMED | `src/commands/loop-edit-command.ts:74-76, 184, 222` |
| Re-arm trigger only when trigger changed AND loop active | CONFIRMED | `src/commands/loop-edit-command.ts:265-272` |
| Pre-fill input field with the current prompt value so the user can edit in place | GAP | `ExtensionInputComponent` ignores `_placeholder` — see `C:\dev\pi\packages\coding-agent\src\modes\interactive\components\extension-input.ts:30-37` — upstream change to `ui.input` API required |
| How to render arbitrary-width input titles in the TUI (wrap vs. truncate with hover preview) | GAP | pi's input dialog title is a single `Text` node — no width-fitted variant exists |

## Data and integrations

- **Tables/entities:** reuses existing `LoopEntry.prompt` (CONFIRMED shape at `src/types.ts:46-65`)
- **API endpoints:** none
- **External services:** none
- **Background jobs/workers:** none
- **Config:** none

## Dependencies

- **Depends on:**
  - The cyclic field edit form in `src/commands/loop-edit-command.ts::editLoopInteractive` — CONFIRMED at `src/commands/loop-edit-command.ts:194-289`
  - The shared `truncate` helper at `src/commands/loop-edit-command.ts:74-76` (must NOT be removed; only the three prompt-specific call sites change)
  - Upstream pi-coding-agent `ui.input` accepts a title string of any length and renders it via the TUI text component — CONFIRMED at `C:\dev\pi\packages\coding-agent\src\modes\interactive\components\extension-input.ts:42-44`
- **Depended on by:** none identified

## Open questions for human review

### Product decisions (block approval — only a human can answer)

1. **Inline pre-fill vs. show-and-retype.** Should the input field start pre-filled with the current prompt so the user can edit it in place (selected, arrow-key navigated, modified), OR should the field stay empty with the full current value shown only in the title? The inline pre-fill path requires an upstream change to `ui.input` (the placeholder / default-value parameter); the show-and-retype path is implementable today. **If the answer is "yes, pre-fill", the planner should file a separate spec for the upstream change first and treat this spec as blocked until that lands.** If the answer is "no, show-and-retype is enough", AC-7 is dropped and AC-3 becomes the verification mechanism.

### Verification tasks (do not block approval — become build-queue items)

1. Confirm `ExtensionInputComponent` handles a 500-character title without crashing the TUI frame loop (smoke test at `C:\dev\pi\packages\coding-agent\src\modes\interactive\components\extension-input.ts:42-44`).
2. Confirm `summarizeDraft` still fits within the TUI's row budget when prompt is multi-line (no overflow into the row list below).
3. Verify the existing `test/loop-edit-command.test.ts` "edits a loop's prompt via ui.input and persists the change" test still passes after the truncation removal — the test asserts `prompt: old prompt` as the row label, which will become `prompt: <full>` matching the new behaviour.
4. Add a new test case in `test/loop-edit-command.test.ts` covering a 200-character prompt to lock in the no-truncation behaviour.

## Acceptance criteria

- **AC-1:** When the user opens Edit on a loop whose prompt is 200 characters, the cyclic menu row renders `prompt: <all 200 chars>` with no `…` and no character loss.
  [TARGET]
- **AC-2:** When the user opens Edit on the same loop, the edit summary header shows `prompt: <all 200 chars>`.
  [TARGET]
- **AC-3:** When the user selects the `prompt:` row, the input dialog title is `Prompt (current: <all 200 chars>)` — no truncation, no `…`.
  [TARGET]
- **AC-4:** After submitting a new value via the input dialog, the loop entry's `prompt` field matches the user's edited text (verified via `store.updateMetadata`).
  [TARGET]
- **AC-5:** When the prompt contains embedded newlines, the title and summary render the newlines rather than collapsing to one line — verified by running Edit on a loop whose prompt is `"step 1\nstep 2\nstep 3"`.
  [TARGET]
- **AC-6:** No regression — the other cyclic fields (trigger, priority, recurring, maxFires, readOnly, autoTask) and the Save & Exit / `< Cancel` rows still work exactly as before.
  [TARGET]
- **AC-7:** [BLOCKED: question 1] If pre-fill is approved: when the user opens Edit on a paused loop, the input field is pre-selected with the existing prompt text so the user can arrow-key through it and modify in place.
  [GAP: question 1]
- **AC-8:** The implementation does not modify the shared `truncate` helper itself — only the three `prompt`-specific call sites that currently pass `40`, `60`, or `80` as the limit.
  [TARGET]

## Adjacent proposals

- **Pre-fill `ui.input` with a default value** — Would unblock AC-7 and improve several other extension flows (settings prompts, search inputs). Out of scope here; belongs as a separate spec and an upstream PR to `earendil-works/pi-coding-agent`.
- **Show full prompt on `LoopList`** — `src/tools/loop-tools.ts:409` truncates `entry.prompt` to 60 chars in the list output. A natural follow-up; out of scope for this edit-form-only spec.
- **Truncation removal in widget rendering** — `src/ui/widget-render.ts:117` and `src/ui/overlays.ts:103` truncate the prompt to fit terminal width; intentional for visual layout. Leave alone.

## Desired changes (always include — even on greenfield)

Not applicable — this proposal does not touch an existing reverse-engineered spec. `specs/` is empty in this repository; this is the first entry.