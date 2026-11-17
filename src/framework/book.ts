import { Effect } from "effect";

import type { BookingRecord, ResourceIdOf } from "../adapter/records.js";
import { checkInstantRange } from "../core/checks.js";
import { checked } from "../core/result.js";
import type { InvalidParams } from "../core/result.js";
import type { AnySchema } from "../schema/define-schema.js";
import { mintBookingId } from "./booking-id.js";
import { fieldValues, floorMs } from "./booking.js";
import type { Booking, FieldsParam } from "./booking.js";
import type { AdapterError, PolicyViolation, SlotConflict } from "./errors.js";
import { conflictsAt } from "./occupancy.js";
import { checkPlacement } from "./placement.js";
import type { ActionContext } from "./scheduler-service.js";

/** Params of `book`: one Resource, one half-open `[start, end)` range, and the schema's Developer Fields under `fields`. */
export type BookParams<S extends AnySchema> = {
  /** The Resource to book, typed by the schema's `idType`. */
  readonly resourceId: ResourceIdOf<S>;
  /** Inclusive start; floored to the millisecond. */
  readonly start: Temporal.Instant;
  /** Exclusive end; floored to the millisecond. */
  readonly end: Temporal.Instant;
} & FieldsParam<S["booking"]["fields"]>;

/** Every way `book` can fail. */
export type BookError =
  | InvalidParams
  | SlotConflict
  | PolicyViolation
  | AdapterError;

/** Store a new `booked` Booking, if the slot is free and inside availability (ADR 014: overlap first). */
export function book<S extends AnySchema>(
  ctx: ActionContext<S>,
  params: BookParams<S>
): Effect.Effect<Booking<S>, BookError> {
  const { resourceId } = params;
  // Adapters see only ms-floored Instants (Invariant 4).
  const start = floorMs(params.start);
  const end = floorMs(params.end);

  const range = {
    end,
    excludeBookingId: null,
    kind: "booking",
    resourceId,
    start,
  } as const;

  // Before any Adapter call (Invariant 5).
  const checkedRange = checked(checkInstantRange(range, []), () => range);

  if (!checkedRange.ok) {
    return Effect.fail(checkedRange.error);
  }

  return ctx.adapter.withResourceLock(resourceId, (locked) =>
    Effect.gen(function* bookUnit() {
      yield* checkPlacement(locked, ctx, range);

      // SAFETY: the base columns are set, and every schema field is set: required ones by BookParams' type, optional ones to their value or `null`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema's field names are only known at runtime.
      const record = {
        ...fieldValues<S["booking"]["fields"]>(
          ctx.schema.booking.fields,
          params
        ),
        end,
        id: mintBookingId(),
        resourceId,
        start,
        status: "booked",
      } as BookingRecord<S>;

      const inserted = yield* locked.insertBooking(record);

      if (!inserted.ok) {
        // The backstop caught an outside write the lock can't see: report what is there now.
        return yield* Effect.fail<SlotConflict>({
          _tag: "SlotConflict",
          conflicts: yield* conflictsAt(locked, ctx.codec, range),
        });
      }

      return record;
    })
  );
}
