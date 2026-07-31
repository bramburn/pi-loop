# User Journey Index — pi-loop

> **Role:** Software Engineer using pi.dev agent CLI with the pi-loop extension.
> **Purpose:** High-level map of all user journeys, one document per flow in `userflow/`.
> **Last updated:** 2026-07-04

---

## How to Read This Index

Each entry is a **user flow**: a distinct goal a software engineer can accomplish with pi-loop.
Flows are organized by **role concern** (Loop Management, Monitor Management, Task Management, System, Developer).

**Priority for review (per Loop 1 instructions):**
1. Flow has no markdown document
2. Flow has a document but no review timestamp
3. Flow document timestamp is older than 2 weeks

---

## 1. Loop Management

| # | User Flow | Entry Point | Exit Point | File | Last Reviewed |
|---|-----------|-------------|------------|------|---------------|
| L1 | Create a cron/scheduled loop | `/loop 5m check deploy` or `LoopCreate` tool | Loop fires on schedule, agent receives wake prompt | `userflow/loop-create-cron.md` | 2026-07-04 |
| L2 | Create an event-triggered loop | `/loop` interactive or `LoopCreate` with event source | Loop fires when specified pi event fires | `userflow/loop-create-event.md` | 2026-07-04 |
| L3 | Create a hybrid loop (cron + event) | `LoopCreate` with hybrid trigger spec | Event debounces cron; loop fires after debounce window | `userflow/loop-create-hybrid.md` | 2026-07-04 |
| L4 | View all active loops | `/loop` interactive → "View loops", or `LoopList` tool | Agent sees table of loop IDs, prompts, triggers, status | `userflow/loop-list.md` | 2026-07-04 |
| L5 | Pause / resume / delete a loop | `LoopDelete(id, "pause")`, `/loop-resume <id>`, `/loop` interactive | Loop stops firing (pause) or restarts (resume); deleted loops removed from store | `userflow/loop-delete-pause.md` | 2026-07-04 |
| L6 | Re-arm a stored loop (Governor) | `/loop-resume` (no args) | Governor picker opens; user selects which loops this terminal arms | `userflow/loop-governor.md` | 2026-07-04 |
| L7 | Manage per-session bindings (multi-terminal) | Multiple pi terminals in same repo | Each terminal arms a disjoint subset; no contention | `userflow/per-session-bindings.md` | 2026-07-04 |
| L8 | Self-paced loop (agent decides next interval) | `/loop` with no interval | Agent fires once, decides next interval via `updateMetadata` reschedule | `userflow/self-paced-loop.md` | 2026-07-04 |

---

## 2. Monitor Management

| # | User Flow | Entry Point | Exit Point | File | Last Reviewed |
|---|-----------|-------------|------------|------|---------------|
| M1 | Run a background command | `MonitorCreate` tool | Child process runs; stdout/stderr streamed as events; `monitor:done` fires | `userflow/monitor-create.md` | — |
| M2 | View monitor output | `MonitorList` tool | Agent sees table of monitors with status, exit codes, last 5 output lines | `userflow/monitor-list.md` | — |
| M3 | Stop a running monitor | `MonitorStop` tool | SIGTERM → 5s grace → SIGKILL; process terminated | `userflow/monitor-stop.md` | — |
| M4 | Auto-notify on monitor completion | `MonitorCreate` with `onDone` prompt | One-shot loop fires when process exits; agent receives completion prompt | `userflow/monitor-create.md` | — |
| M5 | Auto-prune completed monitors | Monitor completion | Monitors removed from store 30s after done/error | `userflow/monitor-auto-prune.md` | — |

---

## 3. Task Management

| # | User Flow | Entry Point | Exit Point | File | Last Reviewed |
|---|-----------|-------------|------------|------|---------------|
| T1 | Create a task | `/tasks <subject>` or `TaskCreate` tool | Task added to store; `tasks:created` event fires | `userflow/task-create.md` | 2026-07-04 |
| T2 | List tasks with status | `/tasks` or `TaskList` tool | Table of tasks: id, subject, status, blockedBy, owner | `userflow/task-list.md` | 2026-07-04 |
| T3 | Update task status / details | `TaskUpdate` tool | Status changes (pending→in_progress→completed); blockedBy/blocks edges updated | `userflow/task-update.md` | 2026-07-04 |
| T4 | Delete a task | `TaskDelete` tool | Task removed; bidirectional edges cleaned up | `userflow/task-delete.md` | 2026-07-04 |
| T5 | Auto-create task when loop fires | `LoopCreate` with `autoTask: true` | Loop fires → RPC to pi-tasks → task created; bidirectional edges maintained | `userflow/task-loop-interaction.md` | 2026-07-04 |
| T6 | Auto-create backlog worker loop | 5+ pending tasks detected | One-shot worker loop created to process backlog; auto-deletes when queue empty | `userflow/auto-task-worker.md` | — |

---

## 4. System / Session Workflows

| # | User Flow | Entry Point | Exit Point | File | Last Reviewed |
|---|-----------|-------------|------------|------|---------------|
| S1 | Session lifecycle hooks | pi session start/end/switch | `turn_start`, `agent_end`, `before_agent_start` drive all runtime behaviors | `userflow/session-lifecycle.md` | — |
| S2 | Cron scheduler internals | Loop fires (cron trigger) | Jittered timer fires; `pump()` checks nextFireTime; delivers to agent | `userflow/cron-scheduler.md` | — |
| S3 | Bindings store persistence | Session start | Loop bindings stored at `.pi/loops/bindings-<sessionId>.json`; survives restart | `userflow/per-session-bindings.md` | — |
| S4 | Git commit triggers task pruning | `git commit` hook | All completed tasks removed from store on successful commit | `userflow/git-commit-pruning.md` | — |
| S5 | Loop/task bidirectional relationships | Loop fires with `autoTask`, or task completes | `blockedBy` edges tracked on loop fires; `blocks` edges set on task create | `userflow/task-loop-interaction.md` | — |

---

## 5. Developer / Maintainer Flows

| # | User Flow | Entry Point | Exit Point | File | Last Reviewed |
|---|-----------|-------------|------------|------|---------------|
| D1 | Gap analysis — find missing features | Code review against documented flows | GAPS.md updated with new gaps; issues filed | `userflow/GAPS.md` | 2026-07-03 |
| D2 | Cross-platform compatibility audit | Windows vs Unix execution | Cross-platform issues documented (G-21, G-22, G-23) | `userflow/cross-platform-ux-analysis.md` | — |
| D3 | Review/update an existing flow doc | Loop 1 selects a stale flow | Flow doc updated with new timestamp; gaps identified | `userflow/*.md` | — |
| D4 | Governor UX walkthrough | Developer traces Governor picker | Governor behavior understood; bugs identified | `userflow/loop-governor.md` | — |

---

## Flow Selection Log (Loop 1)

| Run | Date | Action | Flow Processed |
|-----|------|--------|----------------|
| 1 | 2026-07-04 | Initial scan — created this index | — |
| 2 | 2026-07-04 | Documented L8 Self-Paced Loop | L8: `userflow/self-paced-loop.md` created — full forward/backward pass. Identified 3 gaps: G-L8a (no self-paced in /loop <prompt> mode select), G-L8b (no self-paced in interactive wizard), G-L8c (no LoopUpdate tool for agents to reschedule). AGENTS.md documents self-paced but UI paths are missing. |
| 3 | 2026-07-04 | Reviewed L1 Loop Create Cron | L1: `loop-create-cron.md` updated with timestamp, "Start now?" wizard step (PR #53), createdBy field, fireCount:0, verified G-45 dedup guards in TriggerSystem.add + CronScheduler.add. G-L1a (doc gap), G-L1b (inferTriggerType bare number edge case), G-L1c (G-45 verified OK). |
| 4 | 2026-07-04 | Reviewed L2 Loop Create Event | L2: `loop-create-event.md` updated with timestamp, "Start now?" wizard step, createdBy field, event filter implementation (regex/JSON), MonitorOnDoneRuntime architecture (monitor:done not handled by TriggerSystem directly). G-L2a (doc gap), G-L2b (MonitorOnDoneRuntime separate from TriggerSystem), G-L2c/d verified OK (G-06/G-07 closed, G-17 fixed). |
| 5 | 2026-07-04 | Reviewed L3 Loop Create Hybrid | L3: `loop-create-hybrid.md` updated with timestamp, "Start now?" diagram, createdBy field, hybrid trigger input format, debounce timer implementation (handleHybridFire with hybridTimers cleanup), monitor:done distinction (MonitorOnDoneRuntime vs TriggerSystem for hybrid). G-L3a (no hybrid wizard option), G-L3b (doc gap: missing Start now?), G-L3c/d verified OK. |
| 6 | 2026-07-04 | Reviewed L4 Loop List | L4: `loop-list.md` updated with timestamp, tool vs viewLoops filtering distinction (isUserVisibleLoop only on tool — viewLoops shows all loops including internal monitor:done), no binding status in viewLoops, no nextFire in interactive. G-L4a (viewLoops shows all, no binding info), G-L4b (tool vs interactive output format divergence). |
| 7 | 2026-07-04 | Reviewed L5 Loop Delete/Pause | L5: `loop-delete-pause.md` updated with timestamp. G-L5a (LoopUpdate tool exists in code but undocumented — G-L8c already fixed in code), G-L5b (LoopUpdate missing from doc), G-L5c (remove() cleans hybridTimers + lastFireTime — verified OK), G-L5d (maxFires description imprecise in LoopUpdate). |
| 8 | 2026-07-04 | Reviewed L6 Loop Governor | L6: `loop-governor.md` updated with timestamp, 5 sentinels (added Refresh + Disarm all), section headers partition by createdBy, ~ suffix for paused+bound, orphaned cleanup, Enhancement #22 = /loop-bindings (already implemented). G-L6a (Governor shows monitor:done loops), G-L6b (5 doc inaccuracies), G-L6c (one-shot no paused warning). |
| 9 | 2026-07-04 | Reviewed L7 Per-Session Bindings | L7: `per-session-bindings.md` updated with timestamp, memory scope section (no files, in-process only, resets on restart), clear() note. G-L7a (state diagram shows file-based for all scopes), G-L7b (Governor "My loops" excludes createdBy===undefined loops), G-L7c (clearAllLoops only clears store — verified OK). |
| 10 | 2026-07-04 | Reviewed T1 Task Create | T1: `task-create.md` updated with timestamp, added activeForm/owner/agentType/metadata/blocks/blockedBy to Data Structure, emitNativeTaskEvent in diagram (not simplified emit), /tasks shortcut path documented (description=subject). G-T1a (extra tool params undocumented), G-T1b (metadata type mismatch), G-T1c (shortcut path missing), G-T1d (blocks/blockedBy omitted from doc — verified OK). |
| 11 | 2026-07-04 | Reviewed T2 Task List | T2: `task-list.md` updated with timestamp, sortOrder parameter, blockedBy inline, /tasks top-level menu (5 options), interactive detail panel (Owner/Active/Blocks/BlockedBy/Metadata), ✎ Edit/+ Add blocker actions. G-T2a-g (doc missing sortOrder, blockedBy inline, 5-menu options, detail panel, Edit/Add blocker, Data Structure fields, truncation diff), G-T2h (updateDetails() only via interactive — info). |
| 12 | 2026-07-04 | Reviewed T3 Task Update | T3: `task-update.md` updated with timestamp, dependency edge operations (addBlocks/addBlockedBy/removeBlocks/removeBlockedBy), response format (warnings, auto loop msg), metadata shallow-merge semantics (null=delete), Data Structure updated with 5 missing fields. G-T3a (dependency edge ops undocumented), G-T3b (response format missing warnings/auto loop), G-T3c (metadata semantics undocumented), G-T3d (Data Structure 5 fields), G-T3e (activeForm/owner/agentType params undocumented). |
| 13 | 2026-07-04 | Reviewed T4 Task Delete | T4: `task-delete.md` updated with timestamp, edge cleanup on delete documented (reducer removes deleted task from all blocks/blockedBy arrays), pruneCompleted() bulk delete path documented, updated Deletion Behavior flowchart. G-T4a (edge cleanup undocumented), G-T4b (Data Structure 5 fields), G-T4c (pruneCompleted path undocumented — info). |
| 14 | 2026-07-04 | Reviewed T5 Task-Loop Interaction | T5: `task-loop-interaction.md` updated with timestamp, PI_LOOP_TASK_WORKER_THRESHOLD env var documented in Threshold Constants, isTaskBacklogLoop detection logic clarified (OR with isAutoTaskWorkerLoop + triggerHasEventSource check), cleanup condition precision note. G-T5a (env var undocumented — Medium), G-T5b (isTaskBacklogLoop logic incomplete), G-T5c (cleanup condition timing — info). |

---

## Research Notes (Loop 1 Run 1)

**Best practices for agent CLI loop extensions** (from InfoQ, GitHub awesome-cli-coding-agents, 2025-2026):

1. **Idempotency**: Every loop fire must be idempotent — same state whether fired once or multiple times. pi-loop's `fireCount` guard and `atMaxFires` check before `onFire()` satisfy this.
2. **Jitter**: Deterministic jitter (per loop ID hash) prevents thundering herd without true randomness. pi-loop uses `loop-parse.ts` `computeJitter()` — correct pattern.
3. **Deduplication**: Guard against duplicate `add()` calls registering multiple listeners/timers. pi-loop G-45 addresses this (dedup in `TriggerSystem.add()` and `CronScheduler.add()`).
4. **Session isolation**: Per-session bindings prevent multi-terminal contention. pi-loop's `bindings-<sessionId>.json` pattern is correct.
5. **Cross-platform**: `spawn("sh", "-c")` is Unix-only — G-21 critical. Needs `process.platform` detection or `cross-spawn`/`execa`.
6. **Graceful shutdown**: SIGTERM + 5s grace + SIGKILL pattern is correct for Unix; broken on Windows (G-22).
7. **Message deduplication key**: Notification key should include timestamp to avoid overwrite (G-46 — `loop:<id>:<timestamp>`).

**Reference sources:**
- [InfoQ: Patterns for AI Agent Driven CLIs](https://www.infoq.com/articles/ai-agent-cli/) (Aug 2025)
- [GitHub: awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents)
- [ZenML: Building Production-Ready AI Agents — Codex CLI Architecture](https://www.zenml.io/llmops-database/building-production-ready-ai-agents-openai-codex-cli-architecture-and-agent-loop-design)
- [OneUptime: Idempotency Keys in Node.js](https://oneuptime.com/blog/post/2026-01-27-nodejs-idempotency-keys/view) (Jan 2026)
