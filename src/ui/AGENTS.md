# `src/ui/` — Above-Editor Widget + Modal Overlays

Persistent TUI components for pi-loop v2.0. The single-line status-bar surface
from v1.x is gone — the widget registered via `ctx.ui.setWidget` is the only
surface, plus two modal overlays for keyboard-driven navigation.

## Files

- `widget.ts` — `LoopWidget` class. Registers a `Component` via `ctx.ui.setWidget(KEY, factory, { placement: "aboveEditor" })`. Re-registers on every `update()` so the TUI diffs the latest render output.
- `widget-render.ts` — pure `renderWidgetLines(state, theme, width)` function. Easy to unit-test in isolation. Includes the width-safety net (`truncateToWidth` on every line).
- `overlays.ts` — `showLoopListOverlay` modal. Scrollable list with `a` toggle for "my loops" vs "all loops". Bound to `Ctrl+Shift+L`.
- `escape-dialog.ts` — `showEscapeDialog` modal. Three options (cancel / skip / continue) with `continue` as the safe default. Triggered by `Escape` during a long-running fire.
- `tool-renderer.ts` — renderToolCall / renderToolResult helpers used by the loop tool registration.

## Conventions

- **`setWidget` is the only public surface** — the widget factory is registered once on `session_start` and re-registered on every `update()`. The factory closure reads state via getters; state changes call `invalidate()` → re-register.
- **Width-safety net is mandatory** — every line from `renderWidgetLines` is post-processed through `truncateToWidth(line, width, "…")` so the TUI never crashes on overflow. Tested at widths 50/70/80/100/109/120.
- **Headless mode is a no-op** — both `showLoopListOverlay` and `showEscapeDialog` check `ctx.hasUI` and return their safe default (`undefined` / `"continue"`) without calling `ctx.ui.custom`.
- **Theme integration** — use `theme.fg("accent", …)`, `theme.fg("dim", …)`, `theme.fg("warning", …)`, `theme.bold(…)` from `@earendil-works/pi-coding-agent`. Never hardcode ANSI codes.

## Widget key naming

The widget is registered with key **`"loops"`** (matches the v1.x `setStatus("loops", …)` key for downstream-script compatibility). The two overlays use:

- `"loops-overlay"` — loop list modal
- `"loops-escape"` — escape dialog modal

Per ADR-001, these keys are namespaced to avoid collisions with other extensions.

## Firing flash lifecycle

When a loop fires, `onLoopFire` in `src/index.ts` calls `widget.setFiringStatus(id, prompt)`. The widget:

1. Records `firedAt = Date.now()`.
2. Starts a 1 Hz `setInterval(.unref())` ticker.
3. Each tick calls `invalidate()` to repaint.
4. `renderWidgetLines` shows `→ firing (Ns ago)` on the firing loop's row.
5. After 5 seconds the ticker self-disables and triggers one final repaint to clear the indicator.

The ticker is owned by the widget so `dispose()` can clean it up on session shutdown.

## Cross-cutting concerns

- The widget is updated from many places: tool handlers, command handlers, runtime hooks, monitor-manager onChange. The `widget.update()` calls are fire-and-forget — they don't block the caller.
- `dispose()` clears the widget via `setWidget(undefined)` AND stops the ticker. Called on session shutdown (via `registerSessionRuntimeHooks`).
- `setFiringStatus()` is intentionally idempotent: calling it again with the same loop id resets the firing-flash window.

## When adding new visible state

1. Add the state to the `RenderWidgetState` interface in `widget-render.ts`.
2. Add a render helper that emits one or more lines.
3. Add the state to the `snapshotState()` method in `widget.ts`.
4. Verify the width-safety net still holds at widths 50, 80, 120 with pathological counts.
5. Add a unit test in `test/widget.test.ts` covering the new state.
6. **Priority badge is parked in the inline code review** — `LoopList` and the widget do not currently surface the loop's `priority` field. When this is added, the badge should match the priority: `critical` → `theme.fg("warning", "🔴 critical")`, `urgent` → `theme.fg("accent", "🟡 urgent")`, `defer` → `theme.fg("dim", "⏸ defer")`, default `normal` → no badge.

## When adding a new overlay

1. Create a new file alongside `overlays.ts` and `escape-dialog.ts`.
2. Use `ctx.ui.custom(factory, { overlay: true, overlayOptions: { anchor: "center", width: "80%" } })`.
3. Headless fallback must return the safe default (not throw).
4. Use a unique widget key (e.g., `"loops-<feature>"`).
5. Wire the keybinding in `registerKeybindings()` in `src/runtime/session-runtime.ts`.
6. Return `{ consume: true }` only when consuming the key.

## See also

- `src/AGENTS.md` — entry point and stores
- `src/runtime/AGENTS.md` — runtime hooks that update the widget
- `docs/plan/ADR-001-widget-key-naming.md` — widget key decision
- `docs/plan/ADR-002-tool-visibility-call-site.md` — tool gating decision
- `docs/plan/ADR-004-overlay-keybindings.md` — overlay keybinding decision
- `docs/plan/ADR-005-priority-queue.md` — priority queue decision (drives future widget priority badge work)
