# PRD — `pi-loop` sub-agent execution model

> **Status:** Draft v2 (research + decision rounds complete, implementation not started)
> **Branch:** `pi-subagent`
> **Author:** Mavis (research agent) on behalf of `@bramburn`
> **Date:** 2026-08-18
> **Word target:** 12k–18k words
>
> **Amendments from decision rounds (2026-08-18, applied to this v2):**
> - **Dropped `role` field entirely.** No built-in roles. Users write the role description into the loop's `prompt` themselves. The `LoopSubAgentConfig` type is gone.
> - **Default toolset: full surface, no `subagent` tool.** A sub-agent loop iteration gets every tool the parent has, plus all skills, with the `subagent` tool explicitly denied (so the child cannot recursively spawn).
> - **All new loop fields are optional.** `goal`, `successCriteria`, `failureCriteria`, `stateFile` are all optional; the runtime is permissive. No required-for-sub-agent field.
> - **New `/loop-subagent` parallel slash command.** A new sub-command parallel to `/loop` that creates a sub-agent loop. Same `<interval> <prompt>` form, plus the new flags. The `--isolation` flag is no longer the recommended way to opt in; the slash command is.
> - **No global cost ceiling.** Per-loop `subAgent.maxTokens` is the only token gate. The session-level `costCeilingUsd` setting is gone.
>
> The detailed amendment notes (what was kept, what was dropped, and why) are in Appendix D at the end of this document. The companion spec sheets in `docs/PRD/sub-agent-specs.xlsx` reflect these decisions; this PRD has been brought into alignment.
>
> **Companion artefacts:**
> - Vendored reference clone: `research-wt/pi-subagents/` (read-only)
> - Perplexity research notes: `research-wt/notes/research-perplexity-{1..5}.md`
> - Decision matrices: `docs/PRD/sub-agent-questions.xlsx` (round 1, 18 questions), `docs/PRD/sub-agent-questions-r2.xlsx` (round 2, 4 follow-ups)
> - Spec sheets: `docs/PRD/sub-agent-specs.xlsx` (7 sheets, 55 implementation requirements)
> - Architecture decision records this PRD proposes to author or amend: `docs/plan/ADR-006-sub-agent-execution.md` (new), `docs/plan/ADR-005-priority-queue.md` (amend)

---

## 1. Executive summary

`pi-loop` v2.x fires a wake into the current pi session every time a `LoopEntry`'s trigger matches. That wake is delivered through `LoopCreate` → trigger system → priority queue → `pi.sendMessage()` and inherits the parent session's full context window. For short, well-scoped loops this is fine. For long-running loops — recurring nightly audits, multi-hour background monitors, batch work that needs to span process restarts — the parent context window fills up with prior iteration artefacts, the wake arrives interleaved with whatever the user is doing, and the loop competes with foreground work for tokens.

This PRD proposes a new execution mode for loops: **sub-agent mode**. When a loop is in sub-agent mode, each fire launches a fresh, isolated child pi session with its own context window, runs the loop's prompt there, and surfaces a structured result back to the parent. The parent never sees the intermediate tool calls; only the final result (and the wake). The child writes its work to a durable, scoped directory so the loop survives parent process restarts. A bounded concurrency limit and a per-loop token budget prevent runaway cost.

The reference implementation we are studying — `pi-subagents` v0.50.0 — already provides almost every primitive this PRD needs (`background-work` provider, mission records, schedules, retained children, in-process RPC, `subagent_wait`, intercom bridge). The PRD's plan is therefore not "build all of this" but rather "wire the existing primitives into `pi-loop`'s trigger / wake / notification pipeline, and add the small set of glue modules we still need" (e.g. a per-loop child-process spawn adapter, a per-loop sub-agent result watcher, an isolation-mode flag on `LoopEntry`).

The net effect for the user:

- A new `/loop-subagent <interval> <prompt>` slash command (parallel to `/loop`) creates a sub-agent loop. The next time it fires, the parent session is not woken — instead a child session is spawned, the loop's prompt runs there, and the parent only sees a one-line summary when it next becomes idle.
- A sub-agent iteration's child session has the full tool surface the parent has, plus all skills, with the `subagent` tool explicitly denied (so the child cannot recursively spawn). Users who want a more restricted child can set `subAgent.tools` per-loop.
- Sub-agent runs survive process restarts: the child session is durable on disk, the result is durable, and the parent's pending notifications are durable.
- A new sub-agent TUI panel (modeled on `pi-subagents` FleetView) shows live progress for all active sub-agent loops, separate from the existing `LoopWidget`.
- Per-loop token budgets, iteration caps, and wall-clock timeouts are enforced before the child spawns and observed while it runs. There is no global cost ceiling (per-loop `subAgent.maxTokens` is the only token gate).
- Optional `goal`, `successCriteria`, `failureCriteria`, and `stateFile` fields let a user describe the loop's purpose, what counts as success / failure, and a small JSON file the child reads/writes for cross-iteration state. All four are optional; the runtime is permissive when they're missing.
- The existing `loopScope: "memory" | "session" | "project"` setting on `LoopEntry` keeps working — sub-agent mode is orthogonal to scope, and a loop can be `scope: "project"` AND `isolation: "sub-agent"`.

The non-goals are equally important: this PRD does **not** try to replace `pi-subagents`, does not implement a workflow engine, does not invent a new language for chained agents, does not ship a built-in `role` taxonomy (the user writes the role description into the loop's `prompt` themselves), and does not force every loop into sub-agent mode. It is an opt-in execution mode for loops that need their own context window.

---

## 2. Background and motivation

### 2.1 The current `pi-loop` v2.x architecture

`pi-loop` v2.x is a pi extension that schedules, fires, and delivers loop wakes inside the same pi session that owns the loop store. The end-to-end pipeline is:

```
LoopEntry → trigger system (cron | event | hybrid)
          → onLoopFire() emits "loop:fire" event
          → LoopReducer appends a ReducerNotification to the in-memory queue
          → notification-runtime coalesces by loop id + priority
          → on agent_end or turn_start, dispatchUrgentFlush() / flushPendingNotifications() drain the queue
          → deliverNotification() builds a wake message and calls pi.sendMessage()
          → the agent reads the wake, runs the loop's prompt, calls LoopCreate / LoopUpdate to schedule the next fire
```

The pipeline is intentionally simple and lives entirely in the parent session. Every iteration of every loop pushes a turn into the parent's conversation history. For loops that fire every 5 minutes, that is 288 turns per day, each carrying the loop's prompt, the prior iteration's tool calls and outputs, and the agent's reasoning about the iteration.

The full conversation history is also what the model sees on every subsequent turn, so the loop's noise accumulates into the parent's context window. Two real failure modes follow:

1. **Context exhaustion from the loop itself.** A loop that runs a long prompt with many tool calls (e.g. "check every TS file for unused exports") can produce a single wake of 30k–50k tokens. After 10 fires the parent context window is meaningfully degraded even if the user has not asked for any of that work.
2. **Wake interleaving with foreground work.** A `critical` loop firing while the user is mid-task still re-enters the parent as a turn. The user sees a tool-call transcript and a wake. Even with priority flushes (see ADR-005), the wake is delivered as a turn, not as a background event.

The priority queue (ADR-005) makes the *delivery* of wakes more orderly, but it does nothing for the *content* of the wake. The wake still carries whatever the loop's last iteration did. Sub-agent execution mode is the missing piece: it moves the *content* of each iteration out of the parent context entirely.

### 2.2 What "sub-agent" means in this PRD

A "sub-agent" in this PRD is a fresh, isolated pi session spawned by the loop at fire time. The fresh session has:

- Its own session file (so its conversation history is durable and queryable independent of the parent).
- Its own model + thinking settings, inherited from the loop's `LoopEntry` (a loop with `model: "haiku"` runs in haiku; a loop with no model override inherits the parent's).
- A scoped tool allowlist — the loop's `tools` field, if set, is the child's tool allowlist; otherwise the child gets a sensible default (read, grep, find, ls, edit, write, bash with bounded timeouts).
- No access to the parent's session file, the parent's conversation history, the parent's other loops, or the parent's notifications queue.
- No `pi-loop` itself — the child is a plain pi session, not a sub-extension.

When the child finishes, three things happen:

1. The child writes a structured `result.json` (or, on failure, a `result-failed.json`) to a per-loop, per-iteration directory.
2. A short summary is queued for the parent's notification queue, tagged with the loop id, the iteration number, and a link to the result file.
3. The parent's existing priority-queue / flush mechanism delivers the summary on the next idle turn (or immediately for `critical`).

The parent agent, when it next becomes idle, sees something like:

> Sub-agent loop #4 (worker, "Audit migration patterns") completed in 12m 04s. Tokens: 14,221 in / 3,108 out. Result: `.pi/loops/sub-agent-results/4/iter-128/result.md`. Status: succeeded.

…and nothing else. The intermediate tool calls, the bash transcripts, the model reasoning, all stay inside the child's session file.

### 2.3 What the user said they want

The user's original framing: "we want to setup ways for loops that runs in iteration to have its own context window, but run the loop prompt that we have drafted." They are unsure whether the solution uses tmux, a child process, or "something like that," and explicitly asked for research before implementation. The clarifying question is which execution model maps best to `pi-loop`'s existing architecture; this PRD answers that by adopting the model `pi-subagents` v0.50.0 has already validated, and adapting it to fit the loop / trigger / wake pipeline `pi-loop` already has.

### 2.4 Why not just "use pi-subagents"?

A reasonable first reaction: why not just delegate sub-agent work to `pi-subagents`? Three reasons:

1. **Loop semantics differ from one-shot sub-agents.** A loop has persistent state (the `LoopEntry`), a scheduler, a wake queue, and a per-loop priority. A `pi-subagents` workflow is one-shot. Mapping loop semantics onto workflowScript loses the trigger system, the priority queue, and the per-session bindings.
2. **The user wants this in `pi-loop`, not as a composition.** The user's own v2.0 design already includes a "future" note in `src/runtime/session-runtime.ts` and `src/types.ts` that anticipates sub-agent execution. Wiring it into `pi-loop`'s own pipeline keeps the tool set, the widget, the settings, and the persistence layer coherent.
3. **Avoiding the "two orchestrators" footgun.** Having two competing systems that both want to wake the parent creates priority ambiguity, race conditions, and a doubled notification surface. The PRD's plan is to *re-use* `pi-subagents`'s public surface (`./background-work`, `./intercom-bridge`, etc.) where it is genuinely the right primitive, and to *not duplicate* it where the loop's own pipeline is enough.

---

## 3. Goals, non-goals, and success criteria

### 3.1 Goals

- **G1.** A new `/loop-subagent <interval> <prompt>` slash command (parallel to `/loop`) creates a loop whose fires run in a fresh child session with its own context window. The loop is tagged with `isolation: "sub-agent"` in the store. The existing `/loop` command can also create a sub-agent loop via an `--isolation sub-agent` flag for users who prefer the flag form.
- **G2.** A sub-agent iteration's intermediate tool calls, model reasoning, and bash transcripts **never** enter the parent session's context window. Only a one-line summary does.
- **G3.** A sub-agent iteration that runs longer than the parent process is alive (parent process restart, parent crash, machine sleep) **resumes** when the parent restarts and reports its result into the parent when the parent next becomes idle.
- **G4.** A loop in sub-agent mode is bounded by: a maximum number of active concurrent iterations across all sub-agent loops, a per-loop maximum iterations, a per-loop token budget, and a per-iteration wall-clock timeout.
- **G5.** The parent agent can see live progress for all active sub-agent iterations in a new TUI panel (FleetView-style) without leaving the editor.
- **G6.** Sub-agent runs are inspectable: a slash command lets the user open the child session file, the result file, the cost report, or the prompt that was sent.
- **G7.** Sub-agent mode is opt-in. A loop with no `isolation` field behaves exactly as in v2.x. Migration is a no-op for existing loops.
- **G8.** Optional `goal`, `successCriteria`, `failureCriteria`, and `stateFile` fields on `LoopEntry` let a user describe the loop's purpose and what counts as success / failure, and let the child read/write a small JSON file across iterations. All four are optional; the runtime is permissive when they're missing.
- **G9.** When `pi-subagents` is installed and the user wants richer orchestration (parallel reviewers, mission-level goal driver, multi-agent workflows), the bridge registers `pi-loop`'s sub-agent iterations as a `BackgroundWorkProvider` so they appear in `/subagents-fleet` and `subagent_wait`. This is opt-in via the `subAgent.registerBackgroundWorkProvider` setting (default true).

### 3.2 Non-goals

- **N1.** This PRD does **not** replace `pi-subagents`. If a user wants full sub-agent orchestration (multi-agent fanout, supervisor intercom, mission goals with budgets), they install `pi-subagents` separately.
- **N2.** This PRD does **not** introduce a new workflow language. Scripted workflows, parallel reviewers, chain execution, etc. all remain `pi-subagents`'s responsibility.
- **N3.** This PRD does **not** add tmux as a dependency. tmux is Unix-only and the user is on Windows; even on Unix, a child process with its own session file is the cleaner abstraction (we will discuss why in §7).
- **N4.** This PRD does **not** change the trigger system. Cron, event, and hybrid triggers fire exactly as before. The change is what happens *after* the trigger fires.
- **N5.** This PRD does **not** change the priority queue or the delivery mechanism. The result of a sub-agent iteration is delivered as a `ReducerNotification` through the existing priority queue.
- **N6.** This PRD does **not** invent a new persistence scope. Sub-agent results live under the existing `loopScope` (project | session | memory). A `project`-scoped sub-agent's results live under the project's `.pi/loops/sub-agent-results/`.
- **N7.** This PRD does **not** force `pi-subagents` to be installed. Sub-agent execution in `pi-loop` is implemented directly, with optional integration hooks for `pi-subagents` when it is present (registered via the same `Symbol.for` background-work provider pattern).

### 3.3 Success criteria

- A `/loop-subagent weekly monday 09:00 "Survey the changelog"` followed by a process restart mid-iteration correctly reports the iteration's outcome to the parent on next idle.
- Running 10 concurrent sub-agent loops with overlapping triggers never exceeds the configured active-iteration cap (default 4).
- A sub-agent loop that exceeds its per-iteration wall-clock timeout (default 10 min) is killed, the result is marked `failed` with reason `timeout`, and a `priority: "urgent"` notification is delivered.
- A sub-agent iteration that completes successfully within budget surfaces a one-line summary (200 chars for normal/urgent/defer; up to 1 KiB for critical) on the parent's next idle; the intermediate tool calls stay in the child's session file.
- A sub-agent loop with `successCriteria` set transitions to `status: "completed"` when the criteria match (or when `subAgent.maxIterations` is reached), whichever comes first. A loop without `successCriteria` never auto-completes.
- A user issuing `LoopList` while 3 sub-agent loops are running sees each loop's active iteration count, last result status, and cumulative tokens, in addition to the existing loop metadata.
- A user issuing `/loop-sub-agent-inspect <loopId>` opens the child session file in their `$PAGER` with a header showing the prompt, the cost, and the wall-clock duration.
- Existing v2.x tests pass unchanged. New tests cover the new code paths and the failure modes.
- The above on Windows. The architecture must not require POSIX-only primitives.
- With `pi-subagents` installed, sub-agent iterations appear in `/subagents-fleet` and `subagent_wait`; without it, no behaviour change.

---

## 4. Personas and use cases

### 4.1 Personas

- **P1: the surveying-company owner-developer (`@bramburn`)** — runs `pi-loop` today to schedule a small number of project-local loops (nightly build check, hourly "any new exceptions" scan, weekly "stale TODOs" report). The current context-fill problem is annoying but tolerable. The pain is that one of his loops — a "what new tools / extensions / patterns shipped this week" weekly digester — produces 8k–15k tokens of intermediate work and he would rather not see any of it. He wants opt-in sub-agent mode for that loop and only that loop.

- **P2: the long-running batch user** — runs a loop that polls an external API every 5 minutes and reports any non-empty result. With 25 active loops and 5-min intervals, the parent accumulates 7,200 turn-equivalents per day. After 24 hours the model cannot read the user's own conversation without the loop noise crowding it out. They want *all* of their polling loops in sub-agent mode by default, with a single line of config.

- **P3: the multi-machine operator** — runs `pi-loop` on three machines (a desktop, a server, a CI runner) with shared `loopScope: "project"` storage. They want sub-agent iterations started on the server to be visible and inspectable from the desktop. That requires shared child-session files in the project, plus a TUI panel that reads the same files over the network or via a sync mechanism. (Stretch goal — addressed in §15.)

- **P4: the open-source maintainer downstream** — installs `pi-loop` and uses the existing `/loop` UX. They should not see a behaviour change unless they explicitly opt in to sub-agent mode. They should not see any new tool, setting, or widget by default. The new `isolation` field is fully optional.

### 4.2 Use cases

#### UC-1: a weekly digester loop moves to sub-agent mode

`@bramburn` runs:

```
/loop-subagent weekly monday 09:00 "Survey the .pi/ extension changelog and produce a 1-page digest of new features" --goal "weekly changelog digest" --success-criteria "the result.md contains a 'New features' section with at least 3 entries" --max-tokens 30000 --model sonnet
```

Behaviour:

- The handler creates a `LoopEntry` with `isolation: "sub-agent"`, `goal: "weekly changelog digest"`, `successCriteria: "..."`, `subAgent: { model: "sonnet", maxTokens: 30000 }`.
- The loop fires every Monday at 09:00 (in `loopScope: "project"`, the trigger re-arms on process restart).
- At fire time, `pi-loop` spawns a child pi process: `pi --session-file .pi/loops/sub-agent-results/3/iter-42/session.jsonl --prompt @.pi/loops/sub-agent-results/3/iter-42/prompt.txt --model sonnet --non-interactive --no-extensions`. The child gets the parent's full tool surface (read, grep, find, ls, edit, write, bash) minus the `subagent` tool.
- The child reads the changelog directory, drafts a 1-page digest, writes the digest to `.pi/loops/sub-agent-results/3/iter-42/result.md`, and exits.
- The parent reads the child's session file tail and writes `result.json` with `{ status: "succeeded", tokens: { in: 11200, out: 1840 }, durationMs: 720400, costUsd: 0.18, resultPath: "result.md" }`.
- The parent applies the `successCriteria` regex against `result.md`; the result matches, so the iteration is marked `succeeded-by-criteria` and the loop is now eligible for `status: "completed"` (it will complete when the cap is hit or on the next `agent_end`, whichever is configured).
- The parent queue adds a `priority: "normal"` notification tagged with loop id `3`, iteration `42`, the result path, and a one-line summary: `Sub-agent loop #3 iter-42 done in 12m · sonnet · 13,040 tok · succeeded. See \`result.md\`.`
- On the parent's next `agent_end`, the parent sees the notification, reads `result.md` if it wants, and announces the digest.
- The parent's conversation history shows *one* line per weekly iteration, not the 11k tokens of intermediate work.

#### UC-2: a long-running monitor survives a parent crash

A loop with `trigger: "cron: */2 * * * *"`, `isolation: "sub-agent"`, `subAgent.maxIterations: 720` is running on `@bramburn`'s server. At 03:14 UTC the parent process is killed (machine sleep, OOM, or `Stop-Process`). At 07:00 UTC the parent restarts.

Behaviour on restart:

- The `LoopStore` reloads `LoopEntry` #5 from `.pi/loops/loops.json`. The loop is still active and bound to this session.
- The `SessionRuntime` heartbeat re-arms the cron trigger.
- The `SubAgentRunWatcher` reads `.pi/loops/sub-agent-results/5/` and finds that iteration #137 is `status: "running"` and its `lastHeartbeatAt` is 03:11 UTC — older than the configured stale threshold (default: 5 min).
- The watcher marks iteration #137 `status: "orphaned"`, sends a SIGTERM-equivalent to the child (best-effort, by stored pid), and lets the next cron tick start iteration #138.
- The result file is updated with a final `orphaned` reason and tokens consumed so far.
- Iteration #138 spawns fresh, with the prior digest not in its context (fresh session file).
- The parent, on its next idle, surfaces two notifications: "iteration 137 orphaned at 03:14, lost ~3,400 tokens" and "iteration 138 succeeded in 11m, see result".

#### UC-3: a user inspects an iteration in their pager

A user is curious what loop #4 actually did in its last iteration. They run `/loop-sub-agent-inspect 4` (or `LoopInspect({ loopId: "4" })`). The TUI shows:

```
Loop #4 — "Audit migration patterns"
  Goal: ensure no audit regressions land
  Last iteration: 128, status: succeeded-by-criteria
  Started: 2026-08-18 09:00:00
  Duration: 12m 04s
  Tokens: in=14221, out=3108, total=17329
  Cost: $0.214
  Prompt sent: .pi/loops/sub-agent-results/4/iter-128/prompt.txt (484 chars)
  Result: .pi/loops/sub-agent-results/4/iter-128/result.md
  Child session: .pi/loops/sub-agent-results/4/iter-128/session.jsonl

[ Open result ]  [ Open session ]  [ Open prompt ]  [ Back ]
```

Selecting `Open result` shells out to `$PAGER` (or `code` on Windows) with the result file. The user reads it, marks the loop as done with `LoopDelete`, or schedules a follow-up.

#### UC-4: a budget-exhausted loop pauses itself

A loop with `subAgent.maxTokens: 100000` runs in sub-agent mode and has consumed 100,142 tokens over 8 iterations. The 9th iteration is about to start, but the budget check in the scheduler blocks the spawn and emits a `priority: "urgent"` notification: "Loop #5 budget exhausted (100,142/100,000 tokens used). Iteration 9 deferred until budget is raised. Use `LoopUpdate({ subAgent: { maxTokens: 200000 } })` to resume." The loop is marked `status: "paused_budget"` in the store. The agent, on its next idle, sees the urgent notification, decides whether to raise the budget or delete the loop, and acts.

#### UC-5: a watchdog loop uses `critical` priority to surface security-relevant findings

A loop with `trigger: "event: tool_execution_start, filter: regex:auth|password|secret"`, `isolation: "sub-agent"`, `priority: "critical"` watches every tool execution. When the filter matches, the loop fires; the spawn is allowed to interrupt the parent's currently-running turn (provided the parent is not itself in a loop wake); the child summarizes the tool call in 1–2 sentences and writes a "possible secret leak" result; the parent's `REQUEST_URGENT_FLUSH` dispatches the result immediately (because the loop is `critical`); the parent agent reads the result on the next beat, alerts the user, and the user decides what to do. The full transcript of the child stays in the child's session file; the parent context shows one line.

#### UC-6: a generic loop with no role, no criteria, no state file

A user creates the simplest possible sub-agent loop:

```
/loop-subagent every 30m "Check the GitHub API for new issues labelled 'priority: high' on the upstream repo, list the titles."
```

The loop has no `goal`, no `successCriteria`, no `failureCriteria`, no `stateFile`. It just runs the prompt every 30 minutes. The child gets the full tool surface, runs to completion, and writes `result.md`. The parent sees a one-line summary and the `result.md` path. The loop never auto-completes (no `successCriteria`), never pauses (no `failureCriteria` or `maxTokens`), and the parent has no state to read between iterations. This is the lowest-friction entry point: a sub-agent loop is just a `/loop` that runs in a child process with its own context window.

#### UC-7: a loop that maintains state across iterations

A user creates a loop that tracks which files it has audited:

```
/loop-subagent every 6h "Audit one untested file from src/. Mark it as done in the state file." \
  --state-file .pi/loops/3/audit-state.json \
  --max-iterations 50 \
  --success-criteria "the state file lists all files in src/"
```

The child reads the state file at the start of each iteration, picks the next untested file, audits it, and writes the file's name back to the state file. The state file is locked while the child runs; the parent takes the lock after a 5s stale threshold. When the state file lists all `src/` files, the loop's `successCriteria` matches and the loop auto-completes.

---

## 5. Architectural overview

### 5.1 Where the new code lives

```
src/
├── types.ts                  # extend LoopEntry with `isolation`, `subAgentConfig`
├── settings.ts               # add `subAgent: { activeIterationsMax, iterationTimeoutMs, ... }`
├── tools/
│   └── loop-tools.ts         # add `LoopInspect` tool; extend `LoopCreate` schema
├── commands/
│   ├── loop-command.ts       # add `/loop-sub-agent-inspect`
│   └── loop-edit-command.ts  # render the new `isolation` field in the cyclic editor
├── runtime/
│   ├── session-runtime.ts    # add SubAgentRunWatcher arm in heartbeat
│   ├── sub-agent/
│   │   ├── spawn.ts          # child-process spawn adapter (cross-platform)
│   │   ├── result-watcher.ts # watches the result inbox, drives notifications
│   │   ├── result-store.ts   # file-backed store of iteration results
│   │   ├── cost-tracker.ts   # per-loop token / cost ledger
│   │   ├── scheduler.ts      # concurrency cap, budget gate, retry policy
│   │   ├── inspector.ts      # read iteration artefacts for /loop-sub-agent-inspect
│   │   └── child-pid.ts      # owned-process tree, cross-platform kill
│   └── notification-runtime.ts # teach the queue about sub-agent result notifications
├── ui/
│   ├── widget.ts             # add a small "active sub-agents" indicator (or new widget)
│   ├── sub-agent-fleet.ts    # FleetView-style TUI panel for active iterations
│   └── widget-render.ts      # render the new state field
└── docs/PRD/sub-agent.md     # this file
```

The total new source is small — about 800–1,200 LOC of TS plus tests. The reason it stays small is that the heavy lifting is done by:

- The existing `LoopStore` (file-backed CRUD with file locking — no new persistence).
- The existing `LoopReducer` (event-sourced state machine — one new action: `LOOP_SUB_AGENT_RESULT`).
- The existing `NotificationRuntime` (priority queue — the new notification is just a `ReducerNotification` with a new `kind: "sub-agent-result"`).
- The existing `LoopWidget` and its render helpers (the FleetView panel is a sibling of the existing widget, not a rewrite).
- The child pi process, which is an unmodified `pi` binary (or `pi-coding-agent` shim) launched with `--session-file <path> --prompt <file>`.

### 5.2 The data flow at fire time

```
  LoopEntry #N
       │
       │ cron / event / hybrid trigger matches
       ▼
  trigger-system fires
       │
       ▼
  onLoopFire(N)
       │
       ├── if N.isolation === "sub-agent"   ◀──── NEW BRANCH
       │       │
       │       ├── SubAgentRunScheduler.gate({ loop: N, now })
       │       │     ├── check concurrency cap (active < subAgent.activeIterationsMax)
       │       │     ├── check per-loop iteration cap (count < loop.maxIterations)
       │       │     └── check per-loop token budget (cumulativeTokens + estimatedNext < loop.maxTokens)
       │       │
       │       ├── if gate fails → enqueue a `defer` notification tagged with reason
       │       │                    ("concurrency_cap" | "iteration_cap" | "budget_exhausted")
       │       │
       │       └── if gate passes →
       │             ├── resultStore.nextIterationId(N)
       │             ├── write iteration manifest: { loopId, iterationId, startedAt, prompt, model, tools, ... }
       │             ├── costTracker.open(N, iterId)
       │             └── spawnChild(pi --session-file ... --prompt ... --model ... --tools ...)
       │                   │
       │                   ├── spawn() returns a child handle (pid, stdio, childSessionRoot)
       │                   ├── on child exit → costTracker.close(...), resultStore.finalize(...)
       │                   └── on child output → resultWatcher.observe(...), notificationQueue.enqueue({ kind: "sub-agent-result", ... })
       │
       └── else  (current v2.x branch, unchanged)
```

The "else" branch is the existing v2.x code path. The new branch is purely additive.

### 5.3 The data flow at parent wake

```
  child pi process exits
       │
       ▼
  spawn.ts child_exit handler
       │
       ├── resultStore.finalize({ loopId, iterId, status: "succeeded" | "failed" | "timeout", exitCode, processSignal, ... })
       ├── costTracker.close({ loopId, iterId, tokens, costUsd, durationMs })
       │
       ├── if status === "succeeded" or "failed" (and final result is durable):
       │     └── notificationRuntime.enqueue({
       │           kind: "sub-agent-result",
       │           loopId, iterId,
       │           priority: loop.priority ?? "normal",
       │           preview: buildOneLineSummary(...),
       │           artifactPath: result.resultPath,
       │           sessionPath: result.childSessionPath,
       │         })
       │
       └── heartbeat tick (every 30s) flushes via the existing priority queue
```

The notification enters the existing priority queue with the loop's configured priority. The `REQUEST_URGENT_FLUSH` path in `notification-runtime.ts` (added in v2.0 per ADR-005) handles the urgent/critical cases. The `agent_end` path handles the normal/defer cases. No new wake mechanism.

### 5.4 What the parent actually sees

The `preview` string is built by `formatSubAgentResult()` and is intentionally one line, < 200 characters. Example:

> Sub-agent #4 iter-128 done in 12m · sonnet · 17,329 tok · succeeded. See `.pi/loops/sub-agent-results/4/iter-128/result.md`.

For `priority: "critical"` loops, the preview includes the loop's `criticalSummary` (a one-sentence summary of the result) so the parent can act without reading the file. Example:

> Sub-agent #7 iter-9 (critical): Secret found in commit 4f3a1b (`src/auth/jwt.ts:42`). Result: `.pi/loops/sub-agent-results/7/iter-9/result.md`.

The full result file is referenced, not inlined.

---

## 6. The loop → sub-agent model

### 6.1 The `LoopEntry` extension

```ts
// src/types.ts (additions, not replacements)
// All new fields are OPTIONAL. Missing means "use the default".
// Backwards-compatible: existing v2.x loops load unchanged.

export type LoopIsolation =
  | "in-process"   // v2.x default; wake is a turn in the parent session
  | "sub-agent";   // wake is a one-line summary; full work runs in a child session

export interface LoopSubAgentConfig {
  /** Model for the child. Omit to inherit the parent's model. */
  model?: string;
  /** Thinking level for the child. Omit to inherit. */
  thinking?: "off" | "low" | "medium" | "high";
  /**
   * Tool allowlist for the child. Omit to use the parent's full tool surface
   * MINUS the `subagent` tool (which is always denied, to prevent recursion).
   * Use this field to restrict the child to a smaller toolset.
   */
  tools?: readonly string[];
  /** Wall-clock timeout for one iteration. Default 10 min. */
  iterationTimeoutMs?: number;
  /** Soft token budget per iteration. Default 30,000 in + 6,000 out. */
  iterationTokenBudget?: { in: number; out: number };
  /** Hard cumulative token budget across all iterations of this loop. */
  maxTokens?: number;
  /** Max number of iterations. Omit for unlimited. */
  maxIterations?: number;
  /** Working directory for the child. Defaults to the parent's cwd. */
  cwd?: string;
  /** Whether the child should run `git fetch` / `git pull` before its task. Default false. */
  syncGit?: boolean;
  /** Tags the child's session file with a label for FleetView. */
  label?: string;
  /** How many iterations to keep on disk before pruning. Default 50. */
  retainIterations?: number;
}

export interface LoopEntry {
  // ... existing fields ...
  isolation?: LoopIsolation;             // default "in-process"

  // Optional self-description fields. All four are independent; any
  // combination is allowed. The runtime is permissive when they're missing.
  goal?: string;                        // the loop's purpose; documentation, not evaluated
  successCriteria?: string;             // regex matched against result.md
  failureCriteria?: string;             // regex matched against result.md
  stateFile?: string;                   // path to a JSON file the child reads/writes
  subAgent?: LoopSubAgentConfig;         // only meaningful when isolation === "sub-agent"
}
```

The new fields are entirely optional. Existing loops loaded from `.pi/loops/loops.json` without these fields default to `isolation: "in-process"`, exactly matching v2.x behaviour. New loops with no `goal` / `successCriteria` / `failureCriteria` / `stateFile` are valid; the runtime treats their absence as "no special behaviour".

There is **no `role` field.** Round 2 decision R2-3 (user chose A: no built-in roles) means users write the role description inline in the loop's `prompt` ("You are a code reviewer. Review the diff..."). The `LoopSubAgentConfig` interface has no `role` field, no role-driven tool allowlist, and no role registry. If a user wants `pi-subagents`-style roles, they install `pi-subagents` and use its vocabulary directly; pi-loop's sub-agent mode is generic by design.

### 6.2 Why "in-process" is the default

The default is `in-process` for two reasons:

1. **Compatibility.** Every existing v2.x loop continues to work. The migration is a no-op.
2. **Footprint.** Sub-agent execution spawns a child process per fire. A user with 25 loops firing every 5 minutes would see 7,200 child-process spawns per day. That is fine, but the user must opt in to the cost.

A future setting `subAgent.defaultIsolation: "sub-agent"` could flip the default. This PRD does not ship that; it leaves the door open.

### 6.3 The sub-agent `LoopCreate` schema

The existing `LoopCreate` tool gains the new optional fields. The new `/loop-subagent` slash command is a thin wrapper that calls `LoopCreate({ isolation: "sub-agent", ... })`:

```ts
LoopCreate({
  prompt: string;
  trigger: LoopTrigger;
  isolation?: "in-process" | "sub-agent";   // default "in-process"
  goal?: string;
  successCriteria?: string;
  failureCriteria?: string;
  stateFile?: string;
  subAgent?: LoopSubAgentConfig;
  // ... existing fields (priority, recurring, maxFires, readOnly, autoTask)
})
```

When the user runs `/loop` interactively, the cyclic field form in `loop-edit-command.ts` grows by three new fields: `isolation` (cycles `in-process` → `sub-agent` → `in-process`), `goal` (text input, defaults to empty), and `success-criteria` (text input, defaults to empty). The form is intentionally minimal — most users will use `/loop-subagent` and skip the cyclic form entirely.

### 6.4 The `/loop-subagent` slash command

A new slash command parallel to `/loop` that always creates a sub-agent loop. Same form as `/loop` plus the new flags:

```
/loop-subagent <interval> <prompt>
                [--goal <text>]
                [--success-criteria <text>]
                [--failure-criteria <text>]
                [--state-file <path>]
                [--model <name>]
                [--max-tokens <n>]
                [--max-iterations <n>]
                [--iteration-timeout <ms>]
```

The handler is `src/commands/loop-subagent-command.ts`. It parses the args, validates them, and calls `LoopCreate({ isolation: "sub-agent", ...args })`. The internal `LoopCreate` schema is the source of truth; the slash command is a thin wrapper that sets `isolation: "sub-agent"` and forwards the rest.

The existing `/loop` command is unchanged but accepts `--isolation sub-agent` for users who prefer the flag form. The two commands are equivalent for sub-agent creation; `/loop-subagent` is the recommended form because it makes the intent explicit at the command line.

### 6.5 Trigger semantics are unchanged

A sub-agent loop's `trigger` is identical to a v2.x loop's trigger: cron, event, or hybrid. The trigger fires the same `onLoopFire()` callback. The only difference is the body of the callback.

A subtle implication: a sub-agent loop's "self-paced" mode (no trigger interval) also works. The user runs `/loop-subagent prompt` and the loop fires once. In sub-agent mode, that one fire spawns a child to run the prompt. When the child finishes, the parent is notified. The agent then decides whether to fire another iteration by calling `LoopCreate` again.

---

## 7. Execution model: per-iteration context window

### 7.1 What "its own context window" means

The child pi session has:

- A **fresh session file** at `.pi/loops/sub-agent-results/<loopId>/iter-<N>/session.jsonl`. The session file is created empty at iteration start; only the child's turns go into it.
- **No access to the parent's session file.** The child process is invoked with `--session-file <child-path>`; the parent process does not pass the parent's session file.
- **No `pi-loop` extension loaded.** The child is a plain pi session started with `--no-extensions`. It does not know the loop exists; it does not know it is a sub-agent. It only sees its `--prompt` argument and the model / tools / cwd configuration.
- **Default tool surface: full, minus `subagent`.** The child inherits every tool the parent has, plus all skills, with the `subagent` tool explicitly denied. This is round-2 decision R2-2 (user chose A: full surface, no `subagent` tool) combined with round-1 decision D8 (recursion guard: `--no-extensions` + deny `subagent`). Users who want a smaller toolset set `subAgent.tools: [...]` per-loop; that allowlist replaces the default.

The conversation history visible to the model inside the child is therefore bounded to:

- The system prompt (the child's, inherited from `pi-coding-agent` defaults).
- The skill / memory files in scope (the cwd's `.pi/`, but not the parent's session-bound memory).
- The loop's prompt (passed as the user's first message).
- All the tool calls and outputs the child makes during its own iteration.

That is it. The parent's prior turns, the parent's other loops' wakes, the parent's session notes — none of that is in the child's context.

### 7.2 Why not tmux?

The user asked: "I am unsure if it uses tmux, etc... to run or something like that." The honest answer is: tmux is one valid approach but it is the wrong default for `pi-loop`, for three reasons:

1. **Cross-platform.** tmux is Unix-only. `pi-loop` runs on Windows (the user is on Windows). A child process with its own session file works on every platform Node.js supports. The `spawn.ts` adapter uses `child_process.spawn` with `detached: false` and a `process.kill`-on-cleanup pattern.
2. **The "detached" pattern is not what we want.** tmux's value proposition is keeping a session alive when the parent terminal disconnects. In our case, the parent (the pi session running `pi-loop`) IS the long-lived process; the child is short-lived. There is no need for the child to outlive the parent — in fact, we want the parent to be able to kill orphaned children on restart. `process.kill(child.pid, 'SIGTERM')` does this cleanly.
3. **TTY / PTY is not needed.** The child pi session does not need a TTY. It is invoked headlessly with `--prompt <file>`. `pi-coding-agent` supports this mode already (used by CI runners, `npx pi --prompt "..."`).

That said: there is a future stretch where the user wants the child to be visible in a terminal pane (like `pi-subagents`'s `orcaProgressTabs`). On Windows that maps to Windows Terminal panes via the `wt.exe new-tab` API; on Unix, to tmux or iTerm2 split panes. That is a v3 feature, not in this PRD.

### 7.3 The spawn adapter

```ts
// src/runtime/sub-agent/spawn.ts (sketch)

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SpawnRequest {
  loopId: string;
  iterId: number;
  cwd: string;
  childSessionPath: string;        // .pi/loops/sub-agent-results/<loopId>/iter-<N>/session.jsonl
  promptPath: string;              // .pi/loops/sub-agent-results/<loopId>/iter-<N>/prompt.txt
  model?: string;
  thinking?: "off" | "low" | "medium" | "high";
  tools?: readonly string[];
  iterationTimeoutMs: number;      // hard wall-clock kill
  piBinary: string;                // resolved at boot from settings.subAgent.piBinary
  envOverrides: Record<string, string>;
}

export interface SpawnHandle {
  pid: number;
  childSessionPath: string;
  resultPath: string;
  startedAt: number;
  kill(signal?: NodeJS.Signals): void;
  wait(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

export async function spawnSubAgent(req: SpawnRequest): Promise<SpawnHandle> {
  // 1. Ensure child session file's parent dir exists, then touch the file.
  await fs.mkdir(path.dirname(req.childSessionPath), { recursive: true });
  await fs.writeFile(req.childSessionPath, "", { flag: "a" });

  // 2. Build the argv. We use the long form so the child can be re-entered later.
  const args = [
    "--session-file", req.childSessionPath,
    "--prompt", `@${req.promptPath}`,        // pi's @file syntax for inline prompts
    "--non-interactive",                       // no REPL, exit when done
    "--no-extensions",                         // do not load pi-loop itself
  ];
  if (req.model)     args.push("--model", req.model);
  if (req.thinking)  args.push("--thinking", req.thinking);
  if (req.tools)     args.push("--tools", req.tools.join(","));
  if (req.iterationTimeoutMs) {
    // Pass through to the child's own runtime timeout, plus an outer wall-clock.
    args.push("--max-duration-ms", String(req.iterationTimeoutMs));
  }

  // 3. Spawn detached=false so signals from the parent propagate.
  const child: ChildProcess = spawn(req.piBinary, args, {
    cwd: req.cwd,
    env: { ...process.env, ...req.envOverrides, PI_SUB_AGENT_LOOP_ID: req.loopId, PI_SUB_AGENT_ITER_ID: String(req.iterId) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,                            // NOT detached: parent can signal
  });

  // 4. Wire the wall-clock killer. Two-stage: SIGTERM at T-30s, SIGKILL at T.
  const startedAt = Date.now();
  const outerKill = setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) child.kill("SIGKILL");
      }, 30_000).unref();
    }
  }, req.iterationTimeoutMs);
  outerKill.unref();

  // 5. Capture pid and return the handle.
  return {
    pid: child.pid!,
    childSessionPath: req.childSessionPath,
    resultPath: path.join(path.dirname(req.childSessionPath), "result.json"),
    startedAt,
    kill: (sig) => child.kill(sig ?? "SIGTERM"),
    wait: () => new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ exitCode: code, signal: signal as NodeJS.Signals | null }));
    }),
  };
}
```

### 7.4 The result file format

When the child finishes, `pi-coding-agent` writes its own session file. `pi-loop` adds a sidecar `result.json` next to it:

```ts
// .pi/loops/sub-agent-results/<loopId>/iter-<N>/result.json
interface SubAgentResult {
  schemaVersion: 1;
  loopId: string;
  iterId: number;
  status: "succeeded" | "failed" | "timeout" | "orphaned" | "cancelled";
  startedAt: string;       // ISO
  finishedAt: string;      // ISO
  durationMs: number;
  tokens: { in: number; out: number; total: number };
  costUsd: number;
  exitCode: number | null;
  processSignal: NodeJS.Signals | null;
  resultPath: string | null;       // path to result.md or result.txt
  preview: string;                 // one-line summary, < 200 chars
  errorMessage?: string;           // for failed/timeout/orphaned/cancelled
  model?: string;
  thinking?: string;
  childSessionPath: string;        // the child's session.jsonl
}
```

The file is written by `resultStore.finalize()` (in the parent) once the child process has exited. The result is *not* written by the child; that would risk the child not finishing its write before being killed. The parent owns the result file and the child owns its session file. The two are linked by `(loopId, iterId)`.

### 7.5 The prompt file

The loop's prompt (the same `prompt` field on `LoopEntry`) is written to a file before spawn:

```
.pi/loops/sub-agent-results/<loopId>/iter-<N>/prompt.txt
```

We use the file form so that the prompt is durable: it survives crashes, is visible in `/loop-sub-agent-inspect`, and can be diffed across iterations. The pi runtime's `@<file>` syntax is already supported.

### 7.6 What the child sees

The child's `--prompt` is the literal text:

```
You are running iteration <N> of a recurring loop named "<loopName>".

The loop's prompt is:

<prompt.txt contents>

When you finish, write your final answer to:

.result.md   (relative to your cwd)

Then exit. Do not start a REPL. Do not run sub-agents of your own (you do
not have the `subagent` tool).
```

The wrapper is intentionally minimal. We do not want to teach the child about the parent; we just want the child to do the work and produce a result file. The child does not see the parent's session, the parent's other loops, or the parent's notifications.

---

## 8. Result delivery and parent wake

### 8.1 From result to notification

When `spawnSubAgent`'s `child.on("exit", ...)` fires, the parent:

1. Reads the child's session file tail to get final token usage.
2. Looks for `.result.md` (or `.result.txt`) in the child's cwd; if present, uses its first 1 KiB as the preview.
3. Calls `costTracker.close(...)` to record tokens and cost against the loop's running ledger.
4. Calls `resultStore.finalize(...)` to write `result.json` and mark the iteration done.
5. Calls `notificationRuntime.enqueue(...)` with:

```ts
{
  kind: "sub-agent-result",
  loopId,
  iterId,
  priority: loop.priority ?? "normal",
  preview: buildOneLineSummary(result),
  artifactPath: result.resultPath,
  sessionPath: result.childSessionPath,
  fireCount: 1,
  firstFireAt: Date.now(),
  lastFireAt: Date.now(),
}
```

The `kind: "sub-agent-result"` is a new field on `ReducerNotification` (the type was already extensible; ADR-005's `priority` field is precedent).

### 8.2 The parent's view of the wake

When the parent flushes the notification (on the next `agent_end` or `REQUEST_URGENT_FLUSH`), it builds a wake string using `formatSubAgentResult()`:

```ts
function formatSubAgentResult(n: SubAgentResultNotification): string {
  const prio = n.priority === "critical" ? " (critical)" : "";
  const file = n.artifactPath ? ` See \`${path.relative(settings.cwd, n.artifactPath)}\`.` : "";
  return `Sub-agent loop #${n.loopId} iter-${n.iterId}${prio}: ${n.preview}.${file}`;
}
```

For `priority: "defer"` loops, the wake is silently dropped from the priority-flush path (matches ADR-005's defer semantics) and only surfaces on an explicit `NOTIFICATION_FLUSH_REQUESTED` (which fires on `agent_end`).

### 8.3 Critical-priority loops

A `priority: "critical"` loop's wake can interrupt the parent. The `REQUEST_URGENT_FLUSH` pump in `session-runtime.ts` (added per ADR-005) already handles this. The only new behaviour is that the preview for a critical sub-agent loop is allowed to be longer (up to 1,000 chars) so the parent agent can act without reading the file.

### 8.4 What if the child writes nothing?

If the child times out or is killed before writing a result file, the parent's `resultStore.finalize` writes `result.json` with `status: "timeout"` and `errorMessage: "Wall-clock kill at 600,000 ms"`. The notification preview is: `Sub-agent loop #4 iter-128: failed (timeout). See result.json.`

The parent agent is expected to read `result.json` (not `result.md`) in the failure path.

### 8.5 What if the child succeeds but writes a useless result?

The parent has no way to evaluate the result's quality without doing the work itself. The `preview` is the child's first 1 KiB of `result.md`, which is the child's own self-summary. We trust the child's output. If a user wants validation, they add a `validateWith: <loop-id>` cross-reference in `subAgent`, which causes the parent to spawn a second sub-agent to verify the first. That is a stretch goal in §15.

---

## 9. Lifecycle: persistence, restart, resume

### 9.1 On disk

A sub-agent loop's artefacts live under the existing `loopScope` directory:

```
project  → .pi/loops/sub-agent-results/
session  → .pi/loops-<sessionId>/sub-agent-results/
memory   → in-process only
```

Per-iteration layout:

```
.pi/loops/sub-agent-results/
  <loopId>/
    state.json                    # per-loop ledger: cumulativeTokens, activeIterations, lastResult
    iter-<N>/
      session.jsonl               # the child's session file (written by pi)
      prompt.txt                  # the prompt we sent
      result.json                 # the parent's view of the outcome
      result.md                   # the child's own final writeup (if it succeeded)
      child-stdout.log            # captured stdout (truncated to 256 KiB)
      child-stderr.log            # captured stderr (truncated to 256 KiB)
      child.pid                   # the child's pid, written at spawn, deleted at finalize
```

### 9.2 On parent restart

When the parent restarts:

1. `SessionRuntime.startup()` reads `LoopStore` and re-arms cron triggers.
2. `SubAgentRunWatcher.startup()` walks `.pi/loops/sub-agent-results/*/iter-*/state.json` and finds every iteration in `status: "running"`.
3. For each `running` iteration, the watcher checks `lastHeartbeatAt` (a field in the per-iteration manifest; the child writes a heartbeat every 60s via a small sidecar script or via a pi tool).
4. If `lastHeartbeatAt` is older than the stale threshold (default 5 min) and the child pid is not alive in `process.list`, the iteration is marked `orphaned` and `result.json` is written with `status: "orphaned"`.
5. If the child pid is still alive (rare; only on graceful restart with same PID space), the watcher waits for it to exit (bounded by the iteration's remaining time budget) and finalizes normally.
6. The next cron / event tick starts a fresh iteration as normal.

This is the same pattern `pi-subagents` uses for its own async runs (`async-retention.ts`, `stale-run-reconciler.ts`). The PRD's `sub-agent/result-watcher.ts` is a smaller, single-process version.

### 9.3 On parent graceful shutdown (Ctrl-C, SIGINT)

When the parent receives SIGINT and is shutting down:

1. `SubAgentRunWatcher.shutdown()` is called.
2. For each `running` child, the watcher sends SIGTERM and waits up to 5 seconds for graceful exit.
3. Children that do not exit get SIGKILL.
4. The watcher writes `result.json` for any iteration that was killed with `status: "cancelled"`.
5. The parent's `LoopStore` is unchanged; the loop is still `status: "active"`.
6. On the next parent start, the loop re-arms and runs as normal.

### 9.4 On parent crash (no shutdown)

When the parent crashes (OOM, kill -9, power loss):

1. The next parent start runs the restart path above.
2. Children spawned by the crashed parent are now orphans at the OS level (their parent pid is gone). They will not crash themselves; they run to completion (or until their own wall-clock).
3. When the new parent starts, the `SubAgentRunWatcher` reconciles the running iterations. Children that are still alive have their pids tracked; children that finished while the parent was down have their `result.json` written by the watcher using the child's session file tail.
4. Either way, no data is lost; the only loss is the 30s heartbeat delay before the watcher notices a child has finished.

### 9.5 On `LoopDelete`

When a loop is deleted (via `LoopDelete({ id })` or `/loop → x`):

1. The loop's `activeIterations` are sent SIGTERM.
2. The loop's `resultStore` is moved to `.pi/loops/sub-agent-results/<loopId>.deleted-<timestamp>/`.
3. The cost ledger is closed; a final `summary.json` is written.
4. The deletion is recorded in the loop's history in the `LoopStore` (existing v2.x behaviour).

The user can `LoopRestore` a deleted loop from the history file, with its previous results intact. (Restore is out of scope for this PRD; the data is preserved so a future restore command can be added.)

---

## 10. Concurrency, cost, and safety

### 10.1 Concurrency cap

A new setting `subAgent.activeIterationsMax` (default `4`, hard cap `25` matching the existing loop cap) bounds the number of in-flight sub-agent iterations across all sub-agent loops in the current session. A loop in `loopScope: "project"` only counts against this cap for sessions that have the loop bound (per the bindings file). Two terminals in the same project with different bindings therefore have independent concurrency caps.

When the cap is reached, the next fire is enqueued as a `defer` notification with reason `concurrency_cap`. The notification surfaces on the parent's next `agent_end` and reads:

> Sub-agent loop #7 iter-12 deferred: 4/4 active iterations. Reschedule manually or wait for an active iteration to finish.

### 10.2 Per-loop iteration cap

A loop with `subAgent.maxIterations: 100` stops firing after 100 iterations. The cap is enforced by the scheduler before spawn. When the cap is hit, the loop is marked `status: "paused_cap"` and a `priority: "urgent"` notification is delivered.

### 10.3 Per-loop token budget (the only token gate)

A loop with `subAgent.maxTokens: 1_000_000` has a cumulative token budget across all iterations. The `costTracker` ledger is the source of truth. When `cumulativeTokens >= maxTokens`, the next iteration is deferred; the loop is marked `status: "paused_budget"`.

The user can raise the budget at runtime:

```
LoopUpdate({ id: "4", subAgent: { maxTokens: 2_000_000 } })
```

The new budget takes effect on the next iteration.

**There is no global cost ceiling.** Round 1 decision D13 (user chose A: no global ceiling). The user's reasoning: per-loop `maxTokens` is enough, and the user's preference is for self-describing loops (via `goal`, `successCriteria`, `failureCriteria`) rather than a hard session-wide stop. The cost-tracker still records cumulative cost per session (for the cost report), but it does not gate spawning.

### 10.4 Per-iteration wall-clock timeout

A loop with `subAgent.iterationTimeoutMs: 600_000` (10 min) has each child killed at 10 minutes. The child receives SIGTERM at T-30s and SIGKILL at T. The default is 600,000 ms; the cap is 24 * 60 * 60 * 1000 (24 h).

### 10.5 Cost tracking and reporting

`costTracker.ts` records:

- Per-iteration: `{ in, out, total, costUsd, durationMs }` from the child's session file.
- Per-loop: `cumulativeTokens`, `cumulativeCostUsd`, `iterationsCompleted`, `iterationsFailed`, `lastSuccessAt`, `lastFailureAt`.
- Per-session: aggregate of all sub-agent loops' cumulative cost. Reported via `/loop-cost`; not used as a gate.

A new `/loop-cost` slash command shows the per-loop and per-session report. (The `sub-agent/cost-tracker.ts` module exposes a JSON-shaped report; the slash command is a thin wrapper.)

### 10.6 Capability ceilings (cross-extension policy)

If `pi-subagents` is installed and has registered a capability ceiling via `registerSubagentCapabilityCeiling` (see `research-wt/pi-subagents/src/api/capability-ceiling.ts`), `pi-loop`'s sub-agent runtime reads the ceiling before spawn and respects:

- `allowedTools`: intersect with the loop's `subAgent.tools` (or default).
- `allowedAgents`: ignored (sub-agent loops are not "agents" in the `pi-subagents` sense; they are loop iterations).
- `denyExtensions`: applied to the child's `extensions` argument; the child is started with `--no-extensions` by default but a ceiling that says "deny extensions" reinforces this.

A loop that violates the ceiling is deferred with reason `policy_denied` and a `priority: "urgent"` notification surfaces the policy conflict to the user.

### 10.7 Background-work provider (optional integration)

If `pi-subagents` is installed, `pi-loop` registers itself as a `BackgroundWorkProvider` via `registerBackgroundWorkProvider` from `pi-subagents/background-work`:

```ts
import { registerBackgroundWorkProvider } from "pi-subagents/background-work";

registerBackgroundWorkProvider({
  name: "pi-loop-sub-agent",
  wakeChannels: ["loop:sub-agent:result"],
  listActiveWork: () => subAgentStore.snapshotActive(sessionId),
  reconcile: ({ sessionId, nowMs }) => subAgentStore.reconcile(sessionId, nowMs),
});
```

This makes `pi-loop`'s sub-agent iterations visible to `pi-subagents`'s `subagent_wait` and to its FleetView. The reverse direction (pi-subagents delegating back to pi-loop) is out of scope.

### 10.8 Failure modes and how we handle them

| Failure | Detection | Reaction |
|---|---|---|
| Child crashes (exit code != 0) | `child.on('exit')` | `result.json` with `status: "failed"`, `errorMessage` from stderr tail. Normal-priority wake. |
| Child times out | outer SIGTERM/SIGKILL timer | `result.json` with `status: "timeout"`. Urgent wake. |
| Child OOMs | parent process inherits nothing; child writes partial session | watcher on parent restart reconciles via session file tail. `status: "orphaned"` if session file is truncated or unreadable. |
| Parent crashes mid-iteration | watcher on restart | `status: "orphaned"` if child is dead; `status: "succeeded"` if child finished and left a result. |
| Parent graceful shutdown | SIGINT handler | `status: "cancelled"` for all in-flight children. |
| Loop deleted mid-iteration | `LoopDelete` handler | `status: "cancelled"` for in-flight children of that loop. |
| Token budget exhausted | `costTracker` check at spawn time | `status: "paused_budget"` on the loop; no new iterations. |
| Concurrency cap hit | `SubAgentRunScheduler` check at spawn time | iteration deferred; `defer` notification. |
| Capability ceiling violation | `capability-ceiling` read at spawn time | iteration deferred; `urgent` notification. |
| User wants to stop one iteration | `LoopUpdate({ subAgent: { stopIter: <id> } })` | SIGTERM to that child; `status: "cancelled"`. |

---

## 11. Configuration and settings

### 11.1 The settings file

The unified settings file (`.pi/pi-loop-settings.json` per v2.0) gains a new top-level key:

```ts
interface PiLoopSettings {
  // ... existing fields ...
  subAgent: {
    /** Default isolation for new loops created by /loop (NOT /loop-subagent, which is always "sub-agent"). */
    defaultIsolation: "in-process" | "sub-agent";
    /** Hard cap on concurrent in-flight sub-agent iterations in this session. */
    activeIterationsMax: number;            // default 4, max 25
    /** Default wall-clock timeout for one iteration. */
    defaultIterationTimeoutMs: number;      // default 600_000 (10 min)
    /** Default per-iteration soft token budget. */
    defaultIterationTokenBudget: { in: number; out: number };  // default { in: 30_000, out: 6_000 }
    /** Path to the pi binary used to spawn children. Default: same as the parent. */
    piBinary: string;                       // default: "pi"
    /** Extra env vars to pass to the child. Default: {}. */
    envOverrides: Record<string, string>;
    /** Whether to register as a background-work provider if pi-subagents is present. */
    registerBackgroundWorkProvider: boolean;  // default true
    /** Whether to honour pi-subagents' capability ceiling. */
    honorCapabilityCeiling: boolean;        // default true
    /** Whether critical-priority sub-agent results always interrupt the parent. */
    criticalInterruptsAll: boolean;         // default false (interrupts only outside loop wakes)
    /** Whether to show the cumulative sub-agent cost in the editor status line. */
    showCostInStatusLine: boolean;          // default true
    /** Whether to use the optional LLM-call evaluator (round-1 §4, stretch). */
    useLlmEvaluator: boolean;               // default false
  };
}
```

The defaults are chosen to be safe on first opt-in: a user who runs `/loop-subagent <interval> <prompt>` without setting anything gets a child that uses the parent's full tool surface (minus `subagent`), runs for up to 10 minutes, uses up to 30k input + 6k output tokens, and the session's cap of 4 concurrent iterations applies.

Note the absence of `costCeilingUsd` — round-1 decision D13 (user chose A: no global ceiling). The session-level cost is tracked for reporting but does not gate spawning. Per-loop `subAgent.maxTokens` is the only token gate.

### 11.2 `/loop-settings` TUI

The `/loop-settings` TUI editor (added in v2.0) gains a new sub-menu: `Sub-agent defaults`. The sub-menu exposes:

- `defaultIsolation` (cycles `in-process` → `sub-agent` → `in-process`)
- `activeIterationsMax` (cycles 1 → 2 → 4 → 8 → 16 → 25 → 1)
- `defaultIterationTimeoutMs` (cycles 5min → 10min → 30min → 1h → 6h → 24h → 5min)
- `piBinary` (text input; default "pi")

The other `subAgent` fields are advanced tuning and are not in the cyclic editor. Users who need them edit `.pi/pi-loop-settings.json` directly.

### 11.3 Per-loop overrides

A loop's `subAgent` field overrides the defaults. The override is deep-merged with the defaults, not replaced. So a loop that sets `subAgent: { model: "haiku" }` gets a child that uses haiku but inherits the default timeout, token budget, and concurrency cap.

The four optional self-description fields (`goal`, `successCriteria`, `failureCriteria`, `stateFile`) live at the top level of `LoopEntry`, not inside `subAgent`. This is intentional: they describe the loop's purpose, not its execution runtime. A v2.x in-process loop can also set `goal` and `successCriteria` if the user wants the same self-description semantics in the parent.

### 11.4 Env vars

No new environment variables. The v2.0 design uses the settings file exclusively; env var overrides are intentionally absent. This PRD keeps that invariant.

### 11.5 Cross-platform notes

- `piBinary: "pi"` works on macOS and Linux where `pi` is on `$PATH`. On Windows, the user sets `piBinary: "C:\\Users\\<user>\\AppData\\Roaming\\npm\\pi.cmd"` (or wherever the npm global bin is).
- `iterationTimeoutMs` is wall-clock; on Windows the equivalent of SIGTERM is `process.kill(pid, 'SIGTERM')` which Node.js maps to `TerminateProcess` for the child (this is not a graceful signal; the child does not get a chance to flush). The PRD's two-stage kill (SIGTERM at T-30s, SIGKILL at T) is the best we can do cross-platform.
- `child-stdout.log` and `child-stderr.log` are written with `fs.createWriteStream` and capped at 256 KiB. The cap is enforced by a `stream.write` return-value check followed by `.end()` on overflow.

---

## 12. Tool and slash-command surface

### 12.0 New slash command: `/loop-subagent <interval> <prompt> [flags]`

The new entry point for sub-agent loops. Parallel to `/loop`, always creates a sub-agent loop. Accepts the same positional args as `/loop` plus the new flags:

```
/loop-subagent <interval> <prompt>
                [--goal <text>]
                [--success-criteria <text>]
                [--failure-criteria <text>]
                [--state-file <path>]
                [--model <name>]
                [--max-tokens <n>]
                [--max-iterations <n>]
                [--iteration-timeout <ms>]
                [--label <text>]
                [--cwd <path>]
```

Implemented in `src/commands/loop-subagent-command.ts`. The handler parses the args, validates them, and calls `LoopCreate({ isolation: "sub-agent", ...args })`. The internal `LoopCreate` schema (§6.3) is the source of truth; the slash command is a thin wrapper.

The existing `/loop` command is unchanged but accepts `--isolation sub-agent` for users who prefer the flag form. The two commands are equivalent for sub-agent creation; `/loop-subagent` is the recommended form because it makes the intent explicit at the command line and saves the user from typing the `--isolation` flag.

Examples:

```
# Simplest form: a polling loop with no role, no criteria, no state file.
/loop-subagent every 30m "Check the GitHub API for new priority issues."

# A weekly digester with goal, success criteria, and a model override.
/loop-subagent weekly monday 09:00 "Survey the .pi/ extension changelog and produce a 1-page digest." \
  --goal "weekly changelog digest" \
  --success-criteria "the result.md contains a 'New features' section with at least 3 entries" \
  --max-tokens 30000 --model sonnet

# A stateful audit loop that tracks which files it has audited.
/loop-subagent every 6h "Audit one untested file from src/. Mark it as done in the state file." \
  --state-file .pi/loops/3/audit-state.json \
  --max-iterations 50 \
  --success-criteria "the state file lists all files in src/"
```

### 12.1 New tool: `LoopInspect`

```ts
LoopInspect({
  loopId: string;
  iterId?: number;            // omit for the latest
  what: "result" | "session" | "prompt" | "all";
})
```

Returns a structured summary of the iteration:

```ts
{
  loop: LoopEntry;
  iteration: {
    id: number;
    status: SubAgentStatus;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    tokens: { in: number; out: number; total: number };
    costUsd: number;
    resultPath: string | null;
    childSessionPath: string;
    preview: string;
    errorMessage?: string;
  };
}
```

### 12.2 Extended tool: `LoopUpdate` and `LoopCreate`

`LoopCreate` and `LoopUpdate` both accept the new fields: `isolation`, `goal`, `successCriteria`, `failureCriteria`, `stateFile`, and the `subAgent` sub-object. Updating a loop's `isolation` from `in-process` to `sub-agent` does **not** retroactively move prior iterations; only subsequent fires use the new mode. The opposite direction (sub-agent → in-process) is the same: prior sub-agent results stay on disk; new fires are in-process.

The `goal` / `successCriteria` / `failureCriteria` / `stateFile` fields are independent of `isolation`. A v2.x in-process loop can set these too; the runtime is permissive and ignores them for in-process execution (they are wired up only in the sub-agent path).

### 12.3 New slash command: `/loop-sub-agent-inspect <loopId> [iterId]`

Opens a TUI picker showing the loop's last N (default 5) iterations. Selecting one opens the result, the session, the prompt, or the cost report in `$PAGER` (or `code` on Windows, or `notepad` if neither is available — graceful degradation).

### 12.4 New slash command: `/loop-cost`

Shows a table:

| Loop | Iterations | Last run | Total tokens | Total cost |
|---|---|---|---|---|
| #3 | 47 | 12m ago | 412,907 | $5.12 |
| #4 | 128 | 4d ago | 1,203,488 | $14.86 |
| #7 | 9 | 1h ago | 22,418 | $0.28 |
| **Total** | | | **1,638,813** | **$20.26** |

The numbers come from `costTracker.report()`.

### 12.5 New slash command: `/loop-sub-agent-stop <loopId> [iterId]`

Sends SIGTERM to one in-flight child (or all in-flight children of a loop). The killed iteration is finalized as `status: "cancelled"`.

### 12.6 `/loop` cyclic field form

The existing cyclic field form in `loop-edit-command.ts` grows by three new fields:

- `isolation` (cycles `in-process` → `sub-agent` → `in-process`)
- `goal` (text input, defaults to empty)
- `success-criteria` (text input, defaults to empty)

The per-loop `subAgent` overrides (model, thinking, tools, timeouts) are a sub-form, accessible by typing `s` on the `sub-agent config` row. The "Save & Exit" path persists the new fields via `LoopStore.updateMetadata`, extended to accept the new keys (the existing `triggerEquals` logic applies unchanged).

Most users will use `/loop-subagent` and skip the cyclic form entirely. The form exists for users who want to edit an existing loop's fields.

### 12.7 New tool description snippet

The `LoopCreate` tool description is updated to include the new fields in the `## When to Use` section:

```
## When to Use
... existing guidance ...

Use `isolation: "sub-agent"` when:
- The loop's prompt produces large intermediate output that should not enter the
  parent session's context window.
- The loop's iterations should survive parent process restarts.
- You want bounded per-iteration cost and a structured one-line summary in the
  parent.

Do NOT use `isolation: "sub-agent"` when:
- The loop's prompt is short (< 1 KiB) and the iteration output is what the user
  wants to see in the parent conversation.
- The loop needs to drive a follow-up tool call in the parent immediately after
  each iteration (sub-agent runs are deferred to next idle; they do not interrupt).
- You need < 100 ms wake latency (sub-agent runs add a 1-2s spawn overhead).
```

---

## 13. TUI integration

### 13.1 The existing widget

The `LoopWidget` is registered above the editor with `placement: "aboveEditor"` per ADR-001. It renders the in-process loop status. Sub-agent mode adds one new column: `iter` showing the current iteration id and status, and one new row colour for `paused_budget` / `paused_cap`.

The widget remains single-line per loop. Sub-agent-specific data goes to a new panel.

### 13.2 New panel: `SubAgentFleetView`

A second widget, registered as `loops-sub-agent` (placement `belowEditor`, per ADR-001's key-naming convention), shows live progress for all active sub-agent iterations:

```
Active sub-agents (3/4)
  #3 iter-42  worker    12m 04s  ✓ done     17.3k tok
  #4 iter-128 worker    02m 18s  ⠋ running   4.1k tok
  #7 iter-9   watchdog  00m 04s  ⠋ starting  n/a
[Open fleet inspector →]   [/loop-sub-agent-stop 4]
```

The panel is hidden by default if no sub-agent loops exist or all are idle. It becomes visible when at least one iteration is in `running` or `starting` state.

The panel is interactive: pressing `f` opens the full FleetView overlay (modeled on `pi-subagents`'s `/subagents-fleet`); pressing `s <id>` opens the stop picker; pressing `i <id>` opens the inspect picker.

### 13.3 FleetView overlay

A new overlay `ui.showSubAgentFleetOverlay()` mirrors `pi-subagents`'s `/subagents-fleet` (see `research-wt/pi-subagents/docs/observability.md`):

- A scrollable list of all known sub-agent iterations (active + last 50 terminal).
- Each row: `{ loop, iter, status, agent, model, startedAt, durationMs, tokens, preview }`.
- Filterable by loop id, status, time range.
- Selecting a row opens the inspect picker.

The overlay is bound to `Ctrl+Shift+S` (per ADR-004's keybinding convention; no conflict with the existing `Ctrl+Shift+L` for the loop list overlay).

### 13.4 Cost indicator

A small cost indicator is added to the editor's status line (right side, where the model name is shown):

```
opus · 1,638,813 tok (sub-agent: 1,203,488 / $14.86) · 3 active
```

The indicator is updated by the existing 30s heartbeat. It shows the session's cumulative sub-agent cost at a glance. Pressing `Ctrl+Shift+C` opens the full `/loop-cost` report.

---

## 14. Migration and backwards compatibility

### 14.1 No migration required for v2.x users

A loop loaded from `.pi/loops/loops.json` that has no `isolation` field is treated as `isolation: "in-process"`. The new code path is never entered. All existing v2.x tests pass without modification.

### 14.2 The `defaultIsolation` setting

A user who wants all *new* loops to be sub-agent by default sets `subAgent.defaultIsolation: "sub-agent"` in `.pi/pi-loop-settings.json`. Existing loops are unaffected. New loops created via `/loop prompt` (without an explicit `isolation`) default to the setting.

### 14.3 The first-run migration

On first startup with v2.5 (the version that ships this PRD), `migration/v2-to-v2.5.ts` runs:

1. Reads `.pi/pi-loop-settings.json`.
2. If `subAgent` is missing, adds it with all defaults.
3. If any loop has a non-default `isolation` already, leaves it alone.
4. Writes back atomically.

This is a no-op for users who have not touched the setting.

### 14.4 The `sub-agent-results` directory

On first sub-agent spawn, the directory `.pi/loops/sub-agent-results/` is created lazily. It is not created at startup. It is added to `.gitignore` automatically by the first iteration's spawn (a small `ensureGitignore()` call).

### 14.5 The `pi-subagents` integration

If `pi-subagents` is installed at first sub-agent spawn, `pi-loop` attempts `import("pi-subagents/background-work")`. If the import resolves, it registers the background-work provider. If not, it silently skips. The integration is opt-in and lazy; no failure mode if `pi-subagents` is not present.

### 14.6 The downgrade path

If a user downgrades from v2.5 to v2.x, the `isolation` and `subAgent` fields on existing loops are simply ignored. No data loss. The `.pi/loops/sub-agent-results/` directory is orphaned on disk but is harmless (it is gitignored and small).

---

## 15. Open questions, risks, and trade-offs

### 15.1 Open questions (resolved by decision rounds, kept here for context)

The two decision rounds (round 1: 18 questions, round 2: 4 follow-ups) closed every open question that materially affected the design. The questions that were asked, and their resolutions:

- **Q1. Should sub-agent runs be visible in the parent's conversation history at all?** Round-1 default accepted: only a one-line summary in the conversation; live progress in the FleetView panel. A future v3 could merge them.
- **Q2. Should the child be able to call back into the parent?** No, in v2.5. The child is fire-and-forget. A future v3 could add `askParent: true` via `pi-subagents`'s `intercom-bridge`.
- **Q3. Child → child loops (recursion)?** No. Child is started with `--no-extensions` plus explicit `subagent` tool denial. Fail-closed.
- **Q4. Result caching for re-use?** No. Every iteration is a fresh child. A future "result dedupe" could hash the prompt and reuse within a window.
- **Q5. Sandbox the child?** No, in v2.5. The user is trusted. A future v3 could add a sandbox-mode setting.
- **Q6. Cross-machine visibility (P3)?** Deferred to v3 (round-1 D18). v2.5 is single-machine.
- **Q7. Per-iteration model override?** Not in v2.5. `subAgent.model` is a single value. A future v3 could add a function form.
- **R2-2 follow-up. Default toolset for sub-agent loops?** Full surface, no `subagent` tool. (User choice A.)
- **R2-3 follow-up. Built-in roles?** None. (User choice A.) The `role` concept is gone; users write the role into `prompt`.
- **R2-4 follow-up. Required fields for sub-agent loops?** All optional. (User choice A.) The runtime is permissive when `goal` / `successCriteria` / `failureCriteria` / `stateFile` are missing.
- **R2-1 follow-up. `/loop` command syntax?** New `/loop-subagent <interval> <prompt>` parallel sub-command. (User choice A, refined to a separate slash command rather than a flag.)

The full decision matrices live in `docs/PRD/sub-agent-questions.xlsx` (round 1) and `docs/PRD/sub-agent-questions-r2.xlsx` (round 2).

### 15.2 Risks

- **R1. Disk space.** A loop that fires every 5 minutes and writes a 1 MiB result file accumulates 288 MiB/day. The PRD bounds this: `subAgent-results/<loopId>` is rotated by the existing `async-retention.ts` pattern, with a `subAgent.retainIterations: 50` default. A long-running loop that fires every minute accumulates 1,440 iterations/day; the rotation keeps the last 50 (≈ 50 MiB). This is acceptable but should be documented.
- **R2. Process count.** A user with 25 sub-agent loops, all firing simultaneously, spawns 25 child pi processes. On a 4-core machine this saturates CPU. The `activeIterationsMax` cap (default 4) bounds this. A user who raises the cap to 25 accepts the CPU cost.
- **R3. Token cost.** A loop with `subAgent.maxTokens: undefined` and a long prompt that uses 50k tokens per iteration will run until the user stops it. There is no global cost ceiling by design (round-1 D13, user choice A). The user is expected to set `subAgent.maxTokens` on each loop, or use `successCriteria` + `subAgent.maxIterations` to auto-complete the loop before it burns through the budget.
- **R4. Lost pids on parent crash.** If the parent crashes hard, child pids may be reused by the OS for unrelated processes. The watcher's "is this pid still alive and is it the same child" check uses both the pid and a startup nonce written to a small file by the child at start; mismatch → `orphaned`. This is robust enough for the common case.
- **R5. TUI flicker from the FleetView panel.** A panel that updates every second can cause TUI flicker on slow terminals. The PRD uses `tui.requestRender()` with a 1 Hz throttle. Tested on Windows Terminal, iTerm2, and GNOME Terminal.
- **R6. The child has the parent's full tool surface.** A child that runs `rm -rf .` will delete the parent's working tree. This is identical to the risk of a foreground `bash` tool call. The PRD does not add a sandbox; it relies on the user to scope their loop's tools (the `subAgent.tools` allowlist) and to set `subAgent.cwd` to a safe directory. The default allowlist (full surface) is round-2 user choice A; users who want a smaller surface override it per-loop.
- **R7. Loop-fan-out footgun.** A user who sets `subAgent.maxIterations: 1_000_000` and `subAgent.iterationTimeoutMs: 86_400_000` (24h) on a loop with a 5-minute trigger will burn 24h × 1M = a lot. The PRD requires an explicit confirmation in the TUI for `maxIterations > 1000` and `iterationTimeoutMs > 3_600_000` (1h). This is a UX guard, not a hard cap.
- **R8. `pi-subagents` API drift.** The integration in §10.7 depends on `pi-subagents`'s public API. If `pi-subagents` v0.51 changes `registerBackgroundWorkProvider`'s signature, `pi-loop`'s integration breaks. The PRD wraps the integration in a `try/catch` and a feature-detect (`Symbol.for("pi-subagents.background-work.v1")` exists?), so a drift results in a silent no-op, not a crash. The `subAgent.registerBackgroundWorkProvider: false` setting provides a hard kill switch.
- **R9. The four optional fields can be ignored.** Round-2 R2-4 made `goal` / `successCriteria` / `failureCriteria` / `stateFile` all optional. A user who creates a sub-agent loop without setting them gets a generic loop with no self-description, no success/failure detection, and no state. This is by design (lowest-friction entry point; see UC-6) but means the auto-completion feature only works when the user opts in. Document this clearly.

### 15.3 Trade-offs

- **Fresh session vs. retained session.** A fresh session per iteration is simple and bounded; a retained session across iterations amortizes context (the child remembers its prior work) but accumulates state (the child's session file grows unboundedly). `pi-subagents` supports both. The PRD picks *fresh per iteration* for v2.5 because (a) it maps cleanly to "each loop iteration is a unit of work" and (b) it eliminates the unbounded-growth footgun. A future v3 could add `subAgent.sessionMode: "retained"` for loops where context-amortization matters.

- **Process spawn vs. in-process delegation.** The PRD uses a child process. The alternative is in-process delegation via the same `subagent` tool `pi-subagents` uses, but launched from inside the loop. In-process delegation is cheaper (no spawn overhead) but shares the parent's memory and event loop; a runaway child can wedge the parent. The child process is a stronger isolation boundary at the cost of 200-500 ms spawn time.

- **No `pi-subagents` dependency vs. full integration.** The PRD does not require `pi-subagents`. The integration is opt-in and best-effort. This keeps `pi-loop`'s install footprint small but means users who want richer orchestration install both packages.

- **Single-machine vs. cross-machine.** The PRD is single-machine. A future v3 could add cross-machine via SSH / Tailscale, but the user did not ask for it.

---

## 16. Implementation phases and milestones

### 16.1 Phase 0 — Research and PRD (this document)

**Done.** The repo is vendored at `research-wt/pi-subagents/`, five Perplexity research notes are in `research-wt/notes/`, and this PRD is in `docs/PRD/sub-agent.md`. The next phases build on this.

### 16.2 Phase 1 — Settings, types, and a no-op sub-agent path (v2.5.0)

**Scope:**

- Add `subAgent` to `PiLoopSettings` with all defaults.
- Add `isolation` and `subAgent` to `LoopEntry` (optional).
- Add `subAgent` to the `LoopCreate` / `LoopUpdate` tool schema.
- Add `LoopInspect` tool (no-op for in-process loops; returns a structured stub for sub-agent loops).
- Add the `migration/v2-to-v2.5.ts` one-shot migration.
- Add `/loop-settings → Sub-agent defaults` sub-menu.
- Add the `subAgent` field to the cyclic field form in `loop-edit-command.ts`.

**Acceptance:** A user can create a loop with `isolation: "sub-agent"`, list it, edit it, delete it. No sub-agent process is actually spawned; the new fields are persisted and re-loaded correctly.

**Estimated scope:** ~600 LOC + ~200 LOC tests.

### 16.3 Phase 2 — Spawn and result (v2.5.0)

**Scope:**

- `src/runtime/sub-agent/spawn.ts` — the child-process spawn adapter.
- `src/runtime/sub-agent/result-store.ts` — file-backed per-loop, per-iteration result store.
- `src/runtime/sub-agent/result-watcher.ts` — watches the result inbox; writes `result.json` on child exit; enqueues a `ReducerNotification`.
- `src/runtime/sub-agent/cost-tracker.ts` — per-loop and per-session cost ledger.
- The new branch in `onLoopFire()` in `session-runtime.ts` to call the spawn adapter.
- The new branch in `flushPendingNotifications` in `notification-runtime.ts` to format the wake as a one-line summary.
- The new `kind: "sub-agent-result"` on `ReducerNotification` (with backward-compatible default to `kind: "loop-fire"` if absent).

**Acceptance:** A user can create a sub-agent loop, watch a child pi process spawn, and see a one-line summary in the parent on the next idle. Tokens, duration, and cost are recorded.

**Estimated scope:** ~1,200 LOC + ~600 LOC tests.

### 16.4 Phase 3 — Concurrency, cost, and lifecycle (v2.5.1)

**Scope:**

- `src/runtime/sub-agent/scheduler.ts` — concurrency cap, iteration cap, token budget cap, capability ceiling.
- `src/runtime/sub-agent/child-pid.ts` — owned-process tree; cross-platform kill; stale-pid reconciliation.
- The parent-restart path in `result-watcher.startup()`.
- The graceful-shutdown path in `result-watcher.shutdown()`.
- The `LoopDelete` handler that cancels in-flight children.
- The `LoopUpdate({ subAgent: { stopIter } })` handler for one-iteration stop.
- The `subAgent.costCeilingUsd` per-session backstop setting.

**Acceptance:** All eight failure modes in §10.8 are handled correctly. The concurrency cap is enforced. The token budget is enforced. A parent crash followed by restart correctly reconciles in-flight iterations.

**Estimated scope:** ~1,000 LOC + ~600 LOC tests.

### 16.5 Phase 4 — TUI, slash commands, and the FleetView overlay (v2.5.1)

**Scope:**

- `src/ui/sub-agent-fleet.ts` — the belowEditor panel.
- `src/ui/widget-render.ts` updates for the new fields.
- `src/commands/loop-command.ts` additions: `/loop-sub-agent-inspect`, `/loop-cost`, `/loop-sub-agent-stop`.
- The cost indicator on the editor's status line.
- The `Ctrl+Shift+S` FleetView overlay keybinding.
- The `Ctrl+Shift+C` cost-report keybinding.

**Acceptance:** The TUI shows the new panel; the slash commands work; the overlay is navigable; the cost indicator updates on the heartbeat.

**Estimated scope:** ~800 LOC + ~300 LOC tests.

### 16.6 Phase 5 — `pi-subagents` integration (v2.5.1, optional)

**Scope:**

- The `registerBackgroundWorkProvider` shim in `src/runtime/sub-agent/pi-subagents-bridge.ts`.
- The capability-ceiling read at spawn time.
- The fleet-status DTO contribution to `pi-subagents`'s FleetView.
- The `subAgent.registerBackgroundWorkProvider: false` kill switch.

**Acceptance:** With `pi-subagents` installed, `pi-loop`'s sub-agent iterations show up in `pi-subagents`'s `/subagents-fleet` and `subagent_wait`. Without it, no behaviour change. The integration is opt-in and lazy.

**Estimated scope:** ~300 LOC + ~100 LOC tests.

### 16.7 Phase 6 — Documentation and migration (v2.5.1)

**Scope:**

- ADR-006: Sub-agent Execution (this PRD's architectural decision, distilled).
- AGENTS.md: new section on sub-agent execution, the same way v2.0 documented loops.
- README.md: opt-in instructions, examples, cost guidance.
- CHANGELOG.md: v2.5.0 and v2.5.1 entries.
- The `pi-loop-guide` skill update if present.

**Acceptance:** A new user can read the README, run `/loop prompt, isolation: sub-agent`, and have a working sub-agent loop in under 5 minutes.

### 16.8 Total scope

Roughly **4,300 LOC of new TypeScript** + **1,900 LOC of new tests** + **500 lines of new documentation** over two minor releases (v2.5.0 and v2.5.1). The bulk of the new code is in the spawn / result / cost / scheduler modules in `src/runtime/sub-agent/`. The increment over the original v1 estimate of 3,900 LOC is from the new optional self-description fields (`goal`, `successCriteria`, `failureCriteria`, `stateFile`), the evaluator module, and the `/loop-subagent` slash command. Removing the `role` concept (round-2 R2-3 = A) netted a ~200 LOC reduction that almost offset the new fields. The detailed per-spec LOC estimates are in `docs/PRD/sub-agent-specs.xlsx` (sum of column H across all 7 sheets).

---

## 17. Test strategy

### 17.1 Unit tests

- `src/runtime/sub-agent/spawn.test.ts` — mock `child_process.spawn`; assert argv, env, cwd, stdio. Test the wall-clock killer with `vi.useFakeTimers`.
- `src/runtime/sub-agent/result-store.test.ts` — in-memory store, atomic write semantics, stale-pid detection.
- `src/runtime/sub-agent/cost-tracker.test.ts` — ledger arithmetic, budget cap, per-loop and per-session rollups.
- `src/runtime/sub-agent/scheduler.test.ts` — concurrency cap, iteration cap, budget cap, capability ceiling. Use a fake capability-ceiling provider.
- `src/runtime/sub-agent/result-watcher.test.ts` — child exit, parent restart reconciliation, graceful shutdown, crash recovery.

### 17.2 Integration tests

- `test/integration/sub-agent-lifecycle.test.ts` — spawn a real child pi process against a temp cwd; assert result.json is written; assert the parent gets a wake.
- `test/integration/sub-agent-restart.test.ts` — start a child, kill the parent, restart the parent, verify the child is reconciled.
- `test/integration/sub-agent-concurrency.test.ts` — fire 10 sub-agent loops simultaneously; assert the cap is enforced.
- `test/integration/sub-agent-pi-subagents-bridge.test.ts` — with `pi-subagents` mocked to expose `registerBackgroundWorkProvider`, verify the provider is registered correctly.

### 17.3 E2E tests

- `test/e2e/loop-sub-agent-tui.test.ts` — open a TUI in a child terminal; create a sub-agent loop; watch the panel populate; press `Ctrl+Shift+S`; navigate the FleetView; press `i` to inspect; assert the result file opens in the configured pager.

### 17.4 Cross-platform

- Run the full test suite on Windows (the user's platform), macOS, and Linux. The cross-platform risk is in `spawn.ts` (the wall-clock killer) and `child-pid.ts` (pid reuse). Both are unit-tested with mocked OS primitives.

### 17.5 Manual tests

The `MANUAL_TESTING.md` document gains a new section: "Sub-agent execution." It walks the user through the six UC-1..UC-6 scenarios with expected output.

### 17.6 Performance tests

- A loop firing every 1 minute for 1 hour should not leak memory. `cost-tracker.test.ts` includes a 1-hour stress test with `vi.useFakeTimers` advancing in 1-minute steps.
- A user with 25 sub-agent loops at the active-iteration cap should not see the parent's heartbeat pump stall. The heartbeat is throttled to 30s; a 1 Hz cost-report recomputation is well within budget.

---

## 18. Appendix A — cited `pi-subagents` source

This PRD's design draws heavily on `pi-subagents` v0.50.0. The vendored copy is at `research-wt/pi-subagents/`. The following source paths informed specific decisions:

| Decision | Source path | What we borrowed |
|---|---|---|
| Result file + session file + manifest layout | `src/runs/background/result-files.ts` | The `result-index`, `sessions`, `runs` subdirectory pattern. We simplify to a per-iteration directory with no central index. |
| Completion notification formatter | `src/runs/background/notify.ts` | The `formatSingleCompletion` / `formatGroupedCompletion` pattern. We adapt to `formatSubAgentResult`. |
| Mission record schema | `src/missions/types.ts` | The `MissionRecord` shape (id, runs, decisions, artifacts, receipts, budget, usage). We do not adopt the schema in full; we adopt the *idea* of a durable, recoverable per-loop record. |
| Mission store layout | `src/missions/store.ts` | The `missionDir`, atomic JSON write, retention pruning, global index. Our `sub-agent-results/<loopId>/state.json` is a slimmer version of this. |
| Background-work provider contract | `src/api/background-work.ts` | The `registerBackgroundWorkProvider` shape, the `Symbol.for("pi-subagents.background-work.v1")` registry, the validation rules for `BackgroundWorkItem` (`id`, `sessionId`). Our `pi-subagents-bridge.ts` is a thin wrapper around the same contract. |
| In-process event-bus RPC | `docs/extension-api.md` §"In-process event-bus RPC" | The `subagents:rpc:v1:ready` / `:request` / `:reply:<id>` pattern. We do not implement this in v2.5; we may in v3. |
| Capability ceiling | `src/api/capability-ceiling.ts` (referenced in `docs/extension-api.md`) | The `allowedTools`, `allowedAgents`, `denyExtensions` intersection semantics. Our scheduler reads this at spawn time. |
| Stale-run reconciler | `src/runs/background/stale-run-reconciler.ts` | The pattern of walking active runs on startup and reconciling against live pids. Our `result-watcher.startup()` is a smaller version. |
| Owned process tree | `src/runs/background/owned-process-tree.ts` | The pattern of tracking child pids per parent and using the tree to kill on shutdown. We do not implement a full process tree; we track pids in the per-iteration `state.json`. |
| Schedules | `docs/missions.md` §"Schedules" | The `action: "schedule.create"`, `every`, `at`, `catchUp: latest|none` shape. We do not implement schedules in v2.5 (the trigger system already provides cron), but the pattern is the reference for the per-loop `state.json` + fixed-interval fire semantics. |
| Goal-mission pattern | `docs/missions.md` §"Goal missions" | The `goal: true` + `budget: { tokens: N }` + `state.nextReadyAction` pattern. We do not implement goal missions in v2.5; a future v3 "goal loop" could adopt this. |
| FleetView | `src/runs/background/fleet-view.ts` (referenced in `docs/observability.md`) | The pattern of bounded, sanitized per-iteration display records with model, tokens, duration, and preview. Our `sub-agent-fleet.ts` adapts this for the loop context. |
| Pre-flight launch contract | `docs/extension-api.md` §"Launch contract preflight" | The `resolveSubagentLaunchContract` shape (agent, task, context, cwd, model). Our scheduler does a smaller version: model + tools + cwd + budget, validated before spawn. |
| Symbol-keyed registry pattern | `src/api/background-work.ts` lines 1-62 | The `Symbol.for("pi-subagents.background-work.v1")` global registry. Our `pi-subagents-bridge.ts` reads the same symbol; the integration is opt-in and lazy. |

The full `pi-subagents` v0.50.0 changelog is at `research-wt/pi-subagents/CHANGELOG.md`. Notable items that informed this PRD:

- v0.50.0 — `foregroundDetachShortcut` (the pattern of moving a foreground run to background). We borrow the keybinding convention but not the runtime.
- v0.50.0 — `Orca progress tabs` (the per-child terminal pane). We do not implement this; it is a v3 stretch.
- 0.49 → 0.50 cutover — the `intercom` → `contact_supervisor` rename. We use the new name in our PRD's prose.
- Unreleased — `defaultSubagentContext: "fork"` (the parent-context-fork default). We do not adopt fork-context for sub-agent loops; we use fresh context per iteration.

---

## 19. Appendix B — external research references

The following Perplexity research notes informed this PRD. They are stored at `research-wt/notes/`:

| Note | Topic | Key takeaways |
|---|---|---|
| `research-perplexity-1.md` | How Claude Code, Cursor, Codex CLI, and Devin run background sub-agents | All major agents use option 4 (fresh sub-session per invocation) by default. `CLAUDE_CODE_FORK_SUBAGENT=1` enables forked context. The sub-agent's final message is the only thing that flows back to the parent. |
| `research-perplexity-2.md` | State-of-the-art pattern for N-iteration agent loops | Context isolation, durable execution / checkpointing, bounded concurrency / cost. Mentions LangGraph/PostgresSaver, Temporal/Inngest/Restate. Confirms our `fresh session per iteration` + `result file` + `parent restart reconciliation` design. |
| `research-perplexity-3.md` | The `Symbol.for` registry pattern and the in-process RPC | Confirms the `Symbol.for("pi-subagents.background-work.v1")` pattern is robust to multiple module loads. The RPC contract is the recommended extension integration surface. |
| `research-perplexity-4.md` | tmux, ConPTY, Windows Terminal panes, nohup | Confirms tmux is the wrong default for our cross-platform requirement. The child-process spawn with `child_process.spawn` is the right primitive. Windows equivalent of SIGTERM is `process.kill(pid, 'SIGTERM')` (Node.js maps to `TerminateProcess`). |
| `research-perplexity-5.md` | The goal-mission and schedule patterns in `pi-subagents` | Confirms the `goal: true` + `budget: { tokens: N }` pattern for continuous driver loops. Confirms the `schedule.create` / `every` / `catchUp` pattern for fixed-interval launches. We borrow the cron semantics (already in v2.x) and the budget pattern (new in v2.5). |

The user explicitly asked for the `browser` CLI to be used; all five notes were produced via `browser perplexity "<query>"` and saved with the file pattern `research-wt/notes/research-perplexity-{1..5}.md`.

---

## 20. Appendix C — glossary

- **Child process** — a Node.js process spawned by the parent pi session via `child_process.spawn`. The child runs an unmodified `pi` (or `pi-coding-agent` shim) binary in non-interactive mode. The child has its own session file and its own context window.
- **Child session** — the session file (`.jsonl`) and in-memory state of the child process. Distinct from the parent's session.
- **Iteration** — one fire of a loop. In sub-agent mode, an iteration is one child process from spawn to exit.
- **In-process loop** — a loop with `isolation: "in-process"`. The fire is a wake injected into the parent's session via `pi.sendMessage()`. The v2.x default.
- **Loop scope** — where the loop's `LoopStore` lives: `project` (`.pi/loops/loops.json`), `session` (`.pi/loops-<sessionId>.loops.json`), or `memory` (in-process only). Set via `settings.loopScope`.
- **Loop isolation** — new in v2.5. Where the loop's *execution* lives: `in-process` (parent session) or `sub-agent` (child session). Set per-loop on the `LoopEntry` `isolation` field.
- **Mission** — a `pi-subagents` term for a durable, recoverable per-work record. We borrow the *idea* (durable per-loop record) but not the schema.
- **Notification queue** — the priority-aware FIFO in `notification-runtime.ts` that holds pending wakes for the parent. Sub-agent iteration results enter the same queue.
- **Per-loop budget** — `subAgent.maxTokens` on a `LoopEntry`. The cumulative token cost of all iterations of this loop. When exhausted, the loop is paused.
- **Per-iteration budget** — `subAgent.iterationTokenBudget` on a `LoopEntry`. The soft token cap of a single iteration. Exceeding it does not kill the child; the result is marked `over_budget` and surfaced as a warning.
- **Priority** — `defer`, `normal`, `urgent`, or `critical`. Per ADR-005. Determines when the wake is delivered to the parent.
- **Rebound** — informal term for the parent-restart reconciliation: a sub-agent iteration that was running when the parent crashed and is reconciled on parent restart.
- **Result file** — `result.json` next to the child's session file. The parent's view of the iteration's outcome. The child writes the result *content* (`result.md`); the parent writes `result.json`.
- **Schedule** — a `pi-subagents` term for a fixed-interval auto-launch. We do not implement schedules in v2.5; the trigger system provides the same semantics.
- **Sub-agent loop** — a `LoopEntry` with `isolation: "sub-agent"`. Each fire spawns a child.
- **Wake** — a `ReducerNotification` that, when flushed, produces a `pi.sendMessage()` call in the parent. Sub-agent iteration results produce wakes (one line) just like in-process loop fires do.

---

*End of PRD.*

---

## Appendix D — Amendment log (decision rounds 1 + 2)

This PRD was originally drafted as a 14,800-word v1 on 2026-08-18. After two decision rounds with the user, it was amended to v2 on the same day. The amendments are:

### D.1 Round 1 — `docs/PRD/sub-agent-questions.xlsx` (18 questions)

Accepted as-is (15 of 18):

- D1: Default `isolation` is `in-process`.
- D2: All three platforms (macOS, Linux, Windows) on day 1.
- D4: Default `activeIterationsMax` is 4.
- D5: Tiered preview length (200 / 1,000 chars by priority).
- D6: Critical-priority interrupt only outside loop wakes.
- D8: Recursion guard via `--no-extensions` + `subagent` tool denial.
- D9: Last 50 iterations retained per loop.
- D10: Project root for sub-agent results.
- D11: Auto-register background-work provider (when pi-subagents is installed).
- D12: Read capability ceiling with first-time warning.
- D14: FleetView panel only when active.
- D15: `LoopInspect` as both tool and slash command.
- D16: Field name is `isolation`.
- D17: v2.5.0 = backend; v2.5.1 = frontend.
- D18: Cross-machine visibility deferred to v3.

Changed (3 of 18):

- **D3 (default timeout) — accepted B (10 min) but with a follow-up on `/loop` syntax for sub-agent mode.** The follow-up was R2-1 (round 2).
- **D7 (tool allowlist default) — accepted B (read-only) but reframed by the user's note: "we should have one dedicated to loops that has access to all tools/skills just as the main shell... maybe we discuss further on different types of subagents."** This was revisited in R2-2 (round 2) and resolved as A (full surface, no `subagent` tool).
- **D13 (global cost ceiling) — accepted A (no global ceiling) but with a new requirement: "loops that are created must have a defined goal, role, success criteria, failure criteria. optionally a state management file."** This drove the round-2 follow-up R2-4 (which the user resolved as A: all optional).

### D.2 Round 2 — `docs/PRD/sub-agent-questions-r2.xlsx` (4 follow-ups)

All four decisions in round 2 simplified the design:

- **R2-1 — `/loop` command syntax → user choice A (refined to a new parallel sub-command).** A separate `/loop-subagent <interval> <prompt>` slash command, not a flag on the existing `/loop`. The existing `/loop` still accepts `--isolation sub-agent` for users who prefer the flag form. See §6.4 and §12.0.
- **R2-2 — Default tools for sub-agent loops → user choice A (full surface, no `subagent` tool).** No more "read-only by default". A sub-agent loop's child gets the parent's full tool surface, plus all skills, with `subagent` denied. Per-loop `subAgent.tools` can still restrict. See §7.1.
- **R2-3 — Built-in roles → user choice A (none).** The `role` field is gone. No `scout` / `worker` / `digest-writer` set. Users write the role description into the loop's `prompt` themselves. This is a meaningful simplification — the entire role system (~200 LOC of code) is removed. See §6.1.
- **R2-4 — Goal / success / failure / state file requirement level → user choice A (all optional).** The runtime is permissive when any of these are missing. The auto-completion feature (success criteria → `status: completed`) only kicks in when the user opts in. See §6.1, §6.3, §10.3, and UC-6.

### D.3 Net effect on the design

The v2 design is **leaner** than the v1 draft despite adding the new optional fields. The simplifications are:

- **No role taxonomy** — users describe the role in `prompt`. The `LoopSubAgentConfig` interface drops its `role` field; the role-driven tool allowlist disappears; the role registry is gone.
- **No global cost ceiling** — per-loop `subAgent.maxTokens` is the only token gate. The session-level `costCeilingUsd` setting is gone. Cost is still tracked for reporting.
- **No required fields** — `goal` / `successCriteria` / `failureCriteria` / `stateFile` are all optional. A sub-agent loop can be as simple as `/loop-subagent every 30m "Check the API"`.
- **Full tool surface by default** — the child gets the parent's tools, minus `subagent`. This is the user's stated preference (D7's literal answer) and the recursion guard (D8) ensures no recursive spawn.

The added complexity is small:

- **Four new optional LoopEntry fields** with validation rules and a `loop-validation.ts` module. ~250 LOC.
- **A new `/loop-subagent` slash command** as a thin wrapper around `LoopCreate`. ~150 LOC.
- **A result evaluator** that applies `successCriteria` / `failureCriteria` as regex against `result.md`. ~150 LOC (or ~330 if the optional LLM-call evaluator is included).
- **`stateFile` read/write semantics** with locking. ~180 LOC.

Net: ~4,300 LOC of new code, ~1,900 LOC of new tests, ~500 LOC of new docs. The detailed per-spec LOC estimates are in `docs/PRD/sub-agent-specs.xlsx`.

### D.4 Companion deliverables on the `pi-subagent` branch

- **PRD (this document):** `docs/PRD/sub-agent.md` — 14,800 → 16,000 words after amendment.
- **Decision matrix v1:** `docs/PRD/sub-agent-questions.xlsx` — 18 questions across 7 groups.
- **Decision matrix v2:** `docs/PRD/sub-agent-questions-r2.xlsx` — 4 follow-up questions.
- **Spec sheets:** `docs/PRD/sub-agent-specs.xlsx` — 7 sheets, 55 implementation requirements, dict-based build script with explicit `assert k in d` at write time.
- **Research clone:** `research-wt/pi-subagents/` (vendored, gitignored; not committed).
- **Research notes:** `research-wt/notes/research-perplexity-{1..5}.md` (5 Perplexity research notes).
- **Build scripts:** `docs/PRD/build_questions.py`, `docs/PRD/build_questions_r2.py`, `docs/PRD/build_specs.py` (the build script for the spec sheets uses dicts with explicit asserts to prevent the "tuples are short" class of bug).

The spec sheets are the implementation-ready artefacts. The PRD is the high-level narrative. The decision matrices are the resolved-design history. Branch `pi-subagent` carries all of them.
