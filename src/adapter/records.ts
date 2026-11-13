import type { BookingId } from "../core/types.js";
import type { TypeOf } from "../schema/column.js";
import type { AnySchema, Fields } from "../schema/define-schema.js";

/** The Resource id type a schema declares, brand included. */
export type ResourceIdOf<S extends AnySchema> = TypeOf<S["resource"]["idType"]>;

/** The logical Statuses a schema declares. */
export type StatusOf<S extends AnySchema> = keyof S["statuses"] & string;

type FieldValues<F extends Fields> = {
  [K in keyof F]: F[K]["required"] extends true
    ? TypeOf<F[K]["type"]>
    : TypeOf<F[K]["type"]> | null;
};

/** A Booking as it crosses the Adapter seam: logical names only, Developer Fields included. */
export type BookingRecord<S extends AnySchema> = {
  readonly id: BookingId;
  readonly resourceId: ResourceIdOf<S>;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
  readonly status: StatusOf<S>;
} & Readonly<FieldValues<S["booking"]["fields"]>>;
