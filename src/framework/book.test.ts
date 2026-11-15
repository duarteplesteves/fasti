import { assert, describe, expect, it } from "vitest";

import { createScheduler } from "../index.js";
import { memoryAdapter } from "../memory/index.js";
import {
  uuidIdResources,
  uuidIdSchema,
} from "../test-utils/conformance-schemas.js";

const schema = uuidIdSchema;
const [room] = uuidIdResources;

/** Weekdays 09:00–17:00 in Lisbon. */
const weekdays = {
  exceptions: [],
  recurrence: { daysOfWeek: [1, 2, 3, 4, 5], frequency: "weekly", interval: 1 },
  timeWindow: {
    end: Temporal.PlainTime.from("17:00"),
    start: Temporal.PlainTime.from("09:00"),
  },
  timezone: "Europe/Lisbon",
} as const;

/** UUIDv7 (RFC 9562): version nibble 7, variant bits 10. */
const uuidV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("book", () => {
  it("books a free slot inside availability, with a fresh UUIDv7 id", async () => {
    const adapter = memoryAdapter();

    await adapter(schema).withResourceLock(room, async (locked) => {
      await locked.replaceRules({ resourceId: room, rules: [weekdays] });
    });

    const scheduler = createScheduler({ adapter, schema });
    // Monday 3 June 2030, 10:00–11:00 Lisbon (UTC+1).
    const start = Temporal.Instant.from("2030-06-03T09:00:00Z");
    const end = Temporal.Instant.from("2030-06-03T10:00:00Z");

    const result = await scheduler.book({ end, resourceId: room, start });

    assert(result.ok, "expected ok");

    const { id, ...rest } = result.value;

    expect(id).toMatch(uuidV7);
    expect(rest).toStrictEqual({
      end,
      resourceId: room,
      start,
      status: "booked",
    });
    await expect(adapter(schema).getBooking(id)).resolves.toStrictEqual(
      result.value
    );
  });
});
