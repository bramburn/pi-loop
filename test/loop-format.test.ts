import { describe, expect, it } from "vitest";
import { formatLastTransitionLines, formatTrigger } from "../src/loop-format.js";

describe("formatTrigger", () => {
  it("returns the input unchanged when given a string", () => {
    expect(formatTrigger("raw trigger string")).toBe("raw trigger string");
  });

  it("formats a cron trigger in 'list' style", () => {
    expect(formatTrigger({ type: "cron", schedule: "*/5 * * * *" }, "list")).toBe("cron: */5 * * * *");
  });

  it("formats a cron trigger in 'create' style", () => {
    expect(formatTrigger({ type: "cron", schedule: "0 9 * * *" }, "create")).toBe("schedule: 0 9 * * *");
  });

  it("formats a cron trigger in 'notification' style", () => {
    expect(formatTrigger({ type: "cron", schedule: "*/5 * * * *" }, "notification")).toBe("schedule: */5 * * * *");
  });

  it("formats a cron trigger in 'command' style", () => {
    expect(formatTrigger({ type: "cron", schedule: "*/5 * * * *" }, "command")).toBe("cron: */5 * * * *");
  });

  it("formats an event trigger", () => {
    expect(formatTrigger({ type: "event", source: "tool_execution_start" }, "list")).toBe("event: tool_execution_start");
  });

  it("formats a dynamic trigger", () => {
    expect(formatTrigger({ type: "dynamic" }, "list")).toBe("dynamic");
  });

  it("formats a hybrid trigger in 'command' style", () => {
    expect(formatTrigger({ type: "hybrid", cron: "*/5 * * * *", event: { source: "tool_execution_start" }, debounceMs: 30000 }, "command")).toBe("hybrid: */5 * * * *");
  });

  it("formats a hybrid trigger in 'create' style", () => {
    expect(formatTrigger({ type: "hybrid", cron: "*/5 * * * *", event: { source: "tool_execution_start" }, debounceMs: 30000 }, "create")).toBe("hybrid: cron */5 * * * * + event tool_execution_start");
  });

  it("formats a hybrid trigger in 'notification' style", () => {
    expect(formatTrigger({ type: "hybrid", cron: "*/5 * * * *", event: { source: "tool_execution_start" }, debounceMs: 30000 }, "notification")).toBe("hybrid");
  });

  it("formats a hybrid trigger in 'list' style", () => {
    expect(formatTrigger({ type: "hybrid", cron: "*/5 * * * *", event: { source: "tool_execution_start" }, debounceMs: 30000 }, "list")).toBe("hybrid: */5 * * * * + tool_execution_start");
  });
});

describe("formatLastTransitionLines", () => {
  it("returns one line for a transition with no evidence", () => {
    const lines = formatLastTransitionLines({
      from: "init",
      to: "running",
      outcome: "ok",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("init → running");
    expect(lines[0]).toContain("ok");
  });

  it("returns two lines when evidence is present", () => {
    const lines = formatLastTransitionLines({
      from: "init",
      to: "running",
      outcome: "ok",
      evidence: "build passed",
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("init → running");
    expect(lines[1]).toContain("Evidence: build passed");
  });

  it("collapses whitespace in evidence", () => {
    const lines = formatLastTransitionLines({
      from: "init",
      to: "running",
      outcome: "ok",
      evidence: "build\n\n\tpassed with\nwarnings",
    });
    expect(lines[1]).toContain("build passed with warnings");
  });
});
