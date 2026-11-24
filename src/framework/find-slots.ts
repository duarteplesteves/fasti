import { Clock, Effect } from "effect";

import type { ResourceIdOf } from "../adapter/records.js";
import { checkBookings } from "../core/checks.js";
import { checkSearch, freeGridSlots } from "../core/find-free-slots.js";
import { checked } from "../core/result.js";
import type { InvalidParams } from "../core/result.js";
import type { BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import { floorMs } from "./booking.js";
import { AdapterError } from "./errors.js";
import type { BookingNotFound } from "./errors.js";
import type { Form, Run } from "./forms.js";
import { occupants } from "./occupancy.js";
import { applicable, judge, loadPolicies, parseRelax } from "./policy-pass.js";
import type { UnparsedRelax } from "./policy-pass.js";
import type { RelaxedNames, Violation } from "./policy.js";
import type { ActionContext } from "./scheduler-service.js";

/** Params of `findSlots`: free `duration`-minute slots on one Resource, starting in `[from, to)`. */
export interface FindSlotsParams<S extends AnySchema> {
  /** The Resource to search, typed by the schema's `idType`. */
  readonly resourceId: ResourceIdOf<S>;
  /** Inclusive start of the range slots may start in. */
  readonly from: Temporal.Instant;
  /** Exclusive end of the range slots may start in; a slot's end may pass it. */
  readonly to: Temporal.Instant;
  /** Slot length in whole minutes. */
  readonly duration: number;
  /** Grid step in whole minutes, counted from local midnight in `timezone`. */
  readonly interval: number;
  /** IANA timezone that anchors the grid; slots are zoned in it. */
  readonly timezone: string;
  /** The slots this Booking could be rescheduled to: it leaves the conflict check, and the `reschedule` Policies run instead of `book`'s. */
  readonly excludeBookingId?: BookingId;
}

/** A free slot from `findSlots`, with the caller's typed Resource id; `W` is the Violations of the Policies `relax` named. */
export interface Slot<S extends AnySchema, W = never> {
  readonly start: Temporal.ZonedDateTime;
  readonly end: Temporal.ZonedDateTime;
  readonly resourceId: ResourceIdOf<S>;
  /** The relaxed Policies this slot breaks; empty without `relax`. */
  readonly waived: readonly W[];
}

/** Every way `findSlots` can fail. `BookingNotFound`: `excludeBookingId` names no Booking. */
export type FindSlotsError = InvalidParams | BookingNotFound | AdapterError;

/** `findSlots`'s params when the Policies on its Action report `W`. */
type SearchParams<S extends AnySchema, X> = Omit<
  FindSlotsParams<S>,
  "excludeBookingId"
> & {
  /** Skip these Policies: slots that break only these are listed, tagged in `waived`. */
  readonly relax?: X;
};

/** The slots a search relaxing `X` returns, over Violations `W`. */
type Slots<S extends AnySchema, W, X> = readonly Slot<
  S,
  Extract<W, { readonly policy: RelaxedNames<X> }>
>[];

/** `findSlots` in form `F`: `book`'s Policies (`B`) without `excludeBookingId`, `reschedule`'s (`Rs`) with it, so `relax` and `waived` narrow by it. */
export interface FindSlotsAction<
  F extends Form,
  S extends AnySchema,
  B extends Violation<string, unknown>,
  Rs extends Violation<string, unknown>,
> {
  <const X extends readonly B["policy"][] | undefined = undefined>(
    params: SearchParams<S, X> & { readonly excludeBookingId?: undefined }
  ): Run<F, Slots<S, B, X>, FindSlotsError, never>;
  <const X extends readonly Rs["policy"][] | undefined = undefined>(
    params: SearchParams<S, X> & { readonly excludeBookingId: BookingId }
  ): Run<F, Slots<S, Rs, X>, FindSlotsError, never>;
}

/**
 * Free slots on a Resource: the Grid slots no blocking Booking or Block overlaps, judged by the same Policies as `book`, or `reschedule` with `excludeBookingId` (Invariant 5 of ADR 014's spec).
 * A slot breaking an unrelaxed Policy is hidden. Unlocked reads; each `load` runs once, over `[from, to + duration)`.
 *
 * @returns An Effect of the visible Slots in start order, each with its waived Violations; it fails with `InvalidParams`, `BookingNotFound` (for an unknown `excludeBookingId`) or `AdapterError`.
 */
export function findSlots<S extends AnySchema, Tx>(
  ctx: ActionContext<S, Tx>,
  params: FindSlotsParams<S> & UnparsedRelax
): Effect.Effect<
  readonly Slot<S, Violation<string, unknown>>[],
  FindSlotsError
> {
  const { adapter } = ctx;
  const { duration, excludeBookingId, interval, resourceId, timezone } = params;

  const from = floorMs(params.from);
  const to = floorMs(params.to);

  const target = excludeBookingId === undefined ? "book" : "reschedule";
  const policies = applicable(ctx, target);
  const relaxed = parseRelax(policies, target, params);

  // Checked before any Adapter call (Invariant 5). `to` is before year 10000 and `duration` at most 31 days (ADR 019), so `to.add(duration)` below can't throw.
  const valid = checked(
    [
      ...checkSearch({ duration, from, interval, timezone, to }),
      ...(relaxed.ok ? [] : relaxed.error.issues),
    ],
    () => (relaxed.ok ? relaxed.value : undefined)
  );

  if (!valid.ok) {
    return Effect.fail(valid.error);
  }

  const relax = valid.value;

  return Effect.gen(function* findSlotsRun() {
    const previous =
      excludeBookingId === undefined
        ? null
        : yield* adapter.getBooking(excludeBookingId);

    if (excludeBookingId !== undefined && previous === null) {
      return yield* Effect.fail<BookingNotFound>({
        _tag: "BookingNotFound",
        id: excludeBookingId,
      });
    }

    const now = Temporal.Instant.fromEpochMilliseconds(
      yield* Clock.currentTimeMillis
    );

    // A slot starting before `to` can run to `to + duration`.
    const range = { from, to: to.add({ minutes: duration }) };

    const { bookings } = yield* occupants(
      ctx,
      adapter,
      "booking",
      resourceId,
      range,
      excludeBookingId ?? null
    );

    // Stored data the Core finds invalid is the Adapter's (Invariant 6).
    const grid = checked(checkBookings(bookings, String(resourceId)), () =>
      freeGridSlots({
        bookings,
        duration,
        from,
        interval,
        timezone,
        to,
      })
    );

    if (!grid.ok) {
      return yield* Effect.fail(new AdapterError(grid.error));
    }

    const loaded = yield* loadPolicies(adapter, policies, {
      ...range,
      now,
      resourceId,
    });

    return grid.value.flatMap(({ endMs, startMs }) => {
      const start = Temporal.Instant.fromEpochMilliseconds(startMs);
      const end = Temporal.Instant.fromEpochMilliseconds(endMs);

      const span = {
        end,
        resourceId,
        start,
      };

      const { violations, waived } = judge(
        loaded,
        previous === null
          ? { ...span, action: "book", now }
          : { ...span, action: "reschedule", now, previous },
        relax ?? []
      );

      return violations.length > 0
        ? []
        : [
            {
              end: end.toZonedDateTimeISO(timezone),
              resourceId,
              start: start.toZonedDateTimeISO(timezone),
              waived,
            },
          ];
    });
  });
}
