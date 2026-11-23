import { strict } from "@effect/tsgo/oxlint-presets";
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
  message:
    "Only the Drizzle Adapters in src/drizzle import drizzle-orm (ADR 012).",
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
  extends: [antiSlop, core, vitest, jsPlugins, strict],
  // The examples import the built package, which the lint job doesn't install; CI typechecks them in `integration`.
  ignorePatterns: [...core.ignorePatterns, "examples/**"],
  jsPlugins: jsPlugins.jsPlugins,
  options: { reportUnusedDisableDirectives: "error", typeAware: true },
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
      files: ["src/{schema,adapter,memory,testing}/**"],
      rules: restrict([noVitest, noDrizzle, noPrisma, noEffect]),
    },
    {
      files: ["src/{framework,effect}/**", "src/index.ts"],
      rules: restrict([noVitest, noDrizzle, noPrisma, noAdaptersOrTesting]),
    },
    {
      files: ["src/drizzle/**"],
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
    // A test awaits in a loop to run steps in order: each repetition its own race, a migration before the constraint
    // that needs it, a case that sees the writes before it. Independent work is written with Promise.all.
    {
      files: ["**/*.test.ts", "src/testing/cases/**"],
      rules: { "no-await-in-loop": "off" },
    },
    // The rule can't see that `test.prop(arbitraries)(name, fn)` is a test, so it flags every `expect` inside one.
    {
      files: [
        "**/*.properties.test.ts",
        "src/framework/race-safety.test.ts",
        "src/framework/reschedule.test.ts",
      ],
      // Named again, or the vitest preset's own override, applied after this one, turns the rule back on.
      plugins: ["vitest"],
      rules: { "vitest/no-standalone-expect": "off" },
    },
  ],
  rules: {
    "func-style": ["error", "declaration"],
    // Misreads data-first `Effect.forEach(xs, f)` as `Array#forEach(fn, thisArg)`.
    "unicorn/no-array-method-this-argument": "off",
    "effecttsgo/global-console-in-effect": "error",
    "effecttsgo/global-date-in-effect": "error",
  },
});
