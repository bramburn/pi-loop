# Sub-agent runtime — code review

**Reviewed:** `feat/subagent-runtime` @ `70fead5` (v2.5.1 implementation)
**Reviewer:** Mavis
**Date:** 2026-08-19

This is a code review of the v2.5.1 sub-agent execution mode as implemented in
`src/runtime/sub-agent/`. The implementation is already merged into master and
shipped as v2.5.1; this review captures findings for a follow-up patch release.

## Critical

### C1. Timeout vs cancelled is collapsed into "cancelled"

`src/runtime/sub-agent/result-watcher.ts:266-272` — the `determineStatus` method's
comment says it should distinguish timeout (wall-clock timer killed) from cancel
(user issued a stop), but the code returns `"cancelled"` for **any**
`SIGTERM`/`SIGKILL` signal regardless of source:

```ts
if (exit.signal === "SIGTERM" || exit.signal === "SIGKILL") {
  // Distinguish timeout (the wall-clock timer killed) from cancel
  // (the user issued a stop). The store reads the timing; we just
  // label it cancelled if a signal was used and exitCode is null.
  return "cancelled";
}
```

The `SubAgentStatus` type (`src/types.ts:59-67`) lists `timeout` as a separate
value, and `statusToLabel` in `notification-formatter.ts:52` even has a `"failed
(timeout)"` branch — but the runtime never produces a `"timeout"` status. The
wall-clock timer in `spawn.ts:100-108` fires SIGTERM at the deadline, and that
flows through `determineStatus` and is mislabelled `"cancelled"`.

**Fix:** pass the source-of-signal (timer-fired vs cancel-called) through to
`determineStatus`, and return `"timeout"` when the deadline fired. The watcher
already knows the deadline; it just needs to track whether the kill came from
`spawnSubAgent`'s internal `setTimeout` (timeout) or from `handle.kill()` called
by the user (cancel). Simplest: have the spawn's timer set a flag on the
`SpawnHandle` (e.g. `handle.killedByTimer = true`) and check it in
`determineStatus`.

### C2. `onShutdown` is a no-op

`src/runtime/sub-agent/index.ts:159-161` — the shutdown path calls
`this.watcher.cancel("__all__" as string)`, but `cancel`'s predicate is
`if (rec.loopId !== loopId) continue;` (`result-watcher.ts:164`). Since no loop
has `loopId === "__all__"`, **no children are killed on parent shutdown**. The
parent exits, the children become orphans, and the next startup has to
reconcile.

```ts
onShutdown(): number {
  return this.watcher.cancel("__all__" as string);  // <-- never matches
}
```

**Fix:** add a dedicated `cancelAll()` method on `ResultWatcher` that iterates
`this.active` directly, and have `onShutdown` call it. The `cancel` method
should keep its current single-loop semantics.

### C3. `onShutdown` does not await the kill

`src/runtime/sub-agent/index.ts:159-161` — even if `cancel` matched, the
`cancel` body calls `rec.handle.kill("SIGTERM")` and immediately removes the
record from `this.active`, without awaiting the exit handler in
`attachExitHandler`. The parent may exit before the child finalises
`result.json`, and the SIGTERM-then-SIGKILL two-stage kill never runs (the OS
reaps the child on parent exit).

**Fix:** `onShutdown` should `await Promise.allSettled(activeRecords.map(r =>
r.handle.wait()))` after sending SIGTERM, with a hard upper bound (e.g. 5s
per child) before falling back to SIGKILL and reaping.

## High

### H1. Pause notification points to a tool that no longer exists

`src/runtime/sub-agent/index.ts:114` — the pause notification preview says
"Use LoopUpdate to change the cap or **LoopDelete** to remove." LoopDelete was
removed in v2.6.0 (PR #86) — it is no longer an LLM-callable tool.

**Fix:** change to "ask the user to delete it via /loop's View-loops menu, or
use LoopUpdate to change the cap" — the same wording used elsewhere after
v2.6.0.

### H2. `readSessionTokens` regex is fragile

`src/runtime/sub-agent/result-watcher.ts:313` — the regex assumes the JSONL
`usage` block has `input_tokens` immediately followed by `output_tokens`, with
no nested objects between them:

```ts
const m = line.match(/"usage"\s*:\s*\{[^}]*"input_tokens"\s*:\s*(\d+)[^}]*"output_tokens"\s*:\s*(\d+)/);
```

If the session format ever changes (e.g. adds a `cache_creation_input_tokens`
field between the two), this returns `null` silently and the iteration's
`costUsd: 0` looks like "free". There's no warning or fallback.

**Fix:** parse the line as JSON (it's JSONL after all) instead of regex. One
`JSON.parse(line)` and read `usage.input_tokens` / `usage.output_tokens`. If
that fails for any reason, log a debug breadcrumb and treat as zero tokens.

### H3. `safeReadResultMd` reads the whole file

`src/runtime/sub-agent/evaluator.ts:42-46` — the comment says it uses
`fs.openSync` with truncation but the code uses `readFileSync` and then slices:

```ts
const content = readFileSync(path, "utf-8");
return content.length > MAX_READ_BYTES ? content.slice(0, MAX_READ_BYTES) : content;
```

For a 100 MB `result.md`, this allocates 100 MB before slicing. The 32 KiB cap
is meant to bound memory, not just the regex input.

**Fix:** use `fs.openSync(path, "r")` + `fs.readSync(fd, buf, 0, MAX_READ_BYTES,
0)` + `fs.closeSync(fd)`, or `fs.createReadStream(path, { end: MAX_READ_BYTES - 1 })`
+ stream-to-string. Either avoids the full-file allocation.

## Medium

### M1. `errorMessage` condition in `attachExitHandler` doesn't match `determineStatus`

`src/runtime/sub-agent/result-watcher.ts:225-227` — the `errorMessage` is set
based on a re-check of the status, but the condition is incomplete:

```ts
...(status === "failed" || status === "failed_by_criteria" || status === "timeout"
  ? { errorMessage: verdict.reason ?? result.signal ?? `exit ${result.exitCode}` }
  : {}),
```

The check matches the type union but `determineStatus` never returns
`"timeout"` (see C1). The `verdict.reason` for `"failed_by_criteria"` should
also be the right value, but a `"cancelled"` or `"orphaned"` status with a
non-zero exit code and no `verdict.reason` would silently get an empty
`errorMessage`. Recommend deriving the `errorMessage` once, after
`determineStatus`, using the same switch.

### M2. `defer` notification priority is wrong

`src/runtime/sub-agent/index.ts:96` — the defer notification uses
`loop.priority ?? "defer"`, which means a loop with no explicit priority gets
"defer" priority on a deferral (suppressing it). That defeats the point of
notifying the agent that a defer happened.

**Fix:** `loop.priority ?? "normal"` — same default as elsewhere. Deferral
notifications should be at least "normal" so the agent can act on them.

### M3. `nextIterId` called multiple times in the same `handleFire`

`src/runtime/sub-agent/index.ts:96, 112, 122` — for the defer/pause paths,
`this.nextIterId(loop)` is called twice (once in the notification, once in the
spawn block). It's idempotent (same store read) but wasteful and easy to
misread. Extract to a local `const iterId = this.nextIterId(loop);` at the top
of `handleFire` and use it in all three places.

### M4. `_loop` parameter reserved for future use without a comment

`src/runtime/sub-agent/result-watcher.ts:266, 291` — `determineStatus` and
`extractPreview` take a `_loop: LoopEntry` parameter that is unused. If this is
intentional (e.g. reserved for a future "default to paused if loop is paused"
check), add a comment. Otherwise drop it — the underscore convention signals
"unused", which is misleading if it is actually load-bearing in some planned
refactor.

## Low / cosmetic

### L1. `formatSubAgentResult` hardcodes `"en-US"` locale

`src/runtime/sub-agent/notification-formatter.ts:25` —
`tokens.toLocaleString("en-US")`. Other locales format `1,000` vs `1.000`
differently; the LLM reads these as numbers so it matters. Consider
`Intl.NumberFormat()` with no locale (or inherit from the system).

### L2. `formatDuration` produces inconsistent output

`src/runtime/sub-agent/notification-formatter.ts:35-44` — for 60s returns
`"1m00s"`, for 1h returns `"1h0m"` (no seconds shown). Pick one convention and
document it.

### L3. `reconcileAfterRestart` mixes `require` and `import`

`src/runtime/sub-agent/result-watcher.ts:346` — uses `require("node:fs")` while
the rest of the file uses ESM `import`. Move to a top-level import. The
`require` is also harder to grep for.

### L4. `prune` doesn't bound `retain`

`src/runtime/sub-agent/result-store.ts:108` — `prune(loopId, retain)` only
checks `retain < 1` and exits; `retain: 0` is treated as 0, but a negative
`retain` (or non-integer) is not validated. A defensive
`Math.max(1, Math.floor(retain))` would be safer.

## Test-coverage gaps

These are not in the code under review but worth flagging for the next patch:

- **`determineStatus` with SIGTERM from the timer** is not unit-tested (it's
  part of `attachExitHandler`, which has integration coverage only). With C1
  fixed, this is the test that needs to land.
- **`onShutdown` cancel-everything path** is not unit-tested. With C2 fixed,
  add a test that registers 3 active iterations, calls `onShutdown()`, and
  asserts all 3 received SIGTERM.
- **`readSessionTokens` with malformed JSONL** is not tested. With H2 fixed,
  add a "garbage line" test.

## Verdict

**Ship-blocker for the next release.** C1 and C2 are real correctness bugs —
timeouts get mislabelled, and the parent's shutdown path silently leaks
children. H1 is a stale-documentation bug that surfaces immediately on
v2.6.0 install. H2 and H3 are robustness bugs (silent failure / unnecessary
memory).

The rest of the implementation (gate logic, cost-tracker arithmetic, settings
merge, types) is clean and well-tested. The fix surface is small and localised.

## Suggested fix order

1. C2 (`onShutdown` no-op) — one-method change, can ship as patch.
2. C1 (timeout vs cancelled) — small change, requires test update.
3. H1 (LoopDelete reference) — one-line text fix.
4. C3 (`onShutdown` await) — slightly larger; depends on C2.
5. H2, H3 — independent robustness fixes.
6. Medium / low — opportunistic.
