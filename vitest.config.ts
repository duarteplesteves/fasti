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
  },
});
