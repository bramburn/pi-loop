# ADR-005: Priority-Aware Aging Notification Queue

**Status:** Accepted
**Date:** 2026-01-20
**Author:** pi-loop implementation

---

## Context

The v2.0 notification queue dispatches loop wakes to the agent in simple FIFO order
(`timestamp` ascending). When multiple loops fire simultaneously — or when the agent
is busy and cannot service a wake immediately — every notification waits the same
duration regardless of how urgent it is.

This creates two failure modes:

1. **Priority inversion**: A critical monitoring loop fires and is queued behind 12
   idle polling loops. The agent services them in order and the critical loop's wake
   arrives 8 minutes late.
2. **Fire-count blindness**: A recurring loop that fires 30 times while the agent
   is busy carries no signal in the notification metadata. The agent has no way to
   know the loop has been waiting and cannot adjust its response.

The v2.0 design already stores `fireCount` on `LoopEntry`. The notification layer was
the missing piece.

---

## Decision

### Priority levels

Four mutually exclusive priorities, ordered highest to lowest:

| Priority   | Default age threshold | Behaviour |
|------------|---------------------|-----------|
| `critical` | 0 ms (immediate)    | Force-flush on next heartbeat tick regardless of queue depth |
| `urgent`   | 30 seconds          | Force-flush after 30 s in queue |
| `normal`   | 5 minutes           | Force-flush after 5 min in queue |
| `defer`    | 24 hours            | **Never** force-flushed; waits for explicit `NOTIFICATION_FLUSH_REQUESTED` |

Thresholds are configurable via `urgentFlushThresholds` in
`.pi/pi-loop-settings.json`.

### Fields added to `ReducerNotification`

```ts
interface ReducerNotification {
  // ... existing fields ...
  fireCount?: number;    // how many times this loop fired and was coalesced
  firstFireAt?: number;  // timestamp of the first fire in this coalesced batch
  lastFireAt?: number;   // timestamp of the most recent fire
  priority?: LoopPriority; // "defer" | "normal" | "urgent" | "critical"
}
```

### Fire-count coalescing

When a recurring loop fires again while a prior notification for the same loop is
still in the queue, the reducer **coalesces** them: it increments `fireCount`,
preserves `firstFireAt`, updates `lastFireAt` and `message`, and keeps the existing
priority. The result is one notification entry in the queue per loop at any time,
with accurate fire-count metadata.

Non-recurring loops use timestamp-in-key (`loop:<id>:<timestamp>`) and do not
coalesce.

### Message enrichment

When `fireCount > 1`, the delivered message is prefixed:
```
[pi-loop] Loop #N fired 7× since 2026-01-20T09:15:00.000Z

<original message>
```

When `priority` is `urgent` or `critical`, the prefix also reads:
```
[Priority: urgent] <original message>
```

### Age force-flush (REQUEST_URGENT_FLUSH)

Every 30 seconds the heartbeat pump calls `notificationRuntime.dispatchUrgentFlush()`.
The reducer scans all queued notifications and, for each one whose priority is not
`defer` and whose age exceeds the configured threshold, emits a `DELIVER_NOTIFICATION`
effect. Defer-priority notifications are skipped unconditionally.

Force-flushes are sorted: `critical` first, then `urgent`, then `normal` (FIFO
within each priority band). Each notification is individually removed from the queue
and delivered before the next is processed.

### Configuration

```
urgentFlushThresholds:
  defer:    86400000 ms (24 h)
  normal:   300000 ms  (5 min)
  urgent:   30000 ms   (30 s)
  critical: 0 ms        (immediate)
```

All four thresholds are configurable via `/loop-settings`. The defer threshold is
a ceiling, not a floor — setting it to a low value does not force-flush defer
notifications; it only caps how long they can sit unprocessed.

---

## Consequences

### Covered behaviours

- A `critical` loop wakes the agent within one heartbeat tick even if 50 normal
  loops are queued ahead of it.
- An `urgent` loop fires 10 times in 20 seconds. The agent receives one notification
  with `fireCount: 10` and `firstFireAt` set to the first fire time.
- A `defer` loop is completely shielded from priority inversion — it will not be
  delivered until the queue drains naturally, regardless of how many high-priority
  notifications arrive.
- Configurable thresholds allow operators to tune latency vs. throughput tradeoffs
  for their environment.

### Non-goals

- **No preemption of in-flight agent turns.** Force-flush delivers the notification
  at the next `agent_end` via `REQUEST_URGENT_FLUSH`; it does not interrupt a
  running agent.
- **No priority inheritance.** A high-priority loop spawning a low-priority one does
  not raise the child's priority.
- **No cross-session priority.** Each session's notification state is independent.
  Loops bound to another terminal are not visible in this session's queue.
- **No SLO/SLA enforcement.** The thresholds are best-effort; a saturated agent may
  still delay even `critical` notifications until it reaches `agent_end`.

---

## Alternatives considered

### Priority only, no age
A pure priority system (critical → urgent → normal → defer) without aging would
still suffer from priority inversion among same-priority notifications. Age thresholds
solve the "stale queue" problem.

### Single coalescing key without fireCount metadata
Dropping `fireCount`/`firstFireAt`/`lastFireAt` and just collapsing notifications
loses the signal that a loop fired repeatedly. The agent would re-process the same
work without knowing how many times it had already been attempted.

### Two queues (high-priority / normal)
A separate high-priority queue adds complexity in the coordinator and makes it harder
to reason about ordering between the two queues. A single queue with in-band priority
fields is simpler and equally expressive.

### Immediate force-flush for non-defer on every heartbeat tick
Without a threshold check, every heartbeat would deliver all non-defer notifications
immediately, defeating the purpose of the queue for normal-priority work. Age
thresholds are the right primitive.
