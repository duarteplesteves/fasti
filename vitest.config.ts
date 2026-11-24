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
      {
        extends: true,
        // Time the built package, loaded by the runtime itself: through Vitest's module runner every call into another module pays for an export getter.
        resolve: {
          alias: [
            {
              find: /^\.\.\/src\/(?!test-utils\/)/u,
              replacement: `${import.meta.dirname}/dist/`,
            },
          ],
        },
        test: {
          benchmark: { include: ["bench/**/*.bench.ts"] },
          include: [],
          name: "bench",
          server: { deps: { external: [/\/dist\//u] } },
        },
      },
    ],
    testTimeout: process.env.CI === undefined ? 60_000 : 120_000,
  },
});
