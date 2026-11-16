---
"@fastijs/scheduler": minor
---

Blocks, part two: `blocks.update({ id, start, end, fields })` moves, resizes or re-annotates a Block, and `blocks.delete({ id })` removes it, freeing its time. `start` and `end` come together or not at all; `fields` are merged; the Resource never changes. A new range is checked against blocking Bookings (`SlotConflict`), a fields-only update isn't, and an update that changes nothing writes nothing. Both refuse an unknown id with the new `BlockNotFound`.

The `"blocks"` verb group gains `updateBlock` (compare-and-set, `ok | changed`) and `deleteBlock` (`ok | missing`), with `BlockChanges`, `UpdateBlockResult` and `DeleteBlockResult` on `/adapter`. Custom Adapters that declare `"blocks"` must implement both. The Conformance Suite covers them, including rollback.
