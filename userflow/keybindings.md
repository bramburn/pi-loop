# User Flow — Modal Overlays and Keybindings

> **pi-loop v2.0** introduces two modal overlays and three global keybindings.
> Mirrors pragmaxim's `task-list-overlay.ts` and `goal-escape-dialog.ts`.

## Entry points

- `Ctrl+Shift+L` — opens the loop list overlay. Always available when the TUI is idle and the user has UI access.
- `Escape` — opens the operation dialog when an active loop is firing. Otherwise, Escape passes through to the underlying pi TUI (e.g. clearing editor input).
- `Enter` / `Esc` — dismisses either overlay.

## What users see

### Loop list overlay (`Ctrl+Shift+L`)

```
┌────────────────────────────────────────────────────────────────┐
│  Loops (my loops) — 2 loops · 0 monitors · 0 tasks
├────────────────────────────────────────────────────────────────┤
│  ▸ * #1 Check deploy status (cron: */5 * * * *)
│    * #2 Tail logs (event: tool_execution_start)
├────────────────────────────────────────────────────────────────┤
│  ↑↓ select · 'a' to show all · Enter to inspect · Esc dismiss
└────────────────────────────────────────────────────────────────┘
```

### Escape dialog (during a fire)

```
┌──────────────────────────────────────┐
│  Operation interrupted by Escape  (continue = default)
│  Operation: Loop firing
│  Detail: Loop #5 fired 12s ago
├──────────────────────────────────────┤
│    Cancel the operation
│      Stop the operation and clean up any resources.
│    Skip this iteration
│      Mark the current fire as resolved; the loop continues next time.
│  ▸ Continue working                    ← default
│      Resume the operation. The default for Escape.
├──────────────────────────────────────┤
│  ↑↓ navigate · Enter select · Esc = continue working
└──────────────────────────────────────┘
```

## Keybindings

| Key | Action | Always-on? |
|-----|--------|------------|
| `Ctrl+Shift+L` | Open loop list overlay | Yes (idle, has UI) |
| `Escape` | Open skip/continue/cancel dialog | Only when an active loop exists |
| `Enter` / `Esc` | Dismiss overlay | In any overlay |

The handler returns `{ consume: true }` from `onTerminalInput` only when consuming the key. Otherwise it returns `undefined` (TUI handles the key).

## "My loops" vs "all loops"

The overlay defaults to "my loops" — loops bound by the current session's bindings file. Pressing `a` toggles to "all loops". Scroll position resets on toggle.

## Headless / RPC mode

When `ctx.hasUI === false` (RPC mode, headless tests):

- `showLoopListOverlay` returns `undefined` immediately; `ctx.ui.custom` is not called.
- `showEscapeDialog` returns `"continue"` (safe default — never cancel user intent).

This ensures RPC consumers never see a blocking prompt.

## Data flow

```
key press
  → ctx.ui.onTerminalInput handler
    → if matchesKey(data, "ctrl+shift+l") → showLoopListOverlay(ctx, options)
      → ctx.ui.custom(factory, { overlay: true, overlayOptions: { anchor: "center", width: "80%" } })
        → factory builds Component (scrollable list)
          → user navigates with arrow keys
          → user confirms with Enter or dismisses with Esc
    → if matchesKey(data, "escape") && hasRecentFire → showEscapeDialog(ctx, options)
      → ctx.ui.custom(factory, { overlay: true, overlayOptions: { anchor: "center", width: "70%" } })
        → factory builds Component (3-option modal)
          → user selects with arrows + Enter
            → done(choice) → handler returns { consume: true }
```

## Testing

- `test/overlays.test.ts` — 15 tests covering both overlays' headless fallback, render output, keybindings, my-loops filtering, default Escape behaviour.
- `test/session-runtime.test.ts` — keybinding registration, headless no-op, session_shutdown unsubscribe.

## Why not `Ctrl+Shift+P` for the loop list?

`Ctrl+Shift+P` is the conventional palette key in editors (VS Code, Sublime, JetBrains). Using it for a single-purpose overlay would conflict with editor palettes users may install via other extensions.
