import { Effect } from "effect";

import type { ResourceIdOf, RuleRecord } from "../adapter/records.js";
import { checkRules } from "../core/checks.js";
import { checked } from "../core/result.js";
import type { InvalidParams } from "../core/result.js";
import type { AvailabilityRule } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { AdapterError } from "./errors.js";
import type { ActionContext } from "./scheduler-service.js";
import { writeUnit } from "./write-unit.js";
import type { AlsoContext, AlsoParam, WriteEffect } from "./write-unit.js";

/** An Availability Rule as the caller gives it: no `resourceId`, `exceptions` optional. A {@link RuleRecord} is one, so `get` feeds `set`. */
export type AvailabilityRuleInput = Omit<AvailabilityRule, "resourceId">;

/** Params of `availability.set`. */
export interface SetAvailabilityParams<S extends AnySchema> {
  /** The Resource whose rules are replaced. */
  readonly resourceId: ResourceIdOf<S>;
  /** The whole new rule set; `[]` clears it. */
  readonly rules: readonly AvailabilityRuleInput[];
}

/** What `availability.set` returns: an object, so later checkpoints can add keys. */
export interface SetAvailabilityValue {
  /** The rules as stored, `exceptions` filled in. */
  readonly rules: readonly RuleRecord[];
}

/** What `availability.set`'s `also` gets: the rules after and before, `previous` read under the lock. */
export interface SetAvailabilityAlso<S extends AnySchema, Tx> {
  /** The Adapter's transaction handle: write through it to share the unit. */
  readonly tx: Tx;
  /** The Resource whose rules were replaced. */
  readonly resourceId: ResourceIdOf<S>;
  /** The rules as just stored. */
  readonly rules: readonly RuleRecord[];
  /** The rules as they were. */
  readonly previous: readonly RuleRecord[];
  /** The Clock's time, read on the unit. */
  readonly now: Temporal.Instant;
}

/** Every way `availability.set` can fail. */
export type SetAvailabilityError = InvalidParams | AdapterError;

/** Params of `availability.get`. */
export interface GetAvailabilityParams<S extends AnySchema> {
  /** The Resource whose rules are read. */
  readonly resourceId: ResourceIdOf<S>;
}

/** Every way `availability.get` can fail. */
export type GetAvailabilityError = AdapterError;

/** Replace a Resource's rules under its Resource Lock (PUT); invalid rules store nothing. */
export function setAvailability<S extends AnySchema, Tx, R = never>(
  ctx: ActionContext<S, Tx>,
  {
    also,
    resourceId,
    rules,
  }: SetAvailabilityParams<S> &
    AlsoParam<AlsoContext<SetAvailabilityAlso<S, Tx>>, Tx, R>
): WriteEffect<SetAvailabilityValue, SetAvailabilityError, R> {
  const coreId = String(resourceId);

  const valid = checked(
    checkRules(rules.map((r) => ({ ...r, resourceId: coreId }))),
    () => rules.map((r) => ({ ...r, exceptions: r.exceptions ?? [] }))
  );

  if (!valid.ok) {
    return Effect.fail(valid.error);
  }

  const stored = valid.value;

  return writeUnit(
    ctx,
    { action: "availability.set", resourceId },
    (locked) =>
      Effect.gen(function* setAvailabilityUnit() {
        const previous = yield* locked.getRules(resourceId);

        yield* locked.replaceRules({ resourceId, rules: stored });

        return {
          _tag: "Done",
          context: { previous, resourceId, rules: stored },
          value: { rules: stored },
        } as const;
      }),
    also
  );
}

/** A Resource's rules, read without the lock; `[]` for an unknown Resource. */
export function getAvailability<S extends AnySchema, Tx>(
  { adapter }: ActionContext<S, Tx>,
  { resourceId }: GetAvailabilityParams<S>
): Effect.Effect<readonly RuleRecord[], GetAvailabilityError> {
  return adapter.getRules(resourceId);
}
