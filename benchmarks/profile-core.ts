import { mkdirSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import { resolve } from "node:path";
import { coreWorkloads } from "./workloads.js";

const parsedIterations = Number.parseInt(process.env.PROFILE_ITERATIONS ?? "10000", 10);
if (!Number.isSafeInteger(parsedIterations) || parsedIterations < 1) {
  throw new Error("PROFILE_ITERATIONS must be a positive safe integer");
}

const artifactDir = resolve(".artifacts/profiles");
mkdirSync(artifactDir, { recursive: true });

const startedAt = new Date().toISOString();
const results: Record<string, { checksum: number; durationMs: number }> = {};
let aggregateChecksum = 0;

for (const [name, workload] of Object.entries(coreWorkloads)) {
  for (let index = 0; index < 5; index++) workload();
  const start = performance.now();
  let checksum = 0;
  for (let index = 0; index < parsedIterations; index++) checksum += workload();
  const durationMs = performance.now() - start;
  results[name] = { checksum, durationMs };
  aggregateChecksum += checksum;
}

const metadata = {
  schemaVersion: 1,
  startedAt,
  node: process.version,
  arch: arch(),
  platform: process.platform,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  iterations: parsedIterations,
  aggregateChecksum,
  workloads: results,
};

writeFileSync(
  resolve(artifactDir, "core.meta.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(metadata)}\n`);
