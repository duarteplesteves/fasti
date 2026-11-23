import { decodeValue, encodeValue } from "../adapter/column-value.js";
import type { StoredRecord, StoredValue } from "../adapter/contract.js";
import type { BookingChanges, BookingRecord } from "../adapter/records.js";
import type { Json } from "../schema/column.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";
import type { TableDef } from "../schema/table.js";

/** A value a record holds. */
type RecordValue = string | number | boolean | Temporal.Instant | null;

/** A value of a row as Drizzle reads and writes it: `Date` in place of Instants. */
type RowValue = string | number | boolean | Date | null;

/** A Booking row: logical keys, `Date`s, and the stored Status. */
export type Row = Readonly<Record<string, RowValue>>;

/**
 * Record → row: Instants become `Date`s (milliseconds, I7), everything else as is.
 * Keys left `undefined` (an update's changes leave them out) are dropped, giving a partial row.
 *
 * @returns The row.
 */
export function encodeRow<S extends AnySchema>(
  record: BookingRecord<S> | BookingChanges<S>
): Row {
  return Object.fromEntries(
    // SAFETY: Booking records hold only RecordValues; TS can't resolve a generic S's Developer Fields to them.
    Object.entries(record as Readonly<Record<string, RecordValue | undefined>>)
      .filter((entry): entry is [string, RecordValue] => entry[1] !== undefined)
      .map(([key, value]) => [
        key,
        value instanceof Temporal.Instant
          ? new Date(value.epochMilliseconds)
          : value,
      ])
  );
}

/**
 * Row → record values: `Date`s become Instants.
 *
 * @returns The record values, by column key.
 */
export function decodeRow(row: Row): Readonly<Record<string, RecordValue>> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date
        ? Temporal.Instant.fromEpochMilliseconds(value.getTime())
        : value,
    ])
  );
}

/**
 * Booking record → row: {@link encodeRow}, and the Status its stored value.
 *
 * @returns The row.
 */
export function encodeBooking<S extends AnySchema>(
  codec: StatusCodec<string>,
  record: BookingRecord<S> | BookingChanges<S>
): Row {
  const row = encodeRow(record);

  return record.status === undefined
    ? row
    : { ...row, status: codec.toStored(record.status) };
}

/**
 * Row → Booking record. A stored Status the schema doesn't know throws, so the read rejects.
 *
 * @returns The Booking record.
 */
export function decodeBooking<S extends AnySchema>(
  codec: StatusCodec<string>,
  row: Row
): BookingRecord<S> {
  const stored = String(row["status"]);
  const status = codec.fromStored(stored);

  if (status === undefined) {
    throw new Error(
      `drizzleAdapter: stored Status "${stored}" is not in the schema`
    );
  }

  // SAFETY: the row comes from bookingTable(schema): one column per record key, of the declared kind.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
  return { ...decodeRow(row), status } as BookingRecord<S>;
}

/** A Plugin record row as Drizzle reads and writes it: `Date`s for Instants, ISO strings for dates and times, JSON as is. */
export type RecordRow = Readonly<Record<string, Date | Json>>;

/**
 * Plugin record → row, column by column; works on a partial record (an update's changes) too.
 *
 * @returns The row.
 */
export function encodeRecord(
  record: Readonly<Record<string, StoredValue>>
): RecordRow {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      const encoded = encodeValue(value);

      return [
        key,
        encoded instanceof Temporal.Instant
          ? new Date(encoded.epochMilliseconds)
          : encoded,
      ];
    })
  );
}

/**
 * Row → Plugin record of `table`, column by column.
 *
 * @returns The Plugin record.
 */
export function decodeRecord(table: TableDef, row: RecordRow): StoredRecord {
  // SAFETY: the row comes from recordTables(schema): `id`, `resourceId`, and one column per declared one, of its kind.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      decodeValue(
        table.columns[key]?.type.kind,
        value instanceof Date
          ? Temporal.Instant.fromEpochMilliseconds(value.getTime())
          : value
      ),
    ])
  ) as StoredRecord;
}
