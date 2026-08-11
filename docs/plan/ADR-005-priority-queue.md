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

When two fires of the same loop arrive in the reducer with the **same key**, the
reducer **coalesces** them: it increments `fireCount`, preserves `firstFireAt`,
updates `lastFireAt` and `message`, and keeps the existing priority.

**Key generation:** all loop fires currently use timestamp-in-key
(`loop:<id>:<timestamp>`), so each successive fire of a recurring loop produces a
distinct key and lives as its own queue entry. Coalescing therefore fires only in
the edge case where two fires of the same loop land in the same millisecond, and
for monitor notifications which use stable keys (`monitor:<id>:started`). The
`fireCount`/`firstFireAt`/`lastFireAt` metadata still attaches to every queued
notification so the agent can observe how many times any loop has fired since its
first flush, even when queue entries are distinct. If coalescing on same-loop
distinct-timestamp fires becomes a future requirement, the key generator in
`buildPendingNotification` would change to `loop:<id>` (no timestamp) for
`recurring: true` loops; that change would invalidate the existing G-46 test and
is intentionally deferred.

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

In practice, `/loop-settings` cycles only the `defer` threshold through its TUI
(`1h → 24h → 7d`); `critical`, `urgent`, and `normal` are advanced tuning knobs
expected to be set via direct JSON editing of `.pi/pi-loop-settings.json`. The
TUI limitation is deliberate because `critical` should almost always stay at `0`
(immediate), and exposing a naive cycle UI for `urgent`/`normal` would invite
accidental misconfiguration (e.g. setting `critical` to five minutes).

### Defer shielding applies to BOTH flush paths

`defer` notifications are shielded from priority inversion on **both** delivery
paths, not just the urgent-flush heartbeat:

- **`REQUEST_URGENT_FLUSH`** (heartbeat, every 30 s): defer is filtered out
  unconditionally; urgent/critical/normal are sorted by priority then FIFO and
  force-delivered when aged past their threshold.
- **`NOTIFICATION_FLUSH_REQUESTED`** (normal idle flush, e.g. on `agent_end`):
  when any non-defer notification is queued, the oldest non-defer item is
  delivered first; defer is held back. Defer is only delivered via the normal
  flush path when the queue contains *nothing else*. This satisfies the
  consequence claim below that defer "will not be delivered until all
  higher-priority notifications are delivered."

---

## Consequences

### Covered behaviours

- A `critical` loop wakes the agent within one heartbeat tick even if 50 normal
  loops are queued ahead of it.
- An `urgent` loop fires 10 times in 20 seconds. The agent receives one notification
  with `fireCount: 10` and `firstFireAt` set to the first fire time.
- A `defer` loop is completely shielded from priority inversion — it will not be
  delivered until all non-defer items have drained, regardless of how many
  high-priority notifications arrive. The shielding holds under both the
  urgent-flush heartbeat and the normal idle flush.
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
