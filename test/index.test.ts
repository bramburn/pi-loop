import { describe, expect, it } from "vitest";
import extension from "../src/index.js";
import { createMockPi } from "./helpers/mock-pi.js";

describe("extension entry (no-op mode)", () => {
  it("loads without throwing", () => {
    const { pi } = createMockPi();
    expect(() => extension(pi as any)).not.toThrow();
  });

  it("does not register any tools", () => {
    const { pi, toolMap } = createMockPi();
    extension(pi as any);
    expect(toolMap.size).toBe(0);
  });

  it("does not register any slash commands", () => {
    const { pi, commandMap } = createMockPi();
    extension(pi as any);
    expect(commandMap.size).toBe(0);
  });

  it("does not subscribe to any pi events", () => {
    const { pi, eventHandlers } = createMockPi();
    extension(pi as any);
    expect(eventHandlers.size).toBe(0);
  });

  it("does not register any extension lifecycle hooks", () => {
    const { pi, extensionHandlers } = createMockPi();
    extension(pi as any);
    expect(extensionHandlers.size).toBe(0);
  });
});
