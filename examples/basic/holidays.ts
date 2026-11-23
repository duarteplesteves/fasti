import { column, definePlugin, ok } from "@fastijs/scheduler";
import type { PluginResourceId, RecordId } from "@fastijs/scheduler";

/**
 * A Plugin of your own, written with plain async functions: holidays on a Resource. It brings a table, an Action that
 * writes and one that reads, busy time no Booking may overlap, a Policy, and a Hook.
 */
export function holidays({ eveHours }: { readonly eveHours: number }) {
  return definePlugin({
    name: "holidays", // → scheduler.holidays
    tables: {
      // A timed table: fasti adds and owns `id`, `resourceId`, `start` and `end`.
      holiday: {
        columns: { name: { required: true, type: column.text() } },
        timed: true,
      },
    },
    actions: {
      add: {
        kind: "write",
        // Type the params on `run`; PluginResourceId becomes the schema's Resource id type.
        run: async (
          params: {
            readonly resourceId: PluginResourceId;
            readonly start: Temporal.Instant;
            readonly end: Temporal.Instant;
            readonly name: string;
          },
          { lock }
        ) =>
          // One unit of work under the Resource Lock: the caller's `also` and the Hooks run on it.
          await lock(params.resourceId, async ({ conflicts, records }) => {
            // Busy time must not cover a Booking: checking that is this Plugin's job.
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
              context: { holiday }, // what `also` and the Hooks get
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
    // Busy time: `book` refuses it with SlotConflict { kind: "holiday" }, and findSlots skips it. Nobody can relax it.
    busy: {
      kind: "holiday",
      list: async ({ overlapping, records, resourceId }) =>
        await records.holiday.list({ overlapping, resourceId }),
    },
    // A Policy: no Booking ending within `eveHours` of a holiday. Callers can relax it by name.
    policies: [
      {
        appliesTo: ["book", "reschedule"],
        check: (
          _candidate,
          next: readonly { readonly id: RecordId<"holiday"> }[]
        ) => (next[0] === undefined ? null : { holiday: next[0].id }),
        load: async ({ records, resourceId, to }) =>
          await records.holiday.list({
            overlapping: { from: to, to: to.add({ hours: eveHours }) },
            resourceId,
          }),
        name: "holidayEve",
      },
    ],
    hooks: [
      {
        appliesTo: ["holidays.add"],
        run: (event) => {
          if (event.action === "holidays.add") {
            console.log(`holiday added: ${event.holiday.name}`);
          }
        },
        when: "afterCommit",
      },
    ],
  });
}
