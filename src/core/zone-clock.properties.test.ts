import { test } from "@fast-check/vitest";
import { array, integer } from "fast-check";
import { describe, expect } from "vitest";

import { arbAroundClockChange } from "../test-utils/arbitraries.js";
import { propConfig } from "../test-utils/prop-config.js";
import { referenceTime } from "../test-utils/reference-windows.js";
import { zoneClock } from "./zone-clock.js";

const arbMinutes = array(integer({ max: 80 * 60, min: 0 }), { minLength: 1 });

describe(`${zoneClock.name} (property)`, () => {
  test.prop([arbAroundClockChange(), arbMinutes], propConfig)(
    "agrees with Temporal, for times in any order",
    ({ from, timezone }, minutes) => {
      const clock = zoneClock(timezone);
      const first = from.toZonedDateTimeISO(timezone).toPlainDateTime();

      const locals = minutes.map((m) =>
        first.add({ minutes: m }).round("minute")
      );

      expect(
        locals.map((local) => {
          const localMs = local.toZonedDateTime("UTC").epochMilliseconds;
          const { offsetMs, startMs } = clock(localMs);
          const ms = localMs - offsetMs;

          return { exists: ms >= startMs, ms: Math.max(ms, startMs) };
        })
      ).toStrictEqual(
        locals.map((local) => {
          const reference = referenceTime(
            local.toPlainDate(),
            local.toPlainTime(),
            timezone
          );

          return {
            exists: reference.toPlainDateTime().equals(local),
            ms: reference.epochMilliseconds,
          };
        })
      );
    }
  );
});
