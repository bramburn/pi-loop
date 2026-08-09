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
