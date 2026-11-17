import { expect } from "vitest";

import type { AnySchema } from "../../schema/define-schema.js";
import type {
  CaseContext,
  ConformanceCase,
  TxProbe,
} from "../conformance-case.js";
import { newBooking } from "../fixtures.js";

/** The probe. `tx` cases only run with one. */
function probeOf<S extends AnySchema, Tx>({
  probe,
}: CaseContext<S, Tx>): TxProbe<Tx> {
  if (probe === null) {
    throw new Error("a tx case ran without a probe");
  }

  return probe;
}

/** A Booking and a probe row written in one unit of work, through `locked` and `locked.tx`. */
async function writeBoth<S extends AnySchema, Tx>(
  ctx: CaseContext<S, Tx>,
  then: "resolve" | "reject"
) {
  const { adapter, resources, schema } = ctx;
  const probe = probeOf(ctx);

  const booking = newBooking(schema, {
    optionalFields: "null",
    resourceId: resources[0],
    status: "booked",
  });

  const before = await probe.count();
  const reason = new Error("work failed");

  const unit = adapter.withResourceLock(resources[0], async (locked) => {
    expect(await locked.insertBooking(booking)).toStrictEqual({ ok: true });
    await probe.write(locked.tx);

    if (then === "reject") {
      throw reason;
    }
  });

  await (then === "reject"
    ? expect(unit).rejects.toBe(reason)
    : expect(unit).resolves.toBeUndefined());

  return { before, booking, probe };
}

/** `locked.tx` is the unit of work itself (ADR 015): the developer's writes through it commit and roll back with fasti's. */
export const txCases: readonly ConformanceCase[] = [
  {
    name: "a unit that writes a Booking and a probe row through tx, then rejects, leaves neither",
    async run(ctx) {
      const { before, booking, probe } = await writeBoth(ctx, "reject");

      expect(await ctx.adapter.getBooking(booking.id)).toBeNull();
      expect(await probe.count()).toBe(before);
    },
    tags: ["tx"],
  },
  {
    name: "a unit that writes a Booking and a probe row through tx, then resolves, keeps both",
    async run(ctx) {
      const { before, booking, probe } = await writeBoth(ctx, "resolve");

      expect(await ctx.adapter.getBooking(booking.id)).toStrictEqual(booking);
      expect(await probe.count()).toBe(before + 1);
    },
    tags: ["tx"],
  },
];
