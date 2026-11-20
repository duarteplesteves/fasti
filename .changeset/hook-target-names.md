---
"@fastijs/scheduler": minor
---

Export the target-name types Hooks will use: `BookingActionName` (`book`, `reschedule`, `cancel`: what a Policy can name), `WriteActionName<S>` (every write Action, with `blocks.*` only when the schema has `block`) and `HookTarget<S>`. `ActionTarget` is now a deprecated alias of `BookingActionName`.
