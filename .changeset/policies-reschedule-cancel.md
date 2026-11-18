---
"@fastijs/scheduler": minor
---

Run Policies on `reschedule` and `cancel`. A Policy with `"reschedule"` in `appliesTo` gets `{ action: "reschedule", resourceId, start, end, previous, now }`, where `resourceId` is the destination and `previous` the stored Booking; `availability` runs there too. A Policy with `"cancel"` gets `{ action: "cancel", booking, now }`, and its `load` gets the stored Booking's range. The Invariants come first (`StatusMismatch`, `SlotConflict`, `TransitionNotDeclared`). Both take `relax` and report `waived` as `book` does; on `cancel`, `waived` is on the `alreadyCancelled: false` branch only. A repeat `cancel` runs no Policy and no `also`. `RescheduleCandidate` and `CancelCandidate` are exported.

Breaking: `RescheduleError` drops `PolicyViolation` (the scheduler types it from its Policies), and `CancelError` adds `InvalidParams` (an unknown `relax` name).
