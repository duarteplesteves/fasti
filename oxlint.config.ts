import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest, antiSlop],
  // PROTOTYPE branch only: throwaway files skip lint.
  ignorePatterns: ["**/*.prototype*.ts"],
  rules: {
    "func-style": ["error", "declaration"],
  },
});
