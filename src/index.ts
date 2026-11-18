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
  TransitionEdge,
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

export type {
  RescheduleError,
  RescheduleParams,
} from "./framework/reschedule.js";

export type {
  TransitionError,
  TransitionParams,
} from "./framework/transition.js";

export type { Booking, ChangeAlso, FieldsPatch } from "./framework/booking.js";

export type {
  FindSlotsError,
  FindSlotsParams,
  Slot,
} from "./framework/find-slots.js";

export { definePolicy } from "./framework/policy.js";

export type {
  AnyPolicyOf,
  BookCandidate,
  CancelCandidate,
  Candidate,
  CandidateFor,
  DefinePolicyParams,
  LoadContext,
  Policy,
  PolicyReads,
  PolicyTarget,
  RescheduleCandidate,
  Violation,
  ViolationOf,
} from "./framework/policy.js";

export { AdapterError } from "./framework/errors.js";

export type {
  BlockNotFound,
  BookingNotFound,
  Conflict,
  ConflictingBlock,
  ConflictingBooking,
  PolicyViolation,
  SlotConflict,
  StatusMismatch,
  TransitionNotDeclared,
  Vetoed,
} from "./framework/errors.js";

export type { InvalidParams, Issue, Result } from "./core/result.js";

export type { BlockId } from "./core/types.js";
