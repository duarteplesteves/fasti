import { expect } from "vitest";

import type { BookingChanges } from "../../adapter/records.js";
import type { ConformanceCase } from "../conformance-case.js";
import { insert, newBooking } from "../fixtures.js";

/**
 * The database backstop (`backstop` tag, ADR 008): writes that skip fasti's conflict check still
 * can't overlap two blocking Bookings on one Resource.
 */
export const backstopCases: readonly ConformanceCase[] = [
  {
    name: "an unchecked overlapping blocking insertBooking gives conflict, and the unit of work can still read",
    async run({ adapter, resources, schema }) {
      const taken = newBooking(schema, {
        optionalFields: "null",
        resourceId: resources[0],
        status: "booked",
      });

      await insert(adapter, taken);

      const clash = {
        ...newBooking(schema, {
          optionalFields: "null",
          resourceId: resources[0],
          status: "booked",
        }),
        end: taken.end.add({ minutes: 30 }),
        start: taken.start.add({ minutes: 30 }),
      };

      const overlapping = { from: taken.start, to: clash.end };

      await adapter.withResourceLock(resources[0], async (locked) => {
        expect(await locked.insertBooking(clash)).toStrictEqual({
          ok: false,
          reason: "conflict",
        });
        expect(
          await locked.listBookings({ overlapping, resourceId: resources[0] })
        ).toStrictEqual([taken]);
      });

      expect(await adapter.getBooking(clash.id)).toBeNull();
    },
    tags: ["backstop"],
  },
  {
    name: "an unchecked overlapping updateBooking gives conflict",
    async run({ adapter, resources, schema }) {
      const taken = newBooking(schema, {
        optionalFields: "null",
        resourceId: resources[0],
        status: "booked",
      });

      const elsewhere = {
        ...newBooking(schema, {
          optionalFields: "null",
          resourceId: resources[1],
          status: "booked",
        }),
        end: taken.end,
        start: taken.start,
      };

      await insert(adapter, taken);
      await insert(adapter, elsewhere);

      // SAFETY: the context's Resources are valid in every schema.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TypeScript can't check a literal against `Partial` of a generic record.
      const changes = { resourceId: resources[0] } as BookingChanges<
        typeof schema
      >;

      expect(
        await adapter.withResourceLock(
          resources[0],
          async (locked) =>
            await locked.updateBooking({ changes, expected: elsewhere })
        )
      ).toStrictEqual({ ok: false, reason: "conflict" });
      expect(await adapter.getBooking(elsewhere.id)).toStrictEqual(elsewhere);
    },
    tags: ["backstop"],
  },
  {
    name: "a cancelled Booking may overlap a blocking one",
    async run({ adapter, resources, schema }) {
      const taken = newBooking(schema, {
        optionalFields: "null",
        resourceId: resources[0],
        status: "booked",
      });

      const cancelled = {
        ...newBooking(schema, {
          optionalFields: "null",
          resourceId: resources[0],
          status: "cancelled",
        }),
        end: taken.end,
        start: taken.start,
      };

      await insert(adapter, taken);
      await insert(adapter, cancelled);

      expect(await adapter.getBooking(cancelled.id)).toStrictEqual(cancelled);
    },
    tags: ["backstop"],
  },
];
