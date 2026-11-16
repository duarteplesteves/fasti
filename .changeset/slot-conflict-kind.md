---
"@fastijs/scheduler": minor
---

**Breaking:** each `SlotConflict.conflicts` item now has a `kind` (`"booking"` for now; Blocks add `"block"`), and the list is typed as the new exported `Conflict` union, sorted by start, then id. Code reading `id`, `start` and `end` keeps working; code that builds `ConflictingBooking` literals or matches their exact shape must add `kind: "booking"`.
