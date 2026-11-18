---
"@fastijs/scheduler": minor
---

Add `relax` to `book`: `book({ ..., relax: ["name"] })` skips the named Policies, `availability` included. Every applicable Policy still runs; the unrelaxed broken ones make up `PolicyViolation`, and the relaxed broken ones come back as `waived` on the Booking. `waived` is present exactly when `relax` was passed (`[]` when nothing relaxed broke). An unknown name is `InvalidParams` at `["relax", i]`, before any Adapter call. The types narrow `relax` to the names that apply, and drop `PolicyViolation` from the error when every applicable Policy is relaxed.

Breaking: a Booking Developer Field can't be named `waived` (a type error and a `defineSchema` throw).
