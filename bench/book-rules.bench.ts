import { describe, expect, test } from "vitest";

import { decodeValue } from "../src/adapter/column-value.js";
import { openWindows, windowsFor } from "../src/core/availability.js";
import { checkRules } from "../src/core/checks.js";
import { ruleSet } from "./scenarios.js";

// A Tuesday, open in every rule set below.
const slot = {
  end: Temporal.Instant.from("2026-12-01T10:30:00Z"),
  start: Temporal.Instant.from("2026-12-01T10:00:00Z"),
};

const ruleSets = [
  { count: 5, exceptions: 0 },
  { count: 10, exceptions: 15 },
  { count: 100, exceptions: 0 },
  { count: 10, exceptions: 1000 },
  { count: 100, exceptions: 1000 },
];

// What one `book` spends on a Resource's rules while it holds the lock, database time aside.
describe("rule work per book", () => {
  test.for(ruleSets)(
    "$count rules × $exceptions exceptions",
    async (params, { bench }) => {
      const rules = ruleSet(params);

      const stored = rules.map((r) =>
        (r.exceptions ?? []).map((e) => e.toString())
      );

      expect(checkRules(rules)).toStrictEqual([]);
      expect(windowsFor(openWindows(rules), slot, new Map())).not.toHaveLength(
        0
      );

      await bench.compare(
        bench("decode exceptions", () => {
          for (const dates of stored) {
            decodeValue("dates", dates);
          }
        }),
        bench("checkRules", () => {
          checkRules(rules);
        }),
        bench("windowsFor", () => {
          windowsFor(openWindows(rules), slot, new Map());
        })
      );
    }
  );
});
