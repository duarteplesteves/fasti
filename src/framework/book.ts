import { Effect } from "effect";

import { toCoreBooking } from "../adapter/records.js";
import type { BookingRecord, ResourceIdOf } from "../adapter/records.js";
import { checkInstantRange } from "../core/checks.js";
import { detectConflicts } from "../core/detect-conflicts.js";
import { isSlotValid } from "../core/is-slot-valid.js";
import { checked } from "../core/result.js";
import type { InvalidParams } from "../core/result.js";
import type { AnyColumn, TypeOf } from "../schema/column.js";
import type { AnySchema } from "../schema/define-schema.js";
import { mintBookingId } from "./booking-id.js";
import { floorMs } from "./booking.js";
import type { Booking, FieldsParam } from "./booking.js";
import type { EffectLocked } from "./effect-adapter.js";
import { AdapterError } from "./errors.js";
import type {
  ConflictingBooking,
  PolicyViolation,
  SlotConflict,
} from "./errors.js";
import type { ActionContext } from "./scheduler-service.js";

/** Params of `book`: one Resource, one half-open `[start, end)` range, and the schema's Developer Fields under `fields`. */
export type BookParams<S extends AnySchema> = {
  /** The Resource to book, typed by the schema's `idType`. */
  readonly resourceId: ResourceIdOf<S>;
  /** Inclusive start; floored to the millisecond. */
  readonly start: Temporal.Instant;
  /** Exclusive end; floored to the millisecond. */
  readonly end: Temporal.Instant;
} & FieldsParam<S>;

/** Every way `book` can fail. */
export type BookError =
  | InvalidParams
  | SlotConflict
  | PolicyViolation
  | AdapterError;

/** The blocking Bookings overlapping the slot, read inside the unit of work. */
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
): Effect.Effect<readonly ConflictingBooking[], AdapterError> {
  return Effect.flatMap(
    locked.listBookings({ overlapping: { from: start, to: end }, resourceId }),
    (existing) => {
      const r = detectConflicts({
        bookings: existing.map((b) => toCoreBooking(codec, b)),
        candidate: { end, start },
        resourceId: String(resourceId),
      });

      // The params were checked up front, so only invalid stored data fails here (Invariant 6).
      return r.ok
        ? Effect.succeed(
            r.value.map((b) => ({ end: b.end, id: b.id, start: b.start }))
          )
        : Effect.fail(new AdapterError(r.error));
    }
  );
}

/** A Developer Field's value, `null` when an optional one is unset. */
type FieldValue = TypeOf<AnyColumn> | null;

/** One value per schema field, `null` for an optional one left out; keys outside the schema are dropped. */
function fieldValues<S extends AnySchema>(
  schema: S,
  params: BookParams<S>
): Record<string, FieldValue> {
  // SAFETY: FieldsParam<S> is `unknown` or an object with an optional or required `fields`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the conditional type can't narrow inside a generic.
  const { fields } = params as {
    readonly fields?: Readonly<Record<string, FieldValue>>;
  };

  return Object.fromEntries(
    Object.keys(schema.booking.fields).map((name) => [
      name,
      fields?.[name] ?? null,
    ])
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
        ...fieldValues(ctx.schema, params),
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
