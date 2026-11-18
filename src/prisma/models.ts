import { check, sql } from "@prisma/orm-postgres/contract-builder";
import type {
  ScalarFieldBuilder,
  defineContract,
} from "@prisma/orm-postgres/contract-builder";

import type { AnyColumn } from "../schema/column.js";
import type {
  AnySchema,
  AvailabilityRuleColumn,
  BlockColumn,
  BookingColumn,
  Fields,
  HasBlocks,
} from "../schema/define-schema.js";
import { statusCodec } from "../schema/status-codec.js";

/** The helpers `defineContract`'s callback receives. */
export type ContractHelpers = Parameters<
  Parameters<typeof defineContract>[1]
>[0];

/**
 * A `sql` value of text built at runtime. The tag only takes template literals, so this hands it
 * a one-piece template; it reads `raw`, which holds `text` unchanged.
 */
function sqlText(text: string) {
  return sql(Object.assign([text], { raw: [text] }));
}

/** The model of one physical table; its fields are widened so every fasti table has one model type. */
function tableModel(
  { model }: ContractHelpers,
  table: string,
  fields: Readonly<Record<string, ScalarFieldBuilder>>,
  checks: readonly ReturnType<typeof check>[]
) {
  return model(table, { fields }).sql({ checks: [...checks], table });
}

/** A contract model of any fasti table. */
type PrismaModel = ReturnType<typeof tableModel>;

/** One model per fasti table, keyed by its physical table name. The Block model only when `S` declares `block`. */
export type PrismaModels<S extends AnySchema> = Record<
  S["names"]["tables"]["booking"] | S["names"]["tables"]["availabilityRule"],
  PrismaModel
> &
  (HasBlocks<S> extends true
    ? Record<S["names"]["tables"]["block"], PrismaModel>
    : unknown);

/** The Prisma column type of a schema column kind. Instants are `timestamptz(3)` read as `Temporal.Instant` (I7). */
function columnType({ type }: ContractHelpers, kind: AnyColumn["kind"]) {
  switch (kind) {
    case "text": {
      return type.String();
    }

    case "uuid": {
      return type.Uuid();
    }

    case "integer": {
      return type.Int();
    }

    case "boolean": {
      return type.Boolean();
    }

    case "instant": {
      return type.DateTime({ as: "temporal", precision: 3 });
    }

    default: {
      throw new Error(`Unknown column kind: ${JSON.stringify(kind)}`);
    }
  }
}

/** A `NOT NULL` column of a schema column kind. */
function column(
  helpers: ContractHelpers,
  kind: AnyColumn["kind"],
  name: string
) {
  return helpers.field.column(columnType(helpers, kind)).column(name);
}

/** One field per Developer Field, keyed by logical name; nullable unless required. */
function fieldColumns(
  helpers: ContractHelpers,
  fields: Fields,
  names: Readonly<Partial<Record<string, string>>>
) {
  return Object.fromEntries(
    Object.entries(fields).map(([name, def]) => {
      const col = column(helpers, def.type.kind, names[name] ?? name);

      return [name, def.required ? col : col.optional()];
    })
  );
}

/** A SQL string literal, for DDL, where values can't be parameters. */
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The Booking model. Status is `text` with a `CHECK` over its stored values, as on Drizzle Postgres. */
function bookingModel(schema: AnySchema, helpers: ContractHelpers) {
  // SAFETY: defineSchema names every Booking column and Developer Field; a generic S only widens the keys to string.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  const names = schema.names.columns.booking as Readonly<
    Record<BookingColumn, string> & Partial<Record<string, string>>
  >;

  const table = schema.names.tables.booking;
  const stored = statusCodec(schema).allStored.map(sqlLiteral).join(", ");
  const status = `"${names.status.replaceAll('"', '""')}"`;

  return tableModel(
    helpers,
    table,
    {
      id: helpers.field.column(helpers.type.Uuid()).id().column(names.id),
      resourceId: column(
        helpers,
        schema.resource.idType.kind,
        names.resourceId
      ),
      start: column(helpers, "instant", names.start),
      end: column(helpers, "instant", names.end),
      status: column(helpers, "text", names.status),
      ...fieldColumns(helpers, schema.booking.fields, names),
    },
    [
      check({
        expression: sqlText(`${status} in (${stored})`),
        name: `${table}_status_check`,
      }),
    ]
  );
}

/** The Block model, for a schema that declares `block`. */
function blockModel(
  schema: AnySchema,
  fields: Fields,
  helpers: ContractHelpers
) {
  // SAFETY: defineSchema names every Block column and Developer Field; a generic S only widens the keys to string.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  const names = schema.names.columns.block as Readonly<
    Record<BlockColumn, string> & Partial<Record<string, string>>
  >;

  return tableModel(
    helpers,
    schema.names.tables.block,
    {
      id: helpers.field.column(helpers.type.Uuid()).id().column(names.id),
      resourceId: column(
        helpers,
        schema.resource.idType.kind,
        names.resourceId
      ),
      start: column(helpers, "instant", names.start),
      end: column(helpers, "instant", names.end),
      ...fieldColumns(helpers, fields, names),
    },
    []
  );
}

/** The AvailabilityRule model. Its primary key is generated and private; dates are `date` strings, the window `time`. */
function availabilityRuleModel(schema: AnySchema, helpers: ContractHelpers) {
  const { field, type } = helpers;

  const names: Readonly<Record<AvailabilityRuleColumn, string>> =
    schema.names.columns.availabilityRule;

  return tableModel(
    helpers,
    schema.names.tables.availabilityRule,
    {
      id: field
        .column(type.Uuid())
        .id()
        .default(sql`gen_random_uuid()`)
        .column(names.id),
      resourceId: column(
        helpers,
        schema.resource.idType.kind,
        names.resourceId
      ),
      recurrence: field.column(type.Jsonb()).column(names.recurrence),
      windowStart: field.column(type.Time()).column(names.windowStart),
      windowEnd: field.column(type.Time()).column(names.windowEnd),
      timezone: column(helpers, "text", names.timezone),
      effectiveFrom: field
        .column(type.Date())
        .optional()
        .column(names.effectiveFrom),
      effectiveTo: field
        .column(type.Date())
        .optional()
        .column(names.effectiveTo),
      exceptions: field
        .column(type.Date())
        .many({ elementsNullable: true })
        .column(names.exceptions),
    },
    []
  );
}

/**
 * The fasti tables of `schema` as Prisma 8 contract models, keyed and named by your physical
 * table names, with your physical column names. Spread it into your `defineContract` models:
 * `defineContract({}, (helpers) => ({ models: { ...mine, ...prismaModels(schema, helpers) } }))`.
 *
 * @experimental While Prisma 8 is a release candidate.
 */
export function prismaModels<S extends AnySchema>(
  schema: S,
  helpers: ContractHelpers
): PrismaModels<S> {
  const { tables } = schema.names;

  const models: [string, PrismaModel][] = [
    [tables.booking, bookingModel(schema, helpers)],
    [tables.availabilityRule, availabilityRuleModel(schema, helpers)],
  ];

  if (schema.block !== null) {
    models.push([
      tables.block,
      blockModel(schema, schema.block.fields, helpers),
    ]);
  }

  // SAFETY: the keys are S's physical table names, the Block one exactly when S declares `block`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  return Object.fromEntries(models) as PrismaModels<S>;
}
