import { randomInt, randomUUID } from "node:crypto";

import { expect } from "vitest";

import type { SchemaAdapter } from "../adapter/contract.js";
import type {
  BookingRecord,
  ResourceIdOf,
  StatusOf,
} from "../adapter/records.js";
import type { BlockId, BookingId } from "../core/types.js";
import type { AnyColumn } from "../schema/column.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { Columns } from "../schema/table.js";
import { blockFieldsOf } from "./plugin-stores.js";
import type { BlockRecord, BlockStore } from "./plugin-stores.js";

/** A fresh Booking id (a UUID, as the Framework will mint). */
export function bookingId(): BookingId {
  // SAFETY: a UUID string is a valid BookingId; the brand is type-only.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minting a branded id.
  return randomUUID() as BookingId;
}

/** A fresh Block id. */
export function blockId(): BlockId {
  // SAFETY: a UUID string is a valid BlockId; the brand is type-only.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- minting a branded id.
  return randomUUID() as BlockId;
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
export function valueOf(type: AnyColumn): FieldValue {
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

/** A Booking or Block Developer Field's column: Developer Field kinds only. */
function developer(type: Columns[string]["type"]): AnyColumn {
  // SAFETY: Booking and Block Developer Fields are Developer Field kinds; a Block field is typed as a Plugin column.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
  return type as AnyColumn;
}

/** A generated value for every Developer Field; optional ones `null` unless `set`. */
function fieldValues(
  fields: Columns,
  optionalFields: "set" | "null"
): Record<string, FieldValue | null> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      field.required || optionalFields === "set"
        ? valueOf(developer(field.type))
        : null,
    ])
  );
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
  const fields = fieldValues(schema.booking.fields, optionalFields);

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

/** Params of {@link newBlock}. */
export interface NewBlockParams<S extends AnySchema> {
  readonly resourceId: ResourceIdOf<S>;
  /** Whether optional Developer Fields get a value or `null`. */
  readonly optionalFields: "set" | "null";
  /** Defaults to a random Instant in 2030. */
  readonly start?: Temporal.Instant;
}

/** A new Block one hour long, with a generated value for every Block Developer Field. */
export function newBlock<S extends AnySchema>(
  schema: S,
  { optionalFields, resourceId, start = instant() }: NewBlockParams<S>
): BlockRecord<S> {
  return {
    ...fieldValues(blockFieldsOf(schema), optionalFields),
    end: start.add({ hours: 1 }),
    id: blockId(),
    resourceId,
    start,
  };
}

/** Insert a Block in its own unit of work. */
export async function insertBlock<S extends AnySchema, Tx>(
  adapter: BlockStore<S, Tx>,
  block: BlockRecord<S>
): Promise<void> {
  await adapter.withResourceLock(block.resourceId, async (locked) => {
    await locked.insertBlock(block);
  });
}
