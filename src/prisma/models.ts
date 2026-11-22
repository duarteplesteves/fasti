import { check, sql } from "@prisma/orm-postgres/contract-builder";
import type {
  ContractModelBuilder,
  ScalarFieldBuilder,
  defineContract,
} from "@prisma/orm-postgres/contract-builder";

import { sqlLiteral } from "../schema/backstop-sql.js";
import type { ColumnKind } from "../schema/column.js";
import type {
  AnySchema,
  AvailabilityRuleColumn,
  BlockColumn,
  BookingColumn,
  Fields,
  HasBlocks,
} from "../schema/define-schema.js";
import type { Accepts } from "../schema/references.js";
import { statusCodec } from "../schema/status-codec.js";
import { tablesOf } from "../schema/table.js";
import type { Columns, TableDef, TableNamesOf } from "../schema/table.js";

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

/** A field of a model, as the model's `refs` give it; local or from another contract space. */
type TargetFieldRef = ContractModelBuilder<
  string,
  Record<string, ScalarFieldBuilder>,
  Record<string, never>,
  undefined,
  undefined,
  Record<string, never>,
  string
>["refs"][string];

/** A model of yours, e.g. `helpers.model("Staff", …)`. */
interface ResourceModel {
  readonly __fields: Readonly<Record<string, ScalarFieldBuilder>>;
  readonly refs: Readonly<Record<string, TargetFieldRef>>;
}

/** The codec id of a field's column. */
type CodecOf<F> =
  F extends ScalarFieldBuilder<infer State>
    ? NonNullable<State["descriptor"]>["codecId"]
    : never;

/** The codec of the Resource id column, by schema column kind, as {@link columnType} builds it. */
interface ResourceIdCodecs {
  readonly integer: "pg/int4@1";
  readonly text: "pg/text@1";
  readonly uuid: "pg/uuid@1";
}

/** The codec of `S`'s Resource id column. */
type ResourceIdCodec<S extends AnySchema> =
  ResourceIdCodecs[S["resource"]["idType"]["kind"]];

/**
 * Options of {@link prismaModels}.
 *
 * @typeParam S - The schema whose Resource id the target must hold.
 * @typeParam M - Your Resource model.
 * @typeParam F - The referenced field of `M`.
 */
export interface PrismaModelsOptions<
  S extends AnySchema,
  M extends ResourceModel,
  F extends keyof M["__fields"] & keyof M["refs"] & string,
> {
  /**
   * Your Resource model and its key field, e.g. `{ model: staff, field: "id" }`, for a foreign key
   * with `ON DELETE RESTRICT` from every fasti table's Resource id. The field's column must have the
   * Resource id column's type exactly (an `int8` target for an `integer` id is refused too). Without it there is no foreign key.
   */
  readonly references?: { readonly field: F; readonly model: M } & Accepts<
    CodecOf<M["__fields"][F]>,
    ResourceIdCodec<S>
  >;
}

/** The model of one physical table; its fields are widened so every fasti table has one model type. */
function tableModel(
  { model }: ContractHelpers,
  table: string,
  fields: Readonly<
    Record<string, ScalarFieldBuilder> & { resourceId: ScalarFieldBuilder }
  >,
  checks: readonly ReturnType<typeof check>[],
  references: TargetFieldRef | undefined
) {
  return model(table, { fields }).sql(({ cols, constraints }) => ({
    checks: [...checks],
    // No backing index, as on Drizzle Postgres: the tables stay the same when you switch ORM.
    foreignKeys:
      references === undefined
        ? []
        : [
            constraints.foreignKey(cols.resourceId, references, {
              index: false,
              onDelete: "restrict",
            }),
          ],
    table,
  }));
}

/** A contract model of any fasti table. */
type PrismaModel = ReturnType<typeof tableModel>;

/** One model per fasti table, keyed by its physical table name. The Block model only when `S` declares `block`; one per Plugin table. */
export type PrismaModels<S extends AnySchema> = Record<
  | S["names"]["tables"]["booking"]
  | S["names"]["tables"]["availabilityRule"]
  | TableNamesOf<S["plugins"]>,
  PrismaModel
> &
  (HasBlocks<S> extends true
    ? Record<S["names"]["tables"]["block"], PrismaModel>
    : unknown);

/**
 * The Prisma column type of a schema column kind. Instants are `timestamptz(3)` read as `Temporal.Instant` (I7);
 * dates are `date` strings, times `time`, JSON `jsonb`, as on Drizzle Postgres. A `dates` list is {@link column}'s.
 */
function columnType(
  { type }: ContractHelpers,
  kind: Exclude<ColumnKind, "dates">
) {
  switch (kind) {
    case "date": {
      return type.Date();
    }

    case "time": {
      return type.Time();
    }

    case "json": {
      return type.Jsonb();
    }

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

/** A `NOT NULL` column of a schema column kind; `dates` is `date[]`, as on Drizzle Postgres. */
function column(helpers: ContractHelpers, kind: ColumnKind, name: string) {
  return kind === "dates"
    ? helpers.field
        .column(helpers.type.Date())
        .many({ elementsNullable: true })
        .column(name)
    : helpers.field.column(columnType(helpers, kind)).column(name);
}

/** One field per Developer Field or Plugin table column, keyed by logical name; nullable unless required. */
function fieldColumns(
  helpers: ContractHelpers,
  fields: Columns,
  names: Readonly<Partial<Record<string, string>>>
) {
  return Object.fromEntries(
    Object.entries(fields).map(([name, def]) => {
      const col = column(helpers, def.type.kind, names[name] ?? name);

      return [name, def.required ? col : col.optional()];
    })
  );
}

/** The Booking model. Status is `text` with a `CHECK` over its stored values, as on Drizzle Postgres. */
function bookingModel(
  schema: AnySchema,
  helpers: ContractHelpers,
  references: TargetFieldRef | undefined
) {
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
    ],
    references
  );
}

/** The Block model, for a schema that declares `block`. */
function blockModel(
  schema: AnySchema,
  fields: Fields,
  helpers: ContractHelpers,
  references: TargetFieldRef | undefined
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
    [],
    references
  );
}

/** The AvailabilityRule model. Its primary key is generated and private; dates are `date` strings, the window `time`. */
function availabilityRuleModel(
  schema: AnySchema,
  helpers: ContractHelpers,
  references: TargetFieldRef | undefined
) {
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
    [],
    references
  );
}

/** One Plugin table, named logically as on Drizzle: `id` (fasti mints it; the database default stays, R4), `resourceId`, a timed table's range, then its columns. */
function pluginModel(
  schema: AnySchema,
  name: string,
  { columns, timed }: TableDef,
  helpers: ContractHelpers,
  references: TargetFieldRef | undefined
) {
  const { field, type } = helpers;

  return tableModel(
    helpers,
    name,
    {
      id: field
        .column(type.Uuid())
        .id()
        .default(sql`gen_random_uuid()`)
        .column("id"),
      resourceId: column(helpers, schema.resource.idType.kind, "resourceId"),
      ...(timed && {
        start: column(helpers, "instant", "start"),
        end: column(helpers, "instant", "end"),
      }),
      ...fieldColumns(helpers, columns, {}),
    },
    [],
    references
  );
}

/**
 * The fasti tables of `schema` as Prisma 8 contract models, keyed and named by your physical
 * table names, with your physical column names; each Plugin table, as on Drizzle, by its logical names.
 * Spread it into your `defineContract` models:
 * `defineContract({}, (helpers) => ({ models: { ...mine, ...prismaModels(schema, helpers) } }))`.
 * Pass `{ references: { model: staff, field: "id" } }` for a foreign key to your Resource model.
 *
 * @experimental While Prisma 8 is a release candidate.
 */
export function prismaModels<
  S extends AnySchema,
  M extends ResourceModel = ResourceModel,
  F extends keyof M["__fields"] & keyof M["refs"] & string = string,
>(
  schema: S,
  helpers: ContractHelpers,
  options: PrismaModelsOptions<S, M, F> = {}
): PrismaModels<S> {
  const { tables } = schema.names;

  const resourceIdTarget =
    options.references === undefined
      ? undefined
      : options.references.model.refs[options.references.field];

  const models: [string, PrismaModel][] = [
    [tables.booking, bookingModel(schema, helpers, resourceIdTarget)],
    [
      tables.availabilityRule,
      availabilityRuleModel(schema, helpers, resourceIdTarget),
    ],
  ];

  if (schema.block !== null) {
    models.push([
      tables.block,
      blockModel(schema, schema.block.fields, helpers, resourceIdTarget),
    ]);
  }

  for (const [name, def] of Object.entries(tablesOf(schema.plugins))) {
    models.push([
      name,
      pluginModel(schema, name, def, helpers, resourceIdTarget),
    ]);
  }

  // SAFETY: the keys are S's physical table names, the Block one exactly when S declares `block`, and one per Plugin table.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  return Object.fromEntries(models) as PrismaModels<S>;
}
