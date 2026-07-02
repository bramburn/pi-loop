import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskEntry, TaskStatus } from "../task-types.js";

export type NativeTaskEventName =
  | "tasks:created"
  | "tasks:started"
  | "tasks:completed"
  | "tasks:reopened"
  | "tasks:updated"
  | "tasks:deleted";

export interface NativeTaskEventPayload {
  taskId: string;
  subject: string;
  description: string;
  status: TaskStatus;
  previousStatus?: TaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Closes G-19: native task events are suppressed when pi-tasks is active.
 * Pass `tasksAvailable: true` from the caller when pi-tasks has been
 * detected (via tasks:rpc:ping reply). The event is still emitted on the
 * bus so the caller's own subscribers can react, but a no-op shortcut
 * is exposed via the second argument for callers that want to short-circuit.
 */
export function emitNativeTaskEvent(
  pi: ExtensionAPI,
  name: NativeTaskEventName,
  entry: TaskEntry,
  previousStatus?: TaskStatus,
  options: { suppressIfPiTasks?: boolean; piTasksAvailable?: boolean } = {},
): void {
  // Suppress when pi-tasks is the active task system. Native task tools
  // are only registered when pi-tasks is absent, so emitting these events
  // would conflict with pi-tasks's own event semantics.
  if (options.suppressIfPiTasks && options.piTasksAvailable) return;
  pi.events.emit(name, {
    taskId: entry.id,
    subject: entry.subject,
    description: entry.description,
    status: entry.status,
    previousStatus,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    completedAt: entry.completedAt,
    metadata: entry.metadata,
  } satisfies NativeTaskEventPayload);
}
