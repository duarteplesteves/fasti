import { checkOrder, checkRule } from "./check-rule.js";
import type { Path } from "./check-rule.js";
import type { Issue } from "./result.js";
import type { AvailabilityRule, Booking } from "./types.js";

export function checkInstantRange(
  range: { readonly start: Temporal.Instant; readonly end: Temporal.Instant },
  path: Path
): Issue[] {
  return checkOrder(
    Temporal.Instant.compare,
    { label: "start", value: range.start },
    { label: "end", value: range.end },
    "after",
    [...path, "end"]
  );
}

// shortcut: no upper bound, so a huge value can still overflow Temporal's range and throw; cap it if #29/#31 settle a limit.
export function checkPositiveInteger(n: number, path: Path): Issue[] {
  return Number.isInteger(n) && n >= 1
    ? []
    : [{ message: `Must be a positive integer (minutes), got ${n}.`, path }];
}

export function checkRules(rules: readonly AvailabilityRule[]): Issue[] {
  return rules.flatMap((rule, i) =>
    checkRule(rule).map((issue) => ({
      message: issue.message,
      path: ["rules", i, ...(issue.path ?? [])],
    }))
  );
}

export function checkSameResource(
  items: readonly { readonly resourceId: string }[],
  key: "rules" | "bookings",
  resourceId: string
): Issue[] {
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
): Issue[] {
  return [
    ...checkSameResource(bookings, "bookings", resourceId),
    ...bookings.flatMap((b, i) => checkInstantRange(b, ["bookings", i])),
  ];
}
