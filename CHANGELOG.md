# @fastijs/scheduler

## 0.3.0

### Minor Changes

- 3dd36e5: `also` on every existing write Action (ADR 015): `book`, `cancel`, `availability.set` and `blocks.create / update / delete` take an optional `also({ tx, now, ... })` that runs after fasti's write, on the same unit of work. It may be sync or async and returns a `Result`: its value comes back as `also` on the Action's value, and a failure rolls everything back and fails the Action with `Vetoed { reason }` (only in the error union when `also` is passed). A throw rolls back and rejects. `also` doesn't run when nothing changed (a repeat `cancel`); a no-op `blocks.update` still runs it, with `block === previous`. **Breaking (types only):** `CancelValue` is now a union on `alreadyCancelled: true | false`. When a unit fails, the Adapter's `withResourceLock` now rejects with the original error behind an `AdapterError`, or with what `also` threw, so an Adapter can classify it. New exports: `Vetoed`, `BookAlso`, `ChangeAlso`, `SetAvailabilityAlso`, `CreateBlockAlso`, `UpdateBlockAlso`, `DeleteBlockAlso`. In the Effect form, `also` returns an Effect; its services and a typed `tx` come later.
- a9eee49: Conformance Suite `tx` group: prove that writes through `locked.tx` share fasti's unit of work, which `also` relies on. `testAdapter` now takes `groups.tx`: a `TxProbe<Tx>` (`write(tx)` inserts a row in a table of your own through `tx`, `count()` counts those rows outside any transaction), or `null` to register the `tx` cases as skipped, as for an Adapter whose `tx` is no transaction. **Breaking for Adapter authors:** `groups.tx` is required; pass `null` to keep today's behavior. New exports from `/testing`: the `TxProbe` type and the `"tx"` case tag.
- c207bea: Developer Statuses and Transitions (ADR 009): `defineSchema({ booking: { statuses, transitions, initial } })` declares Statuses beyond `booked` and `cancelled`, each with `blocking`, the Transitions between them (`booked → cancelled` is always present), and the Statuses `book` may create a Booking in (default `["booked"]`). With more than one initial Status, `book` takes a required `status`; a non-blocking one skips the overlap check but not availability. Declared Statuses are stored, blocked on and backstopped like the base ones: the Drizzle `CHECK` constraint and `backstopSql` list them, so add a migration and re-run `backstopSql` when blocking Statuses change. Redeclaring a base Status, naming an unknown Status in `transitions` or `initial`, two Statuses sharing a stored value, and a Booking or Block Developer Field named `also` (now reserved) throw at definition time and are type errors. `Schema` gains two type parameters, `transitions` and `initial`; the Status codec gains `canMove(from, to)`.
- 0830c98: The Drizzle Adapter retries transient errors (ADR 008): a unit of work that fails with `40001` (serialization failure) or `40P01` (deadlock), found anywhere on the error's `cause` chain, reruns whole, `also` included, up to 3 attempts. Other errors aren't retried. When attempts run out, the error surfaces as before: an `AdapterError` when it came from fasti's own write, a rejection with what was thrown when it came from `also`.
- 5629a17: In the Effect form, `also` can require your own services (they join the Action's requirements, `Effect<V, E, R>`), its `now` comes from Effect's `Clock` (so `TestClock` controls it), and its `tx` has the Adapter's type (ADR 010, amended). New export from `@fastijs/scheduler/effect`: `TxOf<A>`, an Adapter's transaction type.
  
  **Breaking (types only):** `Scheduler` from `@fastijs/scheduler/effect` takes the Adapter's transaction type as a required third parameter, and `SchedulerService<S>` becomes `SchedulerService<S, Tx>`.
  
  Before:
  
  ```ts
  class AppScheduler extends Scheduler<AppScheduler, typeof schema>()("app/Scheduler") {}
  const live = AppScheduler.layer({ schema, adapter: drizzleAdapter(db) });
  ```
  
  After:
  
  ```ts
  const adapter = drizzleAdapter(db);
  class AppScheduler extends Scheduler<AppScheduler, typeof schema, TxOf<typeof adapter>>()("app/Scheduler") {}
  const live = AppScheduler.layer({ schema, adapter });
  ```
- 9730edf: `reschedule({ id, start, end, resourceId?, fields?, also? })` moves a blocking Booking in time or to another Resource, keeping its id and Status. It takes one Resource Lock, on the destination, checks overlap ignoring the Booking itself and then availability, and carries `also` with `{ tx, booking, previous, now }`. A Booking in a non-blocking Status gives the new `StatusMismatch { id, status }`. `findSlots` takes `excludeBookingId`, so it returns exactly the slots a reschedule of that Booking accepts. New exports: `RescheduleParams`, `RescheduleError`, `StatusMismatch`.
- 9a7ae90: **Breaking (types only):** `Scheduler` now takes the Adapter's transaction type, so `Scheduler<typeof schema>` becomes `Scheduler<typeof schema, Tx>`; `createScheduler` infers `Tx` from the Adapter. `BlockActions` takes `Tx` and the form as well: `BlockActions<S, Tx, "effect" | "plain">`. Calling the Actions is unchanged in both forms.
- d288d18: `transition({ id, from, to, fields, also })` moves a Booking along a declared Transition (ADR 009), compare-and-set on `from`: a stale `from` gives `StatusMismatch { id, status }` with the stored Status. `to` is narrowed by `from` and never `cancelled` (use `cancel`); an undeclared pair gives `InvalidParams` at `["to"]` before any Adapter call. `transition` exists on the Scheduler exactly when some declared Transition doesn't end in `cancelled` (`TransitionEdge<S>`). Moving into a blocking Status from a non-blocking one re-checks overlap; availability isn't checked. `cancel` now follows the declared Transitions: from a Status with no edge to `cancelled` it gives `TransitionNotDeclared { id, from, to }`, and it takes a partial `fields` patch. **Breaking (types only):** `CancelParams` and `CancelError` now take the schema as a type parameter. New exports: `TransitionParams`, `TransitionError`, `TransitionEdge`, `StatusMismatch`, `TransitionNotDeclared`, `FieldsPatch`.

## 0.2.0

### Minor Changes

- 1d4c000: Blocks now occupy time. `book` over a Block is refused with `SlotConflict`, whose items can now be `ConflictingBlock` (`kind: "block"`, `id: BlockId`), sorted with any Bookings by start, then id; the overlap is still reported ahead of a `PolicyViolation`. `findSlots` no longer offers slots that overlap a Block. A schema without `block` makes no Block read. The Conformance Suite gains a concurrency case racing a Block write against bookings of one slot.
- 66100b0: Blocks, part one: declare `block: { fields }` in `defineSchema` (renamable via `names.tables.block` and `names.columns.block`) and the scheduler gains `blocks.create` and `blocks.list`. `create` refuses an overlap with a blocking Booking as `SlotConflict`; Blocks may overlap each other. Without `block`, `schema.block` is `null` and there is no `scheduler.blocks`.
  
  Adapters now declare the optional verb groups they implement: `Adapter<Tx, G>`, with `"blocks"` adding `getBlock`, `listBlocks` and `insertBlock`. `memoryAdapter()` implements it. A schema with `block` needs such an Adapter at `createScheduler`; every existing `Adapter<Tx>` still compiles for schemas without `block`. `LockedAdapter` and `SchemaAdapter` are now type aliases rather than interfaces, so code that extends them with `interface … extends` must use an intersection instead. The Conformance Suite runs its new `blocks` cases when the schema declares `block`.
- aa752ff: Blocks, part two: `blocks.update({ id, start, end, fields })` moves, resizes or re-annotates a Block, and `blocks.delete({ id })` removes it, freeing its time. `start` and `end` come together or not at all; `fields` are merged; the Resource never changes. A new range is checked against blocking Bookings (`SlotConflict`), a fields-only update isn't, and an update that changes nothing writes nothing. Both refuse an unknown id with the new `BlockNotFound`.
  
  The `"blocks"` verb group gains `updateBlock` (compare-and-set, `ok | changed`) and `deleteBlock` (`ok | missing`), with `BlockChanges`, `UpdateBlockResult` and `DeleteBlockResult` on `/adapter`. Custom Adapters that declare `"blocks"` must implement both. The Conformance Suite covers them, including rollback.
- 8fd715d: Blocks on Postgres: `drizzleAdapter(db)` now implements the `"blocks"` verb group, so a schema with `block` works with it. Make the table with the new `blockTable(schema, { references })` from `/drizzle/pg`: a uuid primary key, the Resource id column (with an optional `ON DELETE RESTRICT` foreign key), `start`/`end` as `timestamptz`, and your Developer Fields, all under your physical names. Block writes run under the same Resource Lock as Bookings. A schema without `block` needs no Block table.
- a51d499: **Breaking:** each `SlotConflict.conflicts` item now has a `kind` (`"booking"` for now; Blocks add `"block"`), and the list is typed as the new exported `Conflict` union, sorted by start, then id. Code reading `id`, `start` and `end` keeps working; code that builds `ConflictingBooking` literals or matches their exact shape must add `kind: "booking"`.

## 0.1.0

### Minor Changes

- 14f5e58: First stable release: the thin framework. `createScheduler` with `book`, `cancel`, `findSlots` and `availability.set`, the Effect form at `@fastijs/scheduler/effect`, and typed errors exported from the root.
