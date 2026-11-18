import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";
import vitest from "ultracite/oxlint/vitest";

const jsPlugins = selectJsPlugins(["jsdoc-js", "tsdoc"]);

const noVitest = {
  group: ["vitest", "vitest/*"],
  message: "Only testing and test files import vitest (ADR 012).",
};

const noDrizzle = {
  group: ["drizzle-orm", "drizzle-orm/*"],
  message: "Only drizzle/pg imports drizzle-orm (ADR 012).",
};

const noPrisma = {
  group: ["@prisma/*", "@prisma/**"],
  message: "Only prisma imports Prisma (ADR 012).",
};

const noEffect = {
  group: ["effect", "effect/*"],
  message: "Only the Effect layer imports effect (ADR 012).",
};

const noAdaptersOrTesting = {
  group: [
    "**/memory/**",
    "**/drizzle/**",
    "**/prisma/**",
    "**/testing/**",
    "**/test-utils/**",
  ],
  message:
    "The Framework never imports an Adapter or the Conformance Suite (ADR 012).",
};

/** Builds a no-restricted-imports rule from pattern groups. */
function restrict(patterns: object[]) {
  return { "no-restricted-imports": ["error", { patterns }] };
}

export default defineConfig({
  env: core.env,
  extends: [antiSlop, core, vitest, jsPlugins],
  // The examples import the built package, which the lint job doesn't install; CI typechecks them in `integration`.
  ignorePatterns: [...core.ignorePatterns, "examples/**"],
  jsPlugins: jsPlugins.jsPlugins,
  options: { typeAware: true },
  overrides: [
    {
      // Types already document params/returns; one-line summaries are the house style.
      // TSDoc's `@throws` takes no `{Type}`, so the jsdoc rule demanding one conflicts with tsdoc/syntax.
      files: ["**/*.ts"],
      rules: {
        "jsdoc/require-param": "off",
        "jsdoc/require-returns": "off",
        "jsdoc/require-throws-type": "off",
      },
    },
    // ADR 012 import boundaries. The last matching override wins for each file.
    { files: ["src/**"], rules: restrict([noVitest, noDrizzle, noPrisma]) },
    {
      files: ["src/{schema,adapter,memory,drizzle,testing}/**"],
      rules: restrict([noVitest, noDrizzle, noPrisma, noEffect]),
    },
    {
      files: ["src/{framework,effect}/**", "src/index.ts"],
      rules: restrict([noVitest, noDrizzle, noPrisma, noAdaptersOrTesting]),
    },
    {
      files: ["src/drizzle/pg/**"],
      rules: restrict([noVitest, noPrisma, noEffect]),
    },
    {
      files: ["src/prisma/**"],
      rules: restrict([noVitest, noEffect, noDrizzle]),
    },
    {
      files: ["src/testing/**"],
      rules: restrict([noDrizzle, noPrisma, noEffect]),
    },
    {
      files: ["src/core/**"],
      rules: restrict([
        {
          group: ["*", "!./*"],
          message: "The Core imports only from itself (ADR 012).",
        },
      ]),
    },
    // The in-memory Adapter implements an async contract with synchronous work.
    { files: ["src/memory/**"], rules: { "require-await": "off" } },
    {
      files: ["**/*.test.ts", "src/test-utils/**"],
      rules: {
        "jsdoc-js/require-jsdoc": "off",
        "no-restricted-imports": "off",
        "typescript/no-unsafe-type-assertion": "off",
      },
    },
  ],
  rules: {
    "func-style": ["error", "declaration"],
  },
});
