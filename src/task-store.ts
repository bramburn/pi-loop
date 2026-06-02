import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { TaskEntry, TaskStatus, TaskStoreData } from "./task-types.js";

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;
const MAX_TASKS = 200;

function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (!pid || !isProcessRunning(pid)) {
            try { unlinkSync(lockPath); } catch { /* ignore */ }
            continue;
          }
        } catch { /* ignore read errors */ }
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class TaskStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;

  private nextId = 1;
  private tasks = new Map<string, TaskEntry>();

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  private load(): void {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) return;
    try {
      const data: TaskStoreData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.nextId = data.nextId;
      this.tasks.clear();
      for (const task of data.tasks) {
        this.tasks.set(task.id, task);
      }
    } catch { /* corrupt file — start fresh */ }
  }

  private save(): void {
    if (!this.filePath) return;
    const data: TaskStoreData = {
      nextId: this.nextId,
      tasks: Array.from(this.tasks.values()),
    };
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  private withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    acquireLock(this.lockPath);
    try {
      this.load();
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  create(subject: string, description: string, metadata?: Record<string, unknown>): TaskEntry {
    return this.withLock(() => {
      if (this.tasks.size >= MAX_TASKS) {
        throw new Error(`Maximum of ${MAX_TASKS} tasks reached. Delete some before creating new ones.`);
      }
      const now = Date.now();
      const entry: TaskEntry = {
        id: String(this.nextId++),
        subject,
        description,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        metadata,
      };
      this.tasks.set(entry.id, entry);
      return entry;
    });
  }

  get(id: string): TaskEntry | undefined {
    if (this.filePath) this.load();
    return this.tasks.get(id);
  }

  list(): TaskEntry[] {
    if (this.filePath) this.load();
    return Array.from(this.tasks.values()).sort((a, b) => Number(a.id) - Number(b.id));
  }

  update(id: string, fields: { status?: TaskStatus; subject?: string; description?: string }): TaskEntry | undefined {
    return this.withLock(() => {
      const entry = this.tasks.get(id);
      if (!entry) return undefined;

      if (fields.status !== undefined) {
        entry.status = fields.status;
        if (fields.status === "completed") entry.completedAt = Date.now();
      }
      if (fields.subject !== undefined) entry.subject = fields.subject;
      if (fields.description !== undefined) entry.description = fields.description;
      entry.updatedAt = Date.now();
      return entry;
    });
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.tasks.has(id)) return false;
      this.tasks.delete(id);
      return true;
    });
  }

  pendingCount(): number {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.status === "pending" || t.status === "in_progress") count++;
    }
    return count;
  }

  sweepCompleted(): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, entry] of this.tasks) {
        if (entry.status === "completed") {
          this.tasks.delete(id);
          count++;
        }
      }
      return count;
    });
  }
}
