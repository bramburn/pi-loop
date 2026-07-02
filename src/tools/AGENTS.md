# `src/tools/` — pi Tool Registration

Tools are the agent-facing API surface. Each file exports a single `registerXxxTools(options)` function that wires the tool definitions on an `ExtensionAPI`.

## Files

- `loop-tools.ts` — `LoopCreate`, `LoopList`, `LoopDelete`, `LoopUpdate`. The four CRUD operations.
- `monitor-tools.ts` — `MonitorCreate`, `MonitorList`, `MonitorStop`, `MonitorDelete`.
- `native-task-tools.ts` — `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskDelete`, `TaskPrune`. Only registered when pi-tasks is absent (after a 6s fallback window).

## Conventions

- **Typebox schemas** — every tool parameter schema is a `Type.Object({...})` with `description` strings. The descriptions are shown verbatim to the LLM; they double as inline docs. Keep them accurate and specific.
- **Prompt guidelines** — every tool that benefits from LLM-facing context (when to use, when not to use) should populate `promptGuidelines`. `LoopCreate` is the canonical example.
- **Triggers as parsed objects, not strings** — `LoopCreate.execute()` parses the `trigger` string into a `Trigger` variant via `parseInterval` + `inferTriggerType`. The store only sees parsed objects.
- **No try/catch around `pi.sendMessage` or `pi.events.emit`** — let exceptions propagate to the harness, which logs them.
- **Tool result text** — always use `textResult(msg)` helper. Keep the message under ~10 lines, with the key facts (id, status, next steps) up top.

## Cross-cutting concerns

- **LoopDelete is overloaded** — supports `action: "delete" | "pause" | "resume"`. Pause and resume are no-ops on already-paused/active loops respectively.
- **LoopUpdate re-arms the trigger** — when the trigger changes, `triggerSystem.remove(id)` runs first, then the new trigger is added. Don't skip the remove: stale cron/event subscriptions will leak.
- **MonitorDelete bypasses the 30s auto-prune** — it stops the monitor if running, then immediately removes it from the store.
- **Native task tools fire `tasks:*` events** — the `emitNativeTaskEvent` helper in `runtime/task-events.ts` does this. Always emit on state change so pi-tasks subscribers see updates.
- **Subject length** — `TaskCreate` accepts up to 80 chars in the schema. `tasks-command.ts` also truncates to 80. Don't change this without updating both.

## When adding a new tool

1. Add the `pi.registerTool({...})` block in the appropriate file
2. The schema must use `Type.Object` with descriptions
3. The execute function returns `Promise.resolve(textResult(msg))` (or `textResult` directly for sync)
4. Add a test in the corresponding `test/<tool>.test.ts` that creates a mock pi, calls the tool, and asserts on the result
5. Update `userflow/<related>.md` to document the new flow

## See also

- `src/AGENTS.md` — types and stores
- `src/commands/AGENTS.md` — slash-command equivalent
- `src/runtime/AGENTS.md` — runtimes tools call into
