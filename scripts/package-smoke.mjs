import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const rawReport = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});
let packReport;
try {
  packReport = JSON.parse(rawReport);
} catch (error) {
  throw new Error("npm pack returned invalid JSON", { cause: error });
}
const files = packReport[0]?.files ?? [];
const paths = files.map((file) => file.path);

assert(paths.includes("dist/index.js"), "tarball must include dist/index.js");
assert(paths.includes("dist/index.d.ts"), "tarball must include dist/index.d.ts");
assert(paths.includes("dist/api.js"), "tarball must include dist/api.js");
assert(paths.includes("dist/api.d.ts"), "tarball must include dist/api.d.ts");
assert(!paths.some((path) => path.startsWith("src/")), "tarball must not publish src/");

const root = await import("@trevonistrevon/pi-loop");
const api = await import("@trevonistrevon/pi-loop/api");
assert.equal(typeof root.default, "function", "root export must be the Pi extension");
assert.equal(typeof api.TaskStore, "function", "api export must expose TaskStore");

console.log(`package smoke passed (${paths.length} files)`);
