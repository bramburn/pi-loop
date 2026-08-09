// Generate text-based widget render snapshots for the README.
// Run with: npx tsx scripts/generate-screenshots.ts
// The output is plain-text "screenshots" that can be pasted into the README
// or compared against the real TUI in a future visual regression test.

import { renderWidgetLines } from "../src/ui/widget-render.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

const theme: Theme = {
  fg: (_name: string, text: string) => text,
  bold: (s: string) => s,
} as never;

function render(width: number): string {
  const state = {
    loops: [
      { id: "1", status: "active" as const, prompt: "check deploy status", recurring: true, trigger: { type: "cron", schedule: "*/5 * * * *" } },
      { id: "2", status: "active" as const, prompt: "tail logs", recurring: true, trigger: { type: "event", source: "tool_execution_start" } },
      { id: "3", status: "active" as const, prompt: "weekly report", recurring: true, trigger: { type: "cron", schedule: "0 9 * * 1" }, autoTask: true },
      { id: "4", status: "paused" as const, prompt: "abandoned smoke test", recurring: true, trigger: { type: "event", source: "tool_execution_start" } },
    ],
    monitors: [
      { id: "5", command: "npm test --watch", status: "running", startedAt: Date.now() - 192000, outputLines: 42, outputBuffer: [] },
    ],
    tasks: { count: 3, focusText: "active: wire validator into tests" },
    firingLoopId: "1",
    firedAt: Date.now() - 2000,
    now: Date.now(),
  };
  return renderWidgetLines(state, theme, width).join("\n");
}

const states = [
  { width: 80, label: "default-80" },
  { width: 120, label: "wide-120" },
  { width: 50, label: "narrow-50" },
];

for (const s of states) {
  console.log(`\n=== widget-${s.label} (width=${s.width}) ===\n`);
  console.log(render(s.width));
}
