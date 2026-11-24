import { describe, expect, test } from "vitest";

import { findFreeSlots } from "../src/core/find-free-slots.js";
import { mintBookingId } from "../src/framework/booking-id.js";
import { availability, createScheduler, defineSchema } from "../src/index.js";
import { memoryAdapter } from "../src/memory/index.js";
import { unwrap } from "../src/test-utils/results.js";
import { RESOURCE, scenarios } from "./scenarios.js";

const bare = defineSchema({ plugins: [] });
const withAvailability = defineSchema({ plugins: [availability()] });

/** A memory Adapter holding the scenario's rules and Bookings. */
async function seeded({ search }: (typeof scenarios)[number]) {
  const adapter = memoryAdapter();

  unwrap(
    await createScheduler({
      adapter,
      schema: withAvailability,
    }).availability.set({ resourceId: RESOURCE, rules: search.rules })
  );

  // One unit of work: the memory Adapter copies its store per unit, so a `book` each would be quadratic.
  await adapter(bare).withResourceLock(RESOURCE, async (locked) => {
    for (const { end, isBlocking, start } of search.bookings) {
      await locked.insertBooking({
        end,
        id: mintBookingId(),
        resourceId: RESOURCE,
        start,
        status: isBlocking ? "booked" : "cancelled",
      });
    }
  });

  return adapter;
}

// Searches only: the memory Adapter's store copy makes its write timings meaningless.
describe("findSlots", () => {
  test.for(scenarios)("$name", async (scenario, { bench }) => {
    const { slots, search } = scenario;
    const { bookings: _bookings, rules: _rules, ...params } = search;

    const adapter = await seeded(scenario);
    const plain = createScheduler({ adapter, schema: bare });
    const full = createScheduler({ adapter, schema: withAvailability });

    expect(unwrap(await full.findSlots(params))).toHaveLength(slots);

    await bench.compare(
      bench("findSlots with availability()", async () => {
        await full.findSlots(params);
      }),
      bench("findSlots, no Plugins", async () => {
        await plain.findSlots(params);
      }),
      bench("findFreeSlots (Core)", () => {
        findFreeSlots(search);
      })
    );
  });
});
