#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const model = process.env.PI_LOOP_LIVE_MODEL;
if (!model) {
  console.log("SKIP: set PI_LOOP_LIVE_MODEL=<provider/model[:thinking]> to run the live backlog harness");
  process.exit(0);
}

const timeoutMs = Number.parseInt(process.env.PI_LOOP_LIVE_TIMEOUT_MS ?? "180000", 10);
const artifactDir = resolve(process.env.PI_LOOP_LIVE_ARTIFACT_DIR ?? join(projectDir, ".artifacts", "live-backlog"));
const fixtureDir = mkdtempSync(join(tmpdir(), "pi-loop-live-backlog-"));
const extensionPath = join(projectDir, "dist", "index.js");
const receiptPath = join(fixtureDir, "receipt.txt");
const traceEvents = [];
const toolCalls = [];
let stderr = "";
let eventCount = 0;
let stdoutBytes = 0;
let agentRuns = 0;
let workerEnded = false;
let finished = false;
let failure;
let resolveCompletion;
let rejectCompletion;

const { TaskStore } = await import(pathToFileURL(join(projectDir, "dist", "task-store.js")).href);
const { TASK_BACKLOG_ACTION_CONTRACT } = await import(pathToFileURL(join(projectDir, "dist", "runtime", "task-backlog-runtime.js")).href);
const taskPath = join(fixtureDir, ".pi", "tasks", "tasks.json");
new TaskStore(taskPath).create(
  "Create deterministic receipt",
  "Create receipt.txt in the current working directory containing exactly frozen-plan-receipt-v1. Validate the exact content with a shell command. Then complete this task with the retained claimId.",
);

const initialPrompt = [
  "[pi-loop] Loop #1 fired (event: tasks:created).",
  TASK_BACKLOG_ACTION_CONTRACT,
  "Backlog goal: Inspect the task state and report what will happen next.",
  "Backlog lifecycle: Loop #1 adopts unfinished tasks and re-wakes after this turn while work and its fire budget remain. Do not call LoopDelete; when no unfinished tasks remain, report that and end this iteration.",
].join("\n");

function send(child, command) {
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

function readState() {
  try {
    const tasks = JSON.parse(readFileSync(taskPath, "utf8")).tasks;
    return { loops: [], tasks };
  } catch (cause) {
    throw new Error("live backlog state is unavailable or invalid", { cause });
  }
}

function validate() {
  const { loops, tasks } = readState();
  const workerCalls = toolCalls.filter((call) => call.agentRun === 1);
  const workerNames = workerCalls.map((call) => call.name);
  const claims = workerCalls.filter((call) => call.name === "TaskClaim");
  const completions = workerCalls.filter((call) => call.name === "TaskUpdate" && call.args?.status === "completed");
  const forbidden = toolCalls.filter((call) => ["LoopUpdate", "LoopDelete"].includes(call.name));
  const taskGetIndex = workerCalls.findIndex((call) => call.name === "TaskGet");
  const claimIndex = workerCalls.findIndex((call) => call.name === "TaskClaim");
  const concreteIndex = workerCalls.findIndex((call) => ["write", "edit", "bash"].includes(call.name));
  const validationIndex = workerCalls.findIndex((call) => call.name === "bash");
  const completionIndex = workerCalls.findIndex((call) => call.name === "TaskUpdate" && call.args?.status === "completed");

  if (workerNames[0] !== "TaskList") throw new Error(`expected first worker tool TaskList; got ${workerNames[0] ?? "none"}`);
  if (!workerNames.includes("TaskGet")) throw new Error(`expected TaskGet in worker turn; got ${workerNames.join(",")}`);
  if (claims.length !== 1) throw new Error(`expected one worker TaskClaim; got ${claims.length}`);
  if (concreteIndex < 0) throw new Error(`worker described work without a write/edit/bash tool: ${workerNames.join(",")}`);
  if (!(taskGetIndex > 0 && claimIndex > taskGetIndex && concreteIndex > claimIndex)) {
    throw new Error(`expected TaskList → TaskGet → TaskClaim before concrete work; got ${workerNames.join(",")}`);
  }
  if (validationIndex < concreteIndex || validationIndex > completionIndex) throw new Error("expected bash validation after concrete work and before task completion");
  if (completions.length !== 1) throw new Error(`expected one completed TaskUpdate; got ${completions.length}`);
  if (!completions[0]?.args?.claimId) throw new Error("completed TaskUpdate omitted claimId");
  if (forbidden.length > 0) throw new Error(`worker called forbidden loop tools: ${forbidden.map((call) => call.name).join(",")}`);
  if (toolCalls.some((call) => call.agentRun > 1)) throw new Error("task required more than the first backlog execution turn");
  if (tasks.length !== 1 || tasks[0]?.status !== "completed") {
    throw new Error(`expected one completed task; got ${tasks.map((task) => `${task.id}:${task.status}`).join(",")}`);
  }
  if (loops.length !== 0) throw new Error(`expected drained backlog loop cleanup; found ${loops.length} loop(s)`);
  const receipt = readFileSync(receiptPath, "utf8").trim();
  if (receipt !== "frozen-plan-receipt-v1") throw new Error(`unexpected receipt content: ${JSON.stringify(receipt)}`);
  return { loops, tasks, receipt };
}

function sanitizeArgs(args) {
  return args?.claimId ? { ...args, claimId: "<redacted>" } : args;
}

function redactClaimIds(text) {
  return text.replace(/claimId:\s*[^\s]+/g, "claimId: <redacted>");
}

function summarizeEvent(event) {
  if (event.type === "message_update" || event.type === "extension_ui_request") return undefined;
  if (event.type === "tool_execution_start") {
    return { type: event.type, toolName: event.toolName, args: sanitizeArgs(event.args), agentRun: agentRuns };
  }
  if (event.type === "tool_execution_end") {
    const text = event.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
    return { type: event.type, toolName: event.toolName, isError: event.isError, result: redactClaimIds(text).slice(0, 1000) };
  }
  if (event.type === "agent_start") return { type: event.type, agentRun: agentRuns };
  if (event.type === "agent_end") return { type: event.type, agentRun: agentRuns, messageCount: event.messages?.length ?? 0 };
  if (["agent_settled", "turn_start", "turn_end"].includes(event.type)) return { type: event.type };
  if (event.type === "extension_error") return { type: event.type, extensionPath: event.extensionPath, event: event.event, error: event.error };
  if (event.type === "response") return { type: event.type, id: event.id, command: event.command, success: event.success, error: event.error };
  return undefined;
}

function writeArtifact(status, state) {
  mkdirSync(artifactDir, { recursive: true });
  const report = {
    status,
    model,
    timeoutMs,
    agentRuns,
    workerEnded,
    toolCalls: toolCalls.map((call) => ({ ...call, args: sanitizeArgs(call.args) })),
    state,
    failure: failure instanceof Error ? failure.message : failure,
    stderr: stderr.slice(-12_000),
    eventCount,
    stdoutBytes,
    events: traceEvents.slice(-500),
  };
  writeFileSync(join(artifactDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
}

const child = spawn("pi", [
  "--mode", "rpc",
  "--no-session",
  "--no-extensions",
  "--no-builtin-tools",
  "--extension", extensionPath,
  "--model", model,
  "--tools", "TaskList,TaskGet,TaskClaim,TaskHeartbeat,TaskUpdate,read,write,bash",
], {
  cwd: fixtureDir,
  env: { ...process.env, PI_LOOP_SCOPE: "project", PI_LOOP_DEBUG: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-24_000);
});

let buffer = "";
const decoder = new StringDecoder("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBytes += chunk.length;
  buffer += decoder.write(chunk);
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      failure = new Error(`non-JSON RPC output: ${line.slice(0, 200)}`);
      continue;
    }
    eventCount++;
    if (event.type === "agent_start") agentRuns++;
    const summary = summarizeEvent(event);
    if (summary && traceEvents.length < 2000) traceEvents.push(summary);
    if (event.type === "tool_execution_start") {
      const call = { name: event.toolName, args: event.args, toolCallId: event.toolCallId, agentRun: agentRuns };
      toolCalls.push(call);
      if (agentRuns === 1 && toolCalls.filter((item) => item.agentRun === 1).length === 1 && call.name !== "TaskList") {
        failure = new Error(`first worker tool was ${call.name}, not TaskList`);
      }
    }
    if (event.type === "tool_execution_end" && event.toolName === "TaskUpdate") {
      const text = event.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
      if (!event.isError && text.includes("completed")) finished = true;
    }
    if (event.type === "agent_end" && !workerEnded) {
      workerEnded = true;
      if (!finished && !failure) failure = new Error("first backlog execution turn ended without completing the task");
    }
    if (event.type === "agent_settled" && workerEnded) {
      try {
        if (failure) throw failure;
        resolveCompletion?.(validate());
      } catch (error) {
        failure = error;
        rejectCompletion?.(error);
      }
    }
  }
});

const outcome = new Promise((resolveOutcome, rejectOutcome) => {
  const timeout = setTimeout(() => rejectOutcome(new Error(`live backlog timed out after ${timeoutMs}ms`)), timeoutMs);
  resolveCompletion = (state) => {
    clearTimeout(timeout);
    resolveOutcome(state);
  };
  rejectCompletion = (error) => {
    clearTimeout(timeout);
    rejectOutcome(error);
  };
  child.once("exit", (code, signal) => {
    if (finished) return;
    rejectCompletion(new Error(`pi exited before backlog completion (code=${code}, signal=${signal})`));
  });
});

try {
  await new Promise((resolveWait) => setTimeout(resolveWait, 9000));
  send(child, { id: "backlog-live", type: "prompt", message: initialPrompt });
  const state = await outcome;
  writeArtifact("passed", state);
  console.log(`PASS: live backlog executed action-first with ${toolCalls.length} tool calls across ${agentRuns} agent runs`);
  console.log(`Artifact: ${join(artifactDir, "latest.json")}`);
} catch (error) {
  failure = error;
  let state;
  try {
    state = readState();
  } catch {}
  writeArtifact("failed", state);
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
  console.error(`Artifact: ${join(artifactDir, "latest.json")}`);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await new Promise((resolveClose) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveClose();
    }, 5000);
    child.once("close", () => {
      clearTimeout(timer);
      resolveClose();
    });
  });
  rmSync(fixtureDir, { recursive: true, force: true });
}
