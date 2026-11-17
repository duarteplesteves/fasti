import { Effect } from "effect";

import type { ResourceIdOf, RuleRecord } from "../adapter/records.js";
import { checkRules } from "../core/checks.js";
import { checked } from "../core/result.js";
import type { InvalidParams } from "../core/result.js";
import type { AvailabilityRule } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { AdapterError } from "./errors.js";
import type { ActionContext } from "./scheduler-service.js";

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
export function setAvailability<S extends AnySchema, Tx>(
  { adapter }: ActionContext<S, Tx>,
  { resourceId, rules }: SetAvailabilityParams<S>
): Effect.Effect<SetAvailabilityValue, SetAvailabilityError> {
  const coreId = String(resourceId);

  const valid = checked(
    checkRules(rules.map((r) => ({ ...r, resourceId: coreId }))),
    () => rules.map((r) => ({ ...r, exceptions: r.exceptions ?? [] }))
  );

  if (!valid.ok) {
    return Effect.fail(valid.error);
  }

  const stored = valid.value;

  return Effect.as(
    adapter.withResourceLock(resourceId, (locked) =>
      locked.replaceRules({ resourceId, rules: stored })
    ),
    { rules: stored }
  );
}

/** A Resource's rules, read without the lock; `[]` for an unknown Resource. */
export function getAvailability<S extends AnySchema, Tx>(
  { adapter }: ActionContext<S, Tx>,
  { resourceId }: GetAvailabilityParams<S>
): Effect.Effect<readonly RuleRecord[], GetAvailabilityError> {
  return adapter.getRules(resourceId);
}
