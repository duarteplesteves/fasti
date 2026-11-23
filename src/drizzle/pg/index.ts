export { backstopSql } from "../../schema/backstop-sql.js";

export { drizzleAdapter } from "./drizzle-adapter.js";

// oxlint-disable typescript/no-deprecated -- the aliases stay exported for 0.7 (R7).
export {
  availabilityRuleTable,
  blockTable,
  bookingTable,
  recordTables,
} from "./tables.js";
// oxlint-enable typescript/no-deprecated

export type { TableOptions } from "./tables.js";
