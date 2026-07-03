# Session Lifecycle

## Overview

pi-loop manages loops and monitors across session boundaries. The session lifecycle handles store recreation, per-session bindings loading, trigger management, and notification delivery across `turn_start`, `before_agent_start`, `agent_end`, `session_switch`, and `session_shutdown` events.

## Event Flow Diagram

```mermaid
sequenceDiagram
    participant PI as pi events
    participant SS as Session Store
    participant BS as BindingsStore
    participant TR as TriggerSystem
    participant CS as CronScheduler
    participant N as NotificationRuntime
    participant TBR as TaskBacklogRuntime
    participant W as Widget

    Note over PI, W: Session Start

    rect rgb(220, 240, 255)
        Note over PI: turn_start
        PI->>PI: setSessionId(ctx.sessionManager.getSessionId())
        PI->>SS: upgradeStoreIfNeeded()
        PI->>TR: ensureHeartbeat()
        PI->>W: widget.update()
        PI->>TR: pumpLoops()
    end

    rect rgb(255, 245, 220)
        Note over PI: before_agent_start
        PI->>PI: setSessionId(ctx.sessionManager.getSessionId())<br/>(again — ensures BindingsStore path is set)
        PI->>SS: upgradeStoreIfNeeded()
        PI->>BS: load() — reads bindings-<sessionId>.json
        alt fresh session (no bindings file)
            BS->>BS: save() — creates empty {loopIds: []}
            PI->>PI: notify("No bindings for this session...")
        end
        PI->>SS: clearExpired() + expireEventLoops()
        PI->>TR: add(entry) for each<br/>bindings.has(id) === true
        PI->>TR: start()
        PI->>TR: ensureHeartbeat()
        PI->>W: widget.update()
    end

    rect rgb(240, 255, 240)
        Note over PI: agent_end
        PI->>N: syncRuntimeState()
        PI->>N: flushPendingNotifications()
        PI->>TBR: cleanupTaskBacklogLoops()
        PI->>TR: pumpLoops()
    end

    Note over PI, W: Session End / Switch

    rect rgb(255, 220, 220)
        Note over PI: session_switch
        PI->>TR: stop()
        PI->>TR: stopHeartbeat()
        PI->>N: clear()
        PI->>PI: setSessionId(ctx.sessionManager.getSessionId())
        Note over PI: BindingsStore path resolved<br/>for the new session
        alt resume
            PI->>SS: clearAllLoops() skipped
            PI->>SS: upgradeStoreIfNeeded()
            PI->>BS: load() — reads new session's bindings
            PI->>TR: add(entry) for each<br/>bindings.has(id) === true
        else new session
            PI->>SS: clearAllLoops() if memory scope
            PI->>SS: upgradeStoreIfNeeded()
            PI->>BS: load() — reads new session's bindings
            PI->>TR: add(entry) for each<br/>bindings.has(id) === true
        end
        PI->>W: widget.update()
    end

    rect rgb(220, 220, 220)
        Note over PI: session_shutdown
        PI->>TR: stopHeartbeat()
        PI->>N: clear()
    end
```

## Event Details

### `turn_start`

Fires on every agent turn. Initializes the session store and triggers the heartbeat timer.

```typescript
// src/runtime/session-runtime.ts
pi.on("turn_start", async (_event, ctx) => {
  setSessionId(ctx.sessionManager.getSessionId());  // Refresh BindingsStore path
  upgradeStoreIfNeeded(ctx);                        // Recreate session store
  ensureHeartbeat();                                // Start 30s heartbeat
  widget.update();
  await pumpLoops();                                // Check for due cron fires
});
```

### `before_agent_start`

First turn of a session. Loads bindings, expires stale loops, and arms only the bound loops.

```typescript
pi.on("before_agent_start", async (_event, ctx) => {
  setSessionId(ctx.sessionManager.getSessionId());  // Ensure correct BindingsStore path
  upgradeStoreIfNeeded(ctx);
  ensureHeartbeat();
  showPersistedLoops();                             // Load bindings + arm bound loops
  widget.update();
});
```

`showPersistedLoops()`:
1. Checks if bindings file exists (`bindings.fileExists()`)
2. Loads bindings (`bindings.load()`) → populates the in-memory Set
3. If fresh session (no file): saves empty `{loopIds: []}` + emits first-start notify
4. Filters `store.list()` by `bindings.has(entry.id)`
5. Calls `triggerSystem.add(entry)` for each bound loop
6. Calls `triggerSystem.start()` + `ensureHeartbeat()` if any loops are bound

### `agent_end`

End of each agent turn. Flushes notifications and evaluates the task backlog.

```typescript
pi.on("agent_end", async (_event, ctx) => {
  notificationRuntime.syncRuntimeState({ agentRunning: false, hasPendingMessages: ... });
  await flushPendingNotifications({ ignorePendingMessages: true });
  await cleanupTaskBacklogLoops();
  await pumpLoops();
});
```

### `session_switch`

Fires when switching between sessions. Stops all triggers, clears notifications, and loads the new session's bindings.

```typescript
pi.on("session_switch" as never, async (event, ctx) => {
  getTriggerSystem().stop();      // Stop cron + unsubscribe events
  stopHeartbeat();                // Stop 30s timer
  notificationRuntime.clear("session_switch");

  const isResume = event?.reason === "resume";
  storeUpgraded = false;
  persistedShown = false;

  if (!isResume && getLoopScope() === "memory") {
    clearAllLoops();
  }

  // Set sessionId BEFORE showPersistedLoops so the BindingsStore
  // path is resolved correctly and the right bindings are loaded.
  setSessionId(ctx.sessionManager.getSessionId());

  upgradeStoreIfNeeded(ctx);
  showPersistedLoops(isResume);
  widget.update();
});
```

**Key:** `setSessionId` is called with the **real** sessionId (not `undefined`) before `showPersistedLoops`, so the BindingsStore is resolved to the correct `bindings-<sessionId>.json` path before loading.

### `session_shutdown`

Final cleanup when the session ends.

```typescript
pi.on("session_shutdown", async () => {
  stopHeartbeat();
  notificationRuntime.clear("session_shutdown");
});
```

## Per-Session Bindings

On session start, the BindingsStore is loaded from `bindings-<sessionId>.json`:

```mermaid
flowchart TD
    A[Session Start] --> B{bindings-<sessionId>.json exists?}
    B -->|No (fresh)| C[Load → empty Set]
    C --> D[Save {loopIds: []}]
    D --> E[Emit first-start notify]
    E --> F[Arm zero loops<br/>strict isolation]
    B -->|Yes| G[Load {loopIds: [1,5,9]}]
    G --> H[Arm only loops #1, #5, #9]
    F --> I[Done]
    H --> I
```

See [Per-Session Bindings](./per-session-bindings.md) for the full bindings mechanism.

## Loop Expiry on Resume

When a session resumes (`isResume: true`), old event loops are expired because they were created in a different session context and may have stale state:

```mermaid
flowchart TD
    A[Session Resume] --> B[expireEventLoops]
    B --> C{Loop type}
    C -->|event| D[LOOP_EXPIRED<br/>Delete from store + triggerSystem.remove]
    C -->|hybrid| D
    C -->|cron| E[Keep<br/>Re-arm timer + bindings filter]
    D --> F[Trigger removed cleanly]
```

**Important**: `expireEventLoops()` deletes the loop from the store **and** calls `triggerSystem.remove(id)`. This is G-06 from GAPS.md — event subscription leaks are prevented by the explicit removal.

## Store Scope Resolution

```mermaid
flowchart LR
    A[pi-loop env] --> B{PI_LOOP env set?}
    B -->|Yes| C[Custom path]
    B -->|No| D{PI_LOOP_SCOPE}
    D -->|memory| E[In-memory only<br/>Cleared on switch]
    D -->|session| F[bindings-<sessionId>.json<br/>loops-<sessionId>.json]
    D -->|project (default)| G[.pi/loops/bindings-<sessionId>.json<br/>.pi/loops/loops.json<br/>Shared across sessions]
```

| Scope | Loop Store Path | Bindings Path |
|-------|----------------|---------------|
| `memory` | In-memory only | In-memory only (no file) |
| `session` | `.pi/loops/loops-<sessionId>.json` | `.pi/loops/bindings-<sessionId>.json` |
| `project` (default) | `.pi/loops/loops.json` | `.pi/loops/bindings-<sessionId>.json` |

## Notification Delivery

Loops fire → notification queued → delivered when agent is idle (`agent_end` or `before_agent_start`):

```mermaid
sequenceDiagram
    participant L as Loop fires
    participant N as NotificationRuntime
    participant PI as pi.events

    L->>N: queueOrDeliverNotification(data)
    N->>N: NOTIFICATION_QUEUED
    N->>N: REQUEST_NOTIFICATION_FLUSH

    alt agent running
        Note over N: Skip — agent will flush at agent_end
    else has pending messages
        Note over N: Skip — wait for clear
    else idle
        N->>PI: sendMessage(triggerTurn: true)
        Note over PI: Agent wakes
    end
```

## Relevant Files

| File | Purpose |
|------|---------|
| `src/runtime/session-runtime.ts` | All session lifecycle hooks, `showPersistedLoops` |
| `src/runtime/bindings-store.ts` | BindingsStore for per-session loop bindings |
| `src/runtime/scope.ts` | `resolveLoopStorePath`, `resolveBindingsPath` |
| `src/runtime/notification-runtime.ts` | Notification queue and delivery |
| `src/runtime/task-backlog-runtime.ts` | Task backlog cleanup |
| `src/scheduler.ts` | CronScheduler.start/stop |
| `src/trigger-system.ts` | TriggerSystem.start/stop |
| `src/store.ts` | clearExpired, expireEventLoops, clearAll |

## Related Flows

- [Per-Session Bindings](./per-session-bindings.md)
- [Loop Governor](./loop-governor.md)
- [Loop Resume](./loop-resume.md)
- [Loop Create — Cron Trigger](./loop-create-cron.md)
- [Loop Create — Event Trigger](./loop-create-event.md)
- [Auto Task Worker Loop](./auto-task-worker.md)
