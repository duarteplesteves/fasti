export { defineAdapter } from "./contract.js";

export type {
  Adapter,
  AdapterReads,
  DeleteRecordResult,
  GroupsOf,
  InsertBookingResult,
  ListBookingsQuery,
  ListRecordsQuery,
  LockedAdapter,
  RecordReads,
  RecordWrites,
  ReplaceRecordsParams,
  SchemaAdapter,
  StoredRecord,
  StoredValue,
  UpdateBookingParams,
  UpdateBookingResult,
  UpdateRecordParams,
  UpdateRecordResult,
  VerbGroup,
} from "./contract.js";

export type {
  BookingChanges,
  BookingRecord,
  ResourceIdOf,
  RuleRecord,
  StatusOf,
} from "./records.js";
