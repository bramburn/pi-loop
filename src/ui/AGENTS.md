# `src/ui/` — Status Bar Widget

Persistent TUI widget that shows loop + monitor + task counts and the currently-active/next task.

## Files

- `widget.ts` — `LoopWidget` is registered with `pi.ui` and updates on every store mutation. Uses `setStatus("loops", ...)` to render a single compact line.

## Conventions

- **`setStatus` is the only public method** — the widget computes its own text from the store + monitor manager + task summary. Callers don't pass strings.
- **`onChange` is the input** — the widget reads from `LoopStore.list()`, `MonitorManager.list()`, and the optional `taskSummaryProvider` callback. Update the widget by mutating the stores; it reads the latest state on `update()`.
- **Compact line** — the status line should fit in a typical TUI (80-120 cols). Format: `"<N> loops · <M> monitors · <K> tasks | <focus>"` where `<focus>` is the active/next task subject (truncated to 50 chars).
- **`isStatusVisibleLoop`** — internal helper that filters out non-actionable loops (paused, one-shot monitor:done wakes). Use this for the count, not `store.list().length` which includes them.

## Cross-cutting concerns

- The widget is updated from many places: tool handlers, command handlers, runtime hooks, monitor-manager onChange. The `widget.update()` calls are fire-and-forget — they don't block the caller.
- `dispose()` clears the status line. Called on session shutdown (via `registerSessionRuntimeHooks`).

## When adding new visible state

1. Add the state to the `computeStatus()` logic
2. Update the format string in `computeStatus()` to include it
3. If the state is async, add a `setXxxProvider` method that the caller sets in `index.ts`
4. Add the new state to the comment header at the top of `widget.ts` so the format is documented

## See also

- `src/AGENTS.md` — entry point and stores
- `src/runtime/AGENTS.md` — runtime hooks that update the widget
