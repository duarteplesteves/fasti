---
"@fastijs/scheduler": minor
---

Hooks now fire on every write Action: `reschedule`, `cancel`, `transition`, `availability.set` and `blocks.create`/`update`/`delete`, as well as `book`. `appliesTo` takes write Action names, Transition edges (`{ to }`, `{ from, to }`) or `"*"`, and `defineHook` throws on an empty `appliesTo`, an unknown name, `blocks.*` on a schema without `block`, an undeclared edge, or an edge into `cancelled`. No Hook runs on a Veto, a typed failure, a repeat `cancel` or a read.

`availability.set`'s `also` context now carries `resourceId`. `SetAvailabilityAlso` takes the schema as its first type parameter: `SetAvailabilityAlso<S, Tx>`.
