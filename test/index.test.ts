import { describe, expect, it } from "vitest";
import extension from "../src/index.js";
import { createMockPi } from "./helpers/mock-pi.js";

const LOOP_TOOLS = ["LoopCreate", "LoopUpdate", "LoopList", "LoopPause", "LoopResume", "LoopDelete"];
const LOOP_COMMANDS = ["loop", "loop-fire", "loop-resume", "loop-settings"];
const DISABLED_TOOLS = [
  "MonitorCreate",
  "MonitorList",
  "MonitorStop",
  "MonitorDelete",
  "TaskCreate",
  "TaskList",
  "TaskGet",
  "TaskClaim",
  "TaskHeartbeat",
  "TaskUpdate",
  "TaskDelete",
  "TaskPrune",
];
const DISABLED_COMMANDS = ["monitors", "tasks"];

describe("extension entry (loop family)", () => {
  it("loads without throwing", () => {
    const { pi } = createMockPi();
    expect(() => extension(pi as any)).not.toThrow();
  });

  it("registers exactly the four loop tools", () => {
    const { pi, toolMap } = createMockPi();
    extension(pi as any);
    const registered = Array.from(toolMap.keys()).sort();
    expect(registered).toEqual([...LOOP_TOOLS].sort());
  });

  it("registers /loop and /loop-resume commands", () => {
    const { pi, commandMap } = createMockPi();
    extension(pi as any);
    const registered = Array.from(commandMap.keys()).sort();
    expect(registered).toEqual([...LOOP_COMMANDS].sort());
  });

  it("does not register any MonitorXxx or TaskXxx tools", () => {
    const { pi, toolMap } = createMockPi();
    extension(pi as any);
    for (const name of DISABLED_TOOLS) {
      expect(toolMap.has(name)).toBe(false);
    }
  });

  it("does not register /monitors or /tasks commands", () => {
    const { pi, commandMap } = createMockPi();
    extension(pi as any);
    for (const name of DISABLED_COMMANDS) {
      expect(commandMap.has(name)).toBe(false);
    }
  });

  it("subscribes to the loop:fire event (notification pipeline)", () => {
    const { pi, eventHandlers } = createMockPi();
    extension(pi as any);
    expect(eventHandlers.has("loop:fire")).toBe(true);
  });

  it("registers session lifecycle hooks (session_start, turn_start, agent_end, session_shutdown)", () => {
    const { pi, extensionHandlers } = createMockPi();
    extension(pi as any);
    for (const hook of ["session_start", "turn_start", "agent_end", "session_shutdown"]) {
      expect(extensionHandlers.has(hook)).toBe(true);
    }
  });
});
