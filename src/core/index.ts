export {
  MAX_DURATION_MINUTES,
  MAX_EXCEPTIONS,
  MAX_EXPAND_DAYS,
  MAX_GRID_TIMES,
  MAX_RULES,
  checkRule,
} from "./checks.js";

export { detectConflicts } from "./detect-conflicts.js";

export type { DetectConflictsParams } from "./detect-conflicts.js";

export { expandRules } from "./expand-rules.js";

export type { ExpandRulesParams } from "./expand-rules.js";

export { findFreeSlots } from "./find-free-slots.js";

export type { FindFreeSlotsParams } from "./find-free-slots.js";

export { isSlotValid } from "./is-slot-valid.js";

export type { IsSlotValidParams } from "./is-slot-valid.js";

export type { InvalidParams, Issue, Result } from "./result.js";

export type {
  AvailabilityRule,
  AvailabilityViolation,
  Booking,
  BookingId,
  CorePolicy,
  CoreViolations,
  ExpandedWindow,
  Recurrence,
  Slot,
  WeeklyRecurrence,
} from "./types.js";

export { withBlockingFlag } from "./with-blocking-flag.js";
