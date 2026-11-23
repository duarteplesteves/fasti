import type { AnySchema, BookingColumn } from "./define-schema.js";
import { statusCodec } from "./status-codec.js";

/** A SQL string literal, for DDL, where values can't be parameters. */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A quoted SQL identifier. */
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The name of the backstop constraint on the Booking table of `schema`. */
export function noOverlapConstraint(schema: AnySchema): string {
  return `${schema.names.tables.booking}_no_overlap`;
}

/**
 * The backstop (ADR 008): an `EXCLUDE` constraint so no two Bookings in blocking Statuses overlap on
 * one Resource, even when a write skips fasti's check. drizzle 1.0 can't express `EXCLUDE`, so add these
 * statements to a custom migration (`drizzle-kit generate --custom`); with Prisma, to the raw SQL of
 * `prisma migration new`. A clash it catches makes
 * `insertBooking` / `updateBooking` return `conflict`.
 *
 * Correct for capacity 1 only: it forbids any overlap of blocking Bookings on a Resource.
 * drizzle-kit doesn't track the constraint: later generated migrations neither include nor drop it.
 * It lists the blocking Statuses, so when you add, remove or flip a blocking Status, drop the constraint and re-run these statements in a new migration.
 */
export function backstopSql(schema: AnySchema): readonly string[] {
  // SAFETY: defineSchema names every Booking column; AnySchema only widens the keys to string.
  const columns = schema.names.columns.booking as Readonly<
    Record<BookingColumn, string>
  >;

  const blocking = statusCodec(schema)
    .blockingStored.map(sqlLiteral)
    .join(", ");

  return [
    "create extension if not exists btree_gist",
    `alter table ${identifier(schema.names.tables.booking)} add constraint ${identifier(noOverlapConstraint(schema))} exclude using gist (${identifier(columns.resourceId)} with =, tstzrange(${identifier(columns.start)}, ${identifier(columns.end)}, '[)') with &&) where (${identifier(columns.status)} in (${blocking}))`,
  ];
}
