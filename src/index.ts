/**
 * @bramburn/pi-loop — A pi extension providing cron/event-based agent re-wake loops and background process monitoring.
 *
 * DISABLED: tool/command/widget/hook registrations removed on the
 * `disable-loop-monitor-task-tools` branch because the registered tools
 * (LoopCreate, LoopUpdate, LoopList, LoopDelete, MonitorCreate, MonitorList,
 * MonitorStop, MonitorDelete, TaskCreate, TaskList, TaskGet, TaskUpdate,
 * TaskDelete, TaskPrune) and the /loop, /monitors, /tasks slash commands
 * were causing issues with the pi.dev agent.
 *
 * The underlying source modules (src/tools/, src/commands/, src/runtime/,
 * src/ui/, src/store.ts, src/scheduler.ts, src/monitor-manager.ts,
 * src/trigger-system.ts, etc.) are retained so the registrations can be
 * re-enabled by reversing this change. The extension currently behaves as
 * a no-op aside from Sentry telemetry bootstrap.
 *
 * Tools (currently disabled):
 *   LoopCreate, LoopUpdate, LoopList, LoopDelete
 *   MonitorCreate, MonitorList, MonitorStop, MonitorDelete
 *   TaskCreate, TaskList, TaskGet, TaskUpdate, TaskDelete, TaskPrune
 *
 * Commands (currently disabled):
 *   /loop, /monitors, /tasks
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addBreadcrumb, initSentry, isSentryInitialized, logDebug } from "./telemetry/sentry.js";

initSentry();

const DEBUG = !!process.env.PI_LOOP_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-loop]", ...args);
  if (isSentryInitialized()) logDebug("[pi-loop]", ...args);
}

export default function (_pi: ExtensionAPI): void {
  addBreadcrumb("extension_loaded_disabled");
  debug("pi-loop loaded (tools/commands/widget/hooks disabled)");
}
