import type { AvailabilityRule, ExpandedWindow } from "../core/types.js";

/**
 * `time` on `date` in `timeZone`; a time the clocks jump over is the moment they do (ADR 005).
 *
 * @returns The zoned time, at its first occurrence when it repeats.
 */
export function referenceTime(
  date: Temporal.PlainDate,
  time: Temporal.PlainTime,
  timeZone: string
): Temporal.ZonedDateTime {
  const local = date.toPlainDateTime(time);

  const zoned = local.toZonedDateTime(timeZone, {
    disambiguation: "earlier",
  });

  // In a gap, `earlier` lands before the jump, which is then the next transition.
  return zoned.toPlainDateTime().equals(local)
    ? zoned
    : (zoned.getTimeZoneTransition("next") ?? zoned);
}

function mondayOf(date: Temporal.PlainDate): Temporal.PlainDate {
  return date.subtract({ days: date.dayOfWeek - 1 });
}

function occursOn(rule: AvailabilityRule, date: Temporal.PlainDate): boolean {
  const { effectiveFrom, effectiveTo, exceptions = [], recurrence } = rule;

  const weeks = effectiveFrom
    ? mondayOf(effectiveFrom).until(mondayOf(date)).days / 7
    : 0;

  return (
    (!effectiveFrom || Temporal.PlainDate.compare(effectiveFrom, date) <= 0) &&
    (!effectiveTo || Temporal.PlainDate.compare(date, effectiveTo) <= 0) &&
    weeks % recurrence.interval === 0 &&
    recurrence.daysOfWeek.includes(date.dayOfWeek) &&
    !exceptions.some((e) => e.equals(date))
  );
}

/**
 * The windows `rules` open on `[from, to]`, worked out on Temporal alone, sharing no code with the Core: what its windows are tested against.
 *
 * @returns The windows, in rule order.
 */
export function referenceWindows(
  rules: readonly AvailabilityRule[],
  from: Temporal.PlainDate,
  to: Temporal.PlainDate
): ExpandedWindow[] {
  const dates = Array.from({ length: from.until(to).days + 1 }, (_, days) =>
    from.add({ days })
  );

  return rules.flatMap((rule) =>
    dates.flatMap((date) => {
      const { resourceId, timeWindow, timezone } = rule;
      const start = referenceTime(date, timeWindow.start, timezone);
      const end = referenceTime(date, timeWindow.end, timezone);

      return occursOn(rule, date) &&
        Temporal.ZonedDateTime.compare(start, end) < 0
        ? [{ end, resourceId, start }]
        : [];
    })
  );
}
