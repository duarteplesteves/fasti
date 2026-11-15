import { Effect } from "effect";

import { toCoreBooking } from "../adapter/records.js";
import type { BookingRecord, ResourceIdOf } from "../adapter/records.js";
import { detectConflicts } from "../core/detect-conflicts.js";
import { isSlotValid } from "../core/is-slot-valid.js";
import type { AnySchema } from "../schema/define-schema.js";
import { mintBookingId } from "./booking-id.js";
import type { Booking } from "./booking.js";
import type { EffectLocked } from "./effect-adapter.js";
import { AdapterError } from "./errors.js";
import type {
  ConflictingBooking,
  PolicyViolation,
  SlotConflict,
} from "./errors.js";
import type { ActionContext } from "./scheduler-service.js";

/** Params of `book`: one Resource, one half-open `[start, end)` range. */
export interface BookParams<S extends AnySchema> {
  /** The Resource to book, typed by the schema's `idType`. */
  readonly resourceId: ResourceIdOf<S>;
  /** Inclusive start. */
  readonly start: Temporal.Instant;
  /** Exclusive end. */
  readonly end: Temporal.Instant;
}

/** Every way `book` can fail. */
export type BookError = SlotConflict | PolicyViolation | AdapterError;

/** The blocking Bookings overlapping the slot, read inside the unit of work. */
function conflictsAt<S extends AnySchema>(
  { codec }: ActionContext<S>,
  locked: EffectLocked<S>,
  { end, resourceId, start }: BookParams<S>
): Effect.Effect<readonly ConflictingBooking[], AdapterError> {
  return Effect.flatMap(
    locked.listBookings({ overlapping: { from: start, to: end }, resourceId }),
    (existing) => {
      const r = detectConflicts({
        bookings: existing.map((b) => toCoreBooking(codec, b)),
        candidate: { end, start },
        resourceId: String(resourceId),
      });

      // shortcut: until book checks its params (#65), invalid params land here too.
      return r.ok
        ? Effect.succeed(
            r.value.map((b) => ({ end: b.end, id: b.id, start: b.start }))
          )
        : Effect.fail(new AdapterError(r.error));
    }
  );
}

/** Store a new `booked` Booking, if the slot is free and inside availability (ADR 014: overlap first). */
export function book<S extends AnySchema>(
  ctx: ActionContext<S>,
  params: BookParams<S>
): Effect.Effect<Booking<S>, BookError> {
  const { end, resourceId, start } = params;
  const coreId = String(resourceId);

  return ctx.adapter.withResourceLock(resourceId, (locked) =>
    Effect.gen(function* bookUnit() {
      const conflicts = yield* conflictsAt(ctx, locked, params);

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

      // Invalid stored rules are the Adapter's data (Invariant 6). shortcut: until #65 checks params, a bad slot lands here too.
      if (!valid.ok) {
        return yield* Effect.fail(new AdapterError(valid.error));
      }

      if (!valid.value) {
        return yield* Effect.fail<PolicyViolation>({
          _tag: "PolicyViolation",
          violations: [{ detail: {}, policy: "availability" }],
        });
      }

      // SAFETY: the base columns are set; Developer Fields arrive with #65.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shortcut: no Developer Fields yet, so a schema with required fields stores a record without them; #65 adds `fields`.
      const record = {
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
          conflicts: yield* conflictsAt(ctx, locked, params),
        });
      }

      return record;
    })
  );
}
