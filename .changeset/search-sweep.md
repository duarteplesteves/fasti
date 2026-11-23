---
"@fastijs/scheduler": patch
---

`findFreeSlots` and `findSlots` no longer rescan every Booking and every availability window at each Grid time. They sweep both once, in start order, alongside the Grid. A one-year search on a 15-minute Grid with 3,000 Bookings drops from about 27 s to 130 ms, with the same slots.
