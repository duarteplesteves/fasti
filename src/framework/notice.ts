import type { AnySchema } from "../schema/define-schema.js";
import { definePolicy } from "./policy.js";
import type { Policy, PolicyTarget } from "./policy.js";

/** Params of {@link notice}. */
export interface NoticeParams<
  S extends AnySchema,
  T extends PolicyTarget<S>,
  N extends string,
> {
  /** Whole minutes, at least 0: `0` still refuses a start in the past. */
  readonly minimum: number;
  /** The Actions and declared Transition edges that run it; at least one. */
  readonly appliesTo: readonly [T, ...T[]];
  /** Defaults to `notice`; rename it to register more than one. */
  readonly name?: N & (N extends "availability" ? never : unknown);
}

/** What a broken {@link notice} reports: the earliest start it would accept. */
export interface NoticeDetail {
  readonly earliest: Temporal.Instant;
}

/**
 * The prebuilt notice Policy: breaks when the start is before `now + minimum`.
 * The start is the candidate's on `book` and `reschedule`, the stored Booking's on `cancel` and Transition edges.
 * Throws when `minimum` isn't a whole number of minutes, at least 0.
 *
 * @example
 * ```ts
 * const bookingNotice = notice(schema, { name: "bookingNotice", minimum: 120, appliesTo: ["book", "reschedule"] });
 * const cancelNotice = notice(schema, { name: "cancelNotice", minimum: 24 * 60, appliesTo: ["cancel"] });
 * ```
 */
export function notice<
  S extends AnySchema,
  const T extends PolicyTarget<S>,
  const N extends string = "notice",
>(
  schema: S,
  params: NoticeParams<S, T, N>
): Policy<S, N, T, NoticeDetail, undefined> {
  const { appliesTo, minimum, name = "notice" } = params;

  if (!Number.isInteger(minimum) || minimum < 0) {
    throw new Error(
      `fasti: notice minimum must be whole minutes, at least 0 (got ${minimum})`
    );
  }

  return definePolicy<S, N, T, NoticeDetail>(schema, {
    appliesTo,
    check: (candidate) => {
      const earliest = candidate.now.add({ minutes: minimum });

      const start =
        candidate.action === "book" || candidate.action === "reschedule"
          ? candidate.start
          : candidate.booking.start;

      return Temporal.Instant.compare(start, earliest) < 0
        ? { earliest }
        : null;
    },
    // SAFETY: `name` is N, or "notice" when N is left at its default.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
    name: name as N & (N extends "availability" ? never : unknown),
  });
}
