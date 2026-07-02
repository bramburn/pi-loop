# Task-Loop Interaction

## Overview

Tasks and loops have a bidirectional relationship managed by two runtime systems:

- **TaskBacklogRuntime** (`src/runtime/task-backlog-runtime.ts`): Manages the auto task worker loop lifecycle
- **TaskRuntimeBridge** (`src/runtime/task-rpc.ts`): Bridges native tasks and pi-tasks for task creation from loops

```mermaid
flowchart TD
    subgraph "Task Operations"
        T1[TaskCreate]
        T2[TaskUpdate]
        T3[TaskDelete]
    end

    subgraph "TaskBacklogRuntime"
        E[evaluateTaskBacklog]
        A[ensureAutoTaskWorkerLoop]
        C[cleanupTaskBacklogLoops]
    end

    subgraph "Auto Task Worker Loop"
        L1[Created at 5+ pending tasks]
        L2[Fires on tasks:created event]
        L3[Creates tasks via autoCreateTask]
        L4[Self-deletes when queue empty]
    end

    subgraph "pi-tasks Bridge"
        R[TaskRuntimeBridge]
        P[pi-tasks RPC]
        N[Native TaskStore]
    end

    T1 --> E
    T2 --> E
    T3 --> E
    E --> A
    A -->|Creates| L1
    L1 --> L2
    L2 --> L3
    L3 --> T1
    L3 -->|autoTask: true| P
    L3 -->|autoTask: true| N
    C -->|pendingCount=0| L4
```

## The Two Interaction Patterns

### Pattern A: Loop Creates Task (autoTask)

When a loop has `autoTask: true`, it creates a task each time it fires:

```mermaid
sequenceDiagram
    participant L as Loop fires
    participant O as onLoopFire
    participant R as TaskRuntime
    participant P as pi-tasks
    participant N as Native TaskStore

    L->>O: onLoopFire(entry)
    O->>O: store.fire(id)
    O->>R: autoCreateTask(entry)

    alt pi-tasks available
        O->>P: tasks:rpc:create
        P-->>O: taskId
    else Native tasks available
        O->>N: taskStore.create()
        N-->>O: taskId
    else No task system
        O-->>O: No-op
    end

    O-->>O: emit loop:fire event
```

```typescript
// src/index.ts - onLoopFire
function onLoopFire(entry: LoopEntry): void {
  if (atMaxFires(entry)) {
    store.delete(entry.id);
    return;
  }
  store.fire(entry.id);

  if (entry.autoTask) {
    autoCreateTask(entry).then((taskId) => {
      if (taskId) debug(`loop #${entry.id} → task #${taskId}`);
    });
  }

  pi.events.emit("loop:fire", { loopId: entry.id, ... });
}
```

### Pattern B: Task Triggers Loop (backlog worker)

When 5+ pending tasks exist, an auto task worker loop is created that fires on `tasks:created` events:

```mermaid
sequenceDiagram
    participant T as TaskCreate
    participant E as evaluateTaskBacklog
    participant A as ensureAutoTaskWorkerLoop
    participant L as Auto Task Worker Loop
    participant TR as TriggerSystem
    participant R as Agent

    T->>E: evaluateTaskBacklog(store, pendingCount)
    E->>E: pendingCount >= 5?
    E->>A: ensureAutoTaskWorkerLoop()

    alt pendingCount >= 5 AND no worker exists
        A->>L: create loop
        L->>TR: add(entry)
        TR->>TR: subscribe(tasks:created)

        Note over A,L: Bootstrap: fire immediately if pending tasks exist
        A->>A: bootstrapTaskLoop()
        A->>R: queueOrDeliverNotification()
    end

    Note over L,R: Loop fires when tasks:created event fires
    T->>TR: emit(tasks:created)
    TR->>R: Agent wake

    Note over R: Agent picks up task, completes it
    T->>E: evaluateTaskBacklog(store, pendingCount)
    E->>E: pendingCount == 0?
    E->>C: cleanupTaskBacklogLoops()
    C->>L: deleteLoop(id)
```

## Event Flow Diagram

```mermaid
sequenceDiagram
    participant A as Agent
    participant T as TaskStore
    participant R as TaskRuntime
    participant E as pi.events
    participant TBR as TaskBacklogRuntime
    participant L as Auto Task Worker Loop
    participant CS as CronScheduler

    Note over A,L: Scenario: Agent creates 6 tasks rapidly

    A->>T: TaskCreate "Task 1"
    T-->>E: emit(tasks:created, task1)

    A->>T: TaskCreate "Task 2"
    T-->>E: emit(tasks:created, task2)

    A->>T: TaskCreate "Task 3"
    T-->>E: emit(tasks:created, task3)

    A->>T: TaskCreate "Task 4"
    T-->>E: emit(tasks:created, task4)

    A->>T: TaskCreate "Task 5"
    T-->>E: emit(tasks:created, task5)

    Note over TBR: pendingCount = 5 → threshold reached

    A->>T: TaskCreate "Task 6"
    T-->>E: emit(tasks:created, task6)
    T->>TBR: evaluateTaskBacklog(pendingCount=6)
    TBR->>TBR: ensureAutoTaskWorkerLoop()

    TBR->>L: create hybrid loop<br/>cron: */5 * * * *<br/>event: tasks:created
    L->>CS: armTimer()
    L->>E: subscribe(tasks:created)

    Note over L: Bootstrap: immediate fire
    L->>A: pi.sendMessage(AUTO_TASK_WORKER_PROMPT)

    Note over A: Agent processes tasks...
    A->>T: TaskUpdate status: in_progress
    A->>T: TaskUpdate status: completed
    A->>T: TaskUpdate status: in_progress
    A->>T: TaskUpdate status: completed

    Note over TBR: pendingCount = 0
    A->>T: TaskUpdate status: completed
    T->>TBR: cleanupTaskBacklogLoops()
    TBR->>L: deleteLoop(id)
```

## Key Data Structures

### Loop Entry (when used as task worker)

```typescript
// src/runtime/task-backlog-runtime.ts
const AUTO_TASK_WORKER_PROMPT =
  "Run TaskList, pick next pending task, mark it in_progress, " +
  "implement it, run validation, complete it. " +
  "If no pending tasks remain, call LoopDelete on your own loop ID.";

interface AutoTaskWorkerLoop {
  trigger: {
    type: "hybrid";
    cron: "*/5 * * * *";
    event: {
      source: "tasks:created";
    };
    debounceMs: 30000;
  };
  prompt: AUTO_TASK_WORKER_PROMPT;
  recurring: true;
  taskBacklog: true;
  maxFires: 30;
  autoTask: false;  // Worker creates tasks manually via prompts
}
```

### Task Metadata (when created by loop)

```typescript
// src/runtime/task-rpc.ts
interface AutoCreatedTask {
  subject: string;  // Truncated from loop.prompt (first 80 chars)
  description: `Auto-created from loop #${loopId}`;
  metadata: {
    loopId: string;
    trigger: Trigger;
  };
}
```

## Backlog Evaluation State Machine

```mermaid
stateDiagram-v2
    [*] --> Empty: No tasks

    Empty --> Low: TaskCreate
    Low: Low<br/>0-4 tasks

    Low --> Low: TaskCreate
    Low --> Empty: All completed/deleted

    Low --> High: TaskCreate
    High: High<br/>5+ tasks

    High --> High: TaskCreate
    High --> Low: Tasks completed
    High --> AutoWorkerCreated: pendingCount >= threshold

    AutoWorkerCreated: Auto Task Worker Loop<br/>created and active

    AutoWorkerCreated --> High: Loop fires<br/>tasks processed
    High --> Empty: All completed
    AutoWorkerCreated --> [*]: pendingCount = 0<br/>loop deleted
```

## Coordinator Pattern

The TaskBacklogRuntime uses a Coordinator to manage backlog state:

```mermaid
sequenceDiagram
    participant T as TaskStore
    participant C as Coordinator
    participant R as Reducer
    participant E as EffectHandler

    T->>C: dispatch(TASK_BACKLOG_EVALUATED)
    C->>R: reduceTaskBacklogEvent()
    R-->>C: Effect[]

    Note over R: pendingCount < 0: []<br/>pendingCount == 0: CLEANUP_TASK_BACKLOG_LOOPS<br/>pendingCount >= 5: ENSURE_AUTO_TASK_WORKER<br/>otherwise: []

    loop For each effect
        C->>E: effectHandlers[effect.type](effect)
        E->>E: ensureAutoTaskWorkerLoop() or cleanupTaskBacklogLoops()
    end
```

## Threshold Constants

| Constant | Value | Location |
|----------|-------|----------|
| `AUTO_TASK_WORKER_THRESHOLD` | 5 | `src/runtime/task-backlog-runtime.ts` |
| `AUTO_TASK_WORKER_MAX_FIRES` | 30 | `src/runtime/task-backlog-runtime.ts` |
| `AUTO_TASK_WORKER_CRON` | `*/5 * * * *` | `src/runtime/task-backlog-runtime.ts` |
| `AUTO_TASK_WORKER_DEBOUNCE` | 30000ms | `src/runtime/task-backlog-runtime.ts` |

## Task Loop Identification

Backlog loops can be identified by their properties:

```typescript
// src/runtime/task-backlog-runtime.ts
function isAutoTaskWorkerLoop(entry: LoopEntry): boolean {
  return entry.status === "active"
    && entry.prompt === AUTO_TASK_WORKER_PROMPT
    && triggerHasEventSource(entry.trigger, "tasks:created");
}

function isTaskBacklogLoop(entry: LoopEntry): boolean {
  return entry.status === "active"
    && triggerHasEventSource(entry.trigger, "tasks:created")
    && (entry.taskBacklog === true || isAutoTaskWorkerLoop(entry));
}
```

These functions are used for:
- `findAutoTaskWorkerLoop()`: Find existing worker to avoid duplicates
- `cleanupTaskBacklogLoops()`: Delete all backlog loops when queue empties
- `maybeBootstrapTaskLoop()`: Immediate wake when pending tasks exist at creation

## Bootstrap Behavior

When an auto task worker loop is created and pending tasks already exist:

```mermaid
sequenceDiagram
    participant A as TaskBacklogRuntime
    participant T as TaskRuntime
    participant N as NotificationRuntime
    participant P as pi

    A->>T: maybeBootstrapTaskLoop(entry)
    T->>T: hasPendingTasks()
    T->>T: pendingCount > 0?

    alt Yes, pending tasks exist
        T->>N: queueOrDeliverNotification({
            loopId: entry.id,
            prompt: entry.prompt,
            timestamp: Date.now()
        })
        N->>P: pi.sendMessage(triggerTurn: true)
        Note over P: Agent immediately wakes
    else No pending tasks
        Note over T: Skip bootstrap
        Note over T: Wait for tasks:created event
    end
```

## Cleanup Flow

When all tasks are completed:

```mermaid
sequenceDiagram
    participant A as Agent
    participant T as TaskStore
    participant R as TaskBacklogRuntime
    participant TR as TriggerSystem
    participant L as LoopStore

    Note over A,R: agent_end event fires
    A->>R: cleanupTaskBacklogLoops()
    R->>T: pendingCount()
    T-->>R: 0

    R->>R: Get backlog loops
    R->>TR: removeTrigger(loopId)
    R->>L: deleteLoop(loopId)
    R->>R: updateWidget()

    Note over TR: CronScheduler armTimer removed<br/>EventBus unsubscribed
    Note over L: Loop deleted from store
```

## pi-tasks Integration

When pi-tasks is present, task creation from loops uses RPC:

```mermaid
sequenceDiagram
    participant L as Loop fires
    participant R as TaskRuntime
    participant E as pi.events
    participant PT as pi-tasks

    L->>R: autoCreateTask(entry)
    R->>E: emit(tasks:rpc:create, {
        requestId: uuid,
        subject: entry.prompt.slice(0, 80),
        description: `Auto-created from loop #${entry.id}`,
        metadata: { loopId, trigger }
    })
    E-->>PT: Event delivered
    PT->>PT: Creates task in pi-tasks store
    PT->>E: emit(tasks:rpc:create:reply:uuid, { success, data: { id } })
    E-->>R: Reply received
    R-->>L: Returns taskId
```

### RPC Methods Used

| RPC Event | Purpose |
|-----------|---------|
| `tasks:rpc:ping` | Detect pi-tasks presence |
| `tasks:rpc:create` | Create task from loop |
| `tasks:rpc:pending` | Get pending task count |
| `tasks:rpc:clean` | Prune completed tasks |

## Edge Cases

### 1. Task created while worker loop already exists

```mermaid
sequenceDiagram
    participant T as TaskCreate
    participant E as evaluateTaskBacklog
    participant A as ensureAutoTaskWorkerLoop

    T->>E: pendingCount = 6
    E->>A: ensureAutoTaskWorkerLoop()
    A->>A: findAutoTaskWorkerLoop() → exists

    Note over A: Do nothing, existing loop handles it
    A-->>E: { created: false, entry: existing }
```

### 2. Multiple tasks created before worker loop created

```mermaid
sequenceDiagram
    participant T as TasksCreated × N
    participant E as evaluateTaskBacklog
    participant A as ensureAutoTaskWorkerLoop

    loop N times
        T->>E: evaluateTaskBacklog()
    end

    Note over E: Only fires once (last call wins)
    E->>A: ensureAutoTaskWorkerLoop()

    Note over A: Bootstrap fires loop immediately
    A->>A: maybeBootstrapTaskLoop()
```

### 3. Worker loop fires but no tasks available

```mermaid
sequenceDiagram
    participant L as Loop fires
    participant R as Agent

    L->>R: pi.sendMessage(AUTO_TASK_WORKER_PROMPT)
    R->>R: TaskList → no pending tasks
    R->>R: LoopDelete(own loopId)

    Note over R: Agent self-terminates the loop
```

### 4. pi-tasks and native tasks both unavailable

```mermaid
sequenceDiagram
    participant L as Loop fires
    participant R as TaskRuntime

    L->>R: autoCreateTask(entry)
    R->>R: isTasksAvailable() → false
    R->>R: getNativeTaskStore() → undefined

    Note over R: No-op, task not created
    R-->>L: undefined
```

## Relevant Files

| File | Role |
|------|------|
| `src/runtime/task-backlog-runtime.ts` | Auto worker loop lifecycle |
| `src/runtime/task-rpc.ts` | pi-tasks / native task bridge |
| `src/runtime/task-events.ts` | Native task event emission |
| `src/task-backlog-coordinator.ts` | Coordinator reducer |
| `src/task-store.ts` | Native task persistence |
| `src/index.ts` | onLoopFire handler wiring |
| `src/coordinator.ts` | Coordinator pattern implementation |

## Related Flows

- [Auto Task Worker Loop](./auto-task-worker.md)
- [Task Create](./task-create.md)
- [Task Update](./task-update.md)
- [Session Lifecycle](./session-lifecycle.md)
