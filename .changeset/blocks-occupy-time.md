---
"@fastijs/scheduler": minor
---

Blocks now occupy time. `book` over a Block is refused with `SlotConflict`, whose items can now be `ConflictingBlock` (`kind: "block"`, `id: BlockId`), sorted with any Bookings by start, then id; the overlap is still reported ahead of a `PolicyViolation`. `findSlots` no longer offers slots that overlap a Block. A schema without `block` makes no Block read. The Conformance Suite gains a concurrency case racing a Block write against bookings of one slot.
