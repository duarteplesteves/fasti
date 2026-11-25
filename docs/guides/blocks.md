# Blocks

A Block makes a Resource unbookable for a while: a vacation, a lunch, a meeting. It isn't a Booking: it has its own Developer Fields and no Status, and you only create, change or delete it ([ADR 016](../adr/016-block-is-its-own-entity.md)).

## Install

```typescript
import { availability, blocks, column, defineSchema } from "@fastijs/scheduler";
import { bookingTable, recordTables } from "@fastijs/scheduler/drizzle/pg";

export const schema = defineSchema({
  booking: { fields: { customerName: { type: column.text(), required: true } } },
  plugins: [
    availability(),
    blocks({ fields: { reason: { type: column.text(), required: true } } }), // `fields: {}` for none
  ],
});

export const tables = {
  ...recordTables(schema), // now `availabilityRule` and `block`: migrate it
  booking: bookingTable(schema),
};
```

## Use

```typescript
const lunch = await scheduler.blocks.create({
  resourceId: "room-1",
  start: at("12:00"),
  end: at("14:00"),
  fields: { reason: "lunch" },
});
// { ok: true, value: { id, resourceId, start, end, reason: "lunch" } }

// `findSlots` now hides 12:00–14:00, and `book` refuses it:
const overLunch = await scheduler.book({
  resourceId: "room-1",
  start: at("12:30"),
  end: at("13:00"),
  fields: { customerName: "Grace" },
});

if (!overLunch.ok && overLunch.error._tag === "SlotConflict") {
  for (const conflict of overLunch.error.conflicts) {
    conflict.kind; // "booking" | "block": narrow on it
  }
}

if (lunch.ok) {
  // Back early.
  await scheduler.blocks.update({ id: lunch.value.id, start: at("12:00"), end: at("13:00") });
  await scheduler.blocks.delete({ id: lunch.value.id });
}

await scheduler.blocks.list({ resourceId: "room-1", from: at("00:00"), to: at("23:59") });
```

| Action          | Value                                                         | Errors (`_tag`), besides `AdapterError`            |
| --------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| `blocks.create` | the `Block`                                                   | `InvalidParams`, `SlotConflict`                    |
| `blocks.update` | the updated `Block`                                           | `InvalidParams`, `SlotConflict`, `BlockNotFound`   |
| `blocks.delete` | nothing                                                       | `BlockNotFound`                                    |
| `blocks.list`   | the Blocks overlapping `[from, to)`, sorted by start, then id | `InvalidParams`                                    |

## Rules

- **The check runs both ways.** `book` refuses a slot over a Block, and `blocks.create` and `blocks.update` refuse a range over a blocking Booking. Both are a `SlotConflict`, and neither can be relaxed. To take a vacation over existing Bookings, cancel or move them first.
- **A Block is a half-open `[start, end)` range of Instants**: no timezone, no recurrence. It may be in the past.
- **`update`** takes the `id`, and optionally a new `start` and `end` (together) and the `fields` to change. It can't move a Block to another Resource.
- **Blocks may overlap each other**, and no Policy applies to their writes: a Block outside opening hours is fine.
- **The Effect form** has the same `blocks` Actions.

> **Writes outside fasti aren't caught.** The [backstop](./databases.md#the-backstop) works within one table, so no database constraint stops a Booking from overlapping a Block. fasti's lock keeps its own Actions safe, but a row you write to either table yourself can create an overlap that nothing catches. A later `blocks.update` that changes only `fields` doesn't check again, so the overlap stays.

Blocks are [busy time](./plugins.md#busy-time-or-a-policy), stored by a Plugin like any other: rename the table and columns under `names.tables.block` and `names.columns.block`.
