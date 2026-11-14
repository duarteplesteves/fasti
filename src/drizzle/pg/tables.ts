import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { ResourceIdOf } from "../../adapter/records.js";
import type { AnyColumn } from "../../schema/column.js";
import type { AnySchema, BookingColumn } from "../../schema/define-schema.js";
import { statusCodec } from "../../schema/status-codec.js";

/** Resolves to `unknown` when a column of data type `D` can hold every `T`; otherwise to an error-carrying type. */
type Accepts<D, T> = [T] extends [D]
  ? unknown
  : {
      readonly "references: the column's type must hold the Resource id type": T;
    };

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

/** A SQL string literal, for DDL, where values can't be parameters. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The Booking table of `schema`, with your physical names, for your drizzle-kit schema file.
 * Columns are keyed by logical name. Status is `text` with a `CHECK` over its stored values.
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

  const resourceId = pgColumn(
    schema.resource.idType,
    names.resourceId
  ).notNull();

  if (options.references !== undefined) {
    resourceId.references(options.references, { onDelete: "restrict" });
  }

  const fields = Object.fromEntries(
    Object.entries(schema.booking.fields).map(([field, def]) => {
      const col = pgColumn(def.type, names[field] ?? field);

      return [field, def.required ? col.notNull() : col];
    })
  );

  const columns = {
    id: uuid(names.id).primaryKey(),
    resourceId,
    start: pgColumn({ kind: "instant" }, names.start).notNull(),
    end: pgColumn({ kind: "instant" }, names.end).notNull(),
    status: text(names.status).notNull(),
    ...fields,
  };

  const stored = statusCodec(schema).allStored.map(literal).join(", ");
  const table = schema.names.tables.booking;

  return pgTable(table, columns, (self) => [
    // DDL takes no bind parameters, so the stored values go in as escaped literals.
    check(`${table}_status_check`, sql`${self.status} in (${sql.raw(stored)})`),
  ]);
}
