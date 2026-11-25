import { defineContract } from "@prisma/orm-postgres/contract-builder";
import { describe, expect, it } from "vitest";

import type { AnySchema } from "../schema/define-schema.js";
import {
  integerIdSchema,
  recordsSchema,
  textIdSchema,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";
import { prismaModels } from "./models.js";

interface StorageColumn {
  readonly codecId: string;
  readonly dataType: string;
  readonly many: unknown;
  readonly nullable: boolean;
}

/** The storage tables of a contract built from `prismaModels(schema)` alone, by physical name. */
function tablesOf(
  schema: AnySchema
): Record<string, Record<string, StorageColumn>> {
  const contract = defineContract({}, (helpers) => ({
    models: prismaModels(schema, helpers),
  }));

  const tables = contract.storage.namespaces.public.entries.table;

  return Object.fromEntries(
    Object.entries(tables).map(([name, table]) => [name, table.columns])
  );
}

describe(prismaModels, () => {
  it("names the Booking table and its columns physically, with the Resource id type", () => {
    const booking = tablesOf(textIdSchema)["t_appointments"];

    expect(booking).toMatchObject({
      t_booking_id: { codecId: "pg/uuid@1", nullable: false },
      t_staff_id: { codecId: "pg/text@1", nullable: false },
      t_state: { codecId: "pg/text@1", nullable: false },
    });
    expect(tablesOf(integerIdSchema)["i_visits"]).toMatchObject({
      i_staff_id: { codecId: "pg/int4@1", nullable: false },
    });
    expect(tablesOf(uuidIdSchema)["u_reservations"]).toMatchObject({
      u_room_id: { codecId: "pg/uuid@1", nullable: false },
    });
  });

  it("stores instants as timestamptz read as Temporal.Instant", () => {
    expect(tablesOf(textIdSchema)["t_appointments"]).toMatchObject({
      t_ends_at: { codecId: "pg/timestamptz-temporal@1", nullable: false },
      t_starts_at: { codecId: "pg/timestamptz-temporal@1", nullable: false },
    });
  });

  it("adds a Block table only when the schema declares block", () => {
    expect(tablesOf(textIdSchema)["t_time_off"]).toMatchObject({
      t_flag_opt: { codecId: "pg/bool@1", nullable: true },
      t_note: { codecId: "pg/text@1", nullable: false },
      t_off_ends_at: {
        codecId: "pg/timestamptz-temporal@1",
        nullable: false,
      },
      t_off_id: { codecId: "pg/uuid@1", nullable: false },
      t_off_staff_id: { codecId: "pg/text@1", nullable: false },
      t_off_starts_at: {
        codecId: "pg/timestamptz-temporal@1",
        nullable: false,
      },
      t_until_opt: { codecId: "pg/timestamptz-temporal@1", nullable: true },
    });
    expect(Object.keys(tablesOf(integerIdSchema)).toSorted()).toStrictEqual([
      "i_hours",
      "i_visits",
    ]);
  });

  it("types the AvailabilityRule table as Drizzle Postgres does: jsonb, time, date and date[]", () => {
    expect(tablesOf(textIdSchema)["t_hours"]).toMatchObject({
      t_effective_from: { dataType: "pg/date", nullable: true },
      t_effective_to: { dataType: "pg/date", nullable: true },
      t_exceptions: {
        dataType: "pg/date",
        many: { elementNullable: true },
        nullable: false,
      },
      t_id: { dataType: "pg/uuid", nullable: false },
      t_recurrence: { dataType: "pg/jsonb", nullable: false },
      t_staff_id: { dataType: "pg/text", nullable: false },
      t_tz: { dataType: "pg/text", nullable: false },
      t_window_end: { dataType: "pg/time", nullable: false },
      t_window_start: { dataType: "pg/time", nullable: false },
    });
  });

  it("adds a column per Developer Field, nullable only when optional", () => {
    expect(tablesOf(textIdSchema)["t_appointments"]).toMatchObject({
      t_count: { codecId: "pg/int4@1", nullable: false },
      t_count_opt: { codecId: "pg/int4@1", nullable: true },
      t_label: { codecId: "pg/text@1", nullable: false },
      t_label_opt: { codecId: "pg/text@1", nullable: true },
      t_paid: { codecId: "pg/bool@1", nullable: false },
      t_paid_opt: { codecId: "pg/bool@1", nullable: true },
      t_ref: { codecId: "pg/uuid@1", nullable: false },
      t_ref_opt: { codecId: "pg/uuid@1", nullable: true },
      t_remind_at: {
        codecId: "pg/timestamptz-temporal@1",
        nullable: false,
      },
      t_remind_at_opt: {
        codecId: "pg/timestamptz-temporal@1",
        nullable: true,
      },
    });
  });
});

describe("prismaModels Plugin tables", () => {
  /** Every column kind of the conformance Plugin, required and optional, by logical name. */
  const kinds = {
    boolean: { codecId: "pg/bool@1", nullable: false },
    booleanOpt: { codecId: "pg/bool@1", nullable: true },
    date: { dataType: "pg/date", nullable: false },
    dateOpt: { dataType: "pg/date", nullable: true },
    dates: {
      dataType: "pg/date",
      many: { elementNullable: true },
      nullable: false,
    },
    datesOpt: {
      dataType: "pg/date",
      many: { elementNullable: true },
      nullable: true,
    },
    instant: { codecId: "pg/timestamptz-temporal@1", nullable: false },
    instantOpt: { codecId: "pg/timestamptz-temporal@1", nullable: true },
    integer: { codecId: "pg/int4@1", nullable: false },
    integerOpt: { codecId: "pg/int4@1", nullable: true },
    json: { dataType: "pg/jsonb", nullable: false },
    jsonOpt: { dataType: "pg/jsonb", nullable: true },
    text: { codecId: "pg/text@1", nullable: false },
    textOpt: { codecId: "pg/text@1", nullable: true },
    time: { dataType: "pg/time", nullable: false },
    timeOpt: { dataType: "pg/time", nullable: true },
    uuid: { codecId: "pg/uuid@1", nullable: false },
    uuidOpt: { codecId: "pg/uuid@1", nullable: true },
  };

  it("adds one table per Plugin table, named logically: id with a database default (R4), resourceId, the range only when timed", () => {
    const tables = tablesOf(recordsSchema);

    const own = {
      id: { dataType: "pg/uuid", nullable: false },
      resourceId: { codecId: "pg/text@1", nullable: false },
    };

    const range = {
      end: { codecId: "pg/timestamptz-temporal@1", nullable: false },
      start: { codecId: "pg/timestamptz-temporal@1", nullable: false },
    };

    expect(tables["conformanceTimed"]).toMatchObject({
      ...own,
      ...range,
      ...kinds,
    });
    expect(tables["conformanceUntimed"]).toMatchObject({ ...own, ...kinds });
    expect(
      Object.keys(tables["conformanceUntimed"] ?? {}).toSorted()
    ).toStrictEqual(["id", "resourceId", ...Object.keys(kinds)].toSorted());
    expect(tables["conformanceTimed"]?.["id"]).toHaveProperty("default");
  });
});

/** The foreign keys and indexes of each table, with a `dev_resource` model of `kind` ids as the Resource. */
function foreignKeysOf(schema: AnySchema, kind: "Int" | "Uuid") {
  const contract = defineContract({}, (helpers) => {
    const resource = helpers
      .model("Resource", {
        fields: {
          id: helpers.field.column(helpers.type[kind]()).id().column("id"),
        },
      })
      .sql({ table: "dev_resource" });

    return {
      models: {
        Resource: resource,
        ...prismaModels(schema, helpers, {
          // SAFETY: callers pair each schema with the `kind` of its Resource id; the type test below checks the pairing.
          // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- see above.
          references: { field: "id", model: resource } as never,
        }),
      },
    };
  });

  const tables = contract.storage.namespaces.public.entries.table;

  return Object.fromEntries(
    Object.entries(tables).map(([name, table]) => [
      name,
      { foreignKeys: table.foreignKeys, indexes: table.indexes },
    ])
  );
}

/** The foreign key from `column` to `dev_resource.id`, and the table's own index on `column` then `rest`. */
function fk(column: string, index: string, ...rest: readonly string[]) {
  return {
    foreignKeys: [
      {
        onDelete: "restrict",
        source: { columns: [column] },
        target: { columns: ["id"], tableName: "dev_resource" },
      },
    ],
    indexes: [{ columns: [column, ...rest], name: index }],
  };
}

describe("prismaModels references", () => {
  it("adds a foreign key on the Resource id column of every table, ON DELETE RESTRICT, with no index of its own", () => {
    expect(foreignKeysOf(uuidIdSchema, "Uuid")).toMatchObject({
      u_closures: fk(
        "u_off_room_id",
        "u_closures_resource_start_idx",
        "u_off_starts_at",
        "u_off_ends_at"
      ),
      u_hours: fk("u_staff_id", "u_hours_resource_idx"),
      u_reservations: fk(
        "u_room_id",
        "u_reservations_resource_start_idx",
        "u_starts_at",
        "u_ends_at"
      ),
    });
    expect(foreignKeysOf(integerIdSchema, "Int")).toMatchObject({
      i_hours: fk("i_staff_id", "i_hours_resource_idx"),
      i_visits: fk(
        "i_staff_id",
        "i_visits_resource_start_idx",
        "i_starts_at",
        "i_ends_at"
      ),
    });
  });

  it("adds no foreign key without references", () => {
    const contract = defineContract({}, (helpers) => ({
      models: prismaModels(integerIdSchema, helpers),
    }));

    for (const table of Object.values(
      contract.storage.namespaces.public.entries.table
    )) {
      expect(table.foreignKeys).toStrictEqual([]);
    }
  });

  it("type-checks only a target whose column type is the Resource id's (the @ts-expect-error lines are the assertions)", () => {
    expect(() =>
      defineContract({}, (helpers) => {
        const staff = helpers.model("Staff", {
          fields: {
            id: helpers.field.column(helpers.type.Int()).id(),
            slug: helpers.field.column(helpers.type.String()),
            uuid: helpers.field.column(helpers.type.Uuid()),
          },
        });

        return {
          models: {
            Staff: staff,
            ...prismaModels(integerIdSchema, helpers, {
              references: { field: "id", model: staff },
            }),
            ...prismaModels(textIdSchema, helpers, {
              references: { field: "slug", model: staff },
            }),
            ...prismaModels(uuidIdSchema, helpers, {
              // @ts-expect-error an int4 column can't hold a uuid Resource id
              references: { field: "id", model: staff },
            }),
            ...prismaModels(textIdSchema, helpers, {
              // @ts-expect-error a uuid column can't hold a text Resource id: Postgres refuses the foreign key
              references: { field: "uuid", model: staff },
            }),
            ...prismaModels(integerIdSchema, helpers, {
              // @ts-expect-error not a field of Staff
              references: { field: "nope", model: staff },
            }),
          },
        };
      })
    ).toBeDefined();
  });
});
