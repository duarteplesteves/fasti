import { decodeValue, encodeValue } from "../adapter/column-value.js";
import type { StoredRecord, StoredValue } from "../adapter/contract.js";
import type { BookingChanges, BookingRecord } from "../adapter/records.js";
import type { Json } from "../schema/column.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";
import type { TableDef } from "../schema/table.js";

/** A value as the contract's codecs read and write it: Instants stay `Temporal.Instant` (`DateTime(as: temporal)`). */
export type PrismaValue = Temporal.Instant | Json;

/** A row of a fasti table, keyed by physical column name, as the SQL builder reads and writes it. */
export type PrismaRow = Readonly<Record<string, PrismaValue>>;

/** Logical column name → physical column name, as `schema.names.columns.*` holds them. */
export type ColumnNames = Readonly<Record<string, string>>;

/**
 * The physical name of logical column `key`.
 *
 * @returns The physical name, or `key` when it has none.
 */
export function physical(names: ColumnNames, key: string): string {
  const name = names[key];

  if (name === undefined) {
    throw new Error(`prismaAdapter: no column "${key}"`);
  }

  return name;
}

/**
 * Record → row: logical keys become physical column names, values as they are.
 * Keys left `undefined` (an update's changes leave them out) are dropped, giving a partial row.
 *
 * @returns The row.
 */
export function encodeRecord<S extends AnySchema>(
  names: ColumnNames,
  record: BookingRecord<S> | BookingChanges<S>
): PrismaRow {
  return Object.fromEntries(
    // SAFETY: Booking records hold only PrismaValues; TS can't resolve a generic S's fields to them.
    Object.entries(record as Readonly<Record<string, PrismaValue | undefined>>)
      .filter((entry): entry is [string, PrismaValue] => entry[1] !== undefined)
      .map(([key, value]) => [physical(names, key), value])
  );
}

/**
 * Row → record values: physical column names become logical keys.
 *
 * @returns The record values, by logical key.
 */
function decodeRecord(
  names: ColumnNames,
  row: PrismaRow
): Readonly<Record<string, PrismaValue>> {
  return Object.fromEntries(
    Object.entries(names).map(([key, name]) => [key, row[name] ?? null])
  );
}

/**
 * Booking record → row: {@link encodeRecord}, and the Status its stored value.
 *
 * @returns The row.
 */
export function encodeBooking<S extends AnySchema>(
  codec: StatusCodec<string>,
  names: ColumnNames,
  record: BookingRecord<S> | BookingChanges<S>
): PrismaRow {
  const row = encodeRecord(names, record);

  return record.status === undefined
    ? row
    : { ...row, [physical(names, "status")]: codec.toStored(record.status) };
}

/**
 * Row → Booking record. A stored Status the schema doesn't know throws, so the read rejects.
 *
 * @returns The Booking record.
 */
export function decodeBooking<S extends AnySchema>(
  codec: StatusCodec<string>,
  names: ColumnNames,
  row: PrismaRow
): BookingRecord<S> {
  const stored = row[physical(names, "status")];

  const known = codec.allStored.find((s) => s === stored);
  const status = known === undefined ? undefined : codec.fromStored(known);

  if (status === undefined) {
    throw new Error(
      `prismaAdapter: stored Status ${JSON.stringify(stored)} is not in the schema`
    );
  }

  // SAFETY: the row comes from the Booking model of prismaModels(schema): one column per record key, of the declared kind.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
  return { ...decodeRecord(names, row), status } as BookingRecord<S>;
}

/**
 * Plugin record → row, column by column, logical keys to physical names; works on a partial record (an update's changes) too.
 *
 * @returns The row.
 */
export function encodeStored(
  names: ColumnNames,
  record: Readonly<Record<string, StoredValue>>
): PrismaRow {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      physical(names, key),
      encodeValue(value),
    ])
  );
}

/**
 * Row → Plugin record of `table`, column by column, physical names to logical keys.
 *
 * @returns The Plugin record.
 */
export function decodeStored(
  table: TableDef,
  names: ColumnNames,
  row: PrismaRow
): StoredRecord {
  // SAFETY: the row comes from the model prismaModels builds for `table`: `id`, `resourceId`, and one column per declared one, of its kind.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
  return Object.fromEntries(
    Object.entries(names).map(([key, name]) => [
      key,
      decodeValue(table.columns[key]?.type.kind, row[name] ?? null),
    ])
  ) as StoredRecord;
}
