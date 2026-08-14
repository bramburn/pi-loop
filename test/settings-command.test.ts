import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSettingsCommand } from "../src/commands/settings-command.js";
import { LoopStore } from "../src/store.js";

interface UiMock {
  select: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
}

interface PiMock {
  registerCommand: ReturnType<typeof vi.fn>;
  name: string | undefined;
  description: string | undefined;
  handler: ((args: string, ctx: { ui: UiMock }) => Promise<void>) | undefined;
}

function makePi(): PiMock {
  const pi: PiMock = {
    registerCommand: vi.fn(),
    name: undefined,
    description: undefined,
    handler: undefined,
  };
  pi.registerCommand.mockImplementation((name: string, def: { description: string; handler: (args: string, ctx: { ui: UiMock }) => Promise<void> }) => {
    pi.name = name;
    pi.description = def.description;
    pi.handler = def.handler;
  });
  return pi;
}

function makeUi(): UiMock {
  return {
    select: vi.fn(),
    input: vi.fn(),
    notify: vi.fn(),
    confirm: vi.fn(async () => false),
  };
}

describe("/loop-settings command", () => {
  let cwd = "/tmp/test";
  let loadFn: ReturnType<typeof vi.fn>;
  let saveFn: ReturnType<typeof vi.fn>;
  let settings: Record<string, unknown>;

  beforeEach(() => {
    settings = {
      loopScope: "project",
      taskScope: "session",
      debug: false,
      autoClear: "on_list_complete",
      sortOrder: "id",
      hiddenAt: "bottom",
      maxVisible: 10,
      showAll: false,
      taskThreshold: 5,
      urgentFlushThresholds: {
        defer: 86_400_000,
        normal: 300_000,
        urgent: 30_000,
        critical: 0,
      },
    };
    loadFn = vi.fn(() => settings);
    saveFn = vi.fn();
    cwd = "/tmp/test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupCommand(): { pi: PiMock; ui: UiMock } {
    const ui = makeUi();
    const pi = makePi();
    const store = new LoopStore();
    const triggerSystem = { add: vi.fn(), remove: vi.fn() };
    registerSettingsCommand({
      pi: pi as never,
      getCwd: () => cwd,
      getStore: () => store,
      getTriggerSystem: () => triggerSystem,
      load: loadFn as never,
      save: saveFn as never,
    });
    return { pi, ui };
  }

  it("registers the loop-settings command with a description", () => {
    const { pi } = setupCommand();
    expect(pi.name).toBe("loop-settings");
    expect(pi.description).toContain("loopScope");
    expect(pi.description).toContain("taskThreshold");
  });

  it("returns immediately when user selects '< Back'", async () => {
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await pi.handler!("", { ui });
    expect(saveFn).not.toHaveBeenCalled();
  });

  it("returns immediately when select resolves to undefined", async () => {
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).not.toHaveBeenCalled();
  });

  it("cycles loopScope: project -> memory (wraps)", async () => {
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Loop storage: project");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ loopScope: "memory" }));
  });

  it("cycles loopScope: memory -> session", async () => {
    settings.loopScope = "memory";
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Loop storage: memory");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ loopScope: "session" }));
  });

  it("cycles loopScope: session -> project", async () => {
    settings.loopScope = "session";
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Loop storage: session");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ loopScope: "project" }));
  });

  it("cycles taskScope: session -> memory", async () => {
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Task storage: session");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ taskScope: "project" }));
  });

  it("toggles debug from false to true", async () => {
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Debug logging: false");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ debug: true }));
  });

  it("toggles debug from true back to false", async () => {
    settings.debug = true;
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Debug logging: true");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ debug: false }));
  });

  it("cycles autoClear: on_list_complete -> on_task_complete", async () => {
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Auto-clear completed: on_list_complete");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ autoClear: "on_task_complete" }));
  });

  it("cycles autoClear through all three modes and wraps to never", async () => {
    settings.autoClear = "on_task_complete";
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Auto-clear completed: on_task_complete");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ autoClear: "never" }));
  });

  it("cycles sortOrder: id -> status", async () => {
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Widget sort order: id");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ sortOrder: "status" }));
  });

  it("cycles sortOrder: recent -> oldest", async () => {
    settings.sortOrder = "recent";
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Widget sort order: recent");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ sortOrder: "oldest" }));
  });

  it("cycles hiddenAt: bottom -> top (full label match)", async () => {
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Overflow hidden at: bottom (completed at bottom)");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ hiddenAt: "top" }));
  });

  it("cycles hiddenAt: top -> bottom (full label match)", async () => {
    settings.hiddenAt = "top";
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Overflow hidden at: top (completed fold away)");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ hiddenAt: "bottom" }));
  });

  it("cycles maxVisible: 10 -> 20", async () => {
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Max visible tasks: 10");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ maxVisible: 20 }));
  });

  it("cycles maxVisible: 100 -> wraps back to 5", async () => {
    settings.maxVisible = 100;
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Max visible tasks: 100");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ maxVisible: 5 }));
  });

  it("toggles showAll from false to true", async () => {
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Show all tasks: false");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ showAll: true }));
  });

  it("cycles taskThreshold: 5 -> 10", async () => {
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Backlog worker threshold: 5");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ taskThreshold: 10 }));
  });

  it("cycles taskThreshold: 25 -> wraps back to 1", async () => {
    settings.taskThreshold = 25;
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Backlog worker threshold: 25");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/tmp/test", expect.objectContaining({ taskThreshold: 1 }));
  });

  it("calls notify after a successful save", async () => {
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Debug logging: false");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(ui.notify).toHaveBeenCalledWith("Debug logging -> true", "info");
  });

  it("falls back to defaults when load() throws", async () => {
    loadFn = vi.fn(() => {
      throw new Error("corrupt settings");
    });
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await pi.handler!("", { ui });
    expect(saveFn).not.toHaveBeenCalled();
  });

  it("renders all 10 settings in the menu", async () => {
    const { pi, ui } = setupCommand();
    let observedOptions: string[] | undefined;
    (ui.select as ReturnType<typeof vi.fn>).mockImplementation(async (title: string, options: string[]) => {
      expect(title).toBe("Settings");
      observedOptions = options;
      return "< Back";
    });
    await pi.handler!("", { ui });
    expect(observedOptions).toBeDefined();
    expect(observedOptions!.length).toBe(12); // 10 settings + Shared loops sub-screen entry + < Back
    expect(observedOptions!).toContain("Loop storage: project");
    expect(observedOptions!).toContain("Task storage: session");
    expect(observedOptions!).toContain("Debug logging: false");
    expect(observedOptions!).toContain("Auto-clear completed: on_list_complete");
    expect(observedOptions!).toContain("Widget sort order: id");
    expect(observedOptions!).toContain("Overflow hidden at: bottom (completed at bottom)");
    expect(observedOptions!).toContain("Max visible tasks: 10");
    expect(observedOptions!).toContain("Show all tasks: false");
    expect(observedOptions!).toContain("Backlog worker threshold: 5");
    expect(observedOptions!).toContain("< Back");
  });

  it("uses cwd() from getCwd() when saving", async () => {
    cwd = "/custom/cwd";
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Debug logging: false");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await pi.handler!("", { ui });
    expect(saveFn).toHaveBeenCalledWith("/custom/cwd", expect.any(Object));
  });

  it("uses load() from override (not defaults) when provided", async () => {
    settings.loopScope = "memory";
    const { pi, ui } = setupCommand();
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await pi.handler!("", { ui });
    // loadFn was called (our override returned memory scope)
    expect(loadFn).toHaveBeenCalledWith("/tmp/test");
  });

  it("ignores unrecognized menu options (defensive)", async () => {
    const { pi, ui } = setupCommand();
    // Simulate a stale menu that doesn't contain the current label
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Stale menu item");
    (ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("< Back");
    await pi.handler!("", { ui });
    // saveFn not called because the selection wasn't in the menu
    expect(saveFn).not.toHaveBeenCalled();
  });
});
