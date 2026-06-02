export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskEntry {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskStoreData {
  nextId: number;
  tasks: TaskEntry[];
}
