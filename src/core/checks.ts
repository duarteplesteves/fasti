import { checkRecurrence } from "./recurrence.js";
import type { Issue } from "./result.js";
import type { AvailabilityRule, Booking } from "./types.js";

export type Path = readonly (string | number)[];

/** An `Issue` whose path is always set: every check knows where its problem is. */
export interface CheckIssue extends Issue {
  readonly path: Path;
}

/** IANA names only: fixed offsets like "+01:00" don't follow DST. */
export function checkTimeZone(timeZone: string, path: Path): CheckIssue[] {
  let canonical: string;

  try {
    canonical = new Temporal.ZonedDateTime(0n, timeZone).timeZoneId;
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }

    return [
      {
        message: `Unknown timezone "${timeZone}". Use an IANA name such as "Europe/Lisbon".`,
        path,
      },
    ];
  }

  return canonical.startsWith("+") || canonical.startsWith("-")
    ? [
        {
          message: `Timezone "${timeZone}" is a fixed offset, which doesn't follow daylight saving. Use an IANA name such as "Europe/Lisbon".`,
          path,
        },
      ]
    : [];
}

/** Every problem with `rule`, with paths relative to the rule. Empty when valid. */
export function checkRule(rule: AvailabilityRule): readonly CheckIssue[] {
  const issues: CheckIssue[] = [];
  const { timeWindow, effectiveFrom, effectiveTo } = rule;

  if (Temporal.PlainTime.compare(timeWindow.start, timeWindow.end) >= 0) {
    issues.push({
      message: `timeWindow.end (${timeWindow.end.toString()}) must be after timeWindow.start (${timeWindow.start.toString()}). Cross-day windows are not supported; split into two rules.`,
      path: ["timeWindow", "end"],
    });
  }

  if (
    effectiveFrom &&
    effectiveTo &&
    Temporal.PlainDate.compare(effectiveFrom, effectiveTo) > 0
  ) {
    issues.push({
      message: `effectiveTo (${effectiveTo.toString()}) must be on or after effectiveFrom (${effectiveFrom.toString()}).`,
      path: ["effectiveTo"],
    });
  }

  issues.push(
    ...checkRecurrence(rule.recurrence),
    ...checkTimeZone(rule.timezone, ["timezone"])
  );

  return issues;
}

export function checkInstantRange(
  range: { readonly start: Temporal.Instant; readonly end: Temporal.Instant },
  path: Path
): CheckIssue[] {
  return Temporal.Instant.compare(range.start, range.end) < 0
    ? []
    : [
        {
          message: `end (${range.end.toString()}) must be after start (${range.start.toString()}).`,
          path: [...path, "end"],
        },
      ];
}

// shortcut: no upper bound, so a huge value can still overflow Temporal's range and throw; cap it if #29/#31 settle a limit.
export function checkPositiveInteger(n: number, path: Path): CheckIssue[] {
  return Number.isInteger(n) && n >= 1
    ? []
    : [{ message: `Must be a positive integer (minutes), got ${n}.`, path }];
}

export function checkRules(rules: readonly AvailabilityRule[]): CheckIssue[] {
  return rules.flatMap((rule, i) =>
    checkRule(rule).map((issue) => ({
      message: issue.message,
      path: ["rules", i, ...issue.path],
    }))
  );
}

function checkSameResource(
  items: readonly { readonly resourceId: string }[],
  key: "rules" | "bookings",
  resourceId: string
): CheckIssue[] {
  return items.flatMap((item, i) =>
    item.resourceId === resourceId
      ? []
      : [
          {
            message: `resourceId "${item.resourceId}" doesn't match the query's resourceId "${resourceId}".`,
            path: [key, i, "resourceId"],
          },
        ]
  );
}

export function checkBookings(
  bookings: readonly Booking[],
  resourceId: string
): CheckIssue[] {
  return [
    ...checkSameResource(bookings, "bookings", resourceId),
    ...bookings.flatMap((b, i) => checkInstantRange(b, ["bookings", i])),
  ];
}

/** Rules and bookings for one resource: each valid and all on `resourceId`. */
export function checkResourceInputs(inputs: {
  readonly resourceId: string;
  readonly rules: readonly AvailabilityRule[];
  readonly bookings: readonly Booking[];
}): CheckIssue[] {
  const { bookings, resourceId, rules } = inputs;

  return [
    ...checkRules(rules),
    ...checkSameResource(rules, "rules", resourceId),
    ...checkBookings(bookings, resourceId),
  ];
}
