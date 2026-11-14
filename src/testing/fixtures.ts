import { randomInt, randomUUID } from "node:crypto";

import { expect } from "vitest";

import type { SchemaAdapter } from "../adapter/contract.js";
import type {
  BookingRecord,
  ResourceIdOf,
  StatusOf,
} from "../adapter/records.js";
import type { BookingId } from "../core/types.js";
import type { AnyColumn } from "../schema/column.js";
import type { AnySchema } from "../schema/define-schema.js";

/** A fresh Booking id (a UUID, as the Framework will mint). */
export function bookingId(): BookingId {
  // SAFETY: a UUID string is a valid BookingId; the brand is type-only.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minting a branded id.
  return randomUUID() as BookingId;
}

/** A random Instant in 2030 at millisecond precision: what every Adapter must round-trip. */
export function instant(): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(
    Date.UTC(2030, 0, 1) + randomInt(365 * 24 * 3_600_000)
  );
}

/** A value of some column kind. */
type FieldValue = string | number | boolean | Temporal.Instant;

/** A random value of a column kind. Integers stay within a 4-byte SQL integer. */
function valueOf(type: AnyColumn): FieldValue {
  switch (type.kind) {
    case "text": {
      return `text-${randomUUID()}`;
    }

    case "uuid": {
      return randomUUID();
    }

    case "integer": {
      return randomInt(-2_147_483_648, 2_147_483_647);
    }

    case "boolean": {
      return randomInt(2) === 1;
    }

    case "instant": {
      return instant();
    }

    default: {
      throw new Error(`Unknown column kind: ${JSON.stringify(type)}`);
    }
  }
}

/** Params of {@link newBooking}. */
export interface NewBookingParams<S extends AnySchema> {
  readonly resourceId: ResourceIdOf<S>;
  readonly status: StatusOf<S>;
  /** Whether optional Developer Fields get a value or `null`. */
  readonly optionalFields: "set" | "null";
}

/** A new Booking one hour long, with a generated value for every Developer Field. */
export function newBooking<S extends AnySchema>(
  schema: S,
  { optionalFields, resourceId, status }: NewBookingParams<S>
): BookingRecord<S> {
  const start = instant();

  const fields = Object.fromEntries(
    Object.entries(schema.booking.fields).map(([name, field]) => [
      name,
      field.required || optionalFields === "set" ? valueOf(field.type) : null,
    ])
  );

  // SAFETY: `fields` holds one value of the declared kind per Developer Field (null when optional and unset).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the values are generated from the schema at runtime.
  return {
    ...fields,
    end: start.add({ hours: 1 }),
    id: bookingId(),
    resourceId,
    start,
    status,
  } as BookingRecord<S>;
}

/** Insert a Booking in its own unit of work and assert it succeeded. */
export async function insert<S extends AnySchema, Tx>(
  adapter: SchemaAdapter<S, Tx>,
  booking: BookingRecord<S>
): Promise<void> {
  const result = await adapter.withResourceLock(
    booking.resourceId,
    async (locked) => await locked.insertBooking(booking)
  );

  expect(result).toStrictEqual({ ok: true });
}
