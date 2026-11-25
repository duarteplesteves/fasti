# Custom Adapters

If your tables differ from fasti's by more than names, or you use another database, write your own Adapter against the contract in `@fastijs/scheduler/adapter` ([ADR 008](../adr/008-adapter-contract.md)). If only the names differ, use [`names`](./schema.md) instead.

## Write it

It is a few `async` verbs over whole records, plus `withResourceLock`, which runs a unit of work in one transaction that excludes every other locked unit on the same Resource. A sketch, with the bodies left out:

```typescript
import { defineAdapter } from "@fastijs/scheduler/adapter";

export const myAdapter = defineAdapter<MyTx, "records">((schema) => ({
  getBooking: async (id) => /* BookingRecord | null */,
  listBookings: async ({ resourceId, overlapping }) => /* sorted by start, then id */,
  // The "records" group: every Plugin table, by logical name (schema.tables).
  getRecord: async (table, id) => /* StoredRecord | null */,
  listRecords: async (table, { resourceId, overlapping }) => /* timed: by start, then id; untimed: by id */,
  withResourceLock: async (resourceId, work) =>
    db.transaction(async (tx) => {
      await lock(tx, resourceId);
      return work({
        tx,
        getBooking, listBookings, getRecord, listRecords, // the same reads, through tx
        insertBooking: async (booking) => /* { ok: true } or { ok: false, reason: "conflict" } */,
        updateBooking: async ({ expected, changes }) => /* compare-and-set; "changed" if the row moved on */,
        insertRecord: async (table, record) => { /* fasti minted record.id */ },
        updateRecord: async (table, { expected, changes }) => /* compare-and-set; "changed" */,
        deleteRecord: async (table, id) => /* { ok: true } or { ok: false, reason: "missing" } */,
        replaceRecords: async (table, { resourceId, records }) => { /* replace that Resource's rows */ },
      });
    }),
}));
```

What to get right:

- **The lock.** Reads inside it must see everything committed before it was granted, so on Postgres run it at `READ COMMITTED`. Writes exist only on the handle passed into that unit of work.
- **Expected outcomes are values**: `conflict`, `changed` and `missing` are returned. Anything else rejects with an `Error`, carrying your driver's error as `cause` when the driver failed.
- **Logical names.** Records use fasti's names (`start`, `"booked"`); map them to your columns and stored values inside the Adapter.
- **Indexes.** Index each table on its Resource id, `start` and `end` (the Resource id alone when untimed), as fasti's own are: most reads ask for one Resource's rows in a range, some while holding the lock.
- **A pool.** `findSlots` makes its reads at once, so use a connection pool rather than one connection.

### The `"records"` group

It stores every Plugin's tables, present and future, so you write it once. A schema whose Plugins declare tables (`availability()`, `blocks()`, …) needs it, and the types enforce it; a schema with none doesn't.

`schema.tables` lists each table's physical name, whether it's `timed` (fasti-owned `start` and `end`), and its columns with their kinds: `text`, `uuid`, `integer`, `boolean`, `instant`, `date` (`Temporal.PlainDate`), `time` (`Temporal.PlainTime`), `json` and `dates` (a list of `PlainDate`). Compare `json` values by content, not by key order.

## Test it

Prove your Adapter with the Conformance Suite, in a Vitest file, against a real database:

```typescript
import { testAdapter } from "@fastijs/scheduler/testing";

testAdapter({
  schema,
  makeAdapter: () => myAdapter, // called per case; must allow 20 concurrent units of work
  reset: async () => {
    /* empty the fasti tables; keep your Resource rows */
  },
  resources: [staffA, staffB], // two Resource ids that exist in your database
  groups: {
    backstop: false, // true only if your database has a constraint like backstopSql
    // Proves writes through `tx` share fasti's unit of work; null if your `tx` is no transaction.
    tx: {
      write: async (tx) => { /* insert one row in a table of your own through tx */ },
      count: async () => { /* count those rows, outside any transaction */ },
    },
    // A value your Adapter retries as transient, e.g. a serialization failure; null if it never retries.
    retry: { transient: () => ({ code: "40001" }) },
  },
});
```

It registers one test per case, including:

| Cases                                                                                        | Run when your test schema installs                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Concurrency, which catches a missing or broken lock                                          | anything                                                            |
| Hooks: a throw in the transaction rolls back, and a retry runs after-commit Hooks once        | anything                                                            |
| Records: every column kind, half-open `overlapping`, compare-and-set, rollback               | `conformancePlugin`, from `@fastijs/scheduler/testing`. Do, if you implement `"records"` |
| Availability                                                                                 | `availability()`                                                    |
| Blocks                                                                                       | `blocks()`                                                          |

To run a subset, filter `conformanceCases` by `tags` and call `runCase` yourself.
