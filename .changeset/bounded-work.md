---
"@fastijs/scheduler": patch
---

Searches, rule checks and `expandRules` now have fixed limits, and every date must fall in the years 0001–9999 (ADR 019). Going over is `InvalidParams`, never a truncated list or a thrown `RangeError`. A search (`findSlots`, `findFreeSlots`) covers at most 10,000 Grid times, with a `duration` of at most 31 days. A direct `expandRules` call spans at most 366 days. A call takes at most 100 rules (so does `availability.set`), with at most 1,000 exceptions each. The limits are exported from `@fastijs/scheduler/core` as `MAX_GRID_TIMES`, `MAX_DURATION_MINUTES`, `MAX_EXPAND_DAYS`, `MAX_RULES` and `MAX_EXCEPTIONS`.
