import type { Booking, BookingId } from "../core/types.js";
import type { TypeOf } from "../schema/column.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";
import type { Columns } from "../schema/table.js";

/** The Resource id type a schema declares, brand included. */
export type ResourceIdOf<S extends AnySchema> = TypeOf<S["resource"]["idType"]>;

/** The logical Statuses a schema declares. */
export type StatusOf<S extends AnySchema> = keyof S["statuses"] & string;

/** The values of Developer Fields or Plugin table columns `F`: an optional one may be `null`. */
export type FieldValues<F extends Columns> = {
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

/** The fields `updateBooking` may change: anything but `id`. */
export type BookingChanges<S extends AnySchema> = Partial<
  Omit<BookingRecord<S>, "id">
>;

/**
 * The Core's view of a stored Booking: `String` Resource id, blocking derived from its Status. Internal.
 *
 * @returns The Booking as the Core reads it.
 */
export function toCoreBooking<S extends AnySchema>(
  codec: StatusCodec<StatusOf<S>>,
  record: BookingRecord<S>
): Booking<BookingId> {
  return {
    end: record.end,
    id: record.id,
    isBlocking: codec.isBlocking(record.status),
    resourceId: String(record.resourceId),
    start: record.start,
  };
}
