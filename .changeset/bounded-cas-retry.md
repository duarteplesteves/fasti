---
"@fastijs/scheduler": patch
---

`cancel`, `transition`, `reschedule` and `blocks.update` no longer retry forever when an outside writer keeps moving or changing the row between reads: after 3 attempts they fail with `AdapterError`, as an exhausted transient retry does.
