import { Effect } from "effect";

import type { ResourceIdOf } from "../adapter/records.js";
import { isSlotValid } from "../core/is-slot-valid.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { EffectLocked } from "./effect-adapter.js";
import { AdapterError } from "./errors.js";
import type { PolicyViolation } from "./errors.js";

/** Params of `checkAvailability`: a Booking's candidate `[start, end)` on a Resource. */
export interface CheckAvailabilityParams<S extends AnySchema> {
  readonly resourceId: ResourceIdOf<S>;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

/** Whether `[start, end)` fits the Resource's availability; run after `checkOverlap`, so an Invariant failure comes back alone (ADR 014). */
export function checkAvailability<S extends AnySchema, Tx>(
  locked: EffectLocked<S, Tx>,
  { end, resourceId, start }: CheckAvailabilityParams<S>
): Effect.Effect<void, PolicyViolation | AdapterError> {
  const coreId = String(resourceId);

  return Effect.gen(function* checkAvailabilityUnit() {
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
