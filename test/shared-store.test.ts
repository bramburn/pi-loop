import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoopStore } from "../src/store.js";

interface StoresContext {
  tmpDir: string;
  projectPath: string;
  sharedPath: string;
  project: LoopStore;
  sharedStore: LoopStore;
}

function setupStores(): StoresContext {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-loop-shared-test-"));
  const projectPath = join(tmpDir, "project.json");
  const sharedPath = join(tmpDir, "shared.json");
  return {
    tmpDir,
    projectPath,
    sharedPath,
    project: new LoopStore(projectPath),
    sharedStore: new LoopStore(sharedPath),
  };
}

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true });
    tmpDir = undefined;
  }
});

describe("LoopStore.promote (Step 3 of the promote-loop-to-shared plan)", () => {
  it("copies the entry to the shared store and verifies via a second LoopStore instance", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const entry = ctx.project.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "build check",
      { recurring: true },
    );
    const result = ctx.project.promote(entry.id, ctx.sharedPath);
    expect(result.ok).toBe(true);
    expect(result.sharedEntry?.id).toBe(entry.id);
    expect(result.sharedEntry?.scope).toBe("shared");

    const reloaded = new LoopStore(ctx.sharedPath);
    const read = reloaded.get(entry.id);
    expect(read).toBeDefined();
    expect(read?.id).toBe(entry.id);
    expect(read?.prompt).toBe("build check");
    expect(read?.trigger).toEqual({ type: "cron", schedule: "*/5 * * * *" });
    expect(read?.scope).toBe("shared");
  });

  it("is destructive: the source entry is removed from the project store (Q5)", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const entry = ctx.project.create(
      { type: "cron", schedule: "*/10 * * * *" },
      "lint check",
      { recurring: true },
    );
    expect(ctx.project.get(entry.id)).toBeDefined();
    const result = ctx.project.promote(entry.id, ctx.sharedPath);
    expect(result.ok).toBe(true);
    expect(ctx.project.get(entry.id)).toBeUndefined();
    const reloaded = new LoopStore(ctx.projectPath);
    expect(reloaded.get(entry.id)).toBeUndefined();
  });

  it("refuses if the source id does not exist in the project store", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const result = ctx.project.promote("999", ctx.sharedPath);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it("refuses on id collision in the shared store", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const entry = ctx.project.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "first",
      { recurring: true },
    );
    const result = ctx.project.promote(entry.id, ctx.sharedPath);
    expect(result.ok).toBe(true);

    const project2 = new LoopStore(ctx.projectPath);
    const newEntry = project2.create(
      { type: "cron", schedule: "*/15 * * * *" },
      "duplicate-id",
      { recurring: true },
    );
    const sharedStore = new LoopStore(ctx.sharedPath);
    sharedStore.insertEntryWithId({ ...newEntry, scope: "shared" });
    const collision = project2.promote(newEntry.id, ctx.sharedPath);
    expect(collision.ok).toBe(false);
    expect(collision.error).toMatch(/already exists in the shared store/i);
    expect(project2.get(newEntry.id)).toBeDefined();
  });

  it("preserves id continuity: the shared entry has the same id as the source", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const entry = ctx.project.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "build",
      { recurring: true },
    );
    const result = ctx.project.promote(entry.id, ctx.sharedPath);
    expect(result.sharedEntry?.id).toBe(entry.id);
  });
});

describe("LoopStore.adopt (Step 3 of the promote-loop-to-shared plan)", () => {
  it("copies the entry from the shared store into the project store", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const entry = ctx.project.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "shared work",
      { recurring: true },
    );
    ctx.project.promote(entry.id, ctx.sharedPath);

    const project2 = new LoopStore(ctx.projectPath);
    const sharedEntry = ctx.sharedStore.get(entry.id);
    expect(sharedEntry).toBeDefined();
    const adoptResult = project2.adopt(sharedEntry!);
    expect(adoptResult.ok).toBe(true);
    expect(adoptResult.entry?.id).toBe(entry.id);
    expect(adoptResult.entry?.scope).toBe("project");
    expect(project2.get(entry.id)).toBeDefined();
    expect(ctx.sharedStore.get(entry.id)).toBeDefined();
  });

  it("refuses on local id collision in the project store", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const entry = ctx.project.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "shared work",
      { recurring: true },
    );
    ctx.project.promote(entry.id, ctx.sharedPath);

    const project2 = new LoopStore(ctx.projectPath);
    const localEntry = project2.create(
      { type: "cron", schedule: "*/15 * * * *" },
      "local",
      { recurring: true },
    );
    // Insert a conflicting entry with the SAME id as the shared entry.
    // The shared entry was id "1"; force the project2 to also have id "1".
    const sharedEntry = ctx.sharedStore.get(entry.id)!;
    const conflictEntry = {
      ...sharedEntry,
      prompt: "local override",
      scope: "project" as const,
    };
    project2.insertEntryWithId(conflictEntry);
    expect(project2.get(entry.id)).toBeDefined();

    const collision = project2.adopt(sharedEntry);
    expect(collision.ok).toBe(false);
    expect(collision.error).toMatch(/already exists in this project/i);
    expect(project2.get(localEntry.id)).toBeDefined();
  });

  it("preserves id continuity: the adopted entry has the same id as the shared entry", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const entry = ctx.project.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "build",
      { recurring: true },
    );
    ctx.project.promote(entry.id, ctx.sharedPath);

    const project2 = new LoopStore(ctx.projectPath);
    const sharedEntry = ctx.sharedStore.get(entry.id)!;
    const adoptResult = project2.adopt(sharedEntry);
    expect(adoptResult.entry?.id).toBe(entry.id);
  });
});

describe("ReducerBackedStore.insertEntryWithId (Step 3 helper)", () => {
  it("inserts an entry with a caller-supplied id and bumps nextId", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const entry = ctx.project.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "first",
      { recurring: true },
    );
    ctx.project.promote(entry.id, ctx.sharedPath);
    const synthetic = {
      id: "42",
      prompt: "synthetic",
      trigger: { type: "cron" as const, schedule: "*/30 * * * *" },
      status: "active" as const,
      recurring: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 1000,
      scope: "shared" as const,
    };
    const inserted = ctx.sharedStore.insertEntryWithId(synthetic);
    expect(inserted).toBe(true);
    expect(ctx.sharedStore.get("42")).toBeDefined();
    expect(ctx.sharedStore.get("42")?.prompt).toBe("synthetic");
  });

  it("returns false on id collision", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const entry = ctx.project.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "first",
      { recurring: true },
    );
    ctx.project.promote(entry.id, ctx.sharedPath);
    const sharedEntry = ctx.sharedStore.get(entry.id)!;
    const inserted = ctx.sharedStore.insertEntryWithId(sharedEntry);
    expect(inserted).toBe(false);
  });
});

describe("LoopScope / scope field integration (Step 1 + 3)", () => {
  it("scope field defaults to undefined on existing entries (back-compat)", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const entry = ctx.project.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "legacy",
      { recurring: true },
    );
    expect(entry.scope).toBeUndefined();
  });

  it("scope is set to 'shared' after promote", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const entry = ctx.project.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "build",
      { recurring: true },
    );
    const result = ctx.project.promote(entry.id, ctx.sharedPath);
    expect(result.sharedEntry?.scope).toBe("shared");
  });

  it("scope is set to 'project' after adopt", () => {
    const ctx = setupStores();
    tmpDir = ctx.tmpDir;
    const entry = ctx.project.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "build",
      { recurring: true },
    );
    ctx.project.promote(entry.id, ctx.sharedPath);
    const project2 = new LoopStore(ctx.projectPath);
    const sharedEntry = ctx.sharedStore.get(entry.id)!;
    const adoptResult = project2.adopt(sharedEntry);
    expect(adoptResult.entry?.scope).toBe("project");
  });
});
