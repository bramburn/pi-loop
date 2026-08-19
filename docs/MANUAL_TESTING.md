# Manual E2E Testing — pi-loop v2.0

> **Required by verification contract item 17.** These tests are not
> automated (no headless harness can fully exercise the above-editor widget
> or modal overlays in a real pi TUI). Run them manually before tagging
> v2.0.0.

## Test environment

- Linux: Ubuntu 22.04 LTS, gnome-terminal 3.46
- Windows: Windows 11 22H2, Windows Terminal 1.18 (PowerShell)
- Terminal width: 80 cols (default) and 120 cols (wide)

## Test 1 — Multi-line widget renders on session start

**Steps:**
1. Open a fresh pi session in a clean project directory.
2. Confirm there are no loops or tasks.

**Expected:**
- The widget area is empty (no widget visible).
- The status bar is unchanged (v2.0 does not call `setStatus("loops", ...)`).

**Steps (continued):**
3. Run `/loop 5m check the deploy`.
4. Confirm the cron loop is created.

**Expected:**
- The widget renders above the editor with one row:
  ```
  pi-loop · 1 loop
    └─ * #1 [active] check the deploy (cron: */5 * * * *)
  ```

## Test 2 — Width-safety net on narrow terminal

**Steps:**
1. Resize the terminal to 50 columns.
2. Create 3 loops with 50-character prompts via `/loop 5m <prompt>`.
3. Run `/loop-resume` (no args) to view the list.

**Expected:**
- The widget continues to render without truncating the TUI.
- Long prompts are truncated with `…` at the end.
- No "view too wide" error.

## Test 3 — Live ticker during a fire

**Steps:**
1. Run `/loop 30s tick test`.
2. Wait for the first fire (~30 seconds).

**Expected:**
- The widget row for loop #1 shows `→ firing (Ns ago)` updating every second.
- After 5 seconds the indicator disappears; the row returns to its normal state.

## Test 4 — Ctrl+Shift+L overlay opens

**Steps:**
1. With at least one loop active, press `Ctrl+Shift+L`.

**Expected:**
- A modal overlay appears showing every loop with icon, id, prompt, and trigger.
- The header shows the count summary (e.g., `Loops (my loops) — 3 loops · 0 monitors · 0 tasks`).
- The footer shows `↑↓ select · 'a' to show all · Enter to inspect · Esc dismiss`.

**Steps (continued):**
2. Press `a` to toggle to "all loops".
3. Press `Esc` to dismiss.

**Expected:**
- After `a`, the footer hint changes to `↑↓ select · 'a' to show my · ...`.
- After `Esc`, the overlay dismisses cleanly without leaving a stale frame.

## Test 5 — Escape dialog during long-running fire

**Steps:**
1. Run `/loop 1m slow fire` with a prompt that triggers a long-running operation.
2. While the loop is firing, press `Escape`.

**Expected:**
- A modal dialog appears with three options: cancel / skip / continue.
- "Continue working" is the default selection (highlighted).
- The dialog header reads `Operation interrupted by Escape (continue = default)`.

**Steps (continued):**
3. Press the down arrow twice to select "Cancel the operation".
4. Press `Enter`.

**Expected:**
- The dialog dismisses.
- A notification reads `Operation cancelled via Escape`.
- The loop's wake is suppressed (no further agent turn).

## Test 6 — Crash recovery prompt

**Steps:**
1. Create 2 cron loops via `/loop 5m foo` and `/loop 5m bar`.
2. Pause both loops via the LoopList picker (press the pause action).
3. Force-kill the pi process (Ctrl+C in the terminal).
4. Restart pi in the same project directory.

**Expected:**
- The session resumes with `event.reason === "resume"`.
- The user is prompted per paused loop: `Resume paused loop #1?` then `Resume paused loop #2?`.
- Accepting the prompt activates the loop (status changes to active).
- Declining leaves the loop paused.

## Test 7 — Settings migration from v1.x

**Steps:**
1. On a v1.3.x install, create `.pi/tasks-config.json`:
   ```json
   {
     "taskScope": "project",
     "sortOrder": "recent",
     "maxVisible": 25,
     "showAll": true,
     "hiddenAt": "top",
     "autoClearCompleted": "never"
   }
   ```
2. Set `PI_LOOP_SCOPE=session` in the shell.
3. Upgrade to v2.0 (npm install).
4. Start pi.

**Expected:**
- The banner prints once: `pi-loop v2.0 migrated your config to .pi/pi-loop-settings.json. The v1 file is at .pi/tasks-config.json.v1.bak. PI_LOOP_SCOPE / PI_LOOP_DEBUG / PI_LOOP_TASK_THRESHOLD env vars are no longer read; their values were captured into the file.`
- `.pi/pi-loop-settings.json` exists with the merged values.
- `.pi/tasks-config.json.v1.bak` exists with the original v1 contents.
- `PI_LOOP_SCOPE=session` is no longer honoured at runtime; loopScope in the settings file is `session` (captured from the env var).

**Steps (continued):**
5. Restart pi.

**Expected:**
- No banner (migration is idempotent).
- The settings file is unchanged.

## Test 8 — Tool visibility gating (LLM cannot call banned tools)

**Steps:**
1. Create a single cron loop via `/loop 5m check`.
2. Inspect the LLM's tool list (via the pi TUI's tool inspector or `getActiveTools()` debug command).

**Expected:**
- `LoopCreate`, `LoopList` are present (always available).
- `LoopUpdate` is NOT present (no dynamic loop).
- `LoopPause` is present (active cron loop exists).
- `LoopResume` is NOT present (no paused loop).
- `WorkflowTransition` is NOT present (no workflow loop).

**Steps (continued):**
3. Pause the loop via the picker.
4. Inspect the tool list again.

**Expected:**
- `LoopPause` is NOT present (no active loop now that the only one is paused).
- `LoopResume` is now present (paused loop exists).

## Test 9 — Strict settings schema rejects unknown keys

**Steps:**
1. Manually edit `.pi/pi-loop-settings.json` and add `unknownKey: 42`.
2. Restart pi.

**Expected:**
- A startup error is logged: `Unknown pi-loop-settings.json key(s): unknownKey`.
- pi-loop loads defaults for the missing fields.
- The widget and commands continue to work (no crash).

## Test 10 — Multi-terminal Governor UX

**Steps:**
1. Open two pi terminals in the same project directory.
2. In terminal A, create a loop via `/loop 5m foo`.
3. In terminal B, press `Ctrl+Shift+L`.

**Expected:**
- Terminal B's overlay shows the loop from terminal A (since it lives in the shared project-scope store).
- The "my loops" filter shows empty for terminal B (the loop was not bound to terminal B's session).
- Pressing `a` in terminal B shows the loop in the "all loops" view.

## Cross-platform verification

Each test above must pass on both:
- **Linux** (Ubuntu 22.04, gnome-terminal)
- **Windows** (Windows 11, Windows Terminal / PowerShell)

Specifically verify:
- Widget renders identically on both platforms.
- `Ctrl+Shift+L` triggers the overlay on both platforms (the keystroke sequence is platform-independent).
- `Escape` triggers the dialog on both platforms.
- The settings migration banner prints on both platforms.
- The crash-recovery prompts appear on both platforms.

## Test result template

For each platform, record:

```
Platform: [Linux / Windows]
Date: YYYY-MM-DD
Branch: feat/tui-and-tool-visibility-v2
Commit: <sha>

Test 1 (widget render): PASS / FAIL
Test 2 (width safety):  PASS / FAIL
Test 3 (live ticker):    PASS / FAIL
Test 4 (overlay):        PASS / FAIL
Test 5 (escape dialog):  PASS / FAIL
Test 6 (crash recovery): PASS / FAIL
Test 7 (migration):      PASS / FAIL
Test 8 (tool gating):    PASS / FAIL
Test 9 (strict schema):  PASS / FAIL
Test 10 (governor):      PASS / FAIL

Overall: PASS / FAIL
Tester: <name>
```

Sign off by attaching the completed template to the v2.0.0 release PR.
