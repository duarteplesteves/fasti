import { defineConfig } from "vitest/config";

const conformance = "src/**/conformance.test.ts";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["node_modules/", "dist/", "**/*.d.ts"],
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          exclude: [conformance],
          include: ["src/**/*.test.ts"],
          name: "unit",
        },
      },
      { extends: true, test: { include: [conformance], name: "conformance" } },
    ],
    testTimeout: process.env.CI === undefined ? 60_000 : 120_000,
  },
});
