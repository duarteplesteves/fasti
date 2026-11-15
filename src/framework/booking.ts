import type { BookingRecord } from "../adapter/records.js";
import type { TypeOf } from "../schema/column.js";
import type { AnySchema } from "../schema/define-schema.js";

/** A Booking as an Action returns it: flat, Developer Fields included. */
export type Booking<S extends AnySchema> = BookingRecord<S>;

type FieldsOf<S extends AnySchema> = S["booking"]["fields"];

type RequiredNames<S extends AnySchema> = {
  [K in keyof FieldsOf<S>]: FieldsOf<S>[K]["required"] extends true ? K : never;
}[keyof FieldsOf<S>];

/** Developer Field input: required ones must be set; optional ones may be left out or `null`. */
export type FieldsInput<S extends AnySchema> = {
  readonly [K in RequiredNames<S>]: TypeOf<FieldsOf<S>[K]["type"]>;
} & {
  readonly [K in Exclude<keyof FieldsOf<S>, RequiredNames<S>>]?: TypeOf<
    FieldsOf<S>[K]["type"]
  > | null;
};

/** `fields` is absent with no Developer Fields, optional when all are optional, required otherwise. */
export type FieldsParam<S extends AnySchema> = [keyof FieldsOf<S>] extends [
  never,
]
  ? unknown
  : [RequiredNames<S>] extends [never]
    ? { readonly fields?: FieldsInput<S> }
    : { readonly fields: FieldsInput<S> };

/** Truncate to the millisecond, toward the past: the precision every Adapter stores. */
export function floorMs(instant: Temporal.Instant): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(instant.epochMilliseconds);
}
