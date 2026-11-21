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
  ListRecordsQuery,
  LockedAdapter,
  RecordReads,
  RecordWrites,
  ReplaceRulesParams,
  SchemaAdapter,
  StoredRecord,
  StoredValue,
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
