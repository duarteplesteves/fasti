import { test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { arbAvailabilityRule } from "../test-utils/arbitraries.js";
import { propConfig } from "../test-utils/prop-config.js";
import { checkRule } from "./checks.js";

describe("checkRule properties", () => {
  test.prop([arbAvailabilityRule()], propConfig)(
    "reports no issues for any generated valid rule",
    (rule) => {
      expect(checkRule(rule)).toStrictEqual([]);
    }
  );
});
