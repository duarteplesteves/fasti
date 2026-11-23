---
"@fastijs/scheduler": patch
---

On a uuid Resource id, the Postgres Adapters now take the Resource Lock on Postgres's own spelling of the id, so `A0EE…`, `a0ee…` and `{a0ee…}` share one lock. Plugin and Action names can no longer contain a dot, which let two Actions share one Hook target (`a` + `b.c` and `a.b` + `c`).
