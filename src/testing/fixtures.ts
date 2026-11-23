import { randomInt, randomUUID } from "node:crypto";

import { expect } from "vitest";

import type { SchemaAdapter, StoredRecord } from "../adapter/contract.js";
import type {
  BookingRecord,
  ResourceIdOf,
  StatusOf,
} from "../adapter/records.js";
import type { BlockId, BookingId } from "../core/types.js";
import { uuidV7 } from "../framework/booking-id.js";
import type { RuleRecord } from "../framework/plugins/availability.js";
import type { AnyColumn } from "../schema/column.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { Columns } from "../schema/table.js";
import { blockFieldsOf } from "./plugin-stores.js";

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

/** A `blocks()` `block` row, Developer Fields untyped. */
export type BlockRow<S extends AnySchema> = StoredRecord & {
  readonly id: BlockId;
  readonly resourceId: ResourceIdOf<S>;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
};

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
): BlockRow<S> {
  return {
    ...fieldValues(blockFieldsOf(schema), optionalFields),
    end: start.add({ hours: 1 }),
    id: blockId(),
    resourceId,
    start,
  };
}

/** Insert a Block in its own unit of work. */
export async function storeBlock<S extends AnySchema, Tx>(
  adapter: SchemaAdapter<S, Tx, "records">,
  block: BlockRow<S>
): Promise<void> {
  await adapter.withResourceLock(block.resourceId, async (locked) => {
    await locked.insertRecord("block", block);
  });
}

/** `rule` as a new `availability()` `availabilityRule` row on `resourceId`; unset effective dates stored as `null`. */
export function ruleRow<S extends AnySchema>(
  resourceId: ResourceIdOf<S>,
  rule: RuleRecord
): StoredRecord {
  // SAFETY: the recurrence is plain JSON data.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- an interface has no index signature.
  const recurrence = rule.recurrence as unknown as StoredRecord[string];

  return {
    effectiveFrom: rule.effectiveFrom ?? null,
    effectiveTo: rule.effectiveTo ?? null,
    exceptions: rule.exceptions,
    id: uuidV7(),
    recurrence,
    resourceId,
    timezone: rule.timezone,
    windowEnd: rule.timeWindow.end,
    windowStart: rule.timeWindow.start,
  };
}
