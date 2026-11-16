---
"@fastijs/scheduler": minor
---

Blocks, part one: declare `block: { fields }` in `defineSchema` (renamable via `names.tables.block` and `names.columns.block`) and the scheduler gains `blocks.create` and `blocks.list`. `create` refuses an overlap with a blocking Booking as `SlotConflict`; Blocks may overlap each other. Without `block`, `schema.block` is `null` and there is no `scheduler.blocks`.

Adapters now declare the optional verb groups they implement: `Adapter<Tx, G>`, with `"blocks"` adding `getBlock`, `listBlocks` and `insertBlock`. `memoryAdapter()` implements it. A schema with `block` needs such an Adapter at `createScheduler`; every existing `Adapter<Tx>` still compiles for schemas without `block`. `LockedAdapter` and `SchemaAdapter` are now type aliases rather than interfaces, so code that extends them with `interface … extends` must use an intersection instead. The Conformance Suite runs its new `blocks` cases when the schema declares `block`.
