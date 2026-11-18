import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  check,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  time,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { ResourceIdOf } from "../../adapter/records.js";
import type { Recurrence } from "../../core/types.js";
import { sqlLiteral } from "../../schema/backstop-sql.js";
import type { AnyColumn } from "../../schema/column.js";
import type {
  AnySchema,
  AvailabilityRuleColumn,
  BlockColumn,
  BlockSchema,
  BookingColumn,
  Fields,
} from "../../schema/define-schema.js";
import { statusCodec } from "../../schema/status-codec.js";
import type { Accepts } from "../references.js";

/**
 * Options of {@link bookingTable}.
 *
 * @typeParam C - The referenced column.
 */
export interface TableOptions<S extends AnySchema, C extends AnyPgColumn> {
  /**
   * Your Resource column, e.g. `() => staff.id`, for a foreign key with `ON DELETE RESTRICT`.
   * Its type must hold the schema's Resource id type. Without it there is no foreign key.
   */
  readonly references?: () => C & Accepts<C["_"]["data"], ResourceIdOf<S>>;
}

/** A Postgres column of a schema column kind. Instants are `timestamptz` to the millisecond (I7). */
function pgColumn(type: AnyColumn, name: string) {
  switch (type.kind) {
    case "text": {
      return text(name);
    }

    case "uuid": {
      return uuid(name);
    }

    case "integer": {
      return integer(name);
    }

    case "boolean": {
      return boolean(name);
    }

    case "instant": {
      return timestamp(name, {
        mode: "date",
        precision: 3,
        withTimezone: true,
      });
    }

    default: {
      throw new Error(`Unknown column kind: ${JSON.stringify(type)}`);
    }
  }
}

/** The `NOT NULL` Resource id column, with its foreign key when `references` is given. */
function resourceIdColumn<S extends AnySchema, C extends AnyPgColumn>(
  schema: S,
  name: string,
  options: TableOptions<S, C>
) {
  const col = pgColumn(schema.resource.idType, name).notNull();

  if (options.references !== undefined) {
    col.references(options.references, { onDelete: "restrict" });
  }

  return col;
}

/** One column per Developer Field, keyed by logical name; `NOT NULL` when required. */
function fieldColumns(
  fields: Fields,
  names: Readonly<Partial<Record<string, string>>>
) {
  return Object.fromEntries(
    Object.entries(fields).map(([field, def]) => {
      const col = pgColumn(def.type, names[field] ?? field);

      return [field, def.required ? col.notNull() : col];
    })
  );
}

/**
 * The Booking table of `schema`, with your physical names, for your drizzle-kit schema file.
 * Columns are keyed by logical name. Status is `text` with a `CHECK` over its stored values,
 * so declaring a Status changes the table: generate a migration, and re-run `backstopSql` if it blocks.
 */
export function bookingTable<
  S extends AnySchema,
  C extends AnyPgColumn = AnyPgColumn,
>(schema: S, options: TableOptions<S, C> = {}) {
  // SAFETY: defineSchema names every Booking column and Developer Field; a generic S only widens the keys to string.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  const names = schema.names.columns.booking as Readonly<
    Record<BookingColumn, string> & Partial<Record<string, string>>
  >;

  const resourceId = resourceIdColumn(schema, names.resourceId, options);

  const columns = {
    id: uuid(names.id).primaryKey(),
    resourceId,
    start: pgColumn({ kind: "instant" }, names.start).notNull(),
    end: pgColumn({ kind: "instant" }, names.end).notNull(),
    status: text(names.status).notNull(),
    ...fieldColumns(schema.booking.fields, names),
  };

  const stored = statusCodec(schema).allStored.map(sqlLiteral).join(", ");
  const table = schema.names.tables.booking;

  return pgTable(table, columns, (self) => [
    // DDL takes no bind parameters, so the stored values go in as escaped literals.
    check(`${table}_status_check`, sql`${self.status} in (${sql.raw(stored)})`),
  ]);
}

/**
 * The Block table of `schema`, with your physical names, for your drizzle-kit schema file.
 * Columns are keyed by logical name. Only for a schema that declares `block`.
 */
export function blockTable<
  S extends BlockSchema,
  C extends AnyPgColumn = AnyPgColumn,
>(schema: S, options: TableOptions<S, C> = {}) {
  // SAFETY: defineSchema names every Block column and Developer Field; a generic S only widens the keys to string.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  const names = schema.names.columns.block as Readonly<
    Record<BlockColumn, string> & Partial<Record<string, string>>
  >;

  return pgTable(schema.names.tables.block, {
    id: uuid(names.id).primaryKey(),
    resourceId: resourceIdColumn(schema, names.resourceId, options),
    start: pgColumn({ kind: "instant" }, names.start).notNull(),
    end: pgColumn({ kind: "instant" }, names.end).notNull(),
    ...fieldColumns(schema.block.fields, names),
  });
}

/**
 * The AvailabilityRule table of `schema`, with your physical names, for your drizzle-kit schema file.
 * Its primary key is generated and private; dates are `date` strings, the window `time`.
 */
export function availabilityRuleTable<
  S extends AnySchema,
  C extends AnyPgColumn = AnyPgColumn,
>(schema: S, options: TableOptions<S, C> = {}) {
  const names: Readonly<Record<AvailabilityRuleColumn, string>> =
    schema.names.columns.availabilityRule;

  return pgTable(schema.names.tables.availabilityRule, {
    id: uuid(names.id).primaryKey().defaultRandom(),
    resourceId: resourceIdColumn(schema, names.resourceId, options),
    recurrence: jsonb(names.recurrence).$type<Recurrence>().notNull(),
    windowStart: time(names.windowStart).notNull(),
    windowEnd: time(names.windowEnd).notNull(),
    timezone: text(names.timezone).notNull(),
    effectiveFrom: date(names.effectiveFrom, { mode: "string" }),
    effectiveTo: date(names.effectiveTo, { mode: "string" }),
    exceptions: date(names.exceptions, { mode: "string" }).array().notNull(),
  });
}
