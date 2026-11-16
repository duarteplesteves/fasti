import { Effect } from "effect";

import type { BookingRecord, ResourceIdOf } from "../adapter/records.js";
import { checkInstantRange } from "../core/checks.js";
import { detectConflicts } from "../core/detect-conflicts.js";
import { isSlotValid } from "../core/is-slot-valid.js";
import { checked } from "../core/result.js";
import type { InvalidParams } from "../core/result.js";
import type { AnySchema } from "../schema/define-schema.js";
import { mintBookingId } from "./booking-id.js";
import { fieldValues, floorMs } from "./booking.js";
import type { Booking, FieldsParam } from "./booking.js";
import type { EffectLocked } from "./effect-adapter.js";
import { AdapterError } from "./errors.js";
import type { Conflict, PolicyViolation, SlotConflict } from "./errors.js";
import { occupants, toConflicts } from "./occupancy.js";
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

/** The conflicts at the slot, read inside the unit of work. */
function conflictsAt<S extends AnySchema>(
  { codec }: ActionContext<S>,
  locked: EffectLocked<S>,
  {
    end,
    resourceId,
    start,
  }: {
    readonly resourceId: ResourceIdOf<S>;
    readonly start: Temporal.Instant;
    readonly end: Temporal.Instant;
  }
): Effect.Effect<Conflict[], AdapterError> {
  return Effect.flatMap(
    occupants(locked, codec, resourceId, { from: start, to: end }),
    ({ bookings, kindById }) => {
      const r = detectConflicts({
        bookings,
        candidate: { end, start },
        resourceId: String(resourceId),
      });

      // The params were checked up front, so only invalid stored data fails here (Invariant 6).
      return r.ok
        ? Effect.succeed(toConflicts(r.value, kindById))
        : Effect.fail(new AdapterError(r.error));
    }
  );
}

/** Store a new `booked` Booking, if the slot is free and inside availability (ADR 014: overlap first). */
export function book<S extends AnySchema>(
  ctx: ActionContext<S>,
  params: BookParams<S>
): Effect.Effect<Booking<S>, BookError> {
  const { resourceId } = params;
  const coreId = String(resourceId);
  // Adapters see only ms-floored Instants (Invariant 4).
  const start = floorMs(params.start);
  const end = floorMs(params.end);
  const range = { end, resourceId, start };
  // Before any Adapter call (Invariant 5).
  const checkedRange = checked(checkInstantRange(range, []), () => range);

  if (!checkedRange.ok) {
    return Effect.fail(checkedRange.error);
  }

  return ctx.adapter.withResourceLock(resourceId, (locked) =>
    Effect.gen(function* bookUnit() {
      const conflicts = yield* conflictsAt(ctx, locked, range);

      if (conflicts.length > 0) {
        return yield* Effect.fail<SlotConflict>({
          _tag: "SlotConflict",
          conflicts,
        });
      }

      const rules = yield* locked.getRules(resourceId);

      const valid = isSlotValid({
        bookings: [],
        resourceId: coreId,
        rules: rules.map((r) => ({ ...r, resourceId: coreId })),
        slot: { end, start },
      });

      // Invalid stored rules are the Adapter's data (Invariant 6).
      if (!valid.ok) {
        return yield* Effect.fail(new AdapterError(valid.error));
      }

      if (!valid.value) {
        return yield* Effect.fail<PolicyViolation>({
          _tag: "PolicyViolation",
          violations: [{ detail: {}, policy: "availability" }],
        });
      }

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
          conflicts: yield* conflictsAt(ctx, locked, range),
        });
      }

      return record;
    })
  );
}
