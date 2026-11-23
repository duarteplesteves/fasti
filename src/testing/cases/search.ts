import { expect } from "vitest";

import type { BookingRecord } from "../../adapter/records.js";
import type { BookingId } from "../../core/types.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { CaseContext, ConformanceCase } from "../conformance-case.js";
import { insert, newBooking } from "../fixtures.js";

function at(iso: string): Temporal.Instant {
  return Temporal.Instant.from(iso);
}

/**
 * A Booking on 2030-03-04 between two "HH:MM" times.
 *
 * @returns The Booking record, not yet stored.
 */
function bookingAt<S extends AnySchema, Tx>(
  { resources, schema }: CaseContext<S, Tx>,
  {
    resource,
    status,
    from,
    to,
  }: {
    readonly resource: 0 | 1;
    readonly status: string;
    readonly from: string;
    readonly to: string;
  }
): BookingRecord<S> {
  return {
    ...newBooking(schema, {
      optionalFields: "null",
      resourceId: resources[resource],
      status,
    }),
    end: at(`2030-03-04T${to}:00Z`),
    start: at(`2030-03-04T${from}:00Z`),
  };
}

const wholeDay = {
  from: at("2030-03-04T00:00:00Z"),
  to: at("2030-03-05T00:00:00Z"),
};

/** Search (`listBookings`). */
export const searchCases: readonly ConformanceCase[] = [
  {
    name: "listBookings overlap is half-open: a 09:00–10:00 Booking is not returned for 10:00–11:00",
    async run(ctx) {
      const { adapter, resources } = ctx;

      const nine = bookingAt(ctx, {
        from: "09:00",
        resource: 0,
        status: "booked",
        to: "10:00",
      });

      const eleven = bookingAt(ctx, {
        from: "11:00",
        resource: 0,
        status: "booked",
        to: "12:00",
      });

      await insert(adapter, nine);
      await insert(adapter, eleven);

      expect(
        await adapter.listBookings({
          overlapping: {
            from: at("2030-03-04T10:00:00Z"),
            to: at("2030-03-04T11:00:00Z"),
          },
          resourceId: resources[0],
        })
      ).toStrictEqual([]);

      expect(
        await adapter.listBookings({
          overlapping: {
            from: at("2030-03-04T09:59:59.999Z"),
            to: at("2030-03-04T11:00:00.001Z"),
          },
          resourceId: resources[0],
        })
      ).toStrictEqual([nine, eleven]);
    },
    tags: [],
  },
  {
    name: "listBookings is scoped to one Resource and returns every Status",
    async run(ctx) {
      const { adapter, resources, schema } = ctx;

      const mine = Object.keys(schema.statuses).map((status, i) =>
        bookingAt(ctx, {
          from: `0${i}:00`,
          resource: 0,
          status,
          to: `0${i}:30`,
        })
      );

      const theirs = bookingAt(ctx, {
        from: "00:00",
        resource: 1,
        status: "booked",
        to: "00:30",
      });

      await Promise.all(
        [...mine, theirs].map(async (b) => {
          await insert(adapter, b);
        })
      );

      expect(
        await adapter.listBookings({
          overlapping: wholeDay,
          resourceId: resources[0],
        })
      ).toStrictEqual(mine);
    },
    tags: [],
  },
  {
    name: "listBookings is sorted by start, then id",
    async run(ctx) {
      const { adapter, resources } = ctx;

      // Ids differ only in the last hex digit, so any collation orders them the same way.
      function withId(
        b: BookingRecord<typeof ctx.schema>,
        last: string
      ): BookingRecord<typeof ctx.schema> {
        return {
          ...b,
          // SAFETY: a UUID string is a valid BookingId; the brand is type-only.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minting a branded id.
          id: `00000000-0000-4000-8000-00000000000${last}` as BookingId,
        };
      }

      const early = bookingAt(ctx, {
        from: "08:00",
        resource: 0,
        status: "booked",
        to: "09:00",
      });

      const tieA = withId(
        bookingAt(ctx, {
          from: "09:00",
          resource: 0,
          status: "booked",
          to: "10:00",
        }),
        "1"
      );

      // Cancelled, so the tie is a legal overlap where a backstop forbids two blocking Bookings.
      const tieB = withId(
        bookingAt(ctx, {
          from: "09:00",
          resource: 0,
          status: "cancelled",
          to: "09:30",
        }),
        "2"
      );

      const late = bookingAt(ctx, {
        from: "10:00",
        resource: 0,
        status: "booked",
        to: "11:00",
      });

      // Inserted out of order, so insertion order can't pass for sort order.
      await Promise.all(
        [late, tieB, early, tieA].map(async (b) => {
          await insert(adapter, b);
        })
      );

      expect(
        await adapter.listBookings({
          overlapping: wholeDay,
          resourceId: resources[0],
        })
      ).toStrictEqual([early, tieA, tieB, late]);
    },
    tags: [],
  },
];
