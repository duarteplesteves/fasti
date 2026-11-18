---
"@fastijs/scheduler": minor
---

Policies on Transition edges. `appliesTo` takes edges: `{ to }` is every declared edge into `to`, `{ from, to }` one edge; edges into `cancelled` belong to `cancel`. `definePolicy` throws on an undeclared edge, or on `{ to }` with no declared edge into it (both are type errors too). `transition` runs the Policies on its edge after `StatusMismatch` and the overlap check, with candidate `{ action: "transition", booking, from, to, now }`; `load` gets the stored Booking's range. `relax` and `waived` work as on `book`, typed per edge.
