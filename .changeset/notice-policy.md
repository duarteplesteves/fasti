---
"@fastijs/scheduler": minor
---

Add the prebuilt `notice` Policy, written with `definePolicy`: `notice(schema, { minimum, appliesTo, name? })` breaks when the start is before `now + minimum` (whole minutes, at least 0; `name` defaults to `"notice"`). On `book` and `reschedule` it compares the candidate's start, on `cancel` and Transition edges the stored Booking's, and reports `detail: { earliest }`. `minimum: 0` refuses past starts; a negative, fractional or non-finite `minimum` throws. Rename it to register more than one, e.g. `bookingNotice` and `cancelNotice`, each relaxed on its own.
