import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { LoopStore } from "../store.js";
import { type LoopSnapshot, syncLoopTools } from "../tools/tool-visibility.js";
import { showEscapeDialog } from "../ui/escape-dialog.js";
import { showLoopListOverlay } from "../ui/overlays.js";
import type { BindingsStore } from "./bindings-store.js";
import type { NotificationRuntime } from "./notification-runtime.js";
import type { LoopScope } from "./scope.js";

export interface SessionSwitchEvent {
  reason?: string;
}

// Wall-clock cadence for the idle heartbeat that pumps the scheduler. Cron is
// minute-granular, so 30s gives sub-minute wake latency while idle.
const HEARTBEAT_MS = 30_000;

export interface SessionRuntimeOptions {
  pi: ExtensionAPI;
  getLoopScope: () => LoopScope;
  getPiLoopEnv: () => string | undefined;
  recreateSessionStore: (sessionId: string) => void;
  clearAllLoops: () => void;
  getStore: () => LoopStore;
  getScheduler: () => { nextFire(id: string): number | undefined; pump(now: number, filter?: (entry: { id: string }) => boolean): void };
  getTriggerSystem: () => { start(): void; stop(): void; add(entry: { id: string }): void; remove(id: string): void };
  getBindingsStore: () => BindingsStore;
  setLatestCtx: (ctx: ExtensionContext) => void;
  setSessionId: (sessionId: string | undefined) => void;
  widget: { setUICtx(ui: ExtensionContext["ui"]): void; update(): void };
  /** Snapshot of the current loop state. Read by syncLoopTools to decide
   *  which loop tools should be exposed to the LLM. */
  getLoopSnapshots: () => LoopSnapshot[];
  /** Optional override of the runtime sync fn for tests. */
  syncLoopToolsFn?: typeof syncLoopTools;
  /** Optional override for the loop overlay (for tests). */
  showLoopListOverlayFn?: typeof showLoopListOverlay;
  /** Optional override for the escape dialog (for tests). */
  showEscapeDialogFn?: typeof showEscapeDialog;
  notificationRuntime: NotificationRuntime;
  flushPendingNotifications: (options?: { ignorePendingMessages?: boolean }) => Promise<void>;
  migrateTaskBacklogLoops: () => number;
  cleanupTaskBacklogLoops: () => Promise<number>;
  adoptTaskBacklogLoops: (baselineFireCounts?: ReadonlyMap<string, number>) => Promise<number>;
  releaseTaskBacklogWakes: () => void;
  hasPendingTasks: () => Promise<number>;
  cleanDoneTasks: () => Promise<void>;
}

export function registerSessionRuntimeHooks(options: SessionRuntimeOptions): void {
  const {
    pi,
    getLoopScope,
    getPiLoopEnv,
    recreateSessionStore,
    clearAllLoops,
    getStore,
    getScheduler,
    getTriggerSystem,
    getBindingsStore,
    setLatestCtx,
    setSessionId,
    widget,
    getLoopSnapshots,
    syncLoopToolsFn,
    notificationRuntime,
    flushPendingNotifications,
    migrateTaskBacklogLoops,
    cleanupTaskBacklogLoops,
    adoptTaskBacklogLoops,
    releaseTaskBacklogWakes,
    hasPendingTasks,
    cleanDoneTasks,
    showLoopListOverlayFn,
    showEscapeDialogFn,
  } = options;

  let storeUpgraded = false;
  let persistedShown = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let agentStartFireCounts: ReadonlyMap<string, number> | undefined;
  let terminalInputUnsubscribe: (() => void) | undefined;

  // The CronScheduler is pump-driven; without this heartbeat it only advances at
  // turn boundaries (turn_start/agent_end), so a loop whose fire time elapses
  // while the agent is idle would never fire and never re-wake the agent. The
  // timer is unref'd so it never keeps a one-shot (`pi -p`) process alive.
  function ensureHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      // Swallow pump failures so a transient error never surfaces as an
      // unhandled rejection; repaint still runs so cleared harness UI heals.
      void pumpLoops()
        .catch(() => {})
        .then(() => widget.update())
        .catch(() => {});
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }

  function syncToolsNow(): void {
    const fn = syncLoopToolsFn ?? syncLoopTools;
    fn(pi, getLoopSnapshots());
  }

  function stopHeartbeat(): void {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  // Register global keybindings. Per ADR-004: Ctrl+Shift+L opens the loop
  // list overlay; Escape during a pending fire opens the skip/continue/cancel
  // dialog. Returns { consume: true } only when consuming the key.
  // Crash recovery helper: when session_start fires with reason === 'resume',
  // scan the store for paused loops and prompt the user per loop. Mirrors
  // pragmaxim's extensions/goal.ts:3437. Headless mode is a no-op.
  async function offerResumePausedLoops(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    const paused = getStore().list().filter((l) => l.status === "paused");
    if (paused.length === 0) return;
    for (const entry of paused) {
      const shouldResume = await ctx.ui.confirm(
        `Resume paused loop #${entry.id}?`,
        entry.prompt.slice(0, 80),
      );
      if (shouldResume) {
        const resumed = getStore().resume(entry.id);
        if (resumed) {
          getTriggerSystem().add(resumed);
          ctx.ui.notify(`Loop #${entry.id} resumed`, "info");
        }
      }
    }
  }

  function registerKeybindings(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      // Ctrl+Shift+L — always available when idle and has UI.
      if (matchesKey(data, "ctrl+shift+l")) {
        void (showLoopListOverlayFn ?? showLoopListOverlay)(ctx, {
          loops: getStore().list(),
          monitors: [],
          tasks: { count: 0 },
          myLoopIds: new Set(getStore().list().map((l) => l.id)),
        });
        return { consume: true };
      }
      // Escape — only consumed when an operation is in flight. Otherwise the
      // TUI handles Escape (e.g. clearing editor text).
      if (matchesKey(data, "escape")) {
        const hasRecentFire = getStore().list().some((l) => l.status === "active");
        if (!hasRecentFire) return undefined;
        void (showEscapeDialogFn ?? showEscapeDialog)(ctx, {
          operationLabel: "Loop firing",
        }).then((choice) => {
          if (choice === "cancel") {
            ctx.ui.notify("Operation cancelled via Escape", "info");
          } else if (choice === "skip") {
            ctx.ui.notify("Iteration skipped via Escape", "info");
          }
        });
        return { consume: true };
      }
      return undefined;
    });
  }

  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if ((getLoopScope() === "session" || getLoopScope() === "memory") && !getPiLoopEnv()) {
      recreateSessionStore(ctx.sessionManager.getSessionId());
    }
    storeUpgraded = true;
  }

  async function showPersistedLoops(ui?: ExtensionContext["ui"], _isResume = false) {
    if (persistedShown) return;
    persistedShown = true;
    const sessionStartedAt = Date.now();
    migrateTaskBacklogLoops();

    const bindings = getBindingsStore();
    const hadFile = bindings.fileExists();
    bindings.load();
    if (!hadFile) {
      bindings.save();
      if (ui) {
        ui.notify(
          "No bindings for this session — run /loop-resume to choose which loops this terminal arms.",
          "info",
        );
      }
    }

    const loops = getStore().list();
    if (loops.length > 0) {
      getStore().clearExpired();
      getStore().expireEventLoops(sessionStartedAt);

      getTriggerSystem().start();
      const boundIds = new Set(bindings.list());
      for (const loop of loops) {
        if (loop.status === "active" && boundIds.has(loop.id)) {
          getTriggerSystem().add(loop);
        } else {
          getTriggerSystem().remove(loop.id);
        }
      }
      ensureHeartbeat();
    }
    await adoptTaskBacklogLoops();
  }

  async function pumpLoops(): Promise<void> {
    const pendingTasks = new Map<string, boolean>();
    for (const entry of getStore().list()) {
      if (entry.status !== "active") continue;
      if (!entry.autoTask) continue;
      if (entry.trigger.type !== "cron" && entry.trigger.type !== "hybrid") continue;
      const nextFire = getScheduler().nextFire(entry.id);
      if (!nextFire || Date.now() < nextFire) continue;
      const pending = await hasPendingTasks();
      if (pending <= 0) pendingTasks.set(entry.id, true);
    }
    getScheduler().pump(Date.now(), (entry) => !pendingTasks.has(entry.id));
  }

  pi.on("session_start", async (event, ctx) => {
    setLatestCtx(ctx);
    setSessionId(ctx.sessionManager.getSessionId());
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    await showPersistedLoops(ctx.ui);
    registerKeybindings(ctx);

    // Per ADR-001 and pragmaxim's extensions/goal.ts:3437: on crash recovery
    // (event.reason === 'resume'), offer to resume paused loops. Fresh
    // session starts (reason unset or 'new') do NOT prompt — the user
    // should pick deliberately via /loop-list.
    if (event?.reason === "resume") {
      await offerResumePausedLoops(ctx);
    }

    widget.update();
  });

  pi.on("turn_start", async (_event, ctx) => {
    setLatestCtx(ctx);
    setSessionId(ctx.sessionManager.getSessionId());
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    await showPersistedLoops(ctx.ui);
    widget.update();
    await pumpLoops();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    upgradeStoreIfNeeded(ctx);
    ensureHeartbeat();
    await showPersistedLoops(ctx.ui);
    // Per ADR-002: sync the LLM's active tool set to the current loop
    // state. First sync MUST happen in before_agent_start, never in
    // session_start (runtime not bound — see pragmaxim d77e3b8).
    syncToolsNow();
    widget.update();
  });

  pi.on("agent_start", async (_event, ctx) => {
    notificationRuntime.syncRuntimeState({
      agentRunning: true,
      hasPendingMessages: ctx.hasPendingMessages(),
    });
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    agentStartFireCounts = new Map(getStore().list().map((entry) => [entry.id, entry.fireCount ?? 0]));
  });

  pi.on("agent_end", async (_event, ctx) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    notificationRuntime.syncRuntimeState({
      agentRunning: false,
      hasPendingMessages: ctx.hasPendingMessages(),
    });
    releaseTaskBacklogWakes();
    await cleanupTaskBacklogLoops();
    await adoptTaskBacklogLoops(agentStartFireCounts);
    agentStartFireCounts = undefined;
    await flushPendingNotifications({ ignorePendingMessages: true });
    await pumpLoops();
  });

  pi.on("session_shutdown", async () => {
    stopHeartbeat();
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = undefined;
    releaseTaskBacklogWakes();
    notificationRuntime.clear("session_shutdown");
  });

  pi.on("session_switch" as never, async (event: SessionSwitchEvent, ctx: ExtensionContext) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);
    getTriggerSystem().stop();
    stopHeartbeat();
    notificationRuntime.clear("session_switch");
    releaseTaskBacklogWakes();
    setSessionId(undefined);

    const isResume = event?.reason === "resume";
    storeUpgraded = false;
    persistedShown = false;

    setSessionId(ctx.sessionManager.getSessionId());
    upgradeStoreIfNeeded(ctx);
    if (!isResume && getLoopScope() === "memory") clearAllLoops();
    await showPersistedLoops(ctx.ui, isResume);
    widget.update();
  });

  pi.on("tool_execution_end", async (event: unknown, ctx: ExtensionContext) => {
    setLatestCtx(ctx);
    widget.setUICtx(ctx.ui);

    const typed = event as {
      toolName?: string;
      isError?: boolean;
      args?: { command?: string };
      input?: { command?: string };
    };

    if (typed.toolName !== "bash" || typed.isError) return;

    const command = typed.args?.command ?? typed.input?.command;
    if (typeof command !== "string") return;
    if (!/^\s*git\s+commit\b/i.test(command)) return;

    await cleanDoneTasks();
  });
}
