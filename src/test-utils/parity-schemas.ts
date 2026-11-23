import { availability } from "../framework/plugins/availability.js";
import { blocks } from "../framework/plugins/blocks.js";
import { column } from "../schema/column.js";
import { defineSchema } from "../schema/define-schema.js";

// The 0.7 twins of the schemas `v0.6-tables.json` was generated from at v0.6.0 (with `block` in defineSchema):
// the same fields and names, through availability() and blocks(). Parity (I8): the same tables.

/** Integer ids with a foreign key to `test_staff`, a Block field of every kind, everything renamed. */
export const renamedParitySchema = defineSchema({
  names: {
    columns: {
      availabilityRule: {
        effectiveFrom: "p_effective_from",
        effectiveTo: "p_effective_to",
        exceptions: "p_exceptions",
        id: "p_rule_id",
        recurrence: "p_recurrence",
        resourceId: "p_staff_id",
        timezone: "p_tz",
        windowEnd: "p_window_end",
        windowStart: "p_window_start",
      },
      block: {
        count: "p_count",
        countOpt: "p_count_opt",
        end: "p_off_ends_at",
        flag: "p_flag",
        flagOpt: "p_flag_opt",
        id: "p_off_id",
        note: "p_note",
        noteOpt: "p_note_opt",
        ref: "p_ref",
        refOpt: "p_ref_opt",
        resourceId: "p_off_staff_id",
        start: "p_off_starts_at",
        until: "p_until",
        untilOpt: "p_until_opt",
      },
      booking: { status: "p_state" },
    },
    tables: {
      availabilityRule: "p_hours",
      block: "p_time_off",
      booking: "p_bookings",
    },
  },
  plugins: [
    availability(),
    blocks({
      fields: {
        count: { required: true, type: column.integer() },
        countOpt: { required: false, type: column.integer() },
        flag: { required: true, type: column.boolean() },
        flagOpt: { required: false, type: column.boolean() },
        note: { required: true, type: column.text() },
        noteOpt: { required: false, type: column.text() },
        ref: { required: true, type: column.uuid() },
        refOpt: { required: false, type: column.uuid() },
        until: { required: true, type: column.instant() },
        untilOpt: { required: false, type: column.instant() },
      },
    }),
  ],
  resource: { idType: column.integer() },
});

/** Text ids, logical names (but the Status column, which Prisma reserves), one optional Block field. */
export const defaultParitySchema = defineSchema({
  names: { columns: { booking: { status: "state" } } },
  plugins: [
    availability(),
    blocks({ fields: { note: { required: false, type: column.text() } } }),
  ],
});
