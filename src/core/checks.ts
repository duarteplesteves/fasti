import { checkRecurrence } from "./recurrence.js";
import type { Issue } from "./result.js";
import type { AvailabilityRule, Booking } from "./types.js";

/** At most this many Grid times per search: span in minutes ÷ `interval` (ADR 019). */
export const MAX_GRID_TIMES = 10_000;

/** The longest `duration` a search takes, in minutes: 31 days (ADR 019). */
export const MAX_DURATION_MINUTES = 44_640;

/** At most this many dates per `expandRules` call, both ends included (ADR 019). */
export const MAX_EXPAND_DAYS = 366;

/** At most this many availability rules per call (ADR 019). */
export const MAX_RULES = 100;

/** At most this many exceptions per availability rule (ADR 019). */
export const MAX_EXCEPTIONS = 1000;

/** The supported range, years 0001–9999 (ADR 019): `[earliest, latest)`. */
const earliest = Temporal.Instant.from("0001-01-01T00:00:00Z");
const latest = Temporal.Instant.from("+010000-01-01T00:00:00Z");

/** Where an issue sits in the params, e.g. `["rules", 0, "end"]`. */
export type Path = readonly (string | number)[];

/** An `Issue` whose path is always set: every check knows where its problem is. */
export interface CheckIssue extends Issue {
  readonly path: Path;
}

/**
 * IANA names only: fixed offsets like "+01:00" don't follow DST.
 *
 * @returns One issue at `path` when `timeZone` isn't an IANA name, else none.
 */
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

function outsideEra(value: string, path: Path): CheckIssue[] {
  return [
    {
      message: `${value} is outside the supported years 0001–9999.`,
      path,
    },
  ];
}

/**
 * Years 0001–9999 only, so no later Temporal arithmetic can overflow (ADR 019).
 *
 * @returns One issue at `path` when `instant` is outside them, else none.
 */
export function checkInstant(
  instant: Temporal.Instant,
  path: Path
): CheckIssue[] {
  return Temporal.Instant.compare(instant, earliest) >= 0 &&
    Temporal.Instant.compare(instant, latest) < 0
    ? []
    : outsideEra(instant.toString(), path);
}

/**
 * Years 0001–9999 only (ADR 019).
 *
 * @returns One issue at `path` when `date` is outside them, else none.
 */
export function checkDate(date: Temporal.PlainDate, path: Path): CheckIssue[] {
  return date.year >= 1 && date.year <= 9999
    ? []
    : outsideEra(date.toString(), path);
}

/**
 * Every problem with `rule`, with paths relative to the rule.
 *
 * @returns The issues, empty when `rule` is valid.
 */
export function checkRule(rule: AvailabilityRule): readonly CheckIssue[] {
  const issues: CheckIssue[] = [];
  const { effectiveFrom, effectiveTo, exceptions = [], timeWindow } = rule;

  if (Temporal.PlainTime.compare(timeWindow.start, timeWindow.end) >= 0) {
    issues.push({
      message: `timeWindow.end (${timeWindow.end.toString()}) must be after timeWindow.start (${timeWindow.start.toString()}). Cross-day windows are not supported; split into two rules.`,
      path: ["timeWindow", "end"],
    });
  }

  if (effectiveFrom) {
    issues.push(...checkDate(effectiveFrom, ["effectiveFrom"]));
  }

  if (effectiveTo) {
    issues.push(...checkDate(effectiveTo, ["effectiveTo"]));
  }

  if (exceptions.length > MAX_EXCEPTIONS) {
    issues.push({
      message: `The rule has ${exceptions.length} exceptions; the limit is ${MAX_EXCEPTIONS}. Split it into rules with shorter effective dates.`,
      path: ["exceptions"],
    });
  } else {
    issues.push(
      ...exceptions.flatMap((e, i) => checkDate(e, ["exceptions", i]))
    );
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

/**
 * Both ends in years 0001–9999, and `end` strictly after `start`.
 *
 * @returns The issues under `path`, empty when the range is valid.
 */
export function checkInstantRange(
  range: { readonly start: Temporal.Instant; readonly end: Temporal.Instant },
  path: Path
): CheckIssue[] {
  const era = [
    ...checkInstant(range.start, [...path, "start"]),
    ...checkInstant(range.end, [...path, "end"]),
  ];

  if (era.length > 0) {
    return era;
  }

  return Temporal.Instant.compare(range.start, range.end) < 0
    ? []
    : [
        {
          message: `end (${range.end.toString()}) must be after start (${range.start.toString()}).`,
          path: [...path, "end"],
        },
      ];
}

/**
 * A whole number of minutes, at least 1, and a safe integer.
 *
 * @returns One issue at `path` when `n` isn't a positive safe integer, else none.
 */
export function checkPositiveInteger(n: number, path: Path): CheckIssue[] {
  return Number.isSafeInteger(n) && n >= 1
    ? []
    : [{ message: `Must be a positive integer (minutes), got ${n}.`, path }];
}

/**
 * Every rule's issues, with paths under `rules[i]`.
 *
 * @returns The issues, empty when every rule is valid.
 */
export function checkRules(rules: readonly AvailabilityRule[]): CheckIssue[] {
  if (rules.length > MAX_RULES) {
    return [
      {
        message: `Got ${rules.length} rules; the limit is ${MAX_RULES}.`,
        path: ["rules"],
      },
    ];
  }

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

/**
 * Each booking is on `resourceId` and ends after it starts.
 *
 * @returns The issues, with paths under `bookings[i]`; empty when all are valid.
 */
export function checkBookings(
  bookings: readonly Booking[],
  resourceId: string
): CheckIssue[] {
  return [
    ...checkSameResource(bookings, "bookings", resourceId),
    ...bookings.flatMap((b, i) => checkInstantRange(b, ["bookings", i])),
  ];
}

/**
 * Rules and bookings for one resource: each valid and all on `resourceId`.
 *
 * @returns The issues, empty when the inputs are valid.
 */
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
