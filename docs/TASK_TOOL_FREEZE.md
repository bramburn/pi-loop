# pi Task Tool UI Freeze — Root Cause & Workaround

## Summary

When a pi-agent session issues **more than ~2 `TaskCreate` calls in a single parallel tool block**, the TUI freezes. The freeze is **not a deadlock** — it's a render-loop saturation. The tools still execute on the agent side; the terminal just stops painting.

This is unrelated to the `pi-loop` extension code. It reproduces without any extension loaded.

## Reproduction

1. Start a fresh pi session.
2. In a single response, ask the agent to "create 9 tasks numbered 1-9 for X, Y, Z, ..." as a parallel TaskCreate batch.
3. The terminal stops responding to keystrokes within seconds. The agent continues to make tool calls (visible if you can switch to a different terminal and read the session log), but the TUI is unresponsive.

## Root cause

Perplexity research (cached entry `69b98d90-d49f-4148-a2c7-6adeb14977f2`) confirms:

> The freeze is usually not a true deadlock; it's a render saturation problem where one async batch triggers too many React commits, and Ink has to keep repainting the terminal faster than the terminal renderer can keep up. In practice, this happens when parallel async work fans out into many setState calls, especially if each update changes top-level state or causes large subtrees to [re-render].

**Why `TaskCreate` triggers it:** every successful tool call produces an IPC event that mutates pi's task list pane, which is a top-level React subtree. React 18+ auto-batches state updates within React's event handlers, but **cross-process IPCs** (postMessage / Unix socket / pipe) bypass the batching wrapper. Each tool result becomes its own commit.

**Why the threshold is ~2:** below that, the commits complete faster than the terminal can repaint. Above that, the commit queue grows faster than the renderer can drain, and Ink's frame loop falls behind indefinitely.

## Why the merge was a red herring

While debugging this, the natural hypothesis was "the merge from `master` introduced a regression." Investigation showed the merge only touched `pi-loop` extension files (`src/commands/loop-command.ts`, `src/loop-reducer.ts`, `src/store.ts`, `test/loop-command.test.ts` and adjacent). The diff added 2 getter exports to a debug object and pulled in the `fire-on-create` feature from `1fc5451`. None of these touch pi's task system.

The freeze is reproducible on `master` (no extension code) with a parallel TaskCreate batch, so the extension merge is not a factor.

## Workaround

**Rule: ≤2 `TaskCreate` calls per parallel tool block.** For more than 2, use sequential blocks.

```text
# Bad — freeze risk
TaskCreate 1 ...
TaskCreate 2 ...
TaskCreate 3 ...
TaskCreate 4 ...
TaskCreate 5 ...   ← TUI may freeze around here

# Good — sequential
TaskCreate 1 ...
TaskCreate 2 ...   ← commit drain
TaskCreate 3 ...
TaskCreate 4 ...   ← commit drain
TaskCreate 5 ...
```

The same pattern applies to **any TUI-bound tool** that triggers a visible state mutation on success — concrete list (all return IPC events that mutate top-level React state):

- `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskDelete`, `TaskGet`, `TaskPrune`
- `LoopCreate`, `LoopUpdate`, `LoopList`, `LoopDelete`
- `MonitorCreate`, `MonitorList`, `MonitorStop`, `MonitorDelete`
- `TaskCreate` (native fallback)
- Any pi extension tool registered via `pi.registerTool`

## Mitigation if you hit a freeze

1. The agent's tool calls keep running in the background — no work is lost.
2. Give the terminal a few minutes; the render queue may eventually drain if no more IPC events arrive.
3. If it doesn't drain, kill the process (`Ctrl+C` in the terminal, or `kill <pid>` from another shell) and restart. The session state may be lost depending on the persistence scope.

## Recommended upstream fix

In pi's TUI layer:

- Wrap batch tool results in `unstable_batchedUpdates` (or React 18's `startTransition`) so multiple IPC events coalesce into one commit.
- Or: debounce the task list re-render with a 50-100ms coalescing window.

### Confirmed upstream root cause: **earendil-works/pi#7053**

Investigation on 2026-07-31 traced the freeze to an upstream bug in `@earendil-works/pi-coding-agent`:

- **Issue**: <https://github.com/earendil-works/pi/issues/7053> — *Parallel tool batches lose already-completed tool results when one sibling stalls (orphaned toolCalls -> 'No result provided')*
- **State**: OPEN
- **Affected versions**: 0.80.6+ (still open in 0.83.0)
- **Code path**: `executeToolCallsParallel()` in `packages/agent/src/agent-loop.ts`
- **Mechanism**: A `Promise.all` barrier at the agent-core level means persistence of *every* result is gated on the *slowest* sibling. The TUI fires per-tool `tool_execution_end` (so the UI shows results as they finish), but the persisted `toolResult` messages are emitted only after the whole batch settles. If one tool stalls, the *entire* batch's persistence is delayed. If the user aborts or kills the process, every toolCall in the batch becomes orphaned and the next model request sees synthetic failures.

### Why our local guard still helps

Our runtime guard (`wrapToolExecute` + `recordParallelCall`/`checkParallelStorm`) is a **client-side mitigation**, not a fix for #7053:

- It limits the number of parallel calls per tool to 2 in a 1-second window.
- The model learns from the thrown error and throttles its own parallel batches.
- We avoid the `Promise.all` barrier risk entirely by not letting the batch get big enough to stall.
- The TUI saturation case (many concurrent `requestRender()` calls) is also mitigated because we cap the burst.

### TUI render architecture (corrects earlier diagnosis)

For posterity: the pi TUI is **NOT built on React/Ink**. It's a custom terminal UI framework:

- Differential rendering, overlay compositing, synchronized atomic updates via CSI 2026 when supported.
- ~16 ms frame budget (60 fps target) with request coalescing.
- Parallel tool execution is supported natively — `tool_execution_end` fires per-tool as each finishes.
- `tool_execution_update` events may interleave across parallel tools.

So the freeze mechanism is **custom-TUI `requestRender()` overload** from many concurrent tool events, not React/Ink render-loop saturation. (My earlier diagnosis based on initial Perplexity research was wrong on this point; corrected after a second research pass.)

### Other open upstream TUI performance issues (filed but not yet fixed)

- **#7113** — TUI freezes after entering an API key in `/login` when the pi.dev model catalog is unreachable.
- **#6665** (in-progress, assigned to `@davidbrai`) — TUI pins a full core while streaming (uncached `Intl.Segmenter` + per-chunk Markdown rebuild).
- **#7153** — `/scoped-models` appears to do nothing for ~5 minutes while awaiting stalled catalog refresh.
- **#6702** (CLOSED, no-action) — pi-tui replays the entire transcript on every terminal width change (tmux zoom).
- **#6789** (CLOSED, no-action) — TUI hangs on submit (and slow to start) on pi-coding-agent 0.80.10 on Linux Mint.
- **#6478** (CLOSED, no-action) — TUI: per-frame render cost grows with transcript length.
- **#6755** (CLOSED, no-action) — Agent loop retains every tool partial update; settle runs `Promise.all` over all of them.

The `Promise.all`-over-tool-updates pattern in #6755 is structurally identical to the bug in #7053 — both unblock the TUI but block on the slowest sibling for persistence/memory cleanup.

## Local mitigation in `pi-loop`

Since the upstream fix is out of our hands, `pi-loop` ships a runtime guard at the `pi.registerTool` boundary. The `wrapToolExecute` wrapper in `src/telemetry/sentry.ts` counts calls per tool name on a 1-second sliding window. If more than `MAX_PARALLEL_CALLS` (= 2) of the same tool fire in that window, the wrapper throws a clear error:

> Parallel tool call storm for 'MonitorCreate': 3 calls within 1000ms (limit is 2). Call this tool sequentially to avoid TUI freeze.

The model sees the error, learns, and reduces parallelism. Tested in `test/telemetry/sentry.test.ts` (4 cases covering allow / throw / per-tool isolation / reset). The guard is **always on** — it doesn't depend on Sentry being initialized.

Trade-offs:

- The guard fires on the 3rd call, so 1–2 IPC events still happen before the throw. The cumulative load is much lower than the 9+ that caused the original freeze.
- The error message is visible to the model, so future prompts will self-throttle.
- Different tools have separate counters, so a `MonitorCreate` storm doesn't block a `LoopCreate` call.

## Related

- Sisyphus goal that prompted this investigation: ship Sentry + log capture for `pi-loop` (`feat/sentry-crash-analytics` branch).
- Memory: `pi-tool-usage` category — "≤2 parallel tool calls per block when the called tool triggers a visible TUI state mutation."
