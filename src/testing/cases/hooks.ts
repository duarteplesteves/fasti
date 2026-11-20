import { assert, expect } from "vitest";

import type { BookingId } from "../../core/types.js";
import { createScheduler } from "../../framework/create-scheduler.js";
import type { AnyHookOf } from "../../framework/hook.js";
import type { AnySchema } from "../../schema/define-schema.js";
import type { CaseContext, ConformanceCase } from "../conformance-case.js";
import { newBooking } from "../fixtures.js";

/** Book one hour on the first Resource through a scheduler with `hooks`, waiving `availability` so no rules are needed. */
async function bookWith<S extends AnySchema, Tx>(
  { resources, schema, unbound }: CaseContext<S, Tx>,
  hooks: readonly AnyHookOf<S, Tx>[]
) {
  const scheduler = createScheduler({ adapter: unbound, hooks, schema });

  const { end, id, resourceId, start, status, ...fields } = newBooking(schema, {
    optionalFields: "null",
    resourceId: resources[0],
    status: "booked",
  });

  // SAFETY: `fields` holds a value for every Developer Field, and `status` is "booked", an initial Status of every schema.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- TypeScript can't check generated fields against a generic schema's params.
  const params = {
    end,
    fields,
    relax: ["availability"],
    resourceId,
    start,
    status,
  } as unknown as Parameters<typeof scheduler.book>[0];

  return await scheduler.book(params);
}

/** An in-transaction Hook on `book` that records the Booking's id, then runs `then`. */
function seeing<S extends AnySchema, Tx>(
  seen: BookingId[],
  then: (tx: Tx) => void | Promise<void>
): AnyHookOf<S, Tx> {
  return {
    appliesTo: ["book"],
    async run(event) {
      assert("booking" in event, "a book Hook got an event without a Booking");
      seen.push(event.booking.id);

      await then(event.tx);
    },
    when: "inTransaction",
  };
}

/** A Hook that throws `reason`. */
function throwing<S extends AnySchema, Tx>(reason: Error): AnyHookOf<S, Tx> {
  return {
    appliesTo: ["book"],
    run() {
      throw reason;
    },
    when: "inTransaction",
  };
}

/** The one Booking id an in-transaction Hook saw. */
function onlyId(seen: readonly BookingId[]): BookingId {
  const [id, ...rest] = seen;

  assert(id !== undefined && rest.length === 0, "expected one Hook run");

  return id;
}

/** The probe or retry value. Cases of its group only run with one. */
function required<T>(value: T | null, group: string): T {
  if (value === null) {
    throw new Error(`a ${group} case ran without its probe`);
  }

  return value;
}

/** Hooks are atomic with the write (ADR 017): an in-transaction throw rolls it all back; a transient retry commits once and runs after-commit once. */
export const hookCases: readonly ConformanceCase[] = [
  {
    name: "a throwing in-transaction Hook rejects book with its value and leaves no Booking",
    async run(ctx) {
      const seen: BookingId[] = [];
      const reason = new Error("hook failed");

      await expect(
        bookWith(ctx, [
          seeing(seen, () => {
            throw reason;
          }),
        ])
      ).rejects.toBe(reason);

      expect(await ctx.adapter.getBooking(onlyId(seen))).toBeNull();
    },
    tags: [],
  },
  {
    name: "an in-transaction Hook that writes a probe row through tx, then a throwing Hook, leaves neither",
    async run(ctx) {
      const probe = required(ctx.probe, "tx");
      const before = await probe.count();
      const seen: BookingId[] = [];
      const reason = new Error("hook failed");

      await expect(
        bookWith(ctx, [
          seeing(seen, async (tx) => {
            await probe.write(tx);
          }),
          throwing(reason),
        ])
      ).rejects.toBe(reason);

      expect(await ctx.adapter.getBooking(onlyId(seen))).toBeNull();
      expect(await probe.count()).toBe(before);
    },
    tags: ["tx"],
  },
  {
    name: "an in-transaction Hook that throws a transient value once is retried: one Booking, after-commit runs once and reads it back",
    async run(ctx) {
      const retry = required(ctx.retry, "retry");
      const seen: BookingId[] = [];
      const readBack: unknown[] = [];

      const result = await bookWith(ctx, [
        seeing(seen, () => {
          if (seen.length === 1) {
            throw retry.transient();
          }
        }),
        {
          appliesTo: ["book"],
          async run(event) {
            assert(
              "booking" in event,
              "a book Hook got an event without a Booking"
            );
            readBack.push(await ctx.adapter.getBooking(event.booking.id));
          },
          when: "afterCommit",
        },
      ]);

      assert(result.ok, "expected book to succeed after the retry");
      expect(seen).toHaveLength(2);

      const stored = await ctx.adapter.listBookings({
        overlapping: { from: result.value.start, to: result.value.end },
        resourceId: ctx.resources[0],
      });

      expect(stored.map((b) => b.id)).toStrictEqual([seen[1]]);
      expect(readBack).toStrictEqual(stored);
    },
    tags: ["retry"],
  },
];
