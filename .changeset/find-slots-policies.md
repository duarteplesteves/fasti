---
"@fastijs/scheduler": minor
---

`findSlots` honours Policies, and agrees with the writes by construction: it runs the same Policy pass on each Grid slot. A slot that breaks an unrelaxed Policy is hidden. With `relax`, a slot that breaks only relaxed Policies is listed, with those Violations in `waived` (`Slot<S, W>`); `relax: ["availability"]` lists Grid slots outside the rules. Each Policy's `load` runs once per search, over `[from, to + duration)`. Without `excludeBookingId` the `book` Policies run on a `book` candidate. With it, the `reschedule` Policies run, with `previous` set to that Booking, and `relax` narrows to their names. An unknown `relax` name is `InvalidParams` at `["relax", i]`, before any Adapter call.

Breaking: `FindSlotsError` adds `BookingNotFound` (an `excludeBookingId` that names no Booking). `Slot` takes a second type parameter `W` (default `never`).
