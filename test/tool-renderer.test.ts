import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  hideToolTranscript,
  renderToolCall,
  renderToolResult,
  toolArg,
} from "../src/ui/tool-renderer.js";
import type { ToolDisplayDetails } from "../src/tools/tool-result.js";

const theme: Theme = {
  fg: (_name: string, text: string) => `<${_name}>${text}</${_name}>`,
  bold: (s: string) => `**${s}**`,
} as never;

describe("renderToolCall", () => {
  it("returns a function that renders the label and the args summary", () => {
    const render = renderToolCall("Loop", (args) => `id=${args.id as string}`);
    const out = render({ id: "42" }, theme);
    expect(out).toBeDefined();
  });

  it("uses theme.bold for the label and theme.fg('muted', ...) for the summary", () => {
    const render = renderToolCall("Loop", () => "summary text");
    const out = render({}, theme);
    // Should contain both the bolded label and the muted summary
    expect(typeof out).toBe("object");
    // The Text component contains the rendered content
    expect(JSON.stringify(out)).toContain("**Loop ");
    expect(JSON.stringify(out)).toContain("summary text");
  });
});

describe("renderToolResult", () => {
  it("renders a result with no details as plain text", () => {
    const result = {
      content: [{ type: "text" as const, text: "hello world" }],
    };
    const out = renderToolResult(result, {}, theme);
    expect(JSON.stringify(out)).toContain("hello world");
  });

  it("renders a success result with the success icon", () => {
    const result = {
      content: [{ type: "text" as const, text: "ok" }],
      details: { kind: "loop", action: "create", tone: "success", summary: "created" } satisfies ToolDisplayDetails,
    };
    const out = renderToolResult(result, {}, theme);
    expect(JSON.stringify(out)).toContain("created");
  });

  it("renders an error result with the error icon", () => {
    const result = {
      content: [{ type: "text" as const, text: "fail" }],
      details: { kind: "loop", action: "create", tone: "error", summary: "boom" } satisfies ToolDisplayDetails,
    };
    const out = renderToolResult(result, {}, theme);
    expect(JSON.stringify(out)).toContain("boom");
  });

  it("renders a warning result with the warning icon", () => {
    const result = {
      content: [{ type: "text" as const, text: "ok" }],
      details: { kind: "loop", action: "pause", tone: "warning", summary: "paused" } satisfies ToolDisplayDetails,
    };
    const out = renderToolResult(result, {}, theme);
    expect(JSON.stringify(out)).toContain("paused");
  });

  it("renders expanded details when expanded option is true", () => {
    const result = {
      content: [{ type: "text" as const, text: "ok" }],
      details: {
        kind: "loop",
        action: "create",
        tone: "success",
        summary: "created",
        expanded: ["detail line 1", "detail line 2"],
      } satisfies ToolDisplayDetails,
    };
    const out = renderToolResult(result, { expanded: true }, theme);
    const json = JSON.stringify(out);
    expect(json).toContain("created");
    expect(json).toContain("detail line 1");
    expect(json).toContain("detail line 2");
  });

  it("omits expanded details when expanded option is false", () => {
    const result = {
      content: [{ type: "text" as const, text: "ok" }],
      details: {
        kind: "loop",
        action: "create",
        tone: "success",
        summary: "created",
        expanded: ["detail line"],
      } satisfies ToolDisplayDetails,
    };
    const out = renderToolResult(result, { expanded: false }, theme);
    const json = JSON.stringify(out);
    expect(json).toContain("created");
    expect(json).not.toContain("detail line");
  });

  it("renders a 'Working...' indicator when isPartial is true", () => {
    const result = {
      content: [{ type: "text" as const, text: "partial" }],
      details: { kind: "loop", action: "create", tone: "info", summary: "in progress" } satisfies ToolDisplayDetails,
    };
    const out = renderToolResult(result, { expanded: false, isPartial: true }, theme);
    expect(JSON.stringify(out)).toContain("Working");
  });

  it("falls back to content.text when details are missing", () => {
    const result = {
      content: [{ type: "text" as const, text: "fallback text" }],
    };
    const out = renderToolResult(result, {}, theme);
    expect(JSON.stringify(out)).toContain("fallback text");
  });

  it("renders 'No result' when content is empty", () => {
    const result = { content: [] };
    const out = renderToolResult(result, {}, theme);
    expect(JSON.stringify(out)).toContain("No result");
  });
});

describe("hideToolTranscript", () => {
  it("returns a Container-like object", () => {
    const out = hideToolTranscript();
    expect(out).toBeDefined();
  });
});

describe("toolArg", () => {
  it("returns the named field from the args object", () => {
    const args = { id: "42", prompt: "hello" };
    expect(toolArg(args, "id")).toBe("42");
    expect(toolArg(args, "prompt")).toBe("hello");
  });

  it("returns undefined for missing fields", () => {
    expect(toolArg({ id: "42" }, "prompt")).toBeUndefined();
    expect(toolArg({}, "anything")).toBeUndefined();
  });
});
