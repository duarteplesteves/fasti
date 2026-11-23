export { column } from "./schema/column.js";

export type {
  AnyColumn,
  Column,
  ColumnKind,
  Json,
  RecordColumn,
  ResourceIdColumn,
} from "./schema/column.js";

export { defineSchema } from "./schema/define-schema.js";

export type {
  AnySchema,
  BaseStatus,
  BookingColumn,
  DefineSchemaParams,
  FieldDef,
  Fields,
  InitialOf,
  Schema,
  StatusDecls,
  TransitionEdge,
  TransitionTable,
  Transitions,
} from "./schema/define-schema.js";

export type {
  Plugin,
  PluginResourceId,
  RecordId,
  RecordOf,
} from "./schema/table.js";

export { definePlugin, fail, ok } from "./framework/promise-face.js";

export type {
  PluginOutcome,
  PromiseLock,
  PromiseReadsOf,
  PromiseStoreOf,
  PromiseTableReads,
  PromiseTableWrites,
  PromiseUnit,
  Ran,
  ReadDef,
  WriteDef,
} from "./framework/promise-face.js";

export { createScheduler } from "./framework/create-scheduler.js";

export type {
  CreateSchedulerParams,
  Scheduler,
} from "./framework/create-scheduler.js";

export { availability } from "./framework/plugins/availability.js";

export type {
  AvailabilityDetail,
  AvailabilityPlugin,
  AvailabilityRuleInput,
  GetAvailabilityError,
  GetAvailabilityParams,
  SetAvailabilityAlso,
  SetAvailabilityError,
  SetAvailabilityParams,
  SetAvailabilityValue,
} from "./framework/plugins/availability.js";

export { blocks } from "./framework/plugins/blocks.js";

export type {
  Block,
  BlockActions,
  BlockNotFound,
  BlockOverBooking,
  BlocksPlugin,
  BlockTable,
  BlockTables,
  ConflictingBlock,
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
} from "./framework/plugins/blocks.js";

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

export { defineHook } from "./framework/hook.js";

export type { DefineHookParams, Hook, HookEvent } from "./framework/hook.js";

export { notice } from "./framework/notice.js";

export type { NoticeDetail, NoticeParams } from "./framework/notice.js";

export type {
  // oxlint-disable-next-line typescript/no-deprecated -- kept as a public export.
  ActionTarget,
  BookingActionName,
  EdgeTarget,
  HookTarget,
  PolicyTarget,
  WriteActionName,
} from "./framework/target.js";

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
  RescheduleCandidate,
  TransitionCandidate,
  Violation,
  ViolationOf,
} from "./framework/policy.js";

export { AdapterError } from "./framework/errors.js";

export type {
  BookingNotFound,
  Conflict,
  ConflictingBooking,
  PolicyViolation,
  SlotConflict,
  StatusMismatch,
  TransitionNotDeclared,
  Vetoed,
} from "./framework/errors.js";

export type { InvalidParams, Issue, Result } from "./core/result.js";

export type { BlockId } from "./core/types.js";
