/**
 * /loop-subagent slash command (v2.5+).
 *
 * Creates a sub-agent loop. Mirrors the `/loop` `<interval> <prompt>` form
 * plus new flags for the optional self-description fields. Internally
 * delegates to `LoopCreate` with `isolation: "sub-agent"` set.
 *
 * Usage:
 *   /loop-subagent <interval> <prompt>
 *                   [--goal <text>]
 *                   [--success-criteria <text>]
 *                   [--failure-criteria <text>]
 *                   [--state-file <path>]
 *                   [--model <name>]
 *                   [--max-tokens <n>]
 *                   [--max-iterations <n>]
 *                   [--iteration-timeout <ms>]
 *
 * With no args, opens a TUI form (delegated to /loop's behaviour).
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { formatTrigger } from "../loop-format.js";
import { parseInterval } from "../loop-parse.js";
import type { LoopEntry, LoopSubAgentConfig } from "../types.js";

interface LoopStoreLike {
  list(): LoopEntry[];
  get(id: string): LoopEntry | undefined;
  create(trigger: LoopEntry["trigger"], prompt: string, opts: {
    recurring: boolean;
    priority?: LoopEntry["priority"];
    isolation?: "sub-agent";
    goal?: string;
    successCriteria?: string;
    failureCriteria?: string;
    stateFile?: string;
    subAgent?: LoopSubAgentConfig;
  }): LoopEntry;
}

interface TriggerSystemLike {
  add(entry: LoopEntry): void;
}

export interface LoopSubAgentCommandOptions {
  pi: ExtensionAPI;
  getStore: () => LoopStoreLike;
  getTriggerSystem: () => TriggerSystemLike;
}

interface ParsedArgs {
  interval: string;
  prompt: string;
  goal?: string;
  successCriteria?: string;
  failureCriteria?: string;
  stateFile?: string;
  model?: string;
  maxTokens?: number;
  maxIterations?: number;
  iterationTimeoutMs?: number;
}

function parseArgs(rest: string): ParsedArgs | { error: string } {
  const tokens = rest.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  if (tokens.length < 2) {
    return { error: "Usage: /loop-subagent <interval> <prompt> [--goal ...] [--model ...] [--max-tokens N] ..." };
  }
  const out: ParsedArgs = { interval: tokens[0] ?? "", prompt: tokens[1] ?? "" };
  for (let i = 2; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    const next = tokens[i + 1];
    const take = (): string | undefined => {
      if (next !== undefined && !next.startsWith("--")) {
        i++;
        return next;
      }
      return undefined;
    };
    switch (tok) {
      case "--goal": { const v = take(); if (v) out.goal = v; break; }
      case "--success-criteria": { const v = take(); if (v) out.successCriteria = v; break; }
      case "--failure-criteria": { const v = take(); if (v) out.failureCriteria = v; break; }
      case "--state-file": { const v = take(); if (v) out.stateFile = v; break; }
      case "--model": { const v = take(); if (v) out.model = v; break; }
      case "--max-tokens": { const v = take(); if (v) { const n = Number.parseInt(v, 10); if (Number.isFinite(n) && n > 0) out.maxTokens = n; } break; }
      case "--max-iterations": { const v = take(); if (v) { const n = Number.parseInt(v, 10); if (Number.isFinite(n) && n > 0) out.maxIterations = n; } break; }
      case "--iteration-timeout": { const v = take(); if (v) { const n = Number.parseInt(v, 10); if (Number.isFinite(n) && n > 0) out.iterationTimeoutMs = n; } break; }
      default: break;
    }
  }
  return out;
}

export function registerLoopSubAgentCommand(options: LoopSubAgentCommandOptions): void {
  const { pi, getStore, getTriggerSystem } = options;

  pi.registerCommand("loop-subagent", {
    description: "Create a sub-agent loop. Each fire spawns a child pi session with its own context window; only a one-line summary enters the parent.",
    handler: async (args: string, _ctx?: ExtensionCommandContext) => {
      const ui = (pi as unknown as { getUI?: () => ExtensionUIContext }).getUI?.();
      const parsed = parseArgs(args);
      if ("error" in parsed) {
        if (ui) ui.notify(parsed.error, "warning");
        return;
      }
      const cronParsed = parseInterval(parsed.interval);
      const trigger: LoopEntry["trigger"] = { type: "cron", schedule: cronParsed.cron };

      const subAgent: LoopSubAgentConfig = {};
      if (parsed.model) subAgent.model = parsed.model;
      if (parsed.maxTokens !== undefined) subAgent.maxTokens = parsed.maxTokens;
      if (parsed.maxIterations !== undefined) subAgent.maxIterations = parsed.maxIterations;
      if (parsed.iterationTimeoutMs !== undefined) subAgent.iterationTimeoutMs = parsed.iterationTimeoutMs;

      const entry = getStore().create(trigger, parsed.prompt, {
        recurring: true,
        priority: "normal",
        isolation: "sub-agent",
        ...(parsed.goal !== undefined ? { goal: parsed.goal } : {}),
        ...(parsed.successCriteria !== undefined ? { successCriteria: parsed.successCriteria } : {}),
        ...(parsed.failureCriteria !== undefined ? { failureCriteria: parsed.failureCriteria } : {}),
        ...(parsed.stateFile !== undefined ? { stateFile: parsed.stateFile } : {}),
        ...(Object.keys(subAgent).length > 0 ? { subAgent } : {}),
      });
      getTriggerSystem().add(entry);

      const summary = `Loop #${entry.id} (sub-agent) created · ${formatTrigger(trigger, "command")}`;
      if (ui) ui.notify(summary, "info");
    },
  });
}
