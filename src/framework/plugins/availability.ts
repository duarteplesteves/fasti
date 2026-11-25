import { Effect } from "effect";

import { windowFit } from "../../core/availability.js";
import { checkRules } from "../../core/checks.js";
import { checked } from "../../core/result.js";
import type { InvalidParams } from "../../core/result.js";
import type { AvailabilityRule, InstantRange } from "../../core/types.js";
import { column } from "../../schema/column.js";
import type { PluginResourceId, RecordOf } from "../../schema/table.js";
import { AdapterError } from "../errors.js";
import { definePlugin } from "../plugin.js";

/**
 * An AvailabilityRule as `availability()` stores and returns it: the Core rule without `resourceId` (the table keys it).
 * An unset effective date is an absent key; `exceptions` is always present, empty when there are none.
 */
export type RuleRecord = Readonly<
  Omit<AvailabilityRule, "resourceId" | "exceptions">
> & {
  readonly exceptions: readonly Temporal.PlainDate[];
};

/** An Availability Rule as the caller gives it: no `resourceId`, `exceptions` optional. A {@link RuleRecord} is one, so `get` feeds `set`. */
export type AvailabilityRuleInput = Omit<AvailabilityRule, "resourceId">;

/** Params of `availability.set`. */
export interface SetAvailabilityParams {
  /** The Resource whose rules are replaced. */
  readonly resourceId: PluginResourceId;
  /** The whole new rule set; `[]` clears it. */
  readonly rules: readonly AvailabilityRuleInput[];
}

/** What `availability.set` returns: an object, so later checkpoints can add keys. */
export interface SetAvailabilityValue {
  /** The rules as stored, `exceptions` filled in. */
  readonly rules: readonly RuleRecord[];
}

/** What `availability.set`'s `also` gets, beside `tx` and `now`: the rules after and before, `previous` read under the lock. */
export interface SetAvailabilityAlso {
  /** The Resource whose rules were replaced. */
  readonly resourceId: PluginResourceId;
  /** The rules as just stored. */
  readonly rules: readonly RuleRecord[];
  /** The rules as they were. */
  readonly previous: readonly RuleRecord[];
}

/** Every way `availability.set` can fail. */
export type SetAvailabilityError = InvalidParams | AdapterError;

/** Every way `availability.get` can fail. */
export type GetAvailabilityError = AdapterError;

/** Params of `availability.get`. */
export interface GetAvailabilityParams {
  /** The Resource whose rules are read. */
  readonly resourceId: PluginResourceId;
}

/** What the `availability` Policy reports: nothing beyond its name. */
export type AvailabilityDetail = Readonly<Record<string, never>>;

/** A rule's recurrence as stored: JSON. */
interface StoredRecurrence {
  readonly frequency: "weekly";
  readonly interval: number;
  readonly daysOfWeek: readonly number[];
}

/** The rule table, with `0.6`'s columns in `0.6`'s order (I8). */
const ruleTable = {
  columns: {
    recurrence: {
      required: true,
      // A type literal, not the Recurrence interface: only it fits a JSON column.
      type: column.json<{
        readonly [K in keyof StoredRecurrence]: StoredRecurrence[K];
      }>(),
    },
    windowStart: { required: true, type: column.time() },
    windowEnd: { required: true, type: column.time() },
    timezone: { required: true, type: column.text() },
    effectiveFrom: { required: false, type: column.date() },
    effectiveTo: { required: false, type: column.date() },
    exceptions: { required: true, type: column.dates() },
  },
  timed: false,
} as const;

/** A stored rule row. */
type RuleRow = RecordOf<"availabilityRule", typeof ruleTable>;

/**
 * A stored row as the rule it holds; unset effective dates are absent, as `0.6` returned them.
 *
 * @returns The rule.
 */
function toRule(row: RuleRow): RuleRecord {
  return {
    exceptions: row.exceptions,
    recurrence: row.recurrence,
    timeWindow: { end: row.windowEnd, start: row.windowStart },
    timezone: row.timezone,
    ...(row.effectiveFrom !== null && { effectiveFrom: row.effectiveFrom }),
    ...(row.effectiveTo !== null && { effectiveTo: row.effectiveTo }),
  };
}

/**
 * A rule as the columns it's stored in.
 *
 * @returns The column values, unset dates as `null`.
 */
function toColumns(rule: RuleRecord) {
  return {
    effectiveFrom: rule.effectiveFrom ?? null,
    effectiveTo: rule.effectiveTo ?? null,
    exceptions: rule.exceptions,
    recurrence: rule.recurrence,
    timezone: rule.timezone,
    windowEnd: rule.timeWindow.end,
    windowStart: rule.timeWindow.start,
  };
}

/**
 * Availability Rules on `scheduler.availability`, and the `availability` Policy: a Booking must fit inside one of its
 * Resource's availability windows (ADR 014). Without this Plugin, all time outside Bookings and busy time is bookable.
 * Install it first in `plugins`: Policies run in install order, so its Violation then comes first (R6).
 * Its table is `0.6`'s `availabilityRule`, so installing it needs no migration.
 *
 * @returns The Plugin, to install in `defineSchema`'s `plugins`.
 */
export function availability() {
  return definePlugin({
    actions: {
      /** Read the Resource's rules, without the lock; `[]` when it has none. */
      get: {
        kind: "read",
        run: (
          { resourceId }: GetAvailabilityParams,
          { records }
        ): Effect.Effect<readonly RuleRecord[], AdapterError> =>
          Effect.map(records.availabilityRule.list({ resourceId }), (rows) =>
            rows.map(toRule)
          ),
      },
      /** Replace the Resource's whole rule set under its Resource Lock (PUT); invalid rules store nothing. */
      set: {
        kind: "write",
        run: ({ resourceId, rules }: SetAvailabilityParams, { lock }) => {
          // A Resource id is a string or a number at runtime; PluginResourceId only stands in for its type.
          // oxlint-disable-next-line typescript/no-base-to-string -- see above.
          const coreId = String(resourceId);

          // Before any Adapter call (Invariant 5).
          const valid = checked(
            checkRules(rules.map((r) => ({ ...r, resourceId: coreId }))),
            (): readonly RuleRecord[] =>
              rules.map((r) => ({ ...r, exceptions: r.exceptions ?? [] }))
          );

          if (!valid.ok) {
            return Effect.fail(valid.error);
          }

          const stored = valid.value;

          return lock(resourceId, ({ records }) =>
            Effect.gen(function* setAvailabilityUnit() {
              const previous = (yield* records.availabilityRule.list({
                resourceId,
              })).map(toRule);

              yield* records.availabilityRule.replace({
                records: stored.map(toColumns),
                resourceId,
              });

              const context: SetAvailabilityAlso = {
                previous,
                resourceId,
                rules: stored,
              };

              const value: SetAvailabilityValue = { rules: stored };

              return { _tag: "Done", context, value } as const;
            })
          );
        },
      },
    },
    name: "availability",
    policies: [
      {
        appliesTo: ["book", "reschedule"],
        // Expands around each candidate, not over `load`'s range: a findSlots range is long, and a long candidate expands nothing.
        // `fits` lives for one call, so findSlots' candidates share the prepared rules and each date's windows.
        check: (
          candidate,
          fits: (slot: InstantRange) => boolean
        ): AvailabilityDetail | null =>
          // `appliesTo` only passes these two; the others have no range of their own.
          (candidate.action !== "book" && candidate.action !== "reschedule") ||
          fits(candidate)
            ? null
            : {},
        load: ({ records, resourceId }) =>
          Effect.flatMap(
            records.availabilityRule.list({ resourceId }),
            (rows) => {
              // A Resource id is a string or a number at runtime; PluginResourceId only stands in for its type.
              // oxlint-disable-next-line typescript/no-base-to-string -- see above.
              const coreId = String(resourceId);

              const rules = rows.map((r) => ({
                ...toRule(r),
                resourceId: coreId,
              }));

              const valid = checked(checkRules(rules), () => windowFit(rules));

              // Invalid stored rules are the Adapter's data (Invariant 6).
              return valid.ok
                ? Effect.succeed(valid.value)
                : Effect.fail(new AdapterError(valid.error));
            }
          ),
        name: "availability",
      },
    ],
    tables: { availabilityRule: ruleTable },
  });
}

/** The `availability()` Plugin. */
export type AvailabilityPlugin = ReturnType<typeof availability>;
