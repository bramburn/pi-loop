export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskEntry {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  agentType?: string;
  metadata: Record<string, unknown>;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface TaskStoreData {
  nextId: number;
  tasks: TaskEntry[];
}
