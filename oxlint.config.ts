import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import vitest from "ultracite/oxlint/vitest";

const jsPlugins = selectJsPlugins(["jsdoc-js", "tsdoc"]);

export default defineConfig({
  env: core.env,
  extends: [antiSlop, core, vitest, jsPlugins],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  options: { typeAware: true },
  overrides: [
    {
      // Types already document params/returns; one-line summaries are the house style.
      files: ["**/*.ts"],
      rules: { "jsdoc/require-param": "off", "jsdoc/require-returns": "off" },
    },
    {
      files: ["**/*.test.ts", "src/test-utils/**"],
      rules: {
        "jsdoc-js/require-jsdoc": "off",
        "typescript/no-unsafe-type-assertion": "off",
      },
    },
  ],
  rules: {
    "func-style": ["error", "declaration"],
  },
});
