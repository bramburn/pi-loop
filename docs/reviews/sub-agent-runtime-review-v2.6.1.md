# Sub-agent runtime — code review (v2.6.1 status)

**Original review:** [`sub-agent-runtime-review.md`](./sub-agent-runtime-review.md) (committed at `c78b905` on `feat/subagent-runtime`).
**Re-reviewed at:** v2.6.1 (this commit).
**Reviewer:** Mavis
**Date:** 2026-08-19

This file tracks which findings from the original review have been fixed in
v2.6.1 and which remain open. The full review is in
`sub-agent-runtime-review.md`; this is the closure log only.

## Fixed in v2.6.1

- **C1** (timeout vs cancelled). Fixed via the `killedByTimer` flag on
  `SpawnHandle`; `determineStatus` now branches on it.
- **C2** (`onShutdown` no-op). Fixed by adding `ResultWatcher.cancelAll()`;
  `onShutdown()` calls it. Also fixes C3 by awaiting the per-child exit.
- **C3** (`onShutdown` does not await). Fixed as part of C2 — `cancelAll()`
  is async, sends SIGTERM, awaits each child with a 5s SIGTERM-then-SIGKILL
  cap.
- **H1** (pause notification references removed `LoopDelete`). Replaced
  with "ask the user to delete it via /loop's View-loops menu, or use
  LoopUpdate to change the cap".
- **M1** (`errorMessage` condition in `attachExitHandler` doesn't match
  `determineStatus`). Fixed — the conditional now also covers `cancelled`,
  and the timeout message is set explicitly to "iteration wall-clock timeout".

## Tests added

- `test/runtime/sub-agent/result-watcher.test.ts` (8 cases) — covers C1
  (timeout vs cancelled via the flag) and C2 (cancelAll kills every
  in-flight child, returns 0 on empty, is global, not per-loop).

## Still open (deferred to v2.6.2 or later)

- **H2** (readSessionTokens regex is fragile). Recommend `JSON.parse(line)`
  instead of regex. Tracked.
- **H3** (safeReadResultMd reads whole file). Recommend `fs.openSync` with
  truncation. Tracked.
- **M2** (defer notification priority defaults to "defer"). Should be
  `loop.priority ?? "normal"`. Tracked.
- **M3** (`nextIterId` called twice in `handleFire`). Tracked.
- **M4** (`_loop` parameter reserved without a comment). Tracked.
- **L1**–**L4** (cosmetic). Tracked.

## Quality gates

- `npm run test:all`: 1004 passed, 33 skipped (+8 over v2.6.0).
- `npm run typecheck`: clean.
- `npm run lint`: clean.
- `npm run build`: clean.
