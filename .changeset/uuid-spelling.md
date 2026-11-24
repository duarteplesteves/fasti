---
"@fastijs/scheduler": patch
---

On Postgres, a `uuid` Resource id passed in another spelling (`A0EE…` for a stored `a0ee…`) no longer makes `book`, `blocks.create` and `findSlots` return `AdapterError` once the Resource has a Booking in the range.
