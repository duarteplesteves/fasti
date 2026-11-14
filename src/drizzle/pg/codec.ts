import type { BookingRecord, RuleRecord } from "../../adapter/records.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { StatusCodec } from "../../schema/status-codec.js";

/** A value a Booking record holds. */
type RecordValue = string | number | boolean | Temporal.Instant | null;

/** A value of a Booking row as Drizzle reads and writes it: `Date` in place of Instants. */
type RowValue = string | number | boolean | Date | null;

/** A Booking row: logical keys, `Date`s, the stored Status. */
export type BookingRow = Readonly<Record<string, RowValue>>;

/** One record value as the driver takes it. */
function toDriver(
  codec: StatusCodec<string>,
  key: string,
  value: RecordValue
): RowValue {
  if (value instanceof Temporal.Instant) {
    return new Date(value.epochMilliseconds);
  }

  return key === "status" ? codec.toStored(String(value)) : value;
}

/**
 * Record → row: Instants become `Date`s (milliseconds, I7), the Status its stored value.
 * A partial record (an update's changes) gives a partial row.
 */
export function encodeBooking<S extends AnySchema>(
  codec: StatusCodec<string>,
  record: Partial<BookingRecord<S>>
): BookingRow {
  return Object.fromEntries(
    Object.entries<RecordValue | undefined>(record)
      // A partial record's absent keys: nothing to write.
      .filter((entry): entry is [string, RecordValue] => entry[1] !== undefined)
      .map(([key, value]) => [key, toDriver(codec, key, value)])
  );
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
