import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import {
  availabilityRuleTable,
  blockTable,
  bookingTable,
  recordTables,
} from "../drizzle/sqlite/index.js";
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

export const integerRule = availabilityRuleTable(integerIdSchema, {
  references: () => testStaff.id,
});

export const textBlock = blockTable(textIdSchema);
export const textBooking = bookingTable(textIdSchema);
export const textRule = availabilityRuleTable(textIdSchema);

export const uuidBlock = blockTable(uuidIdSchema, {
  references: () => testRooms.id,
});

export const uuidBooking = bookingTable(uuidIdSchema);
export const uuidRule = availabilityRuleTable(uuidIdSchema);

export const recordsBooking = bookingTable(recordsSchema);
export const recordsRule = availabilityRuleTable(recordsSchema);

export const { conformanceTimed, conformanceUntimed } =
  recordTables(recordsSchema);
