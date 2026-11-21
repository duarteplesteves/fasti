import { definePlugin } from "../framework/plugin.js";
import { column } from "../schema/column.js";

/** A column of every kind, required and optional. */
const columns = {
  boolean: { required: true, type: column.boolean() },
  booleanOpt: { required: false, type: column.boolean() },
  date: { required: true, type: column.date() },
  dateOpt: { required: false, type: column.date() },
  dates: { required: true, type: column.dates() },
  datesOpt: { required: false, type: column.dates() },
  instant: { required: true, type: column.instant() },
  instantOpt: { required: false, type: column.instant() },
  integer: { required: true, type: column.integer() },
  integerOpt: { required: false, type: column.integer() },
  json: { required: true, type: column.json() },
  jsonOpt: { required: false, type: column.json() },
  text: { required: true, type: column.text() },
  textOpt: { required: false, type: column.text() },
  time: { required: true, type: column.time() },
  timeOpt: { required: false, type: column.time() },
  uuid: { required: true, type: column.uuid() },
  uuidOpt: { required: false, type: column.uuid() },
} as const;

/**
 * The Plugin the `records` cases store through: one timed and one untimed table, each with a column of every kind.
 * Install it in the schema you pass `testAdapter`, and create its tables, to run them.
 */
export const conformancePlugin = definePlugin({
  actions: {},
  name: "conformance",
  tables: {
    conformanceTimed: { columns, timed: true },
    conformanceUntimed: { columns, timed: false },
  },
});
