---
"@fastijs/scheduler": minor
---

Conformance Suite `tx` group: prove that writes through `locked.tx` share fasti's unit of work, which `also` relies on. `testAdapter` now takes `groups.tx`: a `TxProbe<Tx>` (`write(tx)` inserts a row in a table of your own through `tx`, `count()` counts those rows outside any transaction), or `null` to register the `tx` cases as skipped, as for an Adapter whose `tx` is no transaction. **Breaking for Adapter authors:** `groups.tx` is required; pass `null` to keep today's behavior. New exports from `/testing`: the `TxProbe` type and the `"tx"` case tag.
