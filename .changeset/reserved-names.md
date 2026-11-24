---
"@fastijs/scheduler": patch
---

`defineSchema` now throws on a Booking Developer Field named after a Booking column (`id`, `resourceId`, `start`, `end`, `status`), which was only a type error: plain JavaScript could declare one, and its `fields` patch could then move a Booking past the Resource Lock and the overlap check. A Plugin write Action with an `also` param is now a type error, since fasti takes `also` for itself. A Status named after an inherited property (`toString`, `constructor`) is now refused as unknown instead of reading as not blocking.
