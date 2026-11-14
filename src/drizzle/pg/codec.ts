import type { BookingRecord } from "../../adapter/records.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { StatusCodec } from "../../schema/status-codec.js";

/** A value a Booking record holds. */
type RecordValue = string | number | boolean | Temporal.Instant | null;

/** A value of a Booking row as Drizzle reads and writes it: `Date` in place of Instants. */
type RowValue = string | number | boolean | Date | null;

/** A Booking row: logical keys, `Date`s, the stored Status. */
export type BookingRow = Readonly<Record<string, RowValue>>;

/** Record → row: Instants become `Date`s (milliseconds, I7), the Status its stored value. */
export function encodeBooking<S extends AnySchema>(
  codec: StatusCodec<string>,
  record: BookingRecord<S>
) {
  const values: [string, RecordValue][] = Object.entries(record);

  return {
    ...Object.fromEntries(
      values.map(([key, value]) => [
        key,
        value instanceof Temporal.Instant
          ? new Date(value.epochMilliseconds)
          : value,
      ])
    ),
    status: codec.toStored(record.status),
  } satisfies BookingRow;
}

/** Row → record. A stored Status the schema doesn't know throws, so the read rejects. */
export function decodeBooking<S extends AnySchema>(
  codec: StatusCodec<string>,
  row: BookingRow
): BookingRecord<S> {
  const stored = String(row["status"]);
  const status = codec.fromStored(stored);

  if (status === undefined) {
    throw new Error(
      `drizzleAdapter: stored Status "${stored}" is not in the schema`
    );
  }

  const record = {
    ...Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value instanceof Date
          ? Temporal.Instant.fromEpochMilliseconds(value.getTime())
          : value,
      ])
    ),
    status,
  };

  // SAFETY: the row comes from bookingTable(schema): one column per record key, of the declared kind.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
  return record as BookingRecord<S>;
}
