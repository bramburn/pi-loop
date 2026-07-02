# Monitor Create

## When to Use

- User wants to run a long-running command in background
- User wants to parallelize work (run multiple commands simultaneously)
- User wants to watch a build/CI job without blocking
- User wants to run an experiment and be notified on completion

## Workflow Diagram

```mermaid
sequenceDiagram
    participant A as Agent
    participant M as MonitorManager
    participant P as ChildProcess
    participant E as EventBus
    participant S as LoopStore
    participant T as TriggerSystem
    participant W as Widget

    A->>M: MonitorCreate(command, onDone?)
    M->>M: Check max 25 monitors
    M->>P: spawn(command)
    P-->>M: pid
    M->>E: Register output handlers
    M-->>W: update()

    par Output Streaming
        loop Every line
            P->>E: stdout/stderr
            E->>E: Emit monitor:output
        end
    and OnDone Loop (if onDone provided)
        M->>S: create(doneTrigger, onDonePrompt)
        S-->>T: doneLoop
        T->>T: Register (NOT triggerSystem.add!)
        Note over T: Event-typed but callback-driven
    end

    P->>M: Exit
    M->>M: Update status
    M-->>W: update()

    alt onDone provided
        M->>E: Emit monitor:done
        E->>T: Event received
        T->>A: Wake with onDone prompt
    end
```

## Output Streaming

```mermaid
sequenceDiagram
    participant P as ChildProcess
    participant M as MonitorManager
    participant E as EventBus

    P->>P: stdout.write("Building...")
    P->>M: data event
    M->>M: Buffer line
    M->>E: emit("monitor:output", {line})
    Note over E: Any subscriber receives line

    P->>P: stderr.write("Error!")
    P->>M: error event
    M->>M: Buffer line
    M->>E: emit("monitor:output", {line})
```

## Entry Point

### Via Tool: `MonitorCreate`

1. Agent calls `MonitorCreate` with:
   - `command`: shell command to run
   - `description`: optional human-readable label
   - `timeout`: max runtime in ms (default: 300000 = 5min)
   - `onDone`: optional prompt for completion handling

2. System:
   - Checks running monitor count (max 25)
   - Spawns child process
   - Registers with MonitorManager
   - Streams output via `monitor:output` events
   - Updates widget

3. Returns monitor ID for tracking/stopping

## With onDone Callback

When `onDone` is provided, the system creates a one-shot loop linked to the monitor via an internal callback — NOT a TriggerSystem event subscription.

```mermaid
sequenceDiagram
    participant M as MonitorManager
    participant S as LoopStore
    participant R as MonitorOnDoneRuntime
    participant P as Completion Handler
    participant A as Agent

    Note over M,A: During MonitorCreate
    M->>S: create(doneTrigger, onDonePrompt)<br/>(type: event, source: monitor:done)
    S-->>R: register(doneLoop, monitorId)
    R->>M: onComplete(monitorId, callback)
    M->>M: completionCallbacks.push(callback)

    Note over M,A: When monitor completes (child.on close)
    M->>M: finish(exitCode)
    M->>M: Emit monitor:done event
    M->>P: Run completionCallbacks
    P->>R: DELIVER_MONITOR_ONDONE_WAKE
    R->>A: onLoopFire(loop) + deleteLoop()

    Note over M,A: Edge case: monitor already completed
    R->>M: monitorManager.onComplete(monitorId)
    M-->>R: status: completed
    R->>R: deliver() immediately

    Note over M,A: Edge case: monitor errored/stopped
    R->>M: monitorManager.onComplete(monitorId)
    M-->>R: status: error/stopped
    R->>R: deleteLoop(doneLoop.id) — expire orphan
```

**Critical distinction**: The onDone loop is a LoopStore entry (persisted, visible in LoopList) but is NOT registered with TriggerSystem. Its delivery is driven by `MonitorManager.onComplete()` callbacks registered in `MonitorOnDoneRuntime`.

## Completion Events

| Exit Type | Event Emitted | Status |
|-----------|---------------|--------|
| Clean exit (code 0) | `monitor:done` | `completed` |
| Non-zero exit | `monitor:done` | `completed` |
| Uncaught error | `monitor:error` | `error` |
| SIGTERM timeout | `monitor:done` | `stopped` |

## Data Structure

```typescript
// src/types.ts
interface MonitorEntry {
  id: string;
  command: string;
  description?: string;
  timeout: number;
  status: "running" | "completed" | "error" | "stopped";
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  outputLines: number;
  outputBuffer: string[];
}

interface MonitorProcess {
  entry: MonitorEntry;
  pid: number;
  proc: ChildProcess;
  abortController: AbortController;
  waiters: Array<() => void>;
  completionCallbacks: Array<() => void>;
}
```

## Timeout Handling

| Setting | Value | Behavior |
|---------|-------|----------|
| Default | 300000ms (5 min) | Auto-terminate after 5 minutes |
| Custom | User-specified | Terminate after N ms |
| None | 0 | Run indefinitely |

```mermaid
sequenceDiagram
    participant M as MonitorManager
    participant P as ChildProcess
    participant T as Timer

    M->>P: spawn(command)
    alt timeout > 0
        M->>T: setTimeout(timeout)
    end

    P->>M: Exit naturally
    M-->>T: clear timeout
    M->>M: Process completed

    Note over T: If timeout fires first
    T->>M: Timeout!
    M->>P: SIGTERM
    M->>T2: setTimeout(5000ms)
    T2->>M: 5 seconds pass
    M->>P: SIGKILL
    M->>M: status → "stopped"
```

## Widget Display

Widget shows running monitors count:
```
Loops: 3 | Monitors: 2 >
```

## Relevant Files

| File | Purpose |
|------|---------|
| `src/types.ts` | MonitorEntry, MonitorProcess structures |
| `src/monitor-manager.ts` | Process spawning, output buffering |
| `src/runtime/monitor-ondone-runtime.ts` | onDone callback handling |
| `src/tools/monitor-tools.ts` | MonitorCreate tool |
| `src/ui/widget.ts` | Status bar widget |

## Related Flows

- [Monitor List](./monitor-list.md)
- [Monitor Stop](./monitor-stop.md)
- [Loop Create — Event Trigger](./loop-create-event.md)
