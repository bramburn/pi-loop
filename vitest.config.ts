import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "json"],
      include: ["src/**/*.ts"],
      // Type-only modules and test helpers carry no executable logic worth gating.
      exclude: ["src/**/*-types.ts", "src/types.ts"],
      // Floors set just below current actuals (stmts 84%, branches 75%,
      // funcs 95%, lines 86%) to catch regressions. Raised in Phase 4 after the
      // runtime/ + tools/ suites landed.
      thresholds: {
        statements: 82,
        branches: 73,
        functions: 94,
        lines: 84,
      },
    },
  },
});
