import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { LoopWidget } from "../src/ui/widget.js";

vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (line: string, width: number) =>
    line.length > width ? line.slice(0, width) : line,
}));

function createMockMonitorManager() {
  const monitors: Array<{
    id: string;
    command: string;
    description?: string;
    status: string;
    startedAt: number;
    outputLines: number;
  }> = [];
  return {
    list: () => [...monitors],
    _add: (m: typeof monitors[0]) => monitors.push(m),
    _clear: () => { monitors.length = 0; },
  };
}

describe("LoopWidget rendering", () => {
  let store: LoopStore;
  let monitorManager: ReturnType<typeof createMockMonitorManager>;
  let mockTui: any;
  let widget: LoopWidget;

  beforeEach(() => {
    store = new LoopStore();
    monitorManager = createMockMonitorManager();
    widget = new LoopWidget(store, monitorManager as any);
    mockTui = { terminal: { columns: 80 }, requestRender: vi.fn() };
  });

  afterEach(() => {
    widget.dispose();
  });

  function makeMockUiCtx(setWidget: (_key: string, factory: any) => void) {
    return {
      setStatus: vi.fn(),
      setWidget,
    } as any;
  }

  function extractRenderLines(): string[] {
    let rendered: string[] = [];
    widget.setUICtx(makeMockUiCtx((_key: string, factory: any) => {
      if (factory) {
        const widget = factory(mockTui, {});
        rendered = widget.render();
      }
    }));
    widget.update();
    return rendered;
  }

  it("shows none when no loops or monitors are active", () => {
    const lines = extractRenderLines();
    expect(lines).toEqual(["none"]);
  });

  it("shows a compact monitor count", () => {
    monitorManager._add({
      id: "1",
      command: "bash -lc 'set -euo pipefail\nwhile sleep 30; do hut builds show 1769753; done'",
      description: "Watch SourceHut build",
      status: "running",
      startedAt: Date.now(),
      outputLines: 42,
    });

    const lines = extractRenderLines();
    expect(lines).toEqual(["1 monitor"]);
  });

  it("shows compact loop and monitor counts", () => {
    store.create(
      { type: "event", source: "monitor:done", filter: '{"monitorId":"5"}' },
      "Summarize the GitHub Actions run result",
      { recurring: false },
    );
    monitorManager._add({
      id: "2",
      command: "curl -s https://api.github.com/repos/u/r/actions/runs",
      status: "running",
      startedAt: Date.now(),
      outputLines: 0,
    });

    const lines = extractRenderLines();
    expect(lines).toEqual(["1 loop · 1 monitor"]);
  });

  it("shows task counts and only the active task focus text", () => {
    widget.setTaskSummaryProvider(() => ({
      count: 2,
      focusText: "active: Fix native task fallback",
    }));

    const lines = extractRenderLines();
    expect(lines).toEqual(["2 tasks | active: Fix native task fallback"]);
  });

  it("shows next task when no task is in progress", () => {
    widget.setTaskSummaryProvider(() => ({
      count: 3,
      focusText: "next: Write README updates",
    }));

    const lines = extractRenderLines();
    expect(lines).toEqual(["3 tasks | next: Write README updates"]);
  });

  it("keeps widget registered and updates to none after content clears", () => {
    monitorManager._add({
      id: "x", command: "true", status: "running", startedAt: Date.now(), outputLines: 0,
    });

    let currentFactory: any = null;
    widget.setUICtx(makeMockUiCtx(vi.fn((_key: string, factory: any) => {
      currentFactory = factory;
    })));
    widget.update();
    expect(currentFactory).not.toBeNull();

    monitorManager._clear();
    const rendered = currentFactory(mockTui, {}).render();
    expect(rendered).toEqual(["none"]);
  });
});
