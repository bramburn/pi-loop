# Loop Create — Hybrid Trigger

## When to Use

User wants both:
1. **Event-driven responsiveness**: React immediately when something happens
2. **Cron safety-net**: Fall back to periodic checks if no events fire

Example: Watch for `monitor:done` events but also check every 10 minutes as a fallback.

## Workflow Diagram

```mermaid
sequenceDiagram
    participant A as Agent
    participant S as LoopStore
    participant T as TriggerSystem
    participant C as CronScheduler
    participant E as EventBus
    participant W as Widget

    A->>S: LoopCreate(trigger, prompt)
    Note over S: trigger.type = "hybrid"
    S->>S: Creates LoopEntry
    S-->>T: entry
    T->>C: add(entry)
    Note over C: Registers cron timer
    T->>E: Subscribe(source)
    Note over E: Registers event listener
    T-->>W: update()
    S-->>A: Loop #ID created

    par Event Fires
        E->>T: Event received
        T->>T: Check debounce window
        T->>A: Wakes agent
    and Cron Fires
        C->>T: Cron tick
        T->>T: Check debounce window
        T->>A: Wakes agent
    end
```

## Debounce Behavior

```mermaid
sequenceDiagram
    participant E as Event
    participant C as Cron
    participant T as TriggerSystem
    participant A as Agent

    E->>T: Event fires
    T->>T: Start debounce window<br/>debounceMs = 30000
    T->>A: Queue wake

    C->>T: Cron fires
    T->>T: Check: inside debounce?
    Note over T: Yes - suppress
    T--x A: No second wake

    Note over T: After debounce expires
    T->>T: Reset debounce state
```

## Entry Point

### Via Tool: `LoopCreate`

1. Agent calls `LoopCreate` with:
   - `trigger`: hybrid spec (cron + event)
   - `prompt`: what to do
   - `debounceMs`: debounce window (default: 30000ms)

2. LoopStore creates `LoopEntry` with:
   ```typescript
   {
     type: "hybrid",
     cron: "*/10 * * * *",    // Every 10 minutes
     event: { source: "monitor:done" },
     debounceMs: 30000
   }
   ```

3. TriggerSystem registers BOTH:
   - Cron timer with CronScheduler
   - Event subscription with EventBus

## Data Structure

```typescript
// src/types.ts
interface LoopEntry {
  id: string;
  prompt: string;
  trigger: HybridTrigger;
  status: "active" | "paused";
  recurring: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  autoTask?: boolean;
  taskBacklog?: boolean;
  readOnly?: boolean;
  maxFires?: number;
  fireCount?: number;
}

interface HybridTrigger {
  type: "hybrid";
  cron: string;              // Cron expression
  event: {
    source: string;          // Event source name
    filter?: string;          // Optional filter
  };
  debounceMs: number;        // Debounce window in ms
}
```

## Trigger Input Format

Hybrid triggers can be specified as:
```typescript
// Full trigger parameter (JSON)
{
  trigger: {
    type: "hybrid",
    cron: "*/5 * * * *",
    event: { source: "monitor:done" },
    debounceMs: 60000
  },
  prompt: "Check CI status"
}

// Or parsed from string (inferred)
{
  trigger: "cron:*/5 * * * * event:monitor:done",
  triggerType: "hybrid",
  debounceMs: 60000,
  prompt: "Check CI status"
}
```

## Monitor Done Special Handling

When `source: "monitor:done"`:
1. System checks if monitor is already completed
2. If completed → loop immediately removed
3. If running → waits for monitor:done event

## Relevant Files

| File | Purpose |
|------|---------|
| `src/types.ts` | LoopEntry, HybridTrigger data structures |
| `src/store.ts` | LoopStore.create() persistence |
| `src/trigger-system.ts` | Dual registration (cron + event) |
| `src/scheduler.ts` | CronScheduler for timer management |
| `src/tools/loop-tools.ts` | LoopCreate tool implementation |

## Related Flows

- [Loop Create — Cron Trigger](./loop-create-cron.md)
- [Loop Create — Event Trigger](./loop-create-event.md)
- [Monitor Create](./monitor-create.md)
