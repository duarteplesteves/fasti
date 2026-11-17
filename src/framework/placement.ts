import { Effect } from "effect";

import type { ResourceIdOf } from "../adapter/records.js";
import { isSlotValid } from "../core/is-slot-valid.js";
import type { BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { EffectLocked } from "./effect-adapter.js";
import { AdapterError } from "./errors.js";
import type { PolicyViolation, SlotConflict } from "./errors.js";
import { conflictsAt } from "./occupancy.js";
import type { ActionContext } from "./scheduler-service.js";

/** Params of `checkPlacement`: a Booking's candidate `[start, end)` on a Resource. */
export interface CheckPlacementParams<S extends AnySchema> {
  readonly resourceId: ResourceIdOf<S>;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
  /** Leave this Booking out of the overlap check, e.g. the one being moved; `null` for none. */
  readonly excludeBookingId: BookingId | null;
  /** Whether the Booking's Status blocks; a non-blocking one can't conflict, so it skips the overlap check. */
  readonly blocking: boolean;
}

/** Whether a Booking may sit at `[start, end)`: the overlap Invariant first, then `availability`; an Invariant failure comes back alone (ADR 014). */
export function checkPlacement<S extends AnySchema, Tx>(
  locked: EffectLocked<S, Tx>,
  ctx: ActionContext<S, Tx>,
  params: CheckPlacementParams<S>
): Effect.Effect<void, SlotConflict | PolicyViolation | AdapterError> {
  const { blocking, end, excludeBookingId, resourceId, start } = params;
  const coreId = String(resourceId);

  return Effect.gen(function* checkPlacementUnit() {
    const conflicts = blocking
      ? yield* conflictsAt(locked, ctx.codec, {
          end,
          excludeBookingId,
          kind: "booking",
          resourceId,
          start,
        })
      : [];

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

    return valid.value
      ? undefined
      : yield* Effect.fail<PolicyViolation>({
          _tag: "PolicyViolation",
          violations: [{ detail: {}, policy: "availability" }],
        });
  });
}
