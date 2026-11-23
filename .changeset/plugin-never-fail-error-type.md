---
"@fastijs/scheduler": patch
---

Promise-style Plugin Actions with no failure path of their own now have `AdapterError` as their error type, not `unknown`. This covers a write whose `lock` work never returns `Failed`, and a read that only resolves `ok`, in both the plain and Effect forms. `lock` no longer needs explicit type arguments to get there. The new `RanContext` type is exported so that declarations naming an expanded `Ran` still emit.
