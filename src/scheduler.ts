import { computeJitter, cronToNextFire } from "./loop-parse.js";
import type { LoopStore } from "./store.js";
import type { LoopEntry } from "./types.js";

function computeNextFire(entry: LoopEntry): Date {
  if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid") {
    return cronToNextFire(entry.trigger.type === "hybrid" ? entry.trigger.cron : entry.trigger.schedule);
  }
  if (entry.trigger.type === "dynamic") {
    return new Date(entry.dynamic?.nextWakeAt ?? Date.now());
  }
  return new Date(Date.now() + 60000);
}

export class CronScheduler {
  private fireTimes = new Map<string, number>();

  constructor(
    private store: LoopStore,
    private onFire: (entry: LoopEntry) => void,
  ) {}

  start(): void {
    for (const storedEntry of this.store.list()) {
      let entry = storedEntry;
      if (entry.status !== "active") continue;
      if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid" || entry.trigger.type === "dynamic") {
        if (entry.trigger.type === "dynamic" && entry.dynamic?.awaitingUpdate && !this.fireTimes.has(entry.id)) {
          entry = this.store.updateDynamic(entry.id, {
            dynamic: {
              awaitingUpdate: false,
              nextWakeAt: undefined,
              lastUpdatedAt: Date.now(),
            },
          }) ?? entry;
        }
        this.armTimer(entry);
      }
    }
  }

  stop(): void {
    this.fireTimes.clear();
  }

  add(entry: LoopEntry): void {
    // Guard against double-arming the same entry.
    if (this.fireTimes.has(entry.id)) return;
    if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid" || entry.trigger.type === "dynamic") {
      this.armTimer(entry);
    }
  }

  remove(id: string): void {
    this.fireTimes.delete(id);
  }

  nextFire(id: string): number | undefined {
    return this.fireTimes.get(id);
  }

  private retire(entry: LoopEntry): void {
    if (entry.workflow || entry.taskBacklog) this.store.pause(entry.id);
    else this.store.delete(entry.id);
    this.fireTimes.delete(entry.id);
  }

  private armTimer(entry: LoopEntry): void {
    const nextFire = computeNextFire(entry);
    let jitter = 0;
    if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid") {
      const scheduleExpr = entry.trigger.type === "hybrid" ? entry.trigger.cron : entry.trigger.schedule;
      const minuteField = scheduleExpr.trim().split(/\s+/)[0] ?? "";
      const minuteStep = minuteField.startsWith("*/") ? parseInt(minuteField.slice(2), 10) || 30 : 30;
      jitter = computeJitter(entry.id, entry.recurring, minuteStep);
    }
    const fireTime = nextFire.getTime() + jitter;

    if (fireTime > entry.expiresAt) {
      this.retire(entry);
      return;
    }

    this.fireTimes.set(entry.id, fireTime);
  }

  pump(now: number, filter?: (entry: LoopEntry) => boolean): void {
    for (const [id, fireTime] of this.fireTimes) {
      if (now < fireTime) continue;

      const entry = this.store.get(id);
      if (!entry || entry.status !== "active") {
        this.fireTimes.delete(id);
        continue;
      }

      // Skip dynamic loops that are waiting for an agent-provided next wake time.
      if (entry.trigger.type === "dynamic" && entry.dynamic?.awaitingUpdate) continue;

      if (filter && !filter(entry)) continue;

      if (now >= entry.expiresAt) {
        this.retire(entry);
        continue;
      }

      // Closes G-17: skip the fire entirely if we've already hit the cap.
      // The last allowed fire (fireCount === maxFires) was already issued
      // on the previous tick. This prevents an off-by-one where the cap
      // is reached but one extra fire is delivered.
      if (entry.maxFires && (entry.fireCount ?? 0) >= entry.maxFires) {
        this.retire(entry);
        continue;
      }

      this.onFire(entry);

      const fresh = this.store.get(id);
      if (!fresh) {
        this.fireTimes.delete(id);
        continue;
      }

      // Non-recurring loops are deleted after firing (c5ae360: retire cron one-shots).
      // G-11: maxFires is now applied to non-recurring loops too.
      if (!fresh.recurring) {
        this.retire(fresh);
        continue;
      }

      if (fresh.maxFires && (fresh.fireCount ?? 0) >= fresh.maxFires) {
        this.retire(fresh);
        continue;
      }

      this.armTimer(fresh);
    }
  }
}
