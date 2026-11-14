import { column } from "../schema/column.js";
import { defineSchema } from "../schema/define-schema.js";

/** Every rule column renamed; shared by the three schemas below. */
function ruleColumns(prefix: string) {
  return {
    effectiveFrom: `${prefix}_effective_from`,
    effectiveTo: `${prefix}_effective_to`,
    exceptions: `${prefix}_exceptions`,
    id: `${prefix}_id`,
    recurrence: `${prefix}_recurrence`,
    resourceId: `${prefix}_staff_id`,
    timezone: `${prefix}_tz`,
    windowEnd: `${prefix}_window_end`,
    windowStart: `${prefix}_window_start`,
  };
}

/** Text ids, and a Developer Field of every kind, required and optional. Everything renamed. */
export const textIdSchema = defineSchema({
  booking: {
    fields: {
      count: { required: true, type: column.integer() },
      countOpt: { required: false, type: column.integer() },
      label: { required: true, type: column.text() },
      labelOpt: { required: false, type: column.text() },
      paid: { required: true, type: column.boolean() },
      paidOpt: { required: false, type: column.boolean() },
      ref: { required: true, type: column.uuid() },
      refOpt: { required: false, type: column.uuid() },
      remindAt: { required: true, type: column.instant() },
      remindAtOpt: { required: false, type: column.instant() },
    },
  },
  names: {
    columns: {
      availabilityRule: ruleColumns("t"),
      booking: {
        count: "t_count",
        countOpt: "t_count_opt",
        end: "t_ends_at",
        id: "t_booking_id",
        label: "t_label",
        labelOpt: "t_label_opt",
        paid: "t_paid",
        paidOpt: "t_paid_opt",
        ref: "t_ref",
        refOpt: "t_ref_opt",
        remindAt: "t_remind_at",
        remindAtOpt: "t_remind_at_opt",
        resourceId: "t_staff_id",
        start: "t_starts_at",
        status: "t_state",
      },
    },
    statuses: { booked: "T_CONFIRMED", cancelled: "T_VOID" },
    tables: { availabilityRule: "t_hours", booking: "t_appointments" },
  },
  resource: { idType: column.text() },
});

/** Two existing Resources for {@link textIdSchema}. */
export const textIdResources = ["staff-a", "staff-b"] as const;

/** UUID ids, no Developer Fields. Everything renamed. */
export const uuidIdSchema = defineSchema({
  names: {
    columns: {
      availabilityRule: ruleColumns("u"),
      booking: {
        end: "u_ends_at",
        id: "u_booking_id",
        resourceId: "u_room_id",
        start: "u_starts_at",
        status: "u_state",
      },
    },
    statuses: { booked: "U_HELD", cancelled: "U_RELEASED" },
    tables: { availabilityRule: "u_hours", booking: "u_reservations" },
  },
  resource: { idType: column.uuid() },
});

/** Two existing Resources for {@link uuidIdSchema}. */
export const uuidIdResources = [
  "0193b6e2-7c00-7000-8000-000000000001",
  "0193b6e2-7c00-7000-8000-000000000002",
] as const;

/** Integer ids (linked to a test Resource table on Postgres). Everything renamed. */
export const integerIdSchema = defineSchema({
  booking: { fields: { note: { required: false, type: column.text() } } },
  names: {
    columns: {
      availabilityRule: ruleColumns("i"),
      booking: {
        end: "i_ends_at",
        id: "i_booking_id",
        note: "i_note",
        resourceId: "i_staff_id",
        start: "i_starts_at",
        status: "i_state",
      },
    },
    statuses: { booked: "1", cancelled: "0" },
    tables: { availabilityRule: "i_hours", booking: "i_visits" },
  },
  resource: { idType: column.integer() },
});

/** Two existing Resources for {@link integerIdSchema}. */
export const integerIdResources = [1, 2] as const;
