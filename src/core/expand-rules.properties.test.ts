import { test } from "@fast-check/vitest";
/* eslint-disable vitest/no-standalone-expect */
import { describe, expect } from "vitest";

import {
  arbAvailabilityRule,
  arbResourceId,
} from "../test-utils/arbitraries.js";
import { propConfig } from "../test-utils/prop-config.js";
import { expandRules } from "./expand-rules.js";

describe(`${expandRules.name} (property)`, () => {
  test.prop([arbAvailabilityRule(), arbResourceId()], propConfig)(
    "emits windows with start < end for every output",
    (rule, resourceId) => {
      const finalRule = { ...rule, resourceId };

      const result = expandRules({
        from: Temporal.PlainDate.from("2025-11-01"),
        rules: [finalRule],
        to: Temporal.PlainDate.from("2026-02-28"),
      });

      for (const w of result) {
        expect(Temporal.ZonedDateTime.compare(w.start, w.end)).toBeLessThan(0);
      }
    }
  );

  test.prop([arbAvailabilityRule(), arbResourceId()], propConfig)(
    "every window falls on a day of week declared in the rule",
    (rule, resourceId) => {
      const finalRule = { ...rule, resourceId };

      const result = expandRules({
        from: Temporal.PlainDate.from("2025-11-01"),
        rules: [finalRule],
        to: Temporal.PlainDate.from("2026-02-28"),
      });

      for (const w of result) {
        const date = w.start.toPlainDate();
        expect(finalRule.recurrence.daysOfWeek).toContain(date.dayOfWeek);
      }
    }
  );

  test.prop([arbAvailabilityRule(), arbResourceId()], propConfig)(
    "no windows are emitted on exception dates",
    (rule, resourceId) => {
      const finalRule = { ...rule, resourceId };

      const result = expandRules({
        from: Temporal.PlainDate.from("2025-11-01"),
        rules: [finalRule],
        to: Temporal.PlainDate.from("2026-02-28"),
      });

      const exceptionSet = new Set(
        (finalRule.exceptions ?? []).map((d) => d.toString())
      );

      for (const w of result) {
        expect(exceptionSet.has(w.start.toPlainDate().toString())).toBeFalsy();
      }
    }
  );
});
