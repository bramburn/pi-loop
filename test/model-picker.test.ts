import { describe, expect, it, vi } from "vitest";
import { pickModelFromCatalog, searchableSelect } from "../src/model-picker.js";

describe("searchableSelect", () => {
  it("falls back to flat select when ui.custom is absent", async () => {
    let selectTitle = "";
    let selectOptions: string[] = [];
    const ctx = {
      ui: {
        select: vi.fn(async (title: string, options: string[]) => {
          selectTitle = title;
          selectOptions = options;
          return options[1];
        }),
      },
    };
    const picked = await searchableSelect(ctx, {
      title: "Pick",
      items: [
        { value: "a/1", label: "a/1" },
        { value: "b/2", label: "b/2" },
      ],
    });
    expect(selectTitle).toBe("Pick");
    expect(selectOptions).toEqual(["a/1", "b/2"]);
    expect(picked?.value).toBe("b/2");
  });

  it("resolves undefined on cancel", async () => {
    const picked = await searchableSelect(
      { ui: { select: vi.fn(async () => undefined) } },
      { title: "Pick", items: [{ value: "a/1", label: "a/1" }] },
    );
    expect(picked).toBeUndefined();
  });
});

describe("pickModelFromCatalog", () => {
  const catalog = {
    getModelsOfType: () => [
      { id: "deepseek-chat", provider: "deepseek", api: "openai-completions" },
      { id: "dall-e-3", provider: "openai", type: "image" },
      { id: "moonshot/kimi-k3", provider: "openrouter", api: "openai-completions" },
    ],
    hasConfiguredAuth: () => true,
  };

  it("lists chat models with auth and maps the choice back to provider/modelId", async () => {
    let selectTitle = "";
    const ctx = {
      ui: {
        select: vi.fn(async (title: string, options: string[]) => {
          selectTitle = title;
          expect(options).toEqual(["deepseek/deepseek-chat", "openrouter/moonshot/kimi-k3"]);
          return "openrouter/moonshot/kimi-k3";
        }),
      },
    };
    const choice = await pickModelFromCatalog(ctx, catalog, "Select sub-agent model (pi catalogue)");
    expect(choice).toEqual({ provider: "openrouter", modelId: "moonshot/kimi-k3" });
    expect(selectTitle).toContain("sub-agent model");
  });

  it("returns undefined on empty catalogue", async () => {
    const choice = await pickModelFromCatalog(
      { ui: { select: vi.fn(async () => "x") } },
      { getAvailable: () => [] },
      "Pick",
    );
    expect(choice).toBeUndefined();
  });

  it("returns undefined on cancel", async () => {
    const choice = await pickModelFromCatalog(
      { ui: { select: vi.fn(async () => undefined) } },
      { getAvailable: () => [{ id: "m", provider: "p" }] },
      "Pick",
    );
    expect(choice).toBeUndefined();
  });

  it("drops models without configured auth", async () => {
    let seenOptions: string[] = [];
    const gated = {
      ...catalog,
      hasConfiguredAuth: (m: { provider?: string }) => m.provider !== "deepseek",
    };
    await pickModelFromCatalog(
      {
        ui: {
          select: vi.fn(async (_t: string, options: string[]) => {
            seenOptions = options;
            return options[0];
          }),
        },
      },
      gated,
      "Pick",
    );
    expect(seenOptions).toEqual(["openrouter/moonshot/kimi-k3"]);
  });
});
