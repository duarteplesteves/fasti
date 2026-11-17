import { Effect } from "effect";

import type { ResourceIdOf } from "../adapter/records.js";
import { checkSearch, findFreeSlots } from "../core/find-free-slots.js";
import { checked } from "../core/result.js";
import type { InvalidParams } from "../core/result.js";
import type { BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import { floorMs } from "./booking.js";
import { AdapterError } from "./errors.js";
import { occupants } from "./occupancy.js";
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
  /** Leave this Booking out of the conflict check: the slots it could be rescheduled to. */
  readonly excludeBookingId?: BookingId;
}

/** A free slot from `findSlots`: the Core's Slot with the caller's typed Resource id. */
export interface Slot<S extends AnySchema> {
  readonly start: Temporal.ZonedDateTime;
  readonly end: Temporal.ZonedDateTime;
  readonly resourceId: ResourceIdOf<S>;
  /** Stays empty until `relax` (checkpoint 7). */
  readonly waived: readonly never[];
}

/** Every way `findSlots` can fail. */
export type FindSlotsError = InvalidParams | AdapterError;

/** Free slots on a Resource: no blocking Booking or Block overlaps them and they fit availability. Unlocked reads. */
export function findSlots<S extends AnySchema, Tx>(
  { adapter, codec }: ActionContext<S, Tx>,
  params: FindSlotsParams<S>
): Effect.Effect<readonly Slot<S>[], FindSlotsError> {
  const { duration, excludeBookingId, interval, resourceId, timezone } = params;

  const from = floorMs(params.from);
  const to = floorMs(params.to);

  // Checked before any Adapter call (Invariant 5), so `to.add(duration)` below can't throw.
  const valid = checked(
    checkSearch({ duration, from, interval, timezone, to }),
    () => null
  );

  if (!valid.ok) {
    return Effect.fail(valid.error);
  }

  return Effect.gen(function* findSlotsRun() {
    const coreId = String(resourceId);
    const rules = yield* adapter.getRules(resourceId);

    // A slot starting before `to` can run to `to + duration`.
    const { bookings } = yield* occupants(
      adapter,
      codec,
      "booking",
      resourceId,
      {
        from,
        to: to.add({ minutes: duration }),
      }
    );

    const found = findFreeSlots({
      bookings: bookings.filter((b) => b.id !== excludeBookingId),
      duration,
      from,
      interval,
      resourceId: coreId,
      rules: rules.map((r) => ({ ...r, resourceId: coreId })),
      timezone,
      to,
    });

    // The params passed above, so only stored data can fail (Invariant 6).
    if (!found.ok) {
      return yield* Effect.fail(new AdapterError(found.error));
    }

    return found.value.map((s) => ({ ...s, resourceId, waived: [] }));
  });
}
