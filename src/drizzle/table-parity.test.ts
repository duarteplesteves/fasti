import { readFileSync } from "node:fs";

import { integer as pgInteger, pgTable } from "drizzle-orm/pg-core";
import { integer as sqliteInteger, sqliteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  defaultParitySchema,
  renamedParitySchema,
} from "../test-utils/parity-schemas.js";
import { pgSnapshot, sqliteSnapshot } from "../test-utils/table-snapshot.js";
import { recordTables as pgRecordTables } from "./pg/index.js";
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
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
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

describe("availability() and blocks() need no migration from 0.6 (I8)", () => {
  it("Postgres: recordTables matches 0.6's tables, names, types, nullability, keys, defaults and foreign keys", () => {
    const renamed = pgRecordTables(renamedParitySchema, {
      references: () => pgStaff.id,
    });

    const defaults = pgRecordTables(defaultParitySchema);

    expect({
      defaults: {
        availabilityRule: pgSnapshot(defaults.availabilityRule),
        block: pgSnapshot(defaults.block),
      },
      renamed: {
        availabilityRule: pgSnapshot(renamed.availabilityRule),
        block: pgSnapshot(renamed.block),
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
        availabilityRule: sqliteSnapshot(defaults.availabilityRule),
        block: sqliteSnapshot(defaults.block),
      },
      renamed: {
        availabilityRule: sqliteSnapshot(renamed.availabilityRule),
        block: sqliteSnapshot(renamed.block),
      },
    }).toStrictEqual(v06.sqlite);
  });
});
