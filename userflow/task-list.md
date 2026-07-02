# Task List

## When to Use

- User wants to see all tasks and their status
- Agent needs to find tasks to work on
- User wants to check progress across the backlog
- Finding a task ID for update/delete operations

## Workflow Diagram

```mermaid
sequenceDiagram
    participant A as Agent / User
    participant T as TaskStore
    participant W as Widget

    A->>T: TaskList()
    T->>T: Get all TaskEntries
    loop For each task
        T->>T: Format line<br/>icon + ID + status + subject
    end
    T->>T: Count by status<br/>pending / in_progress / completed
    T-->>A: Formatted list

    Note over A: Interactive via /tasks
    A->>W: /tasks
    W->>T: List tasks
    T-->>W: Task list
    W->>A: Show menu
    A->>A: Select task
    A->>A: Choose action
```

## Entry Point

### Via Tool: `TaskList`

1. Agent or user calls `TaskList` (no parameters)

2. System retrieves all tasks from TaskStore

3. Returns formatted list showing:
   - Status icon (`*` pending, `>` in_progress, `ok` completed)
   - Task ID (`#123`)
   - Status badge
   - Subject (truncated to 80 chars)

4. Summary line shows counts by status

## Output Format

```
4 tasks (2 pending, 1 in progress, 1 done)
* #1 [pending] Research authentication library
> #2 [in_progress] Implement OAuth2 flow
ok #3 [completed] Set up project structure
* #4 [pending] Write unit tests for auth module
```

## Status Icons

| Icon | Status | Color | Meaning |
|------|--------|-------|---------|
| `*` | pending | Neutral | Task queued for work |
| `>` | in_progress | Active | Work started |
| `ok` | completed | Success | Task done |

## Data Structure

```typescript
// src/task-types.ts
interface TaskEntry {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

interface TaskStoreData {
  nextId: number;
  tasks: TaskEntry[];
}
```

## Use Cases

```mermaid
flowchart TD
    A[Need to find work] --> B{Goal}
    B -->|See all| C[TaskList]
    B -->|Find ID| D[TaskList]
    B -->|Check progress| E[TaskList]
    B -->|Pick next task| F[TaskList]

    C --> G[Formatted list]
    D --> G
    E --> G
    F --> G
    
    G --> H{User selects}
    H -->|Start task| I[TaskUpdate status: in_progress]
    H -->|Complete task| J[TaskUpdate status: completed]
    H -->|Delete task| K[TaskDelete]
```

## Relevant Files

| File | Purpose |
|------|---------|
| `src/task-store.ts` | TaskStore.list() |
| `src/task-types.ts` | TaskEntry structure |
| `src/tools/native-task-tools.ts` | TaskList tool |
| `src/commands/tasks-command.ts` | /tasks command |

## Related Flows

- [Task Create](./task-create.md)
- [Task Update](./task-update.md)
- [Task Delete](./task-delete.md)
