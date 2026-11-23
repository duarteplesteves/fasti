import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { bookingTable, recordTables } from "../drizzle/sqlite/index.js";
import {
  integerIdSchema,
  recordsSchema,
  textIdSchema,
  uuidIdSchema,
} from "./conformance-schemas.js";

// The test database's schema module: `drizzle-kit push` reads it by path (see sqlite.ts).

/** The developer's own Resource table, which the integer-id schema references. */
export const testStaff = sqliteTable("test_staff", {
  id: integer().primaryKey(),
});

/** The developer's own Resource table, which the uuid-id schema's Blocks reference. */
export const testRooms = sqliteTable("test_rooms", { id: text().primaryKey() });

/** A scratch table of the developer's own, written through `tx` by the `tx` probe. */
export const testProbe = sqliteTable("test_probe", { id: text().primaryKey() });

export const integerBooking = bookingTable(integerIdSchema, {
  references: () => testStaff.id,
});

export const { availabilityRule: integerRule } = recordTables(integerIdSchema, {
  references: () => testStaff.id,
});

export const textBooking = bookingTable(textIdSchema);

export const { availabilityRule: textRule, block: textBlock } =
  recordTables(textIdSchema);

export const uuidBooking = bookingTable(uuidIdSchema);
export const { availabilityRule: uuidRule } = recordTables(uuidIdSchema);

// The uuid-id schema's Blocks reference test_rooms; its rules don't, as in 0.6.
export const { block: uuidBlock } = recordTables(uuidIdSchema, {
  references: () => testRooms.id,
});

export const recordsBooking = bookingTable(recordsSchema);

export const {
  availabilityRule: recordsRule,
  conformanceTimed,
  conformanceUntimed,
} = recordTables(recordsSchema);
