# `src/commands/` — Slash Commands

Slash commands are the agent-facing menu surface, registered via `pi.registerCommand("name", handler)`. They complement the tool surface with interactive `ui.select` / `ui.input` flows.

## Files

- `loop-command.ts` — `/loop [interval] [prompt]` and the interactive top-level menu. Also registers `/loop-resume <id>` (one-shot: re-arms AND writes the bindings file in one call) and `/loop-resume` (no args: opens the governor picker with checkbox rows reflecting per-session binding state, sentinels `< OK` / `< Continue` / `< Cancel`).
- `tasks-command.ts` — `/tasks [subject]` and the native task viewer.
- `monitors-command.ts` — `/monitors` for managing background processes.

## Conventions

- **Bare invocation shows a menu** — `/loop` and `/tasks` (no args) show a top-level menu. `/monitors` always shows the list. The menu pattern is the same: `ui.select("Title", ["Option 1", "Option 2", "< Back"])`.
- **`< Back` is a sentinel** — the actions list for a selected item always includes `< Back` to return to the previous menu. `ui.select` returning `undefined` or `< Back` short-circuits the action.
- **Trim args before interpreting** — `args.trim()` then check `!trimmed` for the menu case.
- **Recursion for navigation** — `viewX(ui)` calls itself after an action so the user can navigate multiple items without returning to the menu.
- **Notify, don't return** — commands communicate results via `ui.notify(level, msg)` rather than returning a value. The handler returns void.
- **Don't tie command UX to tool UX** — commands can have their own copy and flow that differs from the tool descriptions.

## Cross-cutting concerns

- The commands share store references via the `getXxx()` getters passed in `LoopCommandOptions` / `TasksCommandOptions` / `MonitorsCommandOptions`. This is the same pattern the tools use.
- `updateWidget()` is called after every mutation so the status bar reflects the new state.
- The native tasks command is only registered when `pi-tasks` is absent (after the 6s fallback window). Don't assume it's always present.

## When adding a new command

1. Create a new file with `registerXxxCommand(options)` that takes the extension API and the resources it needs
2. The handler signature is `async (args: string, ctx: ExtensionCommandContext) => void`
3. The command description goes to the LLM as part of the slash-command help — keep it under 100 chars
4. Add tests in `test/<command>-command.test.ts` that mock the UI (`select`, `notify`, `input`) and assert on the calls
5. If the command mirrors a tool, consider whether the user could do the same thing with the tool — prefer the tool for programmatic use, the command for human-driven exploration

## See also

- `src/AGENTS.md` — core types and stores
- `src/tools/AGENTS.md` — tool counterpart
- `src/runtime/AGENTS.md` — runtimes the commands call into
