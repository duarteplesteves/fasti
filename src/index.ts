export { column } from "./schema/column.js";

export type {
  AnyColumn,
  Column,
  ColumnKind,
  ResourceIdColumn,
} from "./schema/column.js";

export { defineSchema } from "./schema/define-schema.js";

export type {
  AnySchema,
  AvailabilityRuleColumn,
  BaseStatus,
  BookingColumn,
  DefineSchemaParams,
  FieldDef,
  Fields,
  Schema,
} from "./schema/define-schema.js";

export { createScheduler } from "./framework/create-scheduler.js";

export type {
  CreateSchedulerParams,
  Scheduler,
} from "./framework/create-scheduler.js";

export type {
  AvailabilityRuleInput,
  GetAvailabilityError,
  GetAvailabilityParams,
  SetAvailabilityError,
  SetAvailabilityParams,
  SetAvailabilityValue,
} from "./framework/availability.js";

export type { BookError, BookParams } from "./framework/book.js";

export type {
  CancelError,
  CancelParams,
  CancelValue,
} from "./framework/cancel.js";

export type { Booking } from "./framework/booking.js";

export type {
  FindSlotsError,
  FindSlotsParams,
  Slot,
} from "./framework/find-slots.js";

export { AdapterError } from "./framework/errors.js";

export type {
  BookingNotFound,
  Conflict,
  ConflictingBooking,
  PolicyViolation,
  SlotConflict,
} from "./framework/errors.js";

export type { InvalidParams, Issue, Result } from "./core/result.js";
