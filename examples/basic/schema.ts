import { column, defineSchema } from "@fastijs/scheduler";
import {
  availabilityRuleTable,
  bookingTable,
} from "@fastijs/scheduler/drizzle/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/** Default names: tables `booking` and `availability_rule`, text Resource ids. */
export const schema = defineSchema({
  booking: {
    fields: { customerName: { required: true, type: column.text() } },
  },
});

export const tables = {
  availabilityRule: availabilityRuleTable(schema),
  booking: bookingTable(schema),
};

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
