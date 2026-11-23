import { canonical, isList } from "../adapter/contract.js";
import type { StoredRecord, StoredValue } from "../adapter/contract.js";
import type { BookingChanges, BookingRecord } from "../adapter/records.js";
import type { ColumnKind, Json } from "../schema/column.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";
import type { TableDef } from "../schema/table.js";

/** A value as the contract's codecs read and write it: Instants stay `Temporal.Instant` (`DateTime(as: temporal)`). */
export type PrismaValue = Temporal.Instant | Json;

/** A row of a fasti table, keyed by physical column name, as the SQL builder reads and writes it. */
export type PrismaRow = Readonly<Record<string, PrismaValue>>;

/** Logical column name → physical column name, as `schema.names.columns.*` holds them. */
export type ColumnNames = Readonly<Record<string, string>>;

/** The physical name of logical column `key`. */
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

/** Row → record values: physical column names become logical keys. */
function decodeRecord(
  names: ColumnNames,
  row: PrismaRow
): Readonly<Record<string, PrismaValue>> {
  return Object.fromEntries(
    Object.entries(names).map(([key, name]) => [key, row[name] ?? null])
  );
}

/** Booking record → row: {@link encodeRecord}, and the Status its stored value. */
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

/** Row → Booking record. A stored Status the schema doesn't know throws, so the read rejects. */
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

/** One Plugin record value → its row value: PlainDates and PlainTimes (in lists too) to ISO strings, JSON canonical, Instants as they are. */
function encodeValue(value: StoredValue): PrismaValue {
  if (value instanceof Temporal.Instant) {
    return value;
  }

  if (
    value instanceof Temporal.PlainDate ||
    value instanceof Temporal.PlainTime
  ) {
    return value.toString();
  }

  if (isList(value)) {
    return value.map((v) =>
      v instanceof Temporal.PlainDate ? v.toString() : canonical(v)
    );
  }

  return canonical(value);
}

/** Plugin record → row, column by column, logical keys to physical names; works on a partial record (an update's changes) too. */
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

/** One row value of a column of `kind` → its value; `kind` is `undefined` for fasti's own columns. */
function decodeValue(
  kind: ColumnKind | undefined,
  value: PrismaValue
): StoredValue {
  if (value === null || value instanceof Temporal.Instant) {
    return value;
  }

  switch (kind) {
    case "date": {
      // SAFETY: prismaModels makes a `date` column `date`, read as an ISO string.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
      return Temporal.PlainDate.from(value as string);
    }

    case "time": {
      // SAFETY: prismaModels makes a `time` column `time`, read as an ISO string.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
      return Temporal.PlainTime.from(value as string);
    }

    case "dates": {
      // SAFETY: prismaModels makes a `dates` column `date[]`, read as ISO strings.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
      return (value as readonly string[]).map((d) =>
        Temporal.PlainDate.from(d)
      );
    }

    case "text":
    case "uuid":
    case "integer":
    case "boolean":
    case "instant":
    case "json":
    case undefined: {
      return value;
    }

    default: {
      throw new Error(`Unknown column kind: ${String(kind)}`);
    }
  }
}

/** Row → Plugin record of `table`, column by column, physical names to logical keys. */
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
