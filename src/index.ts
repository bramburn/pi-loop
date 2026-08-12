/**
 * @bramburn/pi-loop — A pi extension providing cron/event-based agent re-wake loops.
 *
 * Tools (registered):
 *   LoopCreate    — Create a scheduled or event-triggered re-wake loop
 *   LoopUpdate    — Update progress for a dynamic loop
 *   LoopList      — List all active loops with status and next-fire times
 *   LoopDelete    — Delete or pause a loop by ID
 *
 * Commands (registered):
 *   /loop         — Schedule or manage re-wake loops: /loop [interval] [prompt]
 *   /loop-resume  — Re-arm a stored loop by ID (or open the picker with no args)
 *
 * DISABLED (per upstream constraint): MonitorXxx, TaskXxx, /monitors, /tasks,
 * and workflow-tools remain unregistered. The MonitorManager class is still
 * instantiated so the LoopWidget can show a zero-count summary, but no
 * monitor tools or command are wired up.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerLoopCommand } from "./commands/loop-command.js";
import { registerSettingsCommand } from "./commands/settings-command.js";
import { atMaxFires } from "./loop-reducer.js";
import { migrateV1ToV2 } from "./migration/v1-to-v2.js";
import { MonitorManager } from "./monitor-manager.js";
import { BindingsStore } from "./runtime/bindings-store.js";
import {
  createNotificationRuntime,
  type LoopFireEvent,
} from "./runtime/notification-runtime.js";
import { type LoopScope, resolveBindingsPath, resolveLoopStorePath } from "./runtime/scope.js";
import { registerSessionRuntimeHooks } from "./runtime/session-runtime.js";
import { CronScheduler } from "./scheduler.js";
import { loadSettings, type PiLoopSettings } from "./settings.js";
import { LoopStore } from "./store.js";
import { addBreadcrumb, initSentry, isSentryInitialized, logDebug, wrapToolExecute } from "./telemetry/sentry.js";
import { registerLoopTools } from "./tools/loop-tools.js";
import { snapshotFromLoop, syncLoopTools } from "./tools/tool-visibility.js";
import { TriggerSystem } from "./trigger-system.js";
import type { LoopEntry } from "./types.js";
import { LoopWidget } from "./ui/widget.js";

initSentry();

// Per ADR-003, v2.0 reads settings from .pi/pi-loop-settings.json. Env vars
// (PI_LOOP_SCOPE, PI_LOOP_DEBUG, PI_LOOP_TASK_THRESHOLD, PI_LOOP) are
// captured once by the v1-to-v2 migration into the file and ignored
// thereafter.
function loadInitialSettings(): PiLoopSettings {
  const cwd = process.cwd();
  const result = migrateV1ToV2(cwd, process.env);
  if (result.migrated && result.banner) {
    console.error(`[pi-loop] ${result.banner}`);
  }
  return loadSettings(cwd);
}

// _initialSettings is captured once at module load; DEBUG below reads from it
// once and therefore requires a restart for /loop-settings debug changes to
// take effect. This is intentional — debug verbosity is a session-level
// concern, not a per-cycle concern.
const _initialSettings = loadInitialSettings();

const DEBUG = _initialSettings.debug;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-loop]", ...args);
  if (isSentryInitialized()) logDebug("[pi-loop]", ...args);
}

// urgentFlushThresholds MUST be read fresh on every call. The settings file
// is small (~300 bytes) and the heartbeat invokes this once per 30s tick;
// loadSettings already falls back to defaults on error, so disk failures
// degrade gracefully. Without this, /loop-settings changes mid-session
// (which writes the new thresholds to disk) would never reach the
// notification runtime and the heartbeat would keep flushing against the
// stale thresholds loaded at startup.
const _getFlushThresholds = () => loadSettings(process.cwd()).urgentFlushThresholds;

export default function (pi: ExtensionAPI) {
  // Wrap every tool's execute() with a Sentry-capturing try/catch. Done once
  // here so the tool registrations in src/tools/*.ts don't need per-call
  // try/catch boilerplate. The wrapper re-throws so the tool framework still
  // sees the original error.
  interface ToolDefinitionLike {
    name: string;
    execute?: (...args: unknown[]) => Promise<unknown>;
    [key: string]: unknown;
  }
  type WideRegisterTool = (def: ToolDefinitionLike) => void;
  const _realRegisterTool: WideRegisterTool = (pi.registerTool.bind(pi) as unknown) as WideRegisterTool;
  (pi as unknown as { registerTool: WideRegisterTool }).registerTool = (def: ToolDefinitionLike) => {
    const wrapped = {
      ...def,
      execute: def.execute
        ? wrapToolExecute(def.name, def.execute)
        : def.execute,
    };
    return _realRegisterTool(wrapped);
  };

  addBreadcrumb("extension_loaded");

  // Per ADR-003, settings come from .pi/pi-loop-settings.json (with v1.x
  // migration already applied at module load). PI_LOOP_SCOPE and PI_LOOP
  // env vars are no longer read — use /loop-settings to change loopScope.
  const piLoopEnv: string | undefined = undefined;
  const loopScope: LoopScope = _initialSettings.loopScope;

  const getScopeOptions = () => ({ piLoopEnv, loopScope });

  // Hoisted so the BindingsStore below can reference it on init.
  let _latestCtx: ExtensionContext | undefined;
  let _sessionId: string | undefined;

  let store = new LoopStore(resolveLoopStorePath(getScopeOptions()));
  // MonitorManager is instantiated so the LoopWidget can render the monitor
  // count, but no monitor tools or /monitors command are registered in this
  // build (kept disabled per upstream constraint).
  const monitorManager = new MonitorManager(pi);
  let scheduler: CronScheduler;
  let triggerSystem: TriggerSystem;
  // Per-session loop bindings — see docs/loop-governor-design.md.
  // Initial path is undefined because the sessionId is not yet known at
  // extension load time; the session-runtime hook swaps it on session_switch.
  let bindingsStore = new BindingsStore(resolveBindingsPath(getScopeOptions(), _sessionId), loopScope, _sessionId);
  const widget = new LoopWidget(store, monitorManager);

  scheduler = new CronScheduler(store, onLoopFire);
  triggerSystem = new TriggerSystem(pi, scheduler, store, onLoopFire);

  // ── Task hooks (stubs) ──
  // pi-tasks / native task fallback is disabled in this build, but
  // session-runtime and notification-runtime still expect these as
  // dependency-injected callbacks. Provide no-ops so loops can fire without
  // any task coordination.
  const hasPendingTasks = async (): Promise<number> => 0;
  // cleanupDoneTasks emits tasks:rpc:clean so that pi-tasks — when present
  // — can sweep any stale rows whose owners have stopped running. Even with
  // the native task system disabled, the RPC broadcast is harmless (no
  // listener) and is part of the public contract that downstream tests and
  // consumers rely on.
  const cleanDoneTasks = async (): Promise<void> => {
    pi.events.emit("tasks:rpc:clean", { requestId: `clean-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  };
  const migrateTaskBacklogLoops = (): number => 0;
  const cleanupTaskBacklogLoops = async (): Promise<number> => 0;
  const adoptTaskBacklogLoops = async (_baseline?: ReadonlyMap<string, number>): Promise<number> => 0;
  const releaseTaskBacklogWakes = (): void => {};
  // LoopCreate with taskBacklog=true would normally bootstrap an immediate
  // wake from existing pending tasks. Since tasks are disabled, return false.
  const maybeBootstrapTaskLoop = async (_entry: LoopEntry): Promise<boolean> => false;
  const isTaskSystemReady = (): boolean => false;
  // workflow-tools is disabled, so there is never a workflow task to close.
  // Returning true lets LoopDelete proceed past the workflow-task guard.
  const closeWorkflowTask = async (_taskId: string, _claimId?: string): Promise<boolean> => true;

  const notificationRuntime = createNotificationRuntime({
    pi,
    hasPendingTasks,
    cleanDoneTasks,
    getHasPendingMessages: () => _latestCtx?.hasPendingMessages() ?? false,
    getFlushThresholds: _getFlushThresholds,
    debug,
  });

  // ── Loop fire handler ──

  function onLoopFire(entry: LoopEntry): void {
    debug(`loop:fire #${entry.id}`, { prompt: entry.prompt.slice(0, 50) });

    if (atMaxFires(entry)) {
      debug(`loop #${entry.id} — reached maxFires ${entry.maxFires}, expiring`);
      store.delete(entry.id);
      return;
    }
    store.fire(entry.id);

    // The widget renders the firing loop's row with a "-> firing (Ns ago)"
    // suffix for 5 seconds, refreshing every 1s while the indicator is
    // visible. setFiringStatus also starts the internal ticker.
    widget.setFiringStatus(entry.id, entry.prompt);

    pi.events.emit("loop:fire", {
      loopId: entry.id,
      prompt: entry.prompt,
      trigger: entry.trigger,
      timestamp: Date.now(),
      readOnly: entry.readOnly,
      recurring: entry.recurring,
      autoTask: entry.autoTask,
      priority: entry.priority,
    });
  }

  // ── Session lifecycle ──

  registerSessionRuntimeHooks({
    pi,
    getLoopScope: () => loopScope,
    getPiLoopEnv: () => piLoopEnv,
    recreateSessionStore: (sessionId: string) => {
      const path = resolveLoopStorePath(getScopeOptions(), sessionId);
      store = new LoopStore(path);
      widget.setStore(store);
      scheduler = new CronScheduler(store, onLoopFire);
      triggerSystem = new TriggerSystem(pi, scheduler, store, onLoopFire);
      bindingsStore = new BindingsStore(resolveBindingsPath(getScopeOptions(), sessionId), loopScope, sessionId);
    },
    clearAllLoops: () => {
      store.clearAll();
    },
    getStore: () => store,
    getScheduler: () => scheduler,
    getTriggerSystem: () => triggerSystem,
    getBindingsStore: () => bindingsStore,
    setLatestCtx: (ctx) => {
      _latestCtx = ctx;
    },
    setSessionId: (sessionId) => {
      _sessionId = sessionId;
      const expectedPath = resolveBindingsPath(getScopeOptions(), sessionId);
      if (bindingsStore.path !== expectedPath) {
        bindingsStore = new BindingsStore(expectedPath, loopScope, sessionId);
      }
    },
    widget,
    getLoopSnapshots: () => store.list().map(snapshotFromLoop),
    notificationRuntime,
    flushPendingNotifications: notificationRuntime.flushPendingNotifications,
    migrateTaskBacklogLoops,
    cleanupTaskBacklogLoops,
    adoptTaskBacklogLoops,
    releaseTaskBacklogWakes,
    hasPendingTasks,
    cleanDoneTasks,
    showLoopListOverlayFn: undefined,
    showEscapeDialogFn: undefined,
  });

  // ── Loop fire → delivery ──

  const { queueOrDeliverNotification } = notificationRuntime;

  // Per ADR-002: re-sync the LLM's active tool set after every store
  // mutation. Cheap (microseconds) but ensures the LLM can never call a
  // tool that the current loop state has just invalidated.
  function refreshToolVisibility(): void {
    syncLoopTools(pi, store.list().map(snapshotFromLoop));
  }

  pi.events.on("loop:fire", async (event: unknown) => {
    const data = event as LoopFireEvent;
    refreshToolVisibility();
    await queueOrDeliverNotification(data);
  });

  registerLoopTools({
    pi,
    getStore: () => store,
    getTriggerSystem: () => triggerSystem,
    getScheduler: () => scheduler,
    getMonitorManager: () => monitorManager,
    updateWidget: () => {
      widget.update();
      refreshToolVisibility();
    },
    maybeBootstrapTaskLoop,
    isTaskSystemReady,
    closeWorkflowTask,
  });

  registerLoopCommand({
    pi,
    getStore: () => store,
    getTriggerSystem: () => triggerSystem,
    getBindingsStore: () => bindingsStore,
    updateWidget: () => {
      widget.update();
      refreshToolVisibility();
    },
    maybeBootstrapTaskLoop,
  });

  registerSettingsCommand({
    pi,
    getCwd: () => process.cwd(),
  });
}
