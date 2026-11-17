---
"@fastijs/scheduler": minor
---

`reschedule({ id, start, end, resourceId?, fields?, also? })` moves a blocking Booking in time or to another Resource, keeping its id and Status. It takes one Resource Lock, on the destination, checks overlap ignoring the Booking itself and then availability, and carries `also` with `{ tx, booking, previous, now }`. A Booking in a non-blocking Status gives the new `StatusMismatch { id, status }`. `findSlots` takes `excludeBookingId`, so it returns exactly the slots a reschedule of that Booking accepts. New exports: `RescheduleParams`, `RescheduleError`, `StatusMismatch`.
