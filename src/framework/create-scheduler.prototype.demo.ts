/**
 * PROTOTYPE demo: throwaway. `bun run prototype:scheduler`
 *
 * Reads top to bottom as a developer's backend would call the Framework.
 * After each call it prints the result and what the Adapter now stores.
 */

import {
  createScheduler,
  memoryAdapter,
  SlotUnavailableError,
} from "./create-scheduler.prototype.js";
import type { StoredBooking } from "./create-scheduler.prototype.js";

const TZ = "Europe/Lisbon";

const at = (iso: string) =>
  Temporal.PlainDateTime.from(iso).toZonedDateTime(TZ).toInstant();

const local = (i: Temporal.Instant) =>
  i
    .toZonedDateTimeISO(TZ)
    .toPlainDateTime()
    .toString()
    .slice(5, 16)
    .replace("T", " ");

function show(adapter: ReturnType<typeof memoryAdapter>) {
  const { bookings } = adapter.snapshot();

  if (bookings.length === 0) {
    console.log("   stored bookings: (none)");

    return;
  }

  console.log("   stored bookings:");

  for (const b of bookings) {
    console.log(
      `     ${b.id}  ${b.resourceId}  ${local(b.start)} → ${local(b.end)}  ${b.status.padEnd(9)} blocking=${b.isBlocking}`
    );
  }
}

function step(title: string) {
  console.log(`\n── ${title}`);
}

async function attempt<T>(label: string, fn: () => Promise<T>) {
  try {
    const out = await fn();
    console.log(`   ✓ ${label}`);

    return out;
  } catch (error) {
    if (error instanceof SlotUnavailableError) {
      console.log(
        `   ✗ ${label}: SlotUnavailableError reason=${error.reason}${
          error.conflicts.length > 0
            ? ` conflicts=[${error.conflicts.map((c) => c.id).join(", ")}]`
            : ""
        }`
      );
    } else {
      console.log(
        `   ✗ ${label}: ${(error as Error).name}: ${(error as Error).message}`
      );
    }

    return;
  }
}

// ─── 1. Create the instance ────────────────────────────────────────────────

step("1. createScheduler({ adapter })");

const adapter = memoryAdapter();
const scheduler = createScheduler({ adapter });

console.log("   methods:", Object.keys(scheduler).join(", "));

// ─── 2. Store availability ─────────────────────────────────────────────────

step("2. setAvailability: room-1, Mon–Fri 09:00–12:00 Lisbon");

await scheduler.setAvailability({
  resourceId: "room-1",
  rules: [
    {
      recurrence: {
        daysOfWeek: [1, 2, 3, 4, 5],
        frequency: "weekly",
        interval: 1,
      },
      timeWindow: {
        end: Temporal.PlainTime.from("12:00"),
        start: Temporal.PlainTime.from("09:00"),
      },
      timezone: TZ,
    },
  ],
});

console.log(`   stored rules: ${adapter.snapshot().rules.length}`);

// ─── 3. Find slots ─────────────────────────────────────────────────────────

step("3. findSlots: 60 min on Mon 16 Nov");

const slots = await scheduler.findSlots({
  duration: 60,
  from: at("2026-11-16T00:00"),
  resourceId: "room-1",
  to: at("2026-11-17T00:00"),
});

console.log(
  `   slots: ${slots.map((s) => local(s.start.toInstant())).join(" | ")}`
);

// ─── 4. Book a slot straight from findSlots ────────────────────────────────

step("4. book(slots[0]): a Slot is a valid BookParams");

const first = (await attempt("book 09:00", () => scheduler.book(slots[0]!)))!;

show(adapter);

step("5. Book the same slot again");

await attempt("book 09:00 again", () => scheduler.book(slots[0]!));

show(adapter);

step("6. Book outside availability (Mon 14:00)");

await attempt("book 14:00", () =>
  scheduler.book({
    end: at("2026-11-16T15:00"),
    resourceId: "room-1",
    start: at("2026-11-16T14:00"),
  })
);

// ─── 7. Concurrency ────────────────────────────────────────────────────────

step("7. Three requests race for 10:00 (lock on)");

const results = await Promise.allSettled(
  [1, 2, 3].map(() => scheduler.book(slots[1]!))
);

console.log(
  `   fulfilled=${results.filter((r) => r.status === "fulfilled").length}` +
    ` rejected=${results.filter((r) => r.status === "rejected").length}`
);

show(adapter);

const ten = (
  results.find(
    (r) => r.status === "fulfilled"
  ) as PromiseFulfilledResult<StoredBooking>
).value;

step("7b. Same race with an Adapter that skips the lock");

const unsafe = memoryAdapter({ lock: false });
const unsafeScheduler = createScheduler({ adapter: unsafe });

await unsafeScheduler.setAvailability({
  resourceId: "room-1",
  rules: (await scheduler.getAvailability({ resourceId: "room-1" })).map(
    ({ resourceId: _, ...r }) => r
  ),
});

const unsafeResults = await Promise.allSettled(
  [1, 2, 3].map(() => unsafeScheduler.book(slots[1]!))
);

console.log(
  `   fulfilled=${unsafeResults.filter((r) => r.status === "fulfilled").length}  ← double booking`
);

// ─── 8. Reschedule ─────────────────────────────────────────────────────────

step("8. reschedule 09:00 booking to 09:30–10:00 (overlaps its own old time)");

await attempt("reschedule", () =>
  scheduler.reschedule({
    bookingId: first.id,
    end: at("2026-11-16T10:00"),
    start: at("2026-11-16T09:30"),
  })
);

show(adapter);

step("8b. reschedule it onto 10:00 (taken)");

await attempt("reschedule onto 10:00", () =>
  scheduler.reschedule({
    bookingId: first.id,
    end: slots[1]!.end,
    start: slots[1]!.start,
  })
);

// ─── 9. Cancel ─────────────────────────────────────────────────────────────

step("9. cancel the 10:00 booking, then findSlots again");

await attempt("cancel", () => scheduler.cancel({ bookingId: ten.id }));

await attempt("cancel again (idempotent)", () =>
  scheduler.cancel({ bookingId: ten.id })
);

show(adapter);

const after = await scheduler.findSlots({
  duration: 60,
  from: at("2026-11-16T00:00"),
  resourceId: "room-1",
  to: at("2026-11-17T00:00"),
});

console.log(
  `   slots: ${after.map((s) => local(s.start.toInstant())).join(" | ")}`
);

step("10. Reads");

console.log(
  `   listBookings: ${(await scheduler.listBookings({ resourceId: "room-1" })).length} active,` +
    ` ${(await scheduler.listBookings({ includeCancelled: true, resourceId: "room-1" })).length} incl. cancelled`
);

await attempt("cancel unknown id", () =>
  scheduler.cancel({ bookingId: "nope" })
);
