---
"@fastijs/scheduler": patch
---

A very long slot no longer expands availability rules over its whole span. `isSlotValid` and the availability Policy on `book` and `reschedule` now refuse a slot longer than any window could hold before expanding anything, and `expandRules` walks only each rule's effective dates, with a constant-time exception lookup.
