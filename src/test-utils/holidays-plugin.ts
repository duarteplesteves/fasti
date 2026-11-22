import { Effect } from "effect";

import { definePlugin } from "../effect/index.js";
import type { PluginResourceId } from "../effect/index.js";
import { column } from "../index.js";
import type {
  BookCandidate,
  ConflictingBooking,
  RecordId,
  RescheduleCandidate,
  SlotConflict,
} from "../index.js";

/** Refused by `holidays.add`: a blocking Booking is in the way. */
export type HolidayOverBooking = SlotConflict<ConflictingBooking>;

/** What the `holidayEve` Policy reports: the holiday that starts too soon after the Booking ends. */
export interface HolidayEve {
  readonly holiday: RecordId<"holiday">;
}

/** The candidates `holidayEve` checks. */
export type EveCandidate = BookCandidate<never> | RescheduleCandidate<never>;

/**
 * A test-only third-party Plugin, written natively in Effect against public entry points only: holidays on a Resource,
 * as busy time of kind `holiday`, and a `holidayEve` Policy refusing a Booking that ends within `eveHours` of one.
 */
export function holidays({ eveHours }: { readonly eveHours: number }) {
  return definePlugin({
    actions: {
      add: {
        kind: "write",
        run: (
          params: {
            readonly resourceId: PluginResourceId;
            readonly start: Temporal.Instant;
            readonly end: Temporal.Instant;
            readonly name: string;
          },
          { lock }
        ) =>
          lock(params.resourceId, ({ conflicts, records }) =>
            Effect.gen(function* addHoliday() {
              const hits = yield* conflicts(params);

              if (hits.length > 0) {
                return yield* Effect.fail<HolidayOverBooking>({
                  _tag: "SlotConflict",
                  conflicts: hits,
                });
              }

              const holiday = yield* records.holiday.insert(params);

              return {
                _tag: "Done",
                context: { holiday },
                value: holiday,
              } as const;
            })
          ),
      },
      list: {
        kind: "read",
        run: (params: { readonly resourceId: PluginResourceId }, { records }) =>
          records.holiday.list({ resourceId: params.resourceId }),
      },
    },
    busy: {
      kind: "holiday",
      list: ({ overlapping, records, resourceId }) =>
        records.holiday.list({ overlapping, resourceId }),
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
        load: ({ records, resourceId, to }) =>
          records.holiday.list({
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
