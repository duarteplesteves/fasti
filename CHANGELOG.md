# @fastijs/scheduler

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
