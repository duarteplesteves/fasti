import { availability, blocks, column, defineSchema } from "@fastijs/scheduler";
import { bookingTable, recordTables } from "@fastijs/scheduler/drizzle/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, uuid } from "drizzle-orm/pg-core";
import { Pool } from "pg";

/** Default names: tables `booking`, `availabilityRule` and `block`, text Resource ids. */
export const schema = defineSchema({
  booking: {
    fields: { customerName: { required: true, type: column.text() } },
  },
  plugins: [
    availability(),
    blocks({ fields: { reason: { required: true, type: column.text() } } }),
  ],
});

/** A table of your own: prepaid packs of sessions, spent by `also` in the same transaction as `book`. */
export const pack = pgTable("pack", {
  id: uuid().primaryKey(),
  remaining: integer().notNull(),
});

/** The tables to migrate: fasti's, built from `schema`, and your own. */
export const tables = {
  ...recordTables(schema),
  booking: bookingTable(schema),
  pack,
};

/** The connection pool, from `DATABASE_URL`. */
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** The Drizzle database the Adapter runs on. */
export const db = drizzle({ client: pool });

/** Weekdays 09:00–17:00 in Lisbon. */
export const weekdays = {
  recurrence: { daysOfWeek: [1, 2, 3, 4, 5], frequency: "weekly", interval: 1 },
  timeWindow: {
    end: Temporal.PlainTime.from("17:00"),
    start: Temporal.PlainTime.from("09:00"),
  },
  timezone: "Europe/Lisbon",
} as const;
