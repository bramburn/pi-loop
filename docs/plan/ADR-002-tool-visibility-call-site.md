# ADR-002 — Tool Visibility Call Site

- **Status:** Accepted
- **Date:** 2026-08-08
- **Branch:** `feat/tui-and-tool-visibility-v2`
- **Goal phase:** Phase 0 (pre-implementation), implementation in Phase 3

## Context

pi-goal-x (v0.18.5) has a `syncGoalTools()` function that adds/removes tools from `pi.getActiveTools()` based on the current goal state. The pattern prevents the LLM from calling `pause_goal` on a paused goal, or from deleting a completed goal. It is enforced at the tool surface, not just by prompt guidance.

Pragmaxim's most recent fix (`d77e3b8 fix(goal): defer tool sync to before_agent_start to fix runtime error`) addresses a bug: calling `setActiveTools()` from `session_start` crashes with "Extension runtime not initialized" because the runtime hasn't finished binding.

pi-loop needs to adopt this pattern for `LoopCreate`, `LoopList`, `LoopUpdate`, `LoopDelete`, and `WorkflowTransition`. The call site selection is critical — too early and it crashes; too late and the LLM has already made a bad call.

## Decision

**Call `syncLoopTools(pi, store, sessionContext)` from the `before_agent_start` handler and after every store mutation. Do not call it from `session_start`.**

The function:

1. Reads `pi.getActiveTools()` — wrapped in `Array.isArray()` guard (defensive, per pragmaxim's `34818ac` lesson).
2. Computes the new set based on:
   - Always present: `LoopCreate`, `LoopList`.
   - `LoopUpdate` only when at least one dynamic loop is active.
   - `LoopPause` only when at least one loop is active.
   - `LoopResume` only when at least one loop is paused.
   - `LoopDelete` only when at least one loop is paused OR when at least one `taskBacklog` loop exists.
   - `WorkflowTransition` only when at least one workflow loop is active.
3. Writes via `pi.setActiveTools(Array.from(newSet))` — wrapped in try/catch with `console.error` for diagnostics (per pragmaxim's `34818ac`).

Call sites (in order of priority):

| Call site | Why |
|-----------|-----|
| `pi.on("before_agent_start", …)` | Runtime is fully bound; LLM is about to act |
| After `LoopStore.create()` | New loop may enable a tool (e.g., first dynamic loop enables `LoopUpdate`) |
| After `LoopStore.pause()` / `resume()` / `delete()` | Loop status change may enable/disable tools |
| After `LoopStore.continueDynamic()` / `stopDynamic()` | Dynamic loop state change |
| `pi.on("session_switch", …)` (after store upgrade) | New session may enable different tools |
| NOT `session_start` | Runtime not yet bound; crashes per `d77e3b8` |

## Consequences

**Positive:**

- LLM cannot call `LoopDelete` after a normal fire (the tool is removed from the active set). Eliminates the loop-deletion antipattern documented in pi-loop's `AGENTS.md`.
- LLM cannot call `LoopUpdate` when no dynamic loop is active (no false `nextInterval` calls).
- Runtime initialization crash is avoided by deferring the first call to `before_agent_start`.
- Defensive guards (`Array.isArray`, try/catch with logging) make the function robust against SDK drift.

**Negative:**

- Adds a synchronous tool-sync call to every store mutation. Microsecond cost; not measurable.
- Requires careful ordering: store mutation MUST complete before `setActiveTools()` is called. The implementation will use a coordinator pattern (already used in `notification-runtime.ts`) to enforce ordering.
- Tests must mock `pi.getActiveTools()` and `pi.setActiveTools()`; the full state × tool matrix requires ~30 test cases.

**Neutral:**

- The `syncLoopTools` function lives in `src/tools/tool-visibility.ts` (new file). It is a pure function with explicit dependencies, easy to unit-test.

## Alternatives considered

- **Call from `session_start`** — Rejected. Crashes per pragmaxim's `d77e3b8`. Empirically broken.
- **Call from every event (`turn_start`, `agent_start`, `agent_end`)** — Rejected. Too aggressive; would re-sync on every turn even when nothing changed.
- **Call only on `before_agent_start`** — Rejected. Misses mutations that happen during a turn (e.g., agent calls `LoopCreate` mid-turn). Need both lifecycle AND mutation-time calls.
- **Prompt-only enforcement** — Rejected. Pragmaxim proved that prompt guidance is insufficient — the LLM still calls banned tools. Tool gating is the only reliable mechanism.

## Implementation notes

```ts
// src/tools/tool-visibility.ts
export function syncLoopTools(
  pi: ExtensionAPI,
  store: LoopStoreLike,
  sessionContext: SessionContext,
): void {
  try {
    const initialTools = pi.getActiveTools();
    if (!Array.isArray(initialTools)) {
      console.error("[pi-loop] syncLoopTools: pi.getActiveTools() did not return an array, got", typeof initialTools);
      return;
    }
    const active = new Set(initialTools);

    // Always available
    active.add("LoopCreate");
    active.add("LoopList");

    // Conditional tools
    const hasDynamicLoop = store.list().some(e => e.dynamic && e.status === "active");
    const hasPausedLoop = store.list().some(e => e.status === "paused");
    const hasTaskBacklogLoop = store.list().some(e => e.taskBacklog);
    const hasWorkflowLoop = store.list().some(e => e.workflow);

    if (hasDynamicLoop) active.add("LoopUpdate");
    if (hasPausedLoop || hasTaskBacklogLoop) active.add("LoopDelete");
    if (hasWorkflowLoop) active.add("WorkflowTransition");

    pi.setActiveTools(Array.from(active));
  } catch (err) {
    console.error("[pi-loop] syncLoopTools error:", err instanceof Error ? err.message : String(err));
  }
}
```

## References

- `research/pi-goal-x/REPORT.md` §1.4 — Tool visibility gating in pragmaxim
- `research/pi-goal-x/REPORT.md` §2.3 — Comparison with pi-loop's current state
- pragmaxim commit `d77e3b8` — Defer tool sync to `before_agent_start`
- pragmaxim commit `34818ac` — Defensive array check + error logging
- `c:\dev\pi\packages\coding-agent\src\core\extensions\types.ts:1331-1337` — `getActiveTools` / `setActiveTools` API
