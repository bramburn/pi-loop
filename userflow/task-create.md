# Task Create

## When to Use

- User wants to break down a complex goal into trackable pieces
- User wants to decompose a broad goal into a concrete backlog
- User needs to track progress across multiple turns
- User wants to establish shared goals across multiple tasks

## Workflow Diagram

```mermaid
sequenceDiagram
    participant A as Agent
    participant T as TaskStore
    participant E as EventBus
    participant L as LoopStore
    participant W as Widget

    A->>T: TaskCreate(subject, description)
    T->>T: Validates max 200 tasks
    T->>T: Creates TaskEntry<br/>status: "pending"
    T-->>E: emit("tasks:created", task)
    
    Note over E: pi-tasks integration
    E->>L: tasks:created event
    
    Note over T: Backlog evaluation
    T-->>T: pendingCount()
    T->>L: evaluateTaskBacklog()
    L-->>A: backlog.created
    
    T-->>W: update()
    W->>W: Repaints widget
    T-->>A: Task #ID created
```

## Entry Points

### Via Tool: `TaskCreate`

1. Agent calls `TaskCreate` with:
   - `subject`: brief actionable title
   - `description`: detailed requirements and done condition

2. System:
   - Validates max 200 tasks limit
   - Creates TaskEntry with status `pending`
   - Emits `tasks:created` event
   - Evaluates task backlog (may create backlog worker loop)
   - Updates widget

3. Returns task ID for tracking

### Via Command: `/tasks`

1. User types `/tasks` with optional subject

2. If subject provided:
   - Creates task directly
   - Evaluates backlog

3. If no subject:
   - Shows interactive menu
   - "Create task" option

### Via Interactive Menu

1. User selects "+ Create task"

2. Prompts for:
   - Subject (title)
   - Description (details)

3. Same creation flow

## Data Structure

```typescript
// src/task-types.ts
interface TaskEntry {
  id: string;
  subject: string;           // Brief actionable title
  description: string;        // Detailed requirements
  status: "pending" | "in_progress" | "completed";
  createdAt: number;           // Unix timestamp
  updatedAt: number;           // Unix timestamp
  completedAt?: number;        // Unix timestamp
  metadata?: Record<string, unknown>;
}

interface TaskStoreData {
  nextId: number;
  tasks: TaskEntry[];
}
```

## Task Decomposition Guidelines

When creating multiple tasks for a shared goal:

```mermaid
flowchart LR
    A[Shared Goal] --> B[Investigation]
    A --> C[Implementation]
    A --> D[Validation]
    A --> E[Reporting]
    
    B --> B1[Task: Research X]
    B --> B2[Task: Analyze Y]
    C --> C1[Task: Implement Z]
    D --> D1[Task: Test Z]
    E --> E1[Task: Document]
```

## Subject vs Description

| Field | Purpose | Guidelines |
|-------|---------|------------|
| Subject | Quick identification | Short, verb-object (e.g., "Write tests for auth") |
| Description | Detailed context | Include expected artifact, outcome, done condition |

## Auto Task Worker Loop

When `evaluateTaskBacklog()` triggers and `pendingCount >= 5`, the system automatically creates an **Auto Task Worker Loop**:

```mermaid
sequenceDiagram
    participant T as TaskStore
    participant R as TaskBacklogRuntime
    participant L as LoopStore
    participant TR as TriggerSystem

    T->>R: evaluateTaskBacklog(pendingCount = 7)
    R->>R: pendingCount >= AUTO_TASK_WORKER_THRESHOLD (5)?
    R->>R: findAutoTaskWorkerLoop()

    alt No existing worker
        R->>L: create(hybridTrigger, AUTO_TASK_WORKER_PROMPT)
        L->>L: LoopEntry with taskBacklog: true
        L-->>TR: add(entry)
        R->>R: bootstrapTaskLoop() — immediate wake
    else Worker exists
        Note over R: Do nothing
    end

    R-->>T: { created: true/false, entry }
```

### AUTO_TASK_WORKER_PROMPT

```typescript
// src/runtime/task-backlog-runtime.ts
export const AUTO_TASK_WORKER_THRESHOLD = 5;

export const AUTO_TASK_WORKER_PROMPT =
  "Run TaskList, pick next pending task, mark it in_progress, " +
  "implement it, run validation, complete it. " +
  "If no pending tasks remain, call LoopDelete on your own loop ID.";
```

### Properties

| Field | Value |
|-------|-------|
| `trigger.type` | `hybrid` |
| `trigger.cron` | `*/5 * * * *` |
| `trigger.event.source` | `tasks:created` |
| `trigger.debounceMs` | `30000` |
| `recurring` | `true` |
| `taskBacklog` | `true` |
| `maxFires` | `30` |

### Auto-Cleanup

When all tasks are completed and `cleanupTaskBacklogLoops()` is called (e.g., on `agent_end`), the auto worker loop is deleted:

```
pendingCount = 0 → cleanupTaskBacklogLoops() → removeTrigger(id) + deleteLoop(id)
```

See [Auto Task Worker Loop](./auto-task-worker.md) for full details.

## Relevant Files

| File | Purpose |
|------|---------|
| `src/task-types.ts` | TaskEntry data structure |
| `src/task-store.ts` | TaskStore.create() |
| `src/tools/native-task-tools.ts` | TaskCreate tool |
| `src/commands/tasks-command.ts` | /tasks command |
| `src/runtime/task-backlog-runtime.ts` | Backlog evaluation |

## Related Flows

- [Task List](./task-list.md)
- [Task Update](./task-update.md)
- [Task Delete](./task-delete.md)
