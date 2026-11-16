export { defineAdapter } from "./contract.js";

export type {
  Adapter,
  AdapterReads,
  BlockReads,
  BlockWrites,
  DeleteBlockResult,
  GroupsOf,
  InsertBookingResult,
  ListBlocksQuery,
  ListBookingsQuery,
  LockedAdapter,
  ReplaceRulesParams,
  SchemaAdapter,
  UpdateBlockResult,
  UpdateBookingParams,
  UpdateBookingResult,
  VerbGroup,
} from "./contract.js";

export type {
  BlockChanges,
  BlockFieldsOf,
  BlockRecord,
  BookingChanges,
  BookingRecord,
  ResourceIdOf,
  RuleRecord,
  StatusOf,
} from "./records.js";
