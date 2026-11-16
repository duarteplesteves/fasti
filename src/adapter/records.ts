import type {
  AvailabilityRule,
  BlockId,
  Booking,
  BookingId,
} from "../core/types.js";
import type { TypeOf } from "../schema/column.js";
import type { AnySchema, Fields } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";

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

/** A schema's Block Developer Fields; none when it has no Blocks. */
export type BlockFieldsOf<S extends AnySchema> = S["block"] extends {
  readonly fields: infer F extends Fields;
}
  ? F
  : // oxlint-disable-next-line typescript/no-generated-empty-object-type -- "no Developer Fields" is exactly `{}`.
    Record<never, never>;

/** A Block as it crosses the Adapter seam: logical names only, Developer Fields included. */
export type BlockRecord<S extends AnySchema> = {
  readonly id: BlockId;
  readonly resourceId: ResourceIdOf<S>;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
} & Readonly<FieldValues<BlockFieldsOf<S>>>;

/** The fields `updateBooking` may change: anything but `id`. */
export type BookingChanges<S extends AnySchema> = Partial<
  Omit<BookingRecord<S>, "id">
>;

/**
 * A stored AvailabilityRule: the Core rule without `resourceId` (the verbs take it separately).
 * An unset effective date is an absent key; `exceptions` is always present, empty when there are none.
 */
export type RuleRecord = Readonly<
  Omit<AvailabilityRule, "resourceId" | "exceptions">
> & {
  readonly exceptions: readonly Temporal.PlainDate[];
};

/** The Core's view of a stored Booking: `String` Resource id, blocking derived from its Status. Internal. */
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
