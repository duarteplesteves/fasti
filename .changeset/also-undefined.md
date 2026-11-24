---
"@fastijs/scheduler": patch
---

In the plain form, `also: undefined` is now the same as leaving `also` out. Before, it rolled the write back and rejected with "also is not a function".
