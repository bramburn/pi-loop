# ADR-004 — Overlay Keybindings and Modal Surface

- **Status:** Accepted
- **Date:** 2026-08-08
- **Branch:** `feat/tui-and-tool-visibility-v2`
- **Goal phase:** Phase 0 (pre-implementation), implementation in Phase 6

## Context

pi-loop v1.x has no modal overlays and no global keybindings. The user navigates exclusively through slash commands (`/loop`, `/loop-resume`, `/tasks`, `/monitors`). Escape propagates to the underlying pi TUI and is not handled by pi-loop.

pi-goal-x v0.18.5 has two modal overlays:

1. **Task list overlay** — bound to `Ctrl+Shift+T`. Scrollable, modal, dismissable.
2. **Escape dialog during audit** — bound to `Escape`. Two-button modal that returns `"complete_without_audit" | "continue_working"`.

pi-loop v2.0 needs an equivalent modal surface for:

1. **Loop list overlay** — show every loop, monitor, task at a glance. Toggle "all loops" vs "loops bound by this session". Navigate with arrow keys.
2. **Escape dialog** — during long-running fires (loop firing, monitor startup, backlog worker), offer "skip" / "continue" / "cancel" choices.

The choice of keybindings must avoid collisions with pi's built-in shortcuts and with other extensions' bindings.

## Decision

### Keybindings

| Key | Action | Always-on? |
|-----|--------|------------|
| `Ctrl+Shift+L` | Open loop list overlay | Yes (when agent is idle) |
| `Escape` | Open skip/continue/cancel dialog | Only when `agentRunning && hasPendingLoops` |
| `Ctrl+Shift+T` | Reserved for future task overlay | (deferred — not in v2.0) |

**Why `Ctrl+Shift+L`:** "L" stands for "Loops". Single-letter, single-key mnemonic. `Ctrl+Shift` modifiers avoid collision with the editor's text-input shortcuts.

**Why NOT `Ctrl+Shift+P`:** "P" is the conventional palette key in editors (VS Code, Sublime). Using it for a single-purpose overlay is wasteful and would conflict with editor palettes users may install via other extensions.

**Why reserved `Ctrl+Shift+T`:** pragmaxim's task overlay convention. Deferring it to v3.0 keeps the door open without committing scope now.

**Escape handling:** The handler returns `{ consume: true }` from `ctx.ui.onTerminalInput` only when an operation is in flight. Otherwise it returns `undefined` (let the TUI handle Escape). This prevents stealing Escape from the editor's normal "clear input" behaviour.

### Overlay API

Use `ctx.ui.custom<T>(factory, { overlay: true, overlayOptions: { … } })`:

```ts
const result = await ctx.ui.custom<{ action: "edit" | "delete" | "resume" }>(
  (tui, theme, keybindings, done) => {
    let selectedIndex = 0;
    let showAllLoops = false;
    return {
      render(width: number): string[] {
        // scrollable list with branch lines (mirror pragmaxim's task-list-overlay)
      },
      handleInput(data: string): void {
        if (matchesKey(data, "up")) { selectedIndex--; tui.requestRender(); }
        if (matchesKey(data, "down")) { selectedIndex++; tui.requestRender(); }
        if (matchesKey(data, "a")) { showAllLoops = !showAllLoops; tui.requestRender(); }
        if (matchesKey(data, "escape") || matchesKey(data, "enter")) { done({ action: "edit" }); }
      },
      invalidate(): void {},
    };
  },
  {
    overlay: true,
    overlayOptions: { anchor: "center", width: "80%", minWidth: 60, maxHeight: "80%" },
  },
);
```

Overlay keys (matching the widget key from ADR-001):

| Surface | Key |
|---------|-----|
| Above-editor widget | `loops` |
| Loop list overlay | `loops-overlay` |
| Escape dialog | `loops-escape` |

These keys are distinct so they cannot collide.

### Headless fallback

When `ctx.hasUI === false` (RPC mode, headless tests):

- Loop list overlay returns `undefined` immediately (no overlay can render).
- Escape dialog returns `"continue"` (safe default — never cancel user intent).

```ts
if (!ctx.hasUI) {
  if (operation === "loop-list") return undefined;
  return "continue";
}
```

## Consequences

**Positive:**

- Users get keyboard-driven navigation without typing slash commands.
- The overlay follows pragmaxim's pattern (proven UX).
- Headless mode is safe (no crash, no surprise behaviour).
- Keybindings don't collide with pi's built-in shortcuts or with the widget itself.

**Negative:**

- `Ctrl+Shift+L` is a long keystroke. Users with muscle memory for `/loop` may resist. Mitigated by keeping `/loop` working as before (no deprecation).
- Escape handling is conditional (`agentRunning && hasPendingLoops`). Edge case: if the LLM is mid-tool-call, Escape is consumed by the dialog but the underlying tool may already be aborting. The dialog's `cancel` option calls `LoopDelete`; the LLM's tool call will return an error and the agent will handle it gracefully.
- Overlay components are stateful (scroll position, toggle state). Each invocation creates a fresh component, so state doesn't persist across overlay opens. This is intentional — overlays are ephemeral.

**Neutral:**

- The `onTerminalInput` handler is registered in `src/index.ts` and unsubscribed on `session_shutdown`.
- The `custom` API is documented in `c:\dev\pi\packages\coding-agent\src\core\extensions\types.ts:196-202` — verified available in the current peer-dep version.

## Alternatives considered

- **No overlays; slash commands only** — Rejected. Pragmaxim's overlays are a major UX upgrade; not adopting leaves us behind.
- **`Ctrl+P` palette** — Rejected. Conflicts with editor palette convention.
- **Single overlay for everything (loops + monitors + tasks)** — Rejected. The toggle pattern (`a` for "all" vs "current") is cleaner when each entity has its own overlay.
- **Always-on Escape handling** — Rejected. Would steal Escape from the editor's normal "clear input" behaviour, surprising users.

## Implementation notes

```ts
// src/ui/loop-list-overlay.ts
export async function showLoopListOverlay(
  ctx: ExtensionContext,
  store: LoopStoreLike,
  monitorManager: MonitorManagerLike,
  taskStore: TaskStoreLike,
  bindingsStore: BindingsStoreLike,
): Promise<{ action: string; loopId?: string } | undefined> {
  if (!ctx.hasUI) return undefined;
  return await ctx.ui.custom(…);
}

// src/ui/escape-dialog.ts
export async function showEscapeDialog(
  ctx: ExtensionContext,
  operationLabel: string,
): Promise<"continue" | "skip" | "cancel"> {
  if (!ctx.hasUI) return "continue";
  return await ctx.ui.custom(…);
}

// src/index.ts (keybinding registration)
pi.on("session_start", async (_event, ctx) => {
  terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
    if (matchesKey(data, "ctrl+shift+l") && !ctx.hasPendingMessages()) {
      void showLoopListOverlay(ctx, …);
      return { consume: true };
    }
    if (matchesKey(data, "escape") && ctx.isAgentRunning() && hasPendingLoops()) {
      void showEscapeDialog(ctx, "Loop firing…").then(choice => {
        if (choice === "cancel") { … call LoopDelete … }
      });
      return { consume: true };
    }
    return undefined;
  });
});
```

## References

- `research/pi-goal-x/REPORT.md` §1.2 — `Ctrl+Shift+T` task list overlay
- `research/pi-goal-x/REPORT.md` §1.3 — Escape dialog during audit
- `research/pi-goal-x/PLAN.md` §3 Phase 6 — Modal overlays + keybindings
- `c:\dev\pi\packages\coding-agent\src\core\extensions\types.ts:145` — `onTerminalInput` API
- `c:\dev\pi\packages\coding-agent\src\core\extensions\types.ts:196-202` — `custom<T>` overlay API
- pragmaxim `extensions/widgets/task-list-overlay.ts` — Reference implementation
- pragmaxim `extensions/widgets/goal-escape-dialog.ts` — Reference implementation
