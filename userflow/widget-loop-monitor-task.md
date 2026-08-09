# User Flow — Above-Editor Widget

> **pi-loop v2.0** replaces the v1.x single-line status bar with an
> above-editor widget registered via `ctx.ui.setWidget`. This flow covers
> the widget surface, layout, live tick behavior, and update triggers.

## Entry points

- Extension `session_start` → widget registered with key `"loops"`, placement `aboveEditor`.
- Extension `before_agent_start` → widget setUICtx called.
- Extension `session_shutdown` → widget disposed (cleared via `setWidget(undefined)`).

## What users see

The widget renders a multi-line tree above the editor:

```
┌─ pi-loop ─────────────────────────────────────────────────────┐
│  pi-loop · 3 loops · 1 monitor · 2 tasks                      │
│    ├─ * #1 [active] check deploy (cron: */5 * * * *) next: 4m │
│    ├─ * #2 [active] tail logs (event: tool_execution_start)   │
│    ├─ - #3 [paused] weekly report                              │
│    ├─ > #4 [running] npm test … (3m 12s, 42 lines)             │
│    └─ 2 tasks: active: Foo                                     │
└────────────────────────────────────────────────────────────────┘
```

The widget is the **only** UI surface in v2.0. The v1.x `setStatus("loops", ...)` is no longer called.

## Data flow

```
store mutation
  → widget.update() (called from LoopTools / LoopCommand / runtime hooks)
    → widget.invalidate() — re-registers the factory closure
      → TUI calls factory(tui, theme) → Component.render(width)
        → renderWidgetLines(state, theme, width)
          → safe clamp on every line (truncateToWidth)
```

## Render rules

- Width: `Math.min(process.stdout.columns ?? 120, 120)`. Cap at 120 cols.
- Per-loop row: `* #N [active] <prompt> (trigger)` with branch lines.
- Per-monitor row: `> #M [running] <command> (lines, age)` for `running` and `error` monitors only.
- Per-task row: only the task count + focus text on a single line.
- One-shot monitor:done loops are hidden by default (matches v1.x `isStatusVisibleLoop`).
- Paused loops are hidden.

## Firing flash

When a loop fires (`onLoopFire` in `src/index.ts`), `widget.setFiringStatus(id, prompt)` is called. The widget:

1. Stores `firedAt = Date.now()`.
2. Starts a 1 Hz `setInterval(.unref())` ticker.
3. Each tick calls `invalidate()` to repaint.
4. The rendering function shows `→ firing (Ns ago)` on the firing loop's row.
5. After 5 seconds (firing-flash window), the ticker stops itself and triggers one final repaint to clear the indicator.

## Width-safety net

`renderWidgetLines` applies `truncateToWidth(line, width, "…")` to every line. Tested at widths 50, 70, 80, 100, 109, 120 with 25 loops + 25 monitors + 25 tasks.

## Visibility gating (tool surface, not widget)

The widget renders **every** loop, including ones that the LLM cannot see in its active tool set. The widget is for the human user; the LLM's tool gating is a separate concern (see `tool-visibility.md`).

## Testing

- `test/widget.test.ts` — 28 tests covering clamp helper, render fn, widget v2.0 surface (no setStatus, setWidget registration, dispose, setFiringStatus, setStore).
- `test/ui/widget-render.test.ts` — pure render-fn tests (width matrix).
- Pragmaxim regression matrix at widths 50/70/80/100/109/120.

## Migration from v1.x

v1.x users who scripted around the `setStatus("loops", ...)` format will need to update. The new format is multi-line and ANSI-coloured; consumers should parse `pi-loop:` prefix and the count suffix.
