# Task Update

## When to Use

- Starting work on a task (`status: in_progress`)
- Completing a task (`status: completed`)
- Reopening a completed/paused task (`status: pending`)
- Updating task subject or description

## Workflow Diagram

```mermaid
sequenceDiagram
    participant A as Agent
    participant T as TaskStore
    participant E as EventBus
    participant L as LoopStore
    participant W as Widget

    A->>T: TaskUpdate(id, status)
    T->>T: Find TaskEntry
    alt Status change
        T->>T: Update status
        T->>T: Set updatedAt
        alt completed
            T->>T: Set completedAt
        end
    end
    T-->>E: emit status event
    T-->>L: evaluateTaskBacklog()
    T-->>W: update()
    T-->>A: Task #ID updated

    Note over E: Events emitted
    E->>E: tasks:started (pending → in_progress)
    E->>E: tasks:completed (→ completed)
    E->>E: tasks:reopened (→ pending)
```

## Status Transitions

```mermaid
stateDiagram-v2
    [*] --> pending: TaskCreate
    pending --> in_progress: TaskUpdate status: in_progress
    in_progress --> completed: TaskUpdate status: completed
    completed --> pending: TaskUpdate status: pending (reopen)
    in_progress --> pending: TaskUpdate status: pending (return to queue)
    pending --> completed: TaskUpdate status: completed
    completed --> [*]
```

## Entry Points

### Via Tool: `TaskUpdate`

1. Agent calls `TaskUpdate` with:
   - `id`: task ID (note: parameter is `id`, not `taskId`)
   - `status`: optional new status
   - `subject`: optional new title
   - `description`: optional new description

2. System:
   - Finds task by ID
   - Applies status change if provided
   - Applies detail changes if provided
   - Emits appropriate event
   - Evaluates backlog
   - Updates widget

3. Returns confirmation or "not found"

### Available Operations

| Operation | Parameters | Event Emitted |
|-----------|------------|---------------|
| Start | `id`, `status: "in_progress"` | `tasks:started` |
| Complete | `id`, `status: "completed"` | `tasks:completed` |
| Reopen | `id`, `status: "pending"` | `tasks:reopened` |
| Update details | `id`, `subject` and/or `description` | `tasks:updated` |

## Data Structure

```typescript
// src/task-types.ts
interface TaskEntry {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  createdAt: number;
  updatedAt: number;          // Updated on any change
  completedAt?: number;      // Set when status → completed
  metadata?: Record<string, unknown>;
}
```

## Common Patterns

### Starting Work

```typescript
// Agent picks up a task
TaskUpdate({
  id: "1",
  status: "in_progress"
})
```

### Completing Work

```typescript
// Agent finishes a task
TaskUpdate({
  id: "1",
  status: "completed"
})
```

### Updating Details

```typescript
// Agent clarifies task
TaskUpdate({
  id: "1",
  subject: "Updated subject",
  description: "More detailed description"
})
```

## Backlog Evaluation

After status changes:

```mermaid
sequenceDiagram
    participant T as TaskStore
    participant L as LoopStore
    participant B as Backlog Worker

    T->>T: pendingCount()
    T->>L: evaluateTaskBacklog()
    
    alt pendingCount > 0
        Note over L: Keep backlog worker active
    else pendingCount == 0
        L->>B: Auto-delete loop
        Note over L: Loop cleans itself up
    end
```

## Important Parameter Name

> **Note**: The parameter is `id`, NOT `taskId`. Using the wrong parameter name will cause a validation error.

```typescript
// ✅ Correct
TaskUpdate({ id: "1", status: "completed" })

// ❌ Wrong - will fail
TaskUpdate({ taskId: "1", status: "completed" })
```

## Relevant Files

| File | Purpose |
|------|---------|
| `src/task-store.ts` | TaskStore.start(), complete(), reopen(), updateDetails() |
| `src/task-types.ts` | TaskEntry structure |
| `src/tools/native-task-tools.ts` | TaskUpdate tool |
| `src/runtime/task-events.ts` | Event emission |

## Related Flows

- [Task Create](./task-create.md)
- [Task List](./task-list.md)
- [Task Delete](./task-delete.md)
