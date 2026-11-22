import { column, definePlugin, ok } from "../index.js";
import type { PluginResourceId, RecordId } from "../index.js";
import type { HolidayEve } from "./holidays-plugin.js";

/** The test-only `holidays` Plugin written with the Promise face, against the root entry point only: it behaves as `holidays` does (I9). */
export function promiseHolidays({ eveHours }: { readonly eveHours: number }) {
  return definePlugin({
    actions: {
      add: {
        kind: "write",
        run: async (
          params: {
            readonly resourceId: PluginResourceId;
            readonly start: Temporal.Instant;
            readonly end: Temporal.Instant;
            readonly name: string;
          },
          { lock }
        ) =>
          await lock(params.resourceId, async ({ conflicts, records }) => {
            const hits = await conflicts(params);

            if (hits.length > 0) {
              return {
                _tag: "Failed",
                error: { _tag: "SlotConflict", conflicts: hits },
              } as const;
            }

            const holiday = await records.holiday.insert(params);

            return {
              _tag: "Done",
              context: { holiday },
              value: holiday,
            } as const;
          }),
      },
      list: {
        kind: "read",
        run: async (
          params: { readonly resourceId: PluginResourceId },
          { records }
        ) => ok(await records.holiday.list({ resourceId: params.resourceId })),
      },
    },
    busy: {
      kind: "holiday",
      list: async ({ overlapping, records, resourceId }) =>
        await records.holiday.list({ overlapping, resourceId }),
    },
    name: "holidays",
    policies: [
      {
        appliesTo: ["book", "reschedule"],
        check: (
          _candidate,
          next: readonly { readonly id: RecordId<"holiday"> }[]
        ): HolidayEve | null =>
          next[0] === undefined ? null : { holiday: next[0].id },
        load: async ({ records, resourceId, to }) =>
          await records.holiday.list({
            overlapping: { from: to, to: to.add({ hours: eveHours }) },
            resourceId,
          }),
        name: "holidayEve",
      },
    ],
    tables: {
      holiday: {
        columns: { name: { required: true, type: column.text() } },
        timed: true,
      },
    },
  });
}
