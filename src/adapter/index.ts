export { defineAdapter } from "./contract.js";

export type {
  Adapter,
  AdapterReads,
  InsertBookingResult,
  ListBookingsQuery,
  LockedAdapter,
  ReplaceRulesParams,
  SchemaAdapter,
  UpdateBookingParams,
  UpdateBookingResult,
} from "./contract.js";

export type {
  BookingChanges,
  BookingRecord,
  ResourceIdOf,
  RuleRecord,
  StatusOf,
} from "./records.js";
