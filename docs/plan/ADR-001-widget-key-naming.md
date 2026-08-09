# ADR-001 — Above-Editor Widget Key Naming

- **Status:** Accepted
- **Date:** 2026-08-08
- **Branch:** `feat/tui-and-tool-visibility-v2`
- **Goal phase:** Phase 0 (pre-implementation)

## Context

pi-loop's v2.0 replaces the single-line `setStatus("loops", …)` surface with a registered above-editor widget. The widget is registered via `ctx.ui.setWidget(key, factory, { placement: "aboveEditor" })` and the `key` parameter scopes the widget to a named slot in the TUI.

The `key` must be unique across all extensions installed in the same pi TUI. If two extensions register a widget with the same key, the most recent registration wins (per `pi-coding-agent` semantics) and the earlier one is silently dropped.

Candidates considered:

1. **`loops`** — matches the existing `setStatus("loops", …)` key. Minimal migration friction; downstream scripts grepping for `"loops"` continue to find the right slot.
2. **`pi-loop`** — namespaced. Clear ownership; zero collision risk. Downstream scripts need updating.
3. **`loops-widget`** — descriptive. Mild namespacing; verbose.
4. **`@bramburn/pi-loop/widget`** — fully qualified. Zero collision risk but long and unconventional in the pi TUI ecosystem.

## Decision

**Use the key `"loops"`** for the v2.0 widget registration.

The v1.x key was already `"loops"` (via `setStatus("loops", …)`). Keeping the same key:

- Preserves any user scripts that watch for the `"loops"` slot (e.g., screenshot tools, theme overrides).
- Lets the widget and the old status line coexist for one release if we ever need a kill-switch path (though per the locked user decision, v2.0 deletes `setStatus` calls outright).
- Aligns with pragmaxim's pi-goal-x convention (`"goal"` is the equivalent for them).

## Consequences

**Positive:**

- Zero migration friction for users with existing tooling that reads the `"loops"` slot.
- Single semantic identifier for "the pi-loop surface" across v1.x and v2.0.

**Negative:**

- Risk of collision with another extension that also picks `"loops"`. Mitigated by namespace convention: future pi-loop widgets use the prefix `loops-` (e.g., `loops-overlay` for the modal in Phase 6).
- Loss of explicit namespace. Mitigated by adding `pi-loop` to the `Component`'s `dispose()` breadcrumb so Sentry/observability tools can attribute the widget clearly.

**Neutral:**

- Internal `Component` class is named `LoopMonitorTaskComponent` (descriptive, not namespaced). Its `dispose()` does `sentry.addBreadcrumb("loops.widget.dispose", { … })` to maintain observability.

## Alternatives considered

- **`"pi-loop"`** — Rejected. Higher migration friction; no observed benefit in this codebase.
- **`"loops-widget"`** — Rejected. Verbose without solving a problem that `"loops"` doesn't.
- **Fully qualified key** — Rejected. pi TUI conventions use short, slot-like keys; full paths are unconventional.

## Implementation notes

```ts
// src/ui/widget.ts
const WIDGET_KEY = "loops";

ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new LoopMonitorTaskComponent({ tui, theme, … }), { placement: "aboveEditor" });
```

For the v2.0 modal overlay (Phase 6), use the key `"loops-overlay"`. For the Escape dialog, use `"loops-escape"`. These keys are distinct from `"loops"` and from each other, so they cannot collide with the main widget.

## References

- `research/pi-goal-x/REPORT.md` §1.1 — Above-editor widget pattern from pragmaxim
- `research/pi-goal-x/PLAN.md` §3 Phase 2 — Above-editor widget implementation
- `c:\dev\pi\packages\coding-agent\src\core\extensions\types.ts:170-176` — `setWidget` API surface
