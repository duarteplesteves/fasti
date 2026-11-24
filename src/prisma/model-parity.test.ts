import { readFileSync } from "node:fs";

import { defineContract } from "@prisma/orm-postgres/contract-builder";
import { describe, expect, it } from "vitest";

import {
  defaultParitySchema,
  renamedParitySchema,
} from "../test-utils/parity-schemas.js";
import { prismaModels } from "./models.js";

/** 0.6's rule and Block storage tables, generated at v0.6.0 from `prismaModels`, by schema, then physical name. */
// SAFETY: our own fixture, written from 0.6's `defineContract` storage.
const v06 = JSON.parse(
  readFileSync(
    new URL("../test-utils/v0.6-tables.json", import.meta.url),
    "utf-8"
  )
) as {
  readonly prisma: Readonly<
    Record<
      "defaults" | "renamed",
      Readonly<Record<string, ReturnType<typeof storageTable>>>
    >
  >;
};

/** The developer's Resource model, `test_staff`, beside fasti's: the renamed schema references it. */
const contract = defineContract({}, (h) => {
  const staff = h
    .model("TestStaff", { fields: { id: h.field.column(h.type.Int4()).id() } })
    .sql({ table: "test_staff" });

  return {
    models: {
      TestStaff: staff,
      ...prismaModels(defaultParitySchema, h),
      ...prismaModels(renamedParitySchema, h, {
        references: { field: "id", model: staff },
      }),
    },
  };
});

/** A storage table by physical name, as plain data, as the fixture holds it. */
function storageTable(name: string) {
  const { table } = contract.storage.namespaces.public.entries;

  return {
    // SAFETY: a missing name reads as `undefined`, which fails the comparison as it should.
    ...structuredClone(table[name as keyof typeof table]),
    // Without its indexes, the one difference from 0.6.
    indexes: [],
  };
}

describe("availability() and blocks() match 0.6 apart from indexes on Prisma (I8)", () => {
  it("prismaModels matches 0.6's rule and Block storage: names, types, nullability, keys, defaults and foreign keys", () => {
    expect({
      defaults: {
        availabilityRule: storageTable("availabilityRule"),
        block: storageTable("block"),
      },
      renamed: {
        p_hours: storageTable("p_hours"),
        p_time_off: storageTable("p_time_off"),
      },
    }).toStrictEqual(v06.prisma);
  });
});
