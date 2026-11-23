import type { ColumnKind, Json } from "../schema/column.js";
import { canonical, isList } from "./contract.js";
import type { StoredValue } from "./contract.js";

/** A Plugin record value as a SQL Adapter writes and reads it: Instants as they are, everything else JSON. Each Adapter maps Instants to its driver's type. */
export type ColumnValue = Temporal.Instant | Json;

/** One Plugin record value → its column value: PlainDates and PlainTimes (in lists too) to ISO strings, JSON canonical, Instants as they are. */
export function encodeValue(value: StoredValue): ColumnValue {
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

/** One column value of a column of `kind` → its Plugin record value; `kind` is `undefined` for fasti's own columns. */
export function decodeValue(
  kind: ColumnKind | undefined,
  value: ColumnValue
): StoredValue {
  if (value === null || value instanceof Temporal.Instant) {
    return value;
  }

  switch (kind) {
    case "date": {
      // SAFETY: every SQL Adapter stores a `date` column as an ISO date, read as a string.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
      return Temporal.PlainDate.from(value as string);
    }

    case "time": {
      // SAFETY: every SQL Adapter stores a `time` column as an ISO time, read as a string.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decoding a database row.
      return Temporal.PlainTime.from(value as string);
    }

    case "dates": {
      // SAFETY: every SQL Adapter stores a `dates` column as a list of ISO dates (`date[]`, or JSON text on SQLite), read as strings.
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
