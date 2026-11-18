import { defineContract } from "@prisma/orm-postgres/contract-builder";
import { describe, expect, it } from "vitest";

import type { AnySchema } from "../schema/define-schema.js";
import {
  integerIdSchema,
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
