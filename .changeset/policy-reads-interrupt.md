---
"@fastijs/scheduler": patch
---

In the Effect form, interrupting `findSlots` now rejects the reads a Policy's `load` is waiting for or makes afterwards, so `load` stops there, as a Plugin's already did. Before, it ran on.
