import { expect } from "vitest";

import { mintBookingId } from "../../framework/booking-id.js";
import type { ConformanceCase } from "../conformance-case.js";
import { insert, newBooking } from "../fixtures.js";

/** Save and read back. */
export const roundTripCases: readonly ConformanceCase[] = [
  {
    name: "a Booking round-trips every field: id type, Instants to the millisecond, every Developer Field",
    async run({ adapter, resources, schema }) {
      const withValues = newBooking(schema, {
        optionalFields: "set",
        resourceId: resources[0],
        status: "booked",
      });

      const withNulls = newBooking(schema, {
        optionalFields: "null",
        resourceId: resources[1],
        status: "booked",
      });

      await insert(adapter, withValues);
      await insert(adapter, withNulls);

      expect(await adapter.getBooking(withValues.id)).toStrictEqual(withValues);
      expect(await adapter.getBooking(withNulls.id)).toStrictEqual(withNulls);
    },
    tags: [],
  },
  {
    name: "every Status reads back by its logical name",
    async run({ adapter, resources, schema }) {
      const statuses = Object.keys(schema.statuses);

      const bookings = statuses.map((status) =>
        newBooking(schema, {
          optionalFields: "null",
          resourceId: resources[0],
          status,
        })
      );

      await Promise.all(
        bookings.map(async (b) => {
          await insert(adapter, b);
        })
      );

      const read = await Promise.all(
        bookings.map(async (b) => await adapter.getBooking(b.id))
      );

      expect(read.map((b) => b?.status)).toStrictEqual(statuses);
    },
    tags: [],
  },
  {
    name: "getBooking of an unknown id returns null",
    async run({ adapter }) {
      expect(await adapter.getBooking(mintBookingId())).toBeNull();
    },
    tags: [],
  },
];
