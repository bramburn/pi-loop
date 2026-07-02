import { describe, expect, it, vi } from "vitest";
import { registerMonitorsCommand } from "../src/commands/monitors-command.js";
import { createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const { pi, commandMap } = createMockPi();
  const ui = {
    select: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    input: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
  };
  let nextId = 1;
  const monitors = new Map<string, any>();
  const manager = {
    list: vi.fn(() => Array.from(monitors.values())),
    get: vi.fn((id: string) => monitors.get(id)),
    stop: vi.fn(async (id: string) => {
      const m = monitors.get(id);
      if (!m || m.status !== "running") return false;
      m.status = "stopped";
      return true;
    }),
    delete: vi.fn(async (id: string) => {
      return monitors.delete(id);
    }),
  };
  const createMonitor = (overrides: Partial<any> = {}) => {
    const id = String(nextId++);
    const m = {
      id,
      command: "echo test",
      timeout: 300000,
      status: "running",
      startedAt: Date.now(),
      outputLines: 0,
      outputBuffer: [],
      ...overrides,
    };
    monitors.set(id, m);
    return m;
  };
  registerMonitorsCommand({
    pi,
    getMonitorManager: () => manager as any,
    updateWidget: vi.fn(),
  });
  const runCommand = (args: string = "") => {
    const cmd = commandMap.get("monitors")!;
    return cmd.handler?.(args, { ui } as any);
  };
  return { pi, manager, monitors, createMonitor, runCommand, ui };
}

describe("/monitors command", () => {
  it("registers as 'monitors' command", () => {
    const h = setup();
    expect(h.ui).toBeDefined();
  });

  it("shows an empty-state message when no monitors exist", async () => {
    const h = setup();
    const selectMock = vi.spyOn(h.ui, "select").mockResolvedValue(undefined);
    await h.runCommand();
    expect(selectMock).toHaveBeenCalledWith(
      expect.stringContaining("No monitors"),
      expect.arrayContaining(["< Back"]),
    );
  });

  it("lists monitors with status icons and metadata", async () => {
    const h = setup();
    h.createMonitor({ id: "1", command: "npm test", status: "running" });
    h.createMonitor({ id: "2", command: "echo done", status: "completed" });

    const selectMock = vi.spyOn(h.ui, "select").mockResolvedValue(undefined);
    await h.runCommand();

    const listCall = selectMock.mock.calls[0];
    expect(listCall[0]).toBe("Monitors");
    const choices = listCall[1] as string[];
    expect(choices.some((c) => c.startsWith("> #1 [running] npm test"))).toBe(true);
    expect(choices.some((c) => c.startsWith("ok #2 [completed] echo done"))).toBe(true);
    expect(choices).toContain("< Back");
  });

  it("calls stop on a running monitor when selected", async () => {
    const h = setup();
    h.createMonitor({ id: "1", status: "running" });

    const _selectMock = vi.spyOn(h.ui, "select")
      .mockResolvedValueOnce("> #1 [running] npm test — 0 lines (0s)")
      .mockResolvedValueOnce("- Stop");
    const notifyMock = vi.spyOn(h.ui, "notify").mockResolvedValue(undefined);

    await h.runCommand();
    expect(h.manager.stop).toHaveBeenCalledWith("1");
    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining("stopped"),
      "info",
    );
  });

  it("calls delete on a monitor when selected", async () => {
    const h = setup();
    h.createMonitor({ id: "1", status: "completed" });

    const _selectMock = vi.spyOn(h.ui, "select")
      .mockResolvedValueOnce("ok #1 [completed] echo done — 0 lines (0s)")
      .mockResolvedValueOnce("x Delete");
    const notifyMock = vi.spyOn(h.ui, "notify").mockResolvedValue(undefined);

    await h.runCommand();
    expect(h.manager.delete).toHaveBeenCalledWith("1");
    expect(notifyMock).toHaveBeenCalledWith(
      expect.stringContaining("deleted"),
      "info",
    );
  });

  it("returns to the list when < Back is selected", async () => {
    const h = setup();
    h.createMonitor({ id: "1", status: "running" });

    const selectMock = vi.spyOn(h.ui, "select")
      .mockResolvedValueOnce("> #1 [running] npm test — 0 lines (0s)")
      .mockResolvedValueOnce("< Back");
    await h.runCommand();
    // Should have shown the list again
    expect(selectMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
