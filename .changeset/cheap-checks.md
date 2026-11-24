---
"@fastijs/scheduler": patch
---

`findFreeSlots` and `findSlots` compare Bookings and availability windows as numbers, check valid Bookings without allocating, and zone a Slot's `end` only when the Slot is returned. Same Slots and issues, in less time. Untyped callers who pass a string as a blocking Booking's `start` or `end` to `findFreeSlots`, which the types never allowed, now get a `TypeError`.
