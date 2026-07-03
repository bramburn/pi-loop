# pi-loop native task system vs @tintinweb/pi-tasks: Gap Analysis

**Date:** 2026-07-03
**Goal:** Make pi-loop's native task system a full standalone replacement for `@tintinweb/pi-tasks`

---

## LLM-Callable Tools

| Feature | pi-tasks | pi-loop (native) | Status | Notes |
|---------|----------|-----------------|--------|-------|
| TaskCreate (subject, description, metadata) | ✅ | ✅ | **Done** | |
| TaskCreate (activeForm) | ✅ | ❌ | **Missing** | Present continuous for spinner |
| TaskCreate (agentType) | ✅ | ❌ | **Deferred** | Requires @tintinweb/pi-subagents |
| TaskList (status + blockedBy display) | ✅ | ⚠️ Partial | **Partial** | Shows status, no blockedBy |
| TaskList (sortOrder: id/status/recent/oldest) | ✅ | ❌ | **Missing** | |
| TaskList (owner display) | ✅ | ❌ | **Missing** | |
| TaskGet (full details + all edges + metadata JSON) | ✅ | ❌ | **Missing** | |
| TaskUpdate (status, subject, description) | ✅ | ✅ | **Done** | |
| TaskUpdate (activeForm, owner) | ✅ | ❌ | **Missing** | |
| TaskUpdate (metadata shallow-merge, null deletes keys) | ✅ | ❌ | **Missing** | |
| TaskUpdate (addBlocks / addBlockedBy) | ✅ | ❌ | **Missing** | |
| TaskUpdate (status: "deleted") | ✅ | ❌ | **Missing** | Currently separate TaskDelete tool |
| TaskOutput (background process output) | ✅ | ❌ | **Deferred** | Requires process tracker |
| TaskStop (stop background process) | ✅ | ❌ | **Deferred** | Requires process tracker |
| TaskExecute (subagent execution) | ✅ | ❌ | **Deferred** | Requires @tintinweb/pi-subagents |

**Status key:** ✅ Done | ⚠️ Partial | ❌ Missing | **Deferred** (blocked by external dependency)

---

## Dependency Management

| Feature | pi-tasks | pi-loop | Status |
|---------|----------|---------|--------|
| blocks[] field on TaskEntry | ✅ | ❌ | **Missing** |
| blockedBy[] field on TaskEntry | ✅ | ❌ | **Missing** |
| Bidirectional edges (addBlocks adds to other's blockedBy) | ✅ | ❌ | **Missing** |
| Cycle detection (warn on A→B→A) | ✅ | ❌ | **Missing** |
| Self-dependency detection (warn on A blocks A) | ✅ | ❌ | **Missing** |
| Dangling reference warning (block non-existent task) | ✅ | ❌ | **Missing** |
| Cleanup on delete (remove edges pointing to deleted task) | ✅ | ❌ | **Missing** |
| TaskList shows only open blockers | ✅ | ❌ | **Missing** |
| TaskGet shows all edges including completed | ✅ | ❌ | **Missing** |

---

## Interactive `/tasks` Menu (TUI)

| Feature | pi-tasks | pi-loop | Status |
|---------|----------|---------|--------|
| View all tasks (selectable list) | ✅ | ✅ | **Done** |
| Per-task detail view with actions | ✅ | ⚠️ Partial | **Partial** | Has Start/Complete/Delete, missing Edit/Add blocker |
| Create task (interactive prompts) | ✅ | ✅ | **Done** |
| Clear completed (batch prune) | ✅ | ❌ | **Missing** | TaskPrune tool exists but not wired to menu |
| Clear all (delete everything) | ✅ | ❌ | **Missing** |
| Settings panel | ✅ | ❌ | **Missing** |
| Navigate back from detail to list | ✅ | ✅ | **Done** |

---

## Settings Panel

| Feature | pi-tasks | pi-loop | Status |
|---------|----------|---------|--------|
| taskScope: memory / session / project | ✅ | ❌ | **Missing** |
| sortOrder: id / status / recent / oldest | ✅ | ❌ | **Missing** |
| maxVisible: 5–100 | ✅ | ❌ | **Missing** |
| showAll: true / false | ✅ | ❌ | **Missing** |
| hiddenAt: top / bottom | ✅ | ❌ | **Missing** |
| autoClearCompleted: never / on_list_complete / on_task_complete | ✅ | ❌ | **Missing** |
| Persisted to .pi/tasks-config.json | ✅ | ❌ | **Missing** |
| SettingsList TUI component | ✅ | ❌ | **Missing** |

---

## Widget (persistent visual panel above editor)

| Feature | pi-tasks | pi-loop | Status |
|---------|----------|---------|--------|
| Status icons (✔ ◼ ◻ ✳/✽ spinner) | ✅ | ⚠️ Partial | **Partial** | Has ok/>/\* icons, no spinner |
| Task count summary | ✅ | ✅ | **Done** |
| Strikethrough on completed | ✅ | ❌ | **Missing** |
| Active task elapsed time + token counts | ✅ | ❌ | **Missing** |
| blockedBy inline (› blocked by #1) | ✅ | ❌ | **Missing** |
| sortOrder support | ✅ | ❌ | **Missing** |
| maxVisible / showAll support | ✅ | ❌ | **Missing** |
| hiddenAt support | ✅ | ❌ | **Missing** |

---

## Auto-Clear (completed task cleanup)

| Feature | pi-tasks | pi-loop | Status |
|---------|----------|---------|--------|
| Turn-based delay (non-jarring UX) | ✅ | ❌ | **Missing** |
| `never` mode | ✅ | ❌ | **Missing** |
| `on_list_complete` mode | ✅ | ❌ | **Missing** |
| `on_task_complete` mode | ✅ | ❌ | **Missing** |
| Auto-delete empty session files | ✅ | ❌ | **Missing** |

---

## Storage

| Feature | pi-tasks | pi-loop | Status |
|---------|----------|---------|--------|
| memory scope | ✅ | ✅ | **Done** |
| session scope (per-session file) | ✅ | ⚠️ Partial | **Partial** | File path is different from pi-tasks |
| project scope (shared file) | ✅ | ❌ | **Missing** |
| File locking with stale-lock detection | ✅ | ✅ | **Done** |
| PI_TASKS env var override | ✅ | ❌ | **Missing** |
| Named shared lists (e.g. PI_TASKS=sprint-1) | ✅ | ❌ | **Deferred** |
| Auto-clear completed on new session | ✅ | ❌ | **Missing** |
| Show all tasks on session resume | ✅ | ❌ | **Missing** |

---

## Events & Cross-Extension

| Feature | pi-tasks | pi-loop | Status |
|---------|----------|---------|--------|
| tasks:created | ✅ | ✅ | **Done** |
| tasks:started | ✅ | ✅ | **Done** |
| tasks:completed | ✅ | ✅ | **Done** |
| tasks:deleted | ✅ | ✅ | **Done** |
| tasks:updated | ✅ | ✅ | **Done** |
| tasks:reopened | ✅ | ✅ | **Done** |
| tasks:rpc:ping (pi-tasks detection) | ✅ | ✅ | **Done** |
| tasks:rpc:create (remote task creation) | ✅ | N/A | **N/A** |
| tasks:rpc:pending (remote pending count) | ✅ | ✅ | **Done** |
| tasks:rpc:clean (remote prune) | ✅ | ✅ | **Done** |
| subagents:rpc:ping (subagent detection) | ✅ | N/A | **Deferred** |
| subagents:completed (subagent done) | ✅ | N/A | **Deferred** |
| subagents:failed (subagent error) | ✅ | N/A | **Deferred** |

---

## Deferred Features (require external dependencies)

These are explicitly **NOT in scope** for this goal because they depend on packages that pi-loop should not bundle:

| Feature | Blocked By | Reason |
|---------|-----------|--------|
| TaskExecute (subagent execution) | `@tintinweb/pi-subagents` | Requires subagent spawning infrastructure; pi-loop should not own this |
| TaskOutput (background output) | `@tintinweb/pi-subagents` | Tied to subagent process tracking |
| TaskStop (stop subagent) | `@tintinweb/pi-subagents` | Tied to subagent lifecycle |
| agentType on TaskCreate | `@tintinweb/pi-subagents` | Subagent type selector |
| subagent event integration | `@tintinweb/pi-subagents` | `subagents:ready`, `subagents:completed`, `subagents:failed` |
| Named shared task lists (PI_TASKS=sprint-1) | pi-tasks | Named lists are a pi-tasks feature; project scope covers team sharing |

---

## Summary

| Category | Done | Partial | Missing | Deferred |
|----------|------|---------|---------|----------|
| Tools | 3 | 2 | 10 | 3 |
| Dependencies | 0 | 0 | 9 | 0 |
| /tasks Menu | 3 | 1 | 2 | 0 |
| Settings | 0 | 0 | 8 | 0 |
| Widget | 2 | 1 | 6 | 0 |
| Auto-clear | 0 | 0 | 5 | 0 |
| Storage | 1 | 1 | 4 | 1 |
| Events | 6 | 0 | 0 | 3 |
| **Total** | **15** | **5** | **44** | **7** |

**Net new implementation:** 44 missing features to implement (excluding 7 deferred)
