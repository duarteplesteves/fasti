import type {
  BlockChanges,
  BlockRecord,
  BookingChanges,
  BookingRecord,
  RuleRecord,
} from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";

/** A value as the contract's codecs read and write it: Instants stay `Temporal.Instant` (`DateTime(as: temporal)`). */
export type PrismaValue =
  | string
  | number
  | boolean
  | Temporal.Instant
  | RuleRecord["recurrence"]
  | readonly string[]
  | null;

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
  record:
    | BookingRecord<S>
    | BookingChanges<S>
    | BlockRecord<S>
    | BlockChanges<S>
): PrismaRow {
  return Object.fromEntries(
    // SAFETY: Booking and Block records hold only PrismaValues; TS can't resolve a generic S's fields to them.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
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

/** Row → Block record. */
export function decodeBlock<S extends AnySchema>(
  names: ColumnNames,
  row: PrismaRow
): BlockRecord<S> {
  // SAFETY: the row comes from the Block model of prismaModels(schema): one column per record key, of the declared kind.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
  return decodeRecord(names, row) as BlockRecord<S>;
}

/** Rule → row, without its private id: Temporal values become their ISO strings, unset dates `null`. */
export function encodeRule(names: ColumnNames, rule: RuleRecord) {
  return {
    [physical(names, "effectiveFrom")]: rule.effectiveFrom?.toString() ?? null,
    [physical(names, "effectiveTo")]: rule.effectiveTo?.toString() ?? null,
    [physical(names, "exceptions")]: rule.exceptions.map(String),
    [physical(names, "recurrence")]: rule.recurrence,
    [physical(names, "timezone")]: rule.timezone,
    [physical(names, "windowEnd")]: rule.timeWindow.end.toString(),
    [physical(names, "windowStart")]: rule.timeWindow.start.toString(),
  };
}

/** A RuleRecord under construction, so the optional dates can be added after it. */
type RuleDraft = { -readonly [K in keyof RuleRecord]: RuleRecord[K] };

/** Row → rule: a `null` effective date is an absent key. */
export function decodeRule(names: ColumnNames, row: PrismaRow): RuleRecord {
  // SAFETY: the row comes from the AvailabilityRule model of prismaModels(schema), whose columns have these types.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
  const value = decodeRecord(names, row) as {
    readonly recurrence: RuleRecord["recurrence"];
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly timezone: string;
    readonly effectiveFrom: string | null;
    readonly effectiveTo: string | null;
    readonly exceptions: readonly string[];
  };

  const rule: RuleDraft = {
    exceptions: value.exceptions.map((d) => Temporal.PlainDate.from(d)),
    recurrence: value.recurrence,
    timeWindow: {
      end: Temporal.PlainTime.from(value.windowEnd),
      start: Temporal.PlainTime.from(value.windowStart),
    },
    timezone: value.timezone,
  };

  if (value.effectiveFrom !== null) {
    rule.effectiveFrom = Temporal.PlainDate.from(value.effectiveFrom);
  }

  if (value.effectiveTo !== null) {
    rule.effectiveTo = Temporal.PlainDate.from(value.effectiveTo);
  }

  return rule;
}
