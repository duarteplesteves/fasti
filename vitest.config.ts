import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["node_modules/", "dist/", "**/*.d.ts"],
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    environment: "node",
    include: ["src/**/*.test.ts"],
    // CI runs 10k property cases per test (see prop-config); the composition one takes minutes on GitHub runners.
    testTimeout: process.env.CI ? 600_000 : 60_000,
  },
});
