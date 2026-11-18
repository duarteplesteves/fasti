import type {
  BlockChanges,
  BlockRecord,
  BookingChanges,
  BookingRecord,
  RuleRecord,
} from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";

/** A value a record holds. */
type RecordValue = string | number | boolean | Temporal.Instant | null;

/** A value of a row as Drizzle reads and writes it: `Date` in place of Instants. */
type RowValue = string | number | boolean | Date | null;

/** A Booking or Block row: logical keys, `Date`s (and for a Booking, the stored Status). */
export type Row = Readonly<Record<string, RowValue>>;

/**
 * Record → row: Instants become `Date`s (milliseconds, I7), everything else as is.
 * Keys left `undefined` (an update's changes leave them out) are dropped, giving a partial row.
 */
export function encodeRow<S extends AnySchema>(
  record:
    | BookingRecord<S>
    | BookingChanges<S>
    | BlockRecord<S>
    | BlockChanges<S>
): Row {
  return Object.fromEntries(
    // SAFETY: Booking and Block records hold only RecordValues; TS can't resolve a generic S's Block fields to them.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
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

/** Row → record values: `Date`s become Instants. */
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

/** Booking record → row: {@link encodeRow}, and the Status its stored value. */
export function encodeBooking<S extends AnySchema>(
  codec: StatusCodec<string>,
  record: BookingRecord<S> | BookingChanges<S>
): Row {
  const row = encodeRow(record);

  return record.status === undefined
    ? row
    : { ...row, status: codec.toStored(record.status) };
}

/** Row → Booking record. A stored Status the schema doesn't know throws, so the read rejects. */
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

/** Row → Block record. */
export function decodeBlock<S extends AnySchema>(row: Row): BlockRecord<S> {
  // SAFETY: the row comes from blockTable(schema): one column per record key, of the declared kind.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
  return decodeRow(row) as BlockRecord<S>;
}

/** An AvailabilityRule row as Drizzle reads it, without its private id. */
export interface RuleRow {
  readonly recurrence: RuleRecord["recurrence"];
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly timezone: string;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly exceptions: string[];
}

/** Rule → row: Temporal values become their ISO strings, unset dates `null`. */
export function encodeRule(rule: RuleRecord): RuleRow {
  return {
    effectiveFrom: rule.effectiveFrom?.toString() ?? null,
    effectiveTo: rule.effectiveTo?.toString() ?? null,
    exceptions: rule.exceptions.map(String),
    recurrence: rule.recurrence,
    timezone: rule.timezone,
    windowEnd: rule.timeWindow.end.toString(),
    windowStart: rule.timeWindow.start.toString(),
  };
}

/** A RuleRecord under construction, so the optional dates can be added after it. */
type RuleDraft = { -readonly [K in keyof RuleRecord]: RuleRecord[K] };

/** Row → rule: a `null` effective date is an absent key. */
export function decodeRule(row: RuleRow): RuleRecord {
  const rule: RuleDraft = {
    exceptions: row.exceptions.map((d) => Temporal.PlainDate.from(d)),
    recurrence: row.recurrence,
    timeWindow: {
      end: Temporal.PlainTime.from(row.windowEnd),
      start: Temporal.PlainTime.from(row.windowStart),
    },
    timezone: row.timezone,
  };

  if (row.effectiveFrom !== null) {
    rule.effectiveFrom = Temporal.PlainDate.from(row.effectiveFrom);
  }

  if (row.effectiveTo !== null) {
    rule.effectiveTo = Temporal.PlainDate.from(row.effectiveTo);
  }

  return rule;
}
