---
"@fastijs/scheduler": patch
---

`findSlots` makes its reads at once instead of one after another, so a search waits for one round trip. A search can use one pool connection per read; give your Adapter a pool rather than a single client. Policies' `load`s still run in order, but now start before the stored Bookings have been checked.
