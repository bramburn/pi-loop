# `src/commands/` — Slash Commands

Slash commands are the agent-facing menu surface, registered via `pi.registerCommand("name", handler)`. They complement the tool surface with interactive `ui.select` / `ui.input` flows.

## Files

- `loop-command.ts` — `/loop [interval] [prompt]` and the interactive top-level menu. Also registers `/loop-resume <id>` (one-shot: re-arms AND writes the bindings file in one call) and `/loop-resume` (no args: opens the governor picker with checkbox rows reflecting per-session binding state, sentinels `< OK` / `< Continue` / `< Cancel`).
- `loop-fire-command.ts` — `/loop-fire [id]`. One-shot: injects a stored loop's `prompt` as a fresh user message via `pi.sendUserMessage`. No args opens a single-select picker over all stored loops (active and paused) with a `< Cancel>` sentinel. Id form requires a numeric id; non-numeric or unknown ids error out. Sends plain `entry.prompt` only (no `[pi-loop]` wrapper, no `loop:fire` event, no `fireCount` bump) — a manual out-of-band trigger, not a counted fire. When the agent is idle, the message is delivered immediately and triggers a turn; when busy, it is queued with `deliverAs: "followUp"` so it lands after the current run.
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
- **`/loop-settings` reads fresh settings on every call** — the handler in `commands/settings-command.ts` calls `load(getCwd())` per invocation (no module-level cache), so changes to `.pi/pi-loop-settings.json` between menu opens are reflected immediately. This is consistent with `getFlushThresholds` in `index.ts` reading fresh settings per heartbeat tick (rec #1: settings staleness fix).
- **Display-only fields are not cycle-editable** — the `urgentFlushThresholds` setting displays all four sub-values (`defer`, `normal`, `urgent`, `critical` in human-readable form like `defer:24h normal:5m urgent:30s critical:0s`), but only `defer` cycles. Editing `normal` / `urgent` / `critical` requires the JSON file. See ADR-005 for the rationale.

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
