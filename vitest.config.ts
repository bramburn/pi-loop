import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    // CI runners are slower than local; 15s gives real-child-process
    // tests (monitor stop, lifecycle) enough headroom.
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "json"],
      include: ["src/**/*.ts"],
      // Type-only modules and test helpers carry no executable logic worth gating.
      exclude: ["src/**/*-types.ts", "src/types.ts"],
      // Floors set just below current actuals to catch regressions. The
      // commands/ files (loop-command, tasks-command, monitors-command) are
      // covered by command-level tests but exercise different code paths than
      // the tool tests, so the floor is naturally a touch lower than pure-tool
      // code. Raise as coverage is grown.
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 93,
        lines: 82,
      },
    },
  },
});
