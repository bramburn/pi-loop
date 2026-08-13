# `src/tools/` — pi Tool Registration

Tools are the agent-facing API surface. Each file exports a single `registerXxxTools(options)` function that wires the tool definitions on an `ExtensionAPI`.

## Files

- `loop-tools.ts` — `LoopCreate` (with `priority` parameter), `LoopList`, `LoopPause`, `LoopResume`, `LoopDelete`, `LoopUpdate`. The four CRUD operations plus the two soft-halt tools. `LoopCreate` accepts a `priority: "defer" | "normal" | "urgent" | "critical"` enum (default `"normal"`). `LoopList` and `LoopUpdate` do not currently surface priority in their output — the priority is recorded in the loop entry and propagated to the runtime; surfacing it in `LoopList` is parked in the inline code review (rec #4 missing scope).
- `monitor-tools.ts` — DISABLED in this build (per upstream constraint that this build runs without `pi-monitor`). Source retained for re-enabling; the file's exports are no-ops.
- `native-task-tools.ts` — DISABLED in this build. Source retained.

## Conventions

- **Typebox schemas** — every tool parameter schema is a `Type.Object({...})` with `description` strings. The descriptions are shown verbatim to the LLM; they double as inline docs. Keep them accurate and specific.
- **Typebox union for enums** — when a parameter has a small fixed set of valid string values, use `Type.Union([Type.Literal("a"), Type.Literal("b"), ...])` rather than `Type.String({ enum: [...] })`. The union gives proper TypeScript literal types so the cast in the execute body becomes unnecessary. `LoopCreate.priority` is the canonical example.
- **Prompt guidelines** — every tool that benefits from LLM-facing context (when to use, when not to use) should populate `promptGuidelines`. `LoopCreate` is the canonical example.
- **Triggers as parsed objects, not strings** — `LoopCreate.execute()` parses the `trigger` string into a `Trigger` variant via `parseInterval` + `inferTriggerType`. The store only sees parsed objects.
- **Priority default is `"normal"`** — the `LoopCreate` schema declares `default: "normal"` and the execute body applies `priority ?? "normal"` as a defensive fallback. Always read `LoopEntry.priority` with `?? "normal"` for any threshold lookup.
- **No try/catch around `pi.sendMessage` or `pi.events.emit`** — let exceptions propagate to the harness, which logs them.
- **Tool result text** — always use `textResult(msg)` helper. Keep the message under ~10 lines, with the key facts (id, status, next steps) up top.

## Cross-cutting concerns

- **LoopDelete deletes only.** The soft-halt alternatives are first-class tools: `LoopPause({id})` to pause and `LoopResume({id})` to resume. `LoopResume` does not touch the session bindings file — that's `/loop-resume <id>`'s job. Dynamic-loop lifecycle (continue / completed / paused) stays on `LoopUpdate`. See ADR-006.
- **LoopUpdate re-arms the trigger** — when the trigger changes, `triggerSystem.remove(id)` runs first, then the new trigger is added. Don't skip the remove: stale cron/event subscriptions will leak.
- **MonitorDelete bypasses the 30s auto-prune** — it stops the monitor if running, then immediately removes it from the store. (Currently unused in this build; monitor tools are disabled.)
- **Native task tools fire `tasks:*` events** — the `emitNativeTaskEvent` helper in `runtime/task-events.ts` does this. Always emit on state change so pi-tasks subscribers see updates. (Currently unused; native task tools are disabled.)
- **Subject length** — `TaskCreate` accepts up to 80 chars in the schema. `tasks-command.ts` also truncates to 80. Don't change this without updating both. (Currently unused.)
- **LoopEntry.priority is read with `?? "normal"`** — the `LoopEntry` interface marks `priority` as optional. The notification reducer, the threshold lookup, and any UI rendering must treat `undefined` as `"normal"` to keep old stored loops working.

## When adding a new tool

1. Add the `pi.registerTool({...})` block in the appropriate file
2. The schema must use `Type.Object` with descriptions, and `Type.Union([Type.Literal(...)])` for enums (not `Type.String({ enum: [...] })`)
3. The execute function returns `Promise.resolve(textResult(msg))` (or `textResult` directly for sync)
4. Add a test in the corresponding `test/<tool>.test.ts` that creates a mock pi, calls the tool, and asserts on the result
5. If the new tool is gated by a disable contract (e.g. monitor / native-task / workflow), check `index.ts` and `*.test.ts` to confirm the disabled call sites are no-ops and the tool is unregistered
6. Update `userflow/<related>.md` to document the new flow

## See also

- `src/AGENTS.md` — types and stores
- `src/commands/AGENTS.md` — slash-command equivalent
- `src/runtime/AGENTS.md` — runtimes tools call into
