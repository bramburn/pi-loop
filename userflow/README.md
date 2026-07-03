# User Flow Documentation

Comprehensive documentation of all user journeys in pi-loop, derived from code analysis.

## Loop Flows (CRUD)

| Flow | Description | Files |
|------|-------------|-------|
| [Loop Create — Cron](./loop-create-cron.md) | Create time-based recurring loops | tools/loop-tools.ts, store.ts |
| [Loop Create — Event](./loop-create-event.md) | Create event-triggered loops | tools/loop-tools.ts, trigger-system.ts |
| [Loop Create — Hybrid](./loop-create-hybrid.md) | Create loops with both cron + event | tools/loop-tools.ts, trigger-system.ts |
| [Loop List](./loop-list.md) | View all loops with status | tools/loop-tools.ts, scheduler.ts |
| [Loop Delete/Pause](./loop-delete-pause.md) | Delete, pause, or resume loops | tools/loop-tools.ts, store.ts |
| [Loop Resume](./loop-resume.md) | Re-arm and bind a loop in one call, or open the Governor | commands/loop-command.ts, bindings-store.ts |
| [Loop Governor](./loop-governor.md) | Interactive picker to manage which loops this terminal arms | commands/loop-command.ts, bindings-store.ts |
| [Per-Session Bindings](./per-session-bindings.md) | Per-session loop bindings for multi-terminal parallelism | runtime/bindings-store.ts, runtime/session-runtime.ts |

## Monitor Flows (Background Commands)

| Flow | Description | Files |
|------|-------------|-------|
| [Monitor Create](./monitor-create.md) | Run background command with output streaming | monitor-manager.ts, tools/monitor-tools.ts |
| [Monitor List](./monitor-list.md) | View all monitors with output | monitor-manager.ts, tools/monitor-tools.ts |
| [Monitor Stop](./monitor-stop.md) | Stop a running monitor | monitor-manager.ts, tools/monitor-tools.ts |

## Native Task Flows (CRUD)

These flows are available when pi-tasks is not installed. They provide a fallback task tracking system.

| Flow | Description | Files |
|------|-------------|-------|
| [Task Create](./task-create.md) | Create a new task | tools/native-task-tools.ts, task-store.ts |
| [Task List](./task-list.md) | View all tasks | tools/native-task-tools.ts, task-store.ts |
| [Task Update](./task-update.md) | Update task status/details | tools/native-task-tools.ts, task-store.ts |
| [Task Delete](./task-delete.md) | Delete a task | tools/native-task-tools.ts, task-store.ts |

## System Workflows

| Flow | Description | Files |
|------|-------------|-------|
| [Cron Scheduler](./cron-scheduler.md) | Pump-driven timing, jitter, concurrency | scheduler.ts, loop-parse.ts |
| [Auto Task Worker Loop](./auto-task-worker.md) | Auto-created when 5+ pending tasks | runtime/task-backlog-runtime.ts |
| [Task-Loop Interaction](./task-loop-interaction.md) | Bidirectional task↔loop relationships | runtime/task-*.ts |
| [Session Lifecycle](./session-lifecycle.md) | turn_start, agent_end, session_switch hooks | runtime/session-runtime.ts |
| [Git Commit Pruning](./git-commit-pruning.md) | Auto-prune completed tasks on git commit | runtime/session-runtime.ts |
| [Monitor Auto-Prune](./monitor-auto-prune.md) | Auto-remove monitors 30s after completion | monitor-manager.ts |

## Analysis

| Document | Description |
|----------|-------------|
| [Cross-Platform & UX Analysis](./cross-platform-ux-analysis.md) | 30+ issues: 3 critical cross-platform, UX gaps, memory leaks, testing gaps |
| [GAPS.md](./GAPS.md) | 20 design/implementation gaps identified from workflow documentation |

## Architecture Overview

```mermaid
flowchart TD
    subgraph Commands
        C1[/loop]
        C2[/loop-resume]
        C3[/tasks]
        C4[/monitors]
    end

    subgraph Tools
        T1[LoopCreate]
        T2[LoopList]
        T3[LoopDelete]
        T4[MonitorCreate]
        T5[MonitorList]
        T6[MonitorStop]
        T7[TaskCreate]
        T8[TaskList]
        T9[TaskUpdate]
        T10[TaskDelete]
    end

    subgraph Core
        S[Store]
        TS[TriggerSystem]
        CS[CronScheduler]
        MM[MonitorManager]
        BS[BindingsStore]
    end

    subgraph Storage
        LS[LoopStore<br/>.pi/loops/loops.json]
        TAS[TaskStore]
        BB[Bindings<br/>.pi/loops/bindings-<sessionId>.json]
    end

    T1 --> S
    T2 --> S
    T2 --> BS
    T2 --> TS
    T3 --> S
    T4 --> MM
    T5 --> MM
    T6 --> MM
    T7 --> TAS
    T8 --> TAS
    T9 --> TAS
    T10 --> TAS

    S --> LS
    BS --> BB
    TAS --> TAS
    
    S --> TS
    TS --> CS
    TS --> E[EventBus]
    
    MM --> E
```

## Data Flow Summary

### Loop Lifecycle

```
LoopCreate → LoopStore → TriggerSystem → Scheduler/EventBus
                                                    ↓
                          showPersistedLoops ← BindingsStore (per-session filter)
                                                    ↓
                                            CronScheduler
                                                    ↓
                                            Loop fires
                                                    ↓
                                            pi.sendMessage()
```

**Per-session bindings:** Only loops whose IDs are in `bindings-<sessionId>.json` are armed on session start. See [Per-Session Bindings](./per-session-bindings.md).

### Monitor Lifecycle

```
MonitorCreate → MonitorManager → ChildProcess spawn
                                           ↓
                                   Output buffering
                                           ↓
                                   monitor:output events
                                           ↓
                              monitor:done / monitor:error
                                           ↓
                              onDone loop fires (if configured)
```

### Task Lifecycle

```
TaskCreate → TaskStore → tasks:created event
                                    ↓
                          evaluateTaskBacklog()
                                    ↓
                   Backlog worker loop created (if needed)
                                    ↓
                          TaskUpdate status changes
                                    ↓
                          TaskDelete / auto-prune
```

## pi-tasks Integration

When `@tintinweb/pi-tasks` is present, pi-loop delegates task operations via RPC:

```typescript
// src/runtime/task-rpc.ts
pi.events.emit("tasks:rpc:ping", { requestId })        // Detect presence
pi.events.emit("tasks:rpc:create", { requestId, subject, description })
pi.events.emit("tasks:rpc:pending", { requestId })    // Get pending count
pi.events.emit("tasks:rpc:clean", { requestId })      // Prune done tasks
```

When pi-tasks is absent, native task tools are registered after a 6-second delay.

## Key Files Reference

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Extension entry, wires all components, BindingsStore init |
| `src/types.ts` | TypeScript interfaces for LoopEntry, MonitorEntry |
| `src/store.ts` | LoopStore with file-backed persistence |
| `src/task-store.ts` | TaskStore with file-backed persistence |
| `src/trigger-system.ts` | Event + cron trigger registration |
| `src/scheduler.ts` | Cron timer management |
| `src/monitor-manager.ts` | Child process spawning and tracking |
| `src/tools/loop-tools.ts` | LoopCreate, LoopList, LoopDelete |
| `src/tools/monitor-tools.ts` | MonitorCreate, MonitorList, MonitorStop |
| `src/tools/native-task-tools.ts` | TaskCreate, TaskList, TaskUpdate, TaskDelete |
| `src/commands/loop-command.ts` | /loop + /loop-resume commands (including Governor picker) |
| `src/commands/tasks-command.ts` | /tasks command handler |
| `src/ui/widget.ts` | Status bar widget |
| `src/runtime/session-runtime.ts` | Session lifecycle hooks, showPersistedLoops (bindings filter) |
| `src/runtime/bindings-store.ts` | Per-session loop bindings (BindingsStore class) |
| `src/runtime/scope.ts` | Path resolution for loops, tasks, and bindings under PI_LOOP_SCOPE |
| `src/runtime/*.ts` | Runtime behaviors (notification, backlog, monitor-on-done, etc.) |
