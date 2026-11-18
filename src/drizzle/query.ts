import { DrizzleQueryError, getColumns } from "drizzle-orm";
import type { Columns, Table } from "drizzle-orm";

/** Run a verb's queries; a driver failure rejects with the driver's own error as `cause`. */
export async function query<T>(
  verb: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Drizzle wraps the driver's error; the cause is the driver's own (its `code`, `constraint`).
    const cause = error instanceof DrizzleQueryError ? error.cause : error;

    // oxlint-disable-next-line preserve-caught-error -- `cause` is the caught error, unwrapped from Drizzle's.
    throw new Error(`drizzleAdapter: ${verb} failed`, { cause });
  }
}

/** A Booking or Block table, with its columns keyed by logical name. */
export interface RecordTable<T extends Table> {
  readonly table: T;
  readonly columns: T["_"]["columns"];
}

/** A Booking or Block table and its columns, keyed by logical name. */
export function recordTable<T extends Table>(table: T): RecordTable<T> {
  return { columns: getColumns(table), table };
}

/** A logical column of a record table; every record table has `id`, `resourceId`, `start`, `end`. */
export function col(
  { columns }: RecordTable<Table>,
  key: string
): Columns[string] {
  const c = columns[key];

  if (c === undefined) {
    throw new Error(`drizzleAdapter: no column "${key}"`);
  }

  return c;
}
