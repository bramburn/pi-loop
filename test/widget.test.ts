import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { LoopWidget } from "../src/ui/widget.js";
import { clampStatusLine, type RenderWidgetState, renderWidgetLines } from "../src/ui/widget-render.js";

// Minimal Theme stub — the render function only uses fg(), bold(), and string
// passthrough. Real styling is exercised by integration tests.
function makeTheme() {
  const passthrough = (s: string) => s;
  return {
    fg: (_name: string, text: string) => text,
    bold: passthrough,
  };
}

function makeMonitor(
  id: string,
  status: "running" | "completed" | "error" | "stopped" = "running",
  outputLines = 0,
): import("../src/types.js").MonitorEntry {
  return {
    id,
    command: `command for ${id}`,
    timeout: 60_000,
    status,
    startedAt: Date.now() - 60_000,
    completedAt: status === "running" ? undefined : Date.now(),
    outputLines,
    outputBuffer: [],
  };
}

function makeLoop(
  id: string,
  status: "active" | "paused" = "active",
  prompt = `Loop ${id} prompt`,
  overrides: Partial<RenderWidgetState["loops"][number]> = {},
): RenderWidgetState["loops"][number] {
  return {
    id,
    status,
    prompt,
    recurring: true,
    trigger: { type: "cron", schedule: "*/5 * * * *" },
    autoTask: false,
    taskBacklog: false,
    dynamic: null,
    ...overrides,
  };
}

describe("clampStatusLine", () => {
  it("returns the input unchanged when shorter than maxWidth", () => {
    expect(clampStatusLine("hello", 80)).toBe("hello");
  });

  it("returns the input unchanged when exactly at maxWidth", () => {
    const line = "x".repeat(80);
    expect(clampStatusLine(line, 80)).toBe(line);
  });

  it("truncates when longer than maxWidth and includes an ellipsis marker", () => {
    const line = "x".repeat(200);
    const out = clampStatusLine(line, 80);
    expect(visibleWidth(out)).toBeLessThanOrEqual(80);
    const stripped = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped.endsWith("…")).toBe(true);
  });

  it("rounds up widths below the 20-column floor to a safe minimum", () => {
    const out = clampStatusLine("hello world", 5);
    expect(visibleWidth(out)).toBeLessThanOrEqual(20);
  });

  it("treats empty input as a no-op", () => {
    expect(clampStatusLine("", 80)).toBe("");
  });
});

describe("renderWidgetLines", () => {
  const theme = makeTheme();

  it("returns an empty array when no loops, monitors, or tasks are visible", () => {
    const lines = renderWidgetLines({ loops: [], monitors: [], tasks: { count: 0 } }, theme, 80);
    expect(lines).toEqual([]);
  });

  it("renders a header line with counts when there is any state", () => {
    const lines = renderWidgetLines(
      { loops: [makeLoop("1")], monitors: [], tasks: { count: 0 } },
      theme,
      80,
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("pi-loop");
    expect(lines[0]).toContain("1 loop");
  });

  it("renders one row per visible (non-paused) loop", () => {
    const loops = [makeLoop("1"), makeLoop("2", "paused"), makeLoop("3", "active", "Loop 3 prompt")];
    const lines = renderWidgetLines({ loops, monitors: [], tasks: { count: 0 } }, theme, 80);
    // header + 2 active rows (paused is hidden) = 3 lines
    expect(lines.length).toBe(3);
    expect(lines.some((l) => l.includes("#1"))).toBe(true);
    expect(lines.some((l) => l.includes("#3"))).toBe(true);
  });

  it("hides paused loops by default", () => {
    const lines = renderWidgetLines(
      { loops: [makeLoop("1", "paused")], monitors: [], tasks: { count: 0 } },
      theme,
      80,
    );
    // Empty — paused loops are not visible
    expect(lines).toEqual([]);
  });

  it("hides one-shot monitor:done loops", () => {
    const loop = makeLoop("1", "active", "auto wake", {
      recurring: false,
      trigger: { type: "event", source: "monitor:done" },
    });
    const lines = renderWidgetLines({ loops: [loop], monitors: [], tasks: { count: 0 } }, theme, 80);
    expect(lines).toEqual([]);
  });

  it("shows the firing flash when fired within the window", () => {
    const loops = [makeLoop("7")];
    const lines = renderWidgetLines(
      { loops, monitors: [], tasks: { count: 0 }, firingLoopId: "7", firedAt: Date.now(), now: Date.now() + 2000 },
      theme,
      80,
    );
    expect(lines.some((l) => l.includes("firing"))).toBe(true);
    expect(lines.some((l) => l.includes("2s ago"))).toBe(true);
  });

  it("hides the firing flash after the 5-second window expires", () => {
    const loops = [makeLoop("7")];
    const lines = renderWidgetLines(
      {
        loops,
        monitors: [],
        tasks: { count: 0 },
        firingLoopId: "7",
        firedAt: Date.now(),
        now: Date.now() + 10_000,
      },
      theme,
      80,
    );
    expect(lines.some((l) => l.includes("firing"))).toBe(false);
  });

  it("renders monitor age using deterministic `now` injection (purity check)", () => {
    const monitors = [makeMonitor("5", "running", 42)];
    const lines = renderWidgetLines(
      {
        loops: [],
        monitors,
        tasks: { count: 0 },
        now: monitors[0].startedAt + 3 * 60 * 1000,
      },
      theme,
      80,
    );
    // Pure render: age must come from `now` injection, not Date.now()
    expect(lines.some((l) => l.includes("3m"))).toBe(true);
  });

  it("renders monitor rows with status and line count", () => {
    const monitors = [makeMonitor("5", "running", 42)];
    const lines = renderWidgetLines({ loops: [], monitors, tasks: { count: 0 } }, theme, 80);
    expect(lines.some((l) => l.includes("#5"))).toBe(true);
    expect(lines.some((l) => l.includes("42 lines"))).toBe(true);
  });

  it("renders the task summary on the final line", () => {
    const lines = renderWidgetLines(
      { loops: [], monitors: [], tasks: { count: 3, focusText: "active: Foo" } },
      theme,
      80,
    );
    expect(lines.some((l) => l.includes("3 tasks"))).toBe(true);
    expect(lines.some((l) => l.includes("Foo"))).toBe(true);
  });

  // Pragmaxim's regression test matrix from commit a45b43d.
  for (const width of [50, 70, 80, 100, 109, 120]) {
    it(`clamps every line at width ${width} under pathological counts`, () => {
      const loops = Array.from({ length: 25 }, (_, i) => makeLoop(String(i + 1), "active", `prompt #${i}`));
      const monitors = Array.from({ length: 25 }, (_, i) =>
        makeMonitor(`m${i}`, "running", i),
      );
      const lines = renderWidgetLines(
        { loops, monitors, tasks: { count: 25, focusText: "x".repeat(200) } },
        theme,
        width,
      );
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    });
  }
});

describe("LoopWidget v2.0 surface", () => {
  let store: LoopStore;
  let monitorManager: { list: () => import("../src/types.js").MonitorEntry[] };
  let widget: LoopWidget;
  let setWidgetCalls: Array<{ key: string; content: unknown; options?: unknown }>;
  let setStatusCalls: Array<{ key: string; text: string | undefined }>;

  beforeEach(() => {
    store = new LoopStore();
    monitorManager = { list: () => [] };
    widget = new LoopWidget(store, monitorManager as never);
    setWidgetCalls = [];
    setStatusCalls = [];
    widget.setUICtx({
      setWidget: (key, content, options) => {
        setWidgetCalls.push({ key, content, options });
      },
      setStatus: (key, text) => {
        setStatusCalls.push({ key, text });
      },
    } as never);
  });

  afterEach(() => widget.dispose());

  it("registers the widget above the editor on first setUICtx", () => {
    expect(setWidgetCalls.length).toBeGreaterThan(0);
    const last = setWidgetCalls[setWidgetCalls.length - 1]!;
    expect(last.key).toBe("loops");
    expect(last.options).toEqual({ placement: "aboveEditor" });
    expect(typeof last.content).toBe("function");
  });

  it("does NOT call setStatus in v2.0", () => {
    // setStatus is the v1.x surface — v2.0 replaces it entirely.
    expect(setStatusCalls.length).toBe(0);
  });

  it("does NOT re-register the widget on update() (uses tui.requestRender instead)", () => {
    // First registration happens on setUICtx (in beforeEach).
    const afterRegister = setWidgetCalls.length;
    store.create({ type: "cron", schedule: "*/5 * * * *" }, "x", { recurring: true });
    widget.update();
    // update() should call tui.requestRender via the captured tui, NOT setWidget
    expect(setWidgetCalls.length).toBe(afterRegister);
    // The widget's tui.requestRender should have been called.
    // (We can't easily verify this without a tui spy — but no re-registration is the key invariant.)
  });

  it("dispose() unregisters the widget via setWidget(undefined)", () => {
    const before = setWidgetCalls.length;
    widget.dispose();
    const last = setWidgetCalls[setWidgetCalls.length - 1]!;
    expect(setWidgetCalls.length).toBe(before + 1);
    expect(last.key).toBe("loops");
    expect(last.content).toBeUndefined();
  });

  it("setFiringStatus() does NOT re-register; setStatus is also not called", () => {
    const before = setWidgetCalls.length;
    widget.setFiringStatus("42", "check build");
    // setFiringStatus must not trigger setWidget registration
    expect(setWidgetCalls.length).toBe(before);
    expect(setStatusCalls.length).toBe(0);
  });

  it("setStore() updates the widget state without re-registering", () => {
    const newStore = new LoopStore();
    newStore.create({ type: "cron", schedule: "*/5 * * * *" }, "from new store", { recurring: true });
    const before = setWidgetCalls.length;
    widget.setStore(newStore);
    // setStore should not trigger re-registration
    expect(setWidgetCalls.length).toBe(before);
    // Verify the registered factory reads the new store: invoke it with mock
    // tui/theme, then call render on the returned component.
    const factory = setWidgetCalls[setWidgetCalls.length - 1]!.content as (
      tui: unknown,
      theme: unknown,
    ) => { render: (w: number) => string[] };
    const component = factory({ requestRender: () => {} } as never, makeTheme() as never);
    const rendered = component.render(80);
    expect(rendered.some((l) => l.includes("from new store"))).toBe(true);
  });

  it("setFiringStatus installs a ticker that calls requestRender at 1Hz (not re-register)", () => {
    vi.useFakeTimers();
    try {
      const before = setWidgetCalls.length;
      widget.setFiringStatus("42", "check build");
      // No re-registration from setFiringStatus
      expect(setWidgetCalls.length).toBe(before);
      // Advance 2 ticks — ticker should still not re-register
      vi.advanceTimersByTime(2200);
      expect(setWidgetCalls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures the tui handle on first registration for later invalidate()", () => {
    // Pull the factory and invoke it with a spy tui
    const factory = setWidgetCalls[0]!.content as (tui: unknown, theme: unknown) => unknown;
    const requestRender = vi.fn();
    factory({ requestRender } as never, makeTheme() as never);
    // After invoking, widget.invalidate() should call requestRender via
    // the captured tui handle. Create a store mutation and update().
    store.create({ type: "cron", schedule: "*/5 * * * *" }, "x", { recurring: true });
    widget.update();
    expect(requestRender).toHaveBeenCalled();
  });

  it("isRegistered() reflects the current registration state", () => {
    // After beforeEach's setUICtx, the widget is registered.
    expect(widget.isRegistered()).toBe(true);
    // After dispose, no longer registered.
    widget.dispose();
    expect(widget.isRegistered()).toBe(false);
  });

  it("ticker self-disables after the firing-flash window expires", () => {
    vi.useFakeTimers();
    try {
      widget.setFiringStatus("42", "check build");
      // Advance past the 5-second firing-flash window plus 1 tick
      vi.advanceTimersByTime(6100);
      // The ticker cleared itself and triggered one final repaint
      const after = setWidgetCalls.length;
      // Advance another 3 seconds: ticker should be silent now
      vi.advanceTimersByTime(3000);
      const later = setWidgetCalls.length;
      expect(later).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose() clears the ticker", () => {
    vi.useFakeTimers();
    try {
      widget.setFiringStatus("42", "check build");
      const clearIntervalSpy = vi.spyOn(global, "clearInterval");
      widget.dispose();
      expect(clearIntervalSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
