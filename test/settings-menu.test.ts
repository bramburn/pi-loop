import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TASKS_CONFIG, type TasksConfig } from "../src/tasks-config.js";
import { openSettingsMenu } from "../src/ui/settings-menu.js";

function makeMockUI() {
  return {
    select: vi.fn<[string, string[]]>(),
    input: vi.fn(),
    notify: vi.fn(),
  };
}

function makeMockConfig() {
  return { ...DEFAULT_TASKS_CONFIG };
}

function makeOpts(ui: ReturnType<typeof makeMockUI>, mockConfig: TasksConfig) {
  return {
    cwd: "/fake/cwd",
    ui,
    onSave: vi.fn(),
    loadConfig: vi.fn(() => ({ ...mockConfig })),
    saveConfig: vi.fn((_cwd: string, config: TasksConfig) => Object.assign(mockConfig, config)),
  };
}

describe("settings-menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exits immediately on Back", async () => {
    const ui = makeMockUI();
    ui.select.mockResolvedValueOnce("< Back");
    await openSettingsMenu(makeOpts(ui, makeMockConfig()));
    expect(ui.select).toHaveBeenCalledTimes(1);
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("cycles taskScope: session → project → memory", async () => {
    const ui = makeMockUI();
    ui.select
      .mockResolvedValueOnce("Task storage: session (isolated per terminal)")
      .mockResolvedValueOnce("< Back");

    await openSettingsMenu(makeOpts(ui, makeMockConfig()));
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("project"), "info");
  });

  it("cycles sortOrder: id → status → recent → oldest", async () => {
    const ui = makeMockUI();
    ui.select
      .mockResolvedValueOnce("Widget sort order: id (creation order)")
      .mockResolvedValueOnce("< Back");

    await openSettingsMenu(makeOpts(ui, makeMockConfig()));
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("status"), "info");
  });

  it("cycles autoClearCompleted: on_list_complete → on_task_complete → never", async () => {
    const ui = makeMockUI();
    ui.select
      .mockResolvedValueOnce("Auto-clear completed: on_list_complete (after all tasks done)")
      .mockResolvedValueOnce("< Back");

    await openSettingsMenu(makeOpts(ui, makeMockConfig()));
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("on_task_complete"), "info");
  });

  it("cycles maxVisible: 10 → 20", async () => {
    const ui = makeMockUI();
    ui.select
      .mockResolvedValueOnce("Max visible tasks: 10")
      .mockResolvedValueOnce("< Back");

    await openSettingsMenu(makeOpts(ui, makeMockConfig()));
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("20"), "info");
  });

  it("toggles showAll: false → true", async () => {
    const ui = makeMockUI();
    ui.select
      .mockResolvedValueOnce("Show all tasks: false")
      .mockResolvedValueOnce("< Back");

    await openSettingsMenu(makeOpts(ui, makeMockConfig()));
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("true"), "info");
  });

  it("calls onSave after each setting change", async () => {
    const ui = makeMockUI();
    const onSave = vi.fn();
    ui.select
      .mockResolvedValueOnce("Widget sort order: id (creation order)")
      .mockResolvedValueOnce("< Back");

    await openSettingsMenu({ ...makeOpts(ui, makeMockConfig()), onSave });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: "status" }));
  });

  it("allows changing multiple settings before exiting", async () => {
    const ui = makeMockUI();
    const onSave = vi.fn();
    ui.select
      .mockResolvedValueOnce("Widget sort order: id (creation order)")
      .mockResolvedValueOnce("Auto-clear completed: on_list_complete (after all tasks done)")
      .mockResolvedValueOnce("< Back");

    await openSettingsMenu({ ...makeOpts(ui, makeMockConfig()), onSave });
    expect(onSave).toHaveBeenCalledTimes(2);
  });
});
