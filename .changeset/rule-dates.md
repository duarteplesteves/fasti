---
"@fastijs/scheduler": patch
---

A rule's dates are worked out as numbers, so expanding rules takes less time. Rule dates in a calendar other than ISO are now read by the date they name: such an exception was ignored or such an `effectiveFrom` could throw. `expandRules` windows are always in `from`'s calendar.
