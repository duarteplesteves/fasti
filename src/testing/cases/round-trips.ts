import { expect } from "vitest";

import type { SchemaAdapter } from "../../adapter/contract.js";
import type { BookingRecord } from "../../adapter/records.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { ConformanceCase } from "../conformance-case.js";
import { bookingId, newBooking } from "../fixtures.js";

async function insert<S extends AnySchema, Tx>(
  adapter: SchemaAdapter<S, Tx>,
  booking: BookingRecord<S>
): Promise<void> {
  const result = await adapter.withResourceLock(
    booking.resourceId,
    async (locked) => await locked.insertBooking(booking)
  );

  expect(result).toStrictEqual({ ok: true });
}

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
      expect(await adapter.getBooking(bookingId())).toBeNull();
    },
    tags: [],
  },
];
