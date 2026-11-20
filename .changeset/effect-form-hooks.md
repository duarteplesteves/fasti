---
"@fastijs/scheduler": minor
---

Hooks in the Effect form: pass `hooks` to `Scheduler.layer`. An in-transaction throw fails the Action with a defect carrying the thrown value, and an after-commit failure is logged at error level to your own `Logger`, annotated with `action`. `defineHook` now types a Hook by its `when` (`Hook<S, Tx, A, W>`), so an after-commit Hook fits a scheduler over any Adapter, while an in-transaction one still needs that Adapter's `tx`.
