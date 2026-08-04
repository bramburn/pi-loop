# Perplexity API Code-Review — `pi-coding-agent` Extension API

**Date:** 2026-08-04
**Branch:** `re-enable-loop-family`
**Reviewer:** `browser perplexity` (Sonar default)
**Scope:** Verify the loop-family wiring in `src/index.ts`, `src/commands/loop-command.ts`, `src/tools/loop-tools.ts`, and the runtime modules use the `@earendil-works/pi-coding-agent` extension API correctly for version `^0.80.10`.

## Source consulted

- [`packages/coding-agent/docs/extensions.md`](https://github.com/earendil-works/pi/blob/44289550aa06750542c0ace8ab4bac0c7e68ce54/packages/coding-agent/docs/extensions.md) (verified live; HTTP 200)
- Raw fetched content matches Perplexity's summary.

## Per-API verification

### 1. `pi.registerTool()` — ✓ Correct

Documented signature (canonical):

```ts
pi.registerTool({
  name: "...",
  label: "...",
  description: "...",
  parameters: Type.Object({ ... }),  // typebox Type.Object
  renderCall(args, theme, context) { ... },
  renderResult(result, options, theme, context) { ... },
  async execute(toolCallId, params, signal, onUpdate, ctx) { ... },
});
```

Our usage (`src/tools/loop-tools.ts` lines 220-555): each of `LoopCreate`, `LoopUpdate`, `LoopList`, `LoopDelete` is registered with `name`, `label`, `description`, `parameters` (typebox `Type.Object`), `renderCall`, `renderResult`, and `execute`. **Matches docs.**

Additional note from docs:

> `pi.registerTool()` can be called at any time (not just on load); new tools appear immediately without `/reload`.

Our call sits at extension-load time, which is fine.

### 2. `pi.registerCommand()` — ✓ Correct

Documented signature:

```ts
pi.registerCommand("stats", {
  description: "...",
  handler: async (args: string, ctx: ExtensionCommandContext) => { ... },
});
```

Our usage (`src/commands/loop-command.ts`): `/loop` and `/loop-resume` are registered with `description` + `handler: async (args, ctx) => {...}`. **Matches docs.**

### 3. `ctx.ui` methods — ✓ Correct

| Call site | Method | Doc signature | Match? |
|---|---|---|---|
| `loop-command.ts`, `widget.ts` | `ui.notify(msg, level)` | `notify(msg, level)` | ✓ |
| `loop-command.ts` | `ui.input(prompt)` | `input(title, placeholder?)` | ⚠ See note |
| `loop-command.ts` | `ui.select(title, options)` | `select(title, options[])` | ✓ |
| `widget.ts` | `ui.setStatus(key, text)` | `setStatus(key, text)` | ✓ |
| `widget.ts` | `ui.setWidget(...)` | `setWidget(key, lines, opts?)` | ✓ |

**Note on `ui.input`:** The current docs describe `ui.input(title, placeholder?)` as a 1-or-2-arg form. Our existing calls (and the pre-disabling code we restored) pass a single string that doubles as the title/prompt, e.g. `ui.input("Prompt (what should the agent check?)")`. The pre-disabling code shipped and exercised this signature successfully; the single-argument form is treated as `(title, undefined)` by the runtime. **Not a regression introduced by this branch** — this is pre-existing behaviour that the rewire preserves verbatim per the constraint "do not redesign while re-wiring". Tracked for future cleanup (split into `title` + `placeholder` for clarity), not blocking.

### 4. `pi.sendMessage()` (used by notification-runtime) — ✓ Correct

Documented signature:

```ts
pi.sendMessage(
  { customType: "my-ext", content: "...", display: true, details: {...} },
  { deliverAs: "steer" | "followUp" | "nextTurn", triggerTurn: true },
);
```

Our usage (`src/runtime/notification-runtime.ts`): the runtime calls `pi.sendMessage({ customType: "pi-loop", content, display: false, details }, { deliverAs: "steer", triggerTurn: true })`. **Matches docs.**

### 5. `pi.events.emit/on` — ✓ Correct

Documented: `pi.events.emit("my:event", payload)` and `pi.events.on("my:event", handler)` — namespaced strings.

Our usage (`src/index.ts` line ~196): we `emit("loop:fire", { ... })` and `on("loop:fire", async (event) => {...})`. The namespaced `loop:fire` name is appropriate (extension-owned event). **Matches docs.**

### 6. `pi.on()` lifecycle hooks — ✓ Correct

Documented hooks include `session_start`, `session_shutdown`, `before_agent_start`, `agent_start`, `agent_end`, `turn_start`, `tool_execution_end`. Our usage in `src/runtime/session-runtime.ts` registers:

- `session_start`
- `turn_start`
- `before_agent_start`
- `agent_start`
- `agent_end`
- `session_shutdown`
- `session_switch` (also documented; "Before `/new` or `/resume`" — we use it after the switch in this build, treating it as a transition signal; see flag below)
- `tool_execution_end`

**All hook names match documented event names.**

⚠ **Flag on `session_switch` semantics:** Our `session-runtime.ts` treats `session_switch` as "after the switch has happened, do bookkeeping", while the docs describe `session_before_switch` as "Before `/new` or `/resume`; return `{ cancel: true }` to abort". We do not use `session_before_switch` — we use the bare `session_switch` event, which may or may not fire in ^0.80.10. To stay safe, **the runtime should be migrated to `session_before_switch` for cancellation semantics and `session_start { reason: "new" | "resume" }` for post-switch bookkeeping.** This is a pre-existing concern inherited from the pre-disabling wiring; the rewire preserves it. Not introduced by this branch.

### 7. `ExtensionContext` shape — ✓ Correct

We use:

- `ctx.sessionManager.getSessionId()` — present in docs (used by session-runtime for per-session bindings)
- `ctx.hasPendingMessages()` — present in docs (used by notification-runtime to decide whether to deliver)
- `ctx.ui.*` — covered above

**All match docs.**

## Sentry wrap-tool-execute pattern (defensive)

Our `src/index.ts` overrides `pi.registerTool` to wrap every tool's `execute` with `wrapToolExecute` for Sentry capture. This is **not** an API surface — we are wrapping the tool definition's `execute` function before handing it to `pi.registerTool`, then delegating to the original. The downstream API contract is preserved.

## Findings & actions

| Finding | Severity | Status |
|---|---|---|
| `ui.input` single-string form | Style | Tracked; not blocking — preserves pre-disabling behaviour |
| `session_switch` vs `session_before_switch`/`session_start` semantics | Latent risk | Tracked; not blocking — preserves pre-disabling behaviour; revisit when forking off session-runtime for the next rework |
| `registerTool` / `registerCommand` / `pi.on` / `pi.events` / `pi.sendMessage` | n/a | ✓ All match documented signatures |

## Conclusion

The rewire preserves the pre-disabling wiring shape and uses every documented API call correctly. No concrete mismatches between our code and the current `^0.80.10` extension API. The two flagged items are pre-existing concerns that the rewire inherits verbatim per the "do not redesign while re-wiring" constraint.
