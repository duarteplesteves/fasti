---
"@fastijs/scheduler": patch
---

A Plugin's busy range whose id equals the Booking being moved no longer vanishes from `reschedule` and `findSlots({ excludeBookingId })`: only the stored Booking is left out. A Conflict now keeps its own `kind` when a busy range shares its id with a Booking.
