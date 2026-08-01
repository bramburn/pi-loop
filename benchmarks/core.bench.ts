import { bench, describe } from "vitest";
import { coreWorkloads } from "./workloads.js";

const options = { time: 750, warmupTime: 250 };

describe("core workloads", () => {
  for (const [name, workload] of Object.entries(coreWorkloads)) {
    bench(name, () => {
      workload();
    }, options);
  }
});
