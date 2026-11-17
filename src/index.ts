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
  BlockColumn,
  BookingColumn,
  DefineSchemaParams,
  FieldDef,
  Fields,
  HasBlocks,
  InitialOf,
  Schema,
  StatusDecls,
  TransitionTable,
  Transitions,
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
  SetAvailabilityAlso,
  SetAvailabilityError,
  SetAvailabilityParams,
  SetAvailabilityValue,
} from "./framework/availability.js";

export type {
  Block,
  BlockActions,
  CreateBlockAlso,
  CreateBlockError,
  CreateBlockParams,
  DeleteBlockAlso,
  DeleteBlockError,
  DeleteBlockParams,
  ListBlocksError,
  ListBlocksParams,
  UpdateBlockAlso,
  UpdateBlockError,
  UpdateBlockParams,
} from "./framework/blocks.js";

export type {
  BookAlso,
  BookError,
  BookParams,
  StatusParam,
} from "./framework/book.js";

export type {
  CancelError,
  CancelParams,
  CancelValue,
} from "./framework/cancel.js";

export type { Booking, ChangeAlso } from "./framework/booking.js";

export type {
  FindSlotsError,
  FindSlotsParams,
  Slot,
} from "./framework/find-slots.js";

export { AdapterError } from "./framework/errors.js";

export type {
  BlockNotFound,
  BookingNotFound,
  Conflict,
  ConflictingBlock,
  ConflictingBooking,
  PolicyViolation,
  SlotConflict,
  Vetoed,
} from "./framework/errors.js";

export type { InvalidParams, Issue, Result } from "./core/result.js";

export type { BlockId } from "./core/types.js";
