import type { BookingRecord } from "../adapter/records.js";
import type { AnyColumn, TypeOf } from "../schema/column.js";
import type { AnySchema, Fields } from "../schema/define-schema.js";

/** A Booking as an Action returns it: flat, Developer Fields included. */
export type Booking<S extends AnySchema> = BookingRecord<S>;

type RequiredNames<F extends Fields> = {
  [K in keyof F]: F[K]["required"] extends true ? K : never;
}[keyof F];

/** Developer Field input: required ones must be set; optional ones may be left out or `null`. */
export type FieldsInput<F extends Fields> = {
  readonly [K in RequiredNames<F>]: TypeOf<F[K]["type"]>;
} & {
  readonly [K in Exclude<keyof F, RequiredNames<F>>]?: TypeOf<
    F[K]["type"]
  > | null;
};

/** `fields` is absent with no Developer Fields, optional when all are optional, required otherwise. */
export type FieldsParam<F extends Fields> = [keyof F] extends [never]
  ? unknown
  : [RequiredNames<F>] extends [never]
    ? { readonly fields?: FieldsInput<F> }
    : { readonly fields: FieldsInput<F> };

/** Truncate to the millisecond, toward the past: the precision every Adapter stores. */
export function floorMs(instant: Temporal.Instant): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(instant.epochMilliseconds);
}

/** A Developer Field's value, `null` when an optional one is unset. */
export type FieldValue = TypeOf<AnyColumn> | null;

/** One value per declared field, `null` for an optional one left out, Instants ms-floored; keys outside `fields` are dropped. */
export function fieldValues<F extends Fields>(
  fields: F,
  params: FieldsParam<F>
): Record<string, FieldValue> {
  // SAFETY: FieldsParam<F> is `unknown` or an object with an optional or required `fields`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the conditional type can't narrow inside a generic.
  const { fields: input } = params as {
    readonly fields?: Readonly<Record<string, FieldValue>>;
  };

  return Object.fromEntries(
    Object.keys(fields).map((name) => {
      const value = input?.[name] ?? null;

      return [name, value instanceof Temporal.Instant ? floorMs(value) : value];
    })
  );
}
