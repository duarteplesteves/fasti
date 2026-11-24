import { readFileSync } from "node:fs";

import { integer as pgInteger, pgTable } from "drizzle-orm/pg-core";
import { integer as sqliteInteger, sqliteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { defineSchema } from "../schema/define-schema.js";
import {
  defaultParitySchema,
  renamedParitySchema,
} from "../test-utils/parity-schemas.js";
import { pgSnapshot, sqliteSnapshot } from "../test-utils/table-snapshot.js";
import * as pg from "./pg/index.js";
import { recordTables as pgRecordTables } from "./pg/index.js";
import * as sqlite from "./sqlite/index.js";
import { recordTables as sqliteRecordTables } from "./sqlite/index.js";

/** 0.6's tables in one dialect, by schema, then table. */
type Snapshots<T> = Readonly<
  Record<
    "defaults" | "renamed",
    Readonly<Record<"availabilityRule" | "block", T>>
  >
>;

/** 0.6's rule and Block tables, generated at v0.6.0 from `blockTable` and `availabilityRuleTable`. */
// SAFETY: our own fixture, written by `pgSnapshot` and `sqliteSnapshot` over 0.6's builders.
const v06 = JSON.parse(
  readFileSync(
    new URL("../test-utils/v0.6-tables.json", import.meta.url),
    "utf-8"
  )
) as {
  readonly pg: Snapshots<ReturnType<typeof pgSnapshot>>;
  readonly sqlite: Snapshots<ReturnType<typeof sqliteSnapshot>>;
};

const pgStaff = pgTable("test_staff", { id: pgInteger().primaryKey() });

const sqliteStaff = sqliteTable("test_staff", {
  id: sqliteInteger().primaryKey(),
});

/** A snapshot without its indexes, the one difference from 0.6. */
function exceptIndexes<T extends { readonly indexes: number }>(snapshot: T) {
  return { ...snapshot, indexes: 0 };
}

describe("availability() and blocks() match 0.6 apart from indexes (I8)", () => {
  it("Postgres: recordTables matches 0.6's tables, names, types, nullability, keys, defaults and foreign keys", () => {
    const renamed = pgRecordTables(renamedParitySchema, {
      references: () => pgStaff.id,
    });

    const defaults = pgRecordTables(defaultParitySchema);

    expect({
      defaults: {
        availabilityRule: exceptIndexes(pgSnapshot(defaults.availabilityRule)),
        block: exceptIndexes(pgSnapshot(defaults.block)),
      },
      renamed: {
        availabilityRule: exceptIndexes(pgSnapshot(renamed.availabilityRule)),
        block: exceptIndexes(pgSnapshot(renamed.block)),
      },
    }).toStrictEqual(v06.pg);
  });

  it("SQLite: recordTables matches 0.6's tables the same way", () => {
    const renamed = sqliteRecordTables(renamedParitySchema, {
      references: () => sqliteStaff.id,
    });

    const defaults = sqliteRecordTables(defaultParitySchema);

    expect({
      defaults: {
        availabilityRule: exceptIndexes(
          sqliteSnapshot(defaults.availabilityRule)
        ),
        block: exceptIndexes(sqliteSnapshot(defaults.block)),
      },
      renamed: {
        availabilityRule: exceptIndexes(
          sqliteSnapshot(renamed.availabilityRule)
        ),
        block: exceptIndexes(sqliteSnapshot(renamed.block)),
      },
    }).toStrictEqual(v06.sqlite);
  });
});

// oxlint-disable typescript/no-deprecated -- the aliases under test.
describe("the deprecated blockTable and availabilityRuleTable (R7)", () => {
  it("Postgres: build the same tables as recordTables", () => {
    const options = { references: () => pgStaff.id };
    const tables = pgRecordTables(renamedParitySchema, options);

    expect([
      pgSnapshot(pg.blockTable(renamedParitySchema, options)),
      pgSnapshot(pg.availabilityRuleTable(renamedParitySchema, options)),
    ]).toStrictEqual([
      pgSnapshot(tables.block),
      pgSnapshot(tables.availabilityRule),
    ]);
  });

  it("SQLite: build the same tables as recordTables", () => {
    const options = { references: () => sqliteStaff.id };
    const tables = sqliteRecordTables(renamedParitySchema, options);

    expect([
      sqliteSnapshot(sqlite.blockTable(renamedParitySchema, options)),
      sqliteSnapshot(
        sqlite.availabilityRuleTable(renamedParitySchema, options)
      ),
    ]).toStrictEqual([
      sqliteSnapshot(tables.block),
      sqliteSnapshot(tables.availabilityRule),
    ]);
  });

  it("throw on a schema without the Plugin", () => {
    const bare = defineSchema({});

    expect(() => pg.blockTable(bare)).toThrow(/"block" table/u);
    expect(() => sqlite.blockTable(bare)).toThrow(/"block" table/u);
    expect(() => pg.availabilityRuleTable(bare)).toThrow(/"availabilityRule"/u);
    expect(() => sqlite.availabilityRuleTable(bare)).toThrow(
      /"availabilityRule"/u
    );
  });
});
// oxlint-enable typescript/no-deprecated
