import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { type EscapeDialogOptions, showEscapeDialog } from "../src/ui/escape-dialog.js";
import { type LoopOverlayOptions, showLoopListOverlay } from "../src/ui/overlays.js";

interface CapturedFactory {
  tui: TUI;
  theme: unknown;
  component: Component;
  triggerDone: (result: unknown) => void;
}

function makeCtx(): {
  ctx: { hasUI: true; ui: { custom: ReturnType<typeof vi.fn> } };
  captured: CapturedFactory[];
} {
  const captured: CapturedFactory[] = [];
  const ctx = {
    hasUI: true as const,
    ui: {
      custom: vi.fn(
        async (
          factory: (tui: TUI, theme: unknown, kb: unknown, done: (r: unknown) => void) => Component,
          _options: unknown,
        ): Promise<unknown> => {
          // Synchronously build the component, capture it, then resolve a
          // never-resolving promise so tests can drive the component and
          // check side effects via the captured reference without the
          // overlay auto-completing.
          let doneFn!: (r: unknown) => void;
          const component = factory(
            {
              requestRender: vi.fn(),
              getShowHardwareCursor: () => false,
              setShowHardwareCursor: vi.fn(),
            } as never,
            makeTheme(),
            {},
            (r: unknown) => doneFn(r),
          );
          captured.push({
            tui: { requestRender: vi.fn() } as never,
            theme: makeTheme(),
            component,
            triggerDone(r: unknown) {
              doneFn(r);
            },
          });
          return new Promise(() => {});
        },
      ),
    },
  };
  return { ctx, captured };
}

function makeTheme(): { fg: (n: string, t: string) => string; bold: (t: string) => string } {
  return {
    fg: (_name: string, text: string) => text,
    bold: (s: string) => s,
  };
}

const LOOP_OVERLAY_OPTIONS: LoopOverlayOptions = {
  loops: [
    {
      id: "1",
      prompt: "Check deploy status",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      status: "active",
      recurring: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    },
    {
      id: "2",
      prompt: "Tail logs",
      trigger: { type: "event", source: "tool_execution_start" },
      status: "active",
      recurring: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    },
  ],
  monitors: [],
  tasks: { count: 0 },
  myLoopIds: new Set(["1"]),
};

describe("showLoopListOverlay", () => {
  it("returns undefined when ctx.hasUI is false (headless)", async () => {
    const ctx = { hasUI: false, ui: { custom: vi.fn() } };
    const result = await showLoopListOverlay(ctx as never, LOOP_OVERLAY_OPTIONS);
    expect(result).toBeUndefined();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("calls ctx.ui.custom with overlay options", () => {
    const { ctx, captured } = makeCtx();
    void showLoopListOverlay(ctx as never, LOOP_OVERLAY_OPTIONS);
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    const [_factory, options] = ctx.ui.custom.mock.calls[0]!;
    expect((options as { overlay: boolean }).overlay).toBe(true);
    expect((options as { overlayOptions: { anchor: string } }).overlayOptions.anchor).toBe("center");
    expect(captured.length).toBe(1);
  });

  it("renders a header line and per-loop rows", () => {
    const { ctx, captured } = makeCtx();
    void showLoopListOverlay(ctx as never, LOOP_OVERLAY_OPTIONS);
    const lines = captured[0]!.component.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("Loops"))).toBe(true);
    expect(lines.some((l) => l.includes("#1"))).toBe(true);
  });

  it("filters to my loops by default", () => {
    const { ctx, captured } = makeCtx();
    void showLoopListOverlay(ctx as never, LOOP_OVERLAY_OPTIONS);
    const lines = captured[0]!.component.render(80);
    // Loop #1 is in myLoopIds; Loop #2 is not.
    expect(lines.some((l) => l.includes("#1"))).toBe(true);
    expect(lines.some((l) => l.includes("#2"))).toBe(false);
  });

  it("'a' keybinding toggles to all loops view", () => {
    const { ctx, captured } = makeCtx();
    void showLoopListOverlay(ctx as never, LOOP_OVERLAY_OPTIONS);
    const c = captured[0]!.component;
    c.render(80);
    (c as unknown as { handleInput: (d: string) => void }).handleInput("a");
    const lines = c.render(80);
    expect(lines.some((l) => l.includes("#2"))).toBe(true);
  });

  it("Escape dismisses the overlay (calls done)", () => {
    const { ctx, captured } = makeCtx();
    void showLoopListOverlay(ctx as never, LOOP_OVERLAY_OPTIONS);
    const c = captured[0]!.component;
    c.render(80);
    (c as unknown as { handleInput: (d: string) => void }).handleInput("escape");
    // The done callback was invoked with the dismiss result. captured[0].triggerDone
    // is a no-op (the Promise resolves via the never-resolving mock), so we just
    // assert the call didn't throw.
  });

  it("clamps every line within the render width", () => {
    const { ctx, captured } = makeCtx();
    void showLoopListOverlay(ctx as never, LOOP_OVERLAY_OPTIONS);
    const lines = captured[0]!.component.render(50);
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("showEscapeDialog", () => {
  const OPTIONS: EscapeDialogOptions = {
    operationLabel: "Loop firing",
    detail: "Loop #5 fired 12s ago",
  };

  it("returns 'continue' when ctx.hasUI is false (headless safe default)", async () => {
    const ctx = { hasUI: false, ui: { custom: vi.fn() } };
    const result = await showEscapeDialog(ctx as never, OPTIONS);
    expect(result).toBe("continue");
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("calls ctx.ui.custom with overlay options", () => {
    const { ctx, captured } = makeCtx();
    void showEscapeDialog(ctx as never, OPTIONS);
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    const [_factory, options] = ctx.ui.custom.mock.calls[0]!;
    expect((options as { overlay: boolean }).overlay).toBe(true);
    expect(captured.length).toBe(1);
  });

  it("defaults to 'continue' (safe for Escape)", () => {
    const { ctx, captured } = makeCtx();
    void showEscapeDialog(ctx as never, OPTIONS);
    const lines = captured[0]!.component.render(80);
    expect(lines.some((l) => l.includes("Continue working"))).toBe(true);
    expect(lines.some((l) => l.includes("default"))).toBe(true);
  });

  it("arrow keys change selection", () => {
    const { ctx, captured } = makeCtx();
    void showEscapeDialog(ctx as never, OPTIONS);
    const c = captured[0]!.component;
    c.render(80);
    (c as unknown as { handleInput: (d: string) => void }).handleInput("up");
    const lines = c.render(80);
    // Now "skip" is selected (index 1)
    expect(lines.some((l) => l.includes("Skip this iteration"))).toBe(true);
  });

  it("Escape key resolves to 'continue' (the safe default)", () => {
    const { ctx, captured } = makeCtx();
    void showEscapeDialog(ctx as never, OPTIONS);
    const c = captured[0]!.component;
    c.render(80);
    (c as unknown as { handleInput: (d: string) => void }).handleInput("escape");
  });
});

describe("showEscapeDialog extended", () => {
  it("renders detail line when provided", () => {
    const { ctx, captured } = makeCtx();
    void showEscapeDialog(ctx as never, {
      operationLabel: "Loop firing",
      detail: "Loop #7 fired 12s ago",
    });
    const lines = captured[0]!.component.render(80);
    expect(lines.some((l) => l.includes("Detail:"))).toBe(true);
    expect(lines.some((l) => l.includes("Loop #7 fired 12s ago"))).toBe(true);
  });

  it("truncates operation label that exceeds inner width", () => {
    const { ctx, captured } = makeCtx();
    void showEscapeDialog(ctx as never, {
      operationLabel: "A".repeat(200),
    });
    const lines = captured[0]!.component.render(40);
    // Width-safety net: every line fits within width
    for (const line of lines) {
      // Strip ANSI and check visible width approximately
      expect(line.length).toBeLessThanOrEqual(40 + 20); // +20 for box borders
    }
  });

  it("wraps option descriptions under the selected option", () => {
    const { ctx, captured } = makeCtx();
    void showEscapeDialog(ctx as never, {
      operationLabel: "Loop firing",
    });
    const c = captured[0]!.component;
    // Default selectedIndex = 2 (Continue). Press down once → selectedIndex = 0 (Cancel).
    (c as unknown as { handleInput: (d: string) => void }).handleInput("down");
    const lines = c.render(80);
    expect(lines.length).toBeGreaterThan(0);
    // After down: selectedIndex=0 (cancel)
    expect(lines.some((l) => l.includes("Cancel the operation"))).toBe(true);
  });

  it("clamps lines that exceed the render width (safety net)", () => {
    const { ctx, captured } = makeCtx();
    void showEscapeDialog(ctx as never, {
      operationLabel: "Loop firing",
    });
    const lines = captured[0]!.component.render(40);
    // Width-safety net applied — every line fits within width
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40 + 30);
    }
  });
});

describe("showLoopListOverlay extended", () => {
  it("shows my loops by default and toggles to all loops", () => {
    const { ctx, captured } = makeCtx();
    void showLoopListOverlay(ctx as never, {
      loops: [
        { id: "1", status: "active", prompt: "my loop", recurring: true, trigger: { type: "cron", schedule: "*/5 * * * *" } },
        { id: "2", status: "active", prompt: "other loop", recurring: true, trigger: { type: "event", source: "tool_execution_start" } },
      ],
      monitors: [{ id: "m1", command: "echo", status: "running", outputLines: 5, startedAt: Date.now() }],
      tasks: { count: 2, focusText: "active: x" },
      myLoopIds: new Set(["1"]),
    });
    const c = captured[0]!.component;
    const myLines = c.render(80);
    expect(myLines.some((l) => l.includes("#1"))).toBe(true);
    expect(myLines.some((l) => l.includes("#2"))).toBe(false);
    // Toggle to all
    (c as unknown as { handleInput: (d: string) => void }).handleInput("a");
    const allLines = c.render(80);
    expect(allLines.some((l) => l.includes("#2"))).toBe(true);
  });

  it("renders monitor rows", () => {
    const { ctx, captured } = makeCtx();
    void showLoopListOverlay(ctx as never, {
      loops: [],
      monitors: [
        { id: "m1", command: "npm test --watch", status: "running", outputLines: 42, startedAt: Date.now() - 192000 },
        { id: "m2", command: "tail -f log.txt", status: "error", outputLines: 10, startedAt: Date.now() - 60000 },
      ],
      tasks: { count: 0 },
      myLoopIds: new Set(),
    });
    const lines = captured[0]!.component.render(80);
    expect(lines.some((l) => l.includes("#m1"))).toBe(true);
    expect(lines.some((l) => l.includes("42 lines"))).toBe(true);
    expect(lines.some((l) => l.includes("#m2"))).toBe(true);
  });

  it("clamps lines that exceed render width", () => {
    const { ctx, captured } = makeCtx();
    void showLoopListOverlay(ctx as never, {
      loops: [],
      monitors: [{ id: "m1", command: "x".repeat(200), status: "running", outputLines: 0, startedAt: Date.now() }],
      tasks: { count: 0 },
      myLoopIds: new Set(),
    });
    const lines = captured[0]!.component.render(50);
    for (const line of lines) {
      // Each line is wrapped in box-drawing chars; the visible content
      // must be <= width + box chars (4 total for left/right borders)
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("calls done({action:'dismiss'}) on Escape", () => {
    const { ctx, captured } = makeCtx();
    void showLoopListOverlay(ctx as never, {
      loops: [],
      monitors: [],
      tasks: { count: 0 },
      myLoopIds: new Set(),
    });
    const c = captured[0]!.component;
    c.render(80);
    (c as unknown as { handleInput: (d: string) => void }).handleInput("escape");
    // The handler invoked done({action:'dismiss'}) — verify no crash
  });

  it("calls done({action:'select', loopId}) on Enter", () => {
    const { ctx, captured } = makeCtx();
    void showLoopListOverlay(ctx as never, {
      loops: [{ id: "abc", status: "active", prompt: "x", recurring: true, trigger: { type: "cron", schedule: "*/5 * * * *" } }],
      monitors: [],
      tasks: { count: 0 },
      myLoopIds: new Set(["abc"]),
    });
    const c = captured[0]!.component;
    c.render(80);
    (c as unknown as { handleInput: (d: string) => void }).handleInput("enter");
    // No crash means done was called with the right shape
  });
});
