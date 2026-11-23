---
"@fastijs/scheduler": minor
---

**Plugins.** Extend fasti without forking it: install Plugins in `defineSchema({ plugins })`. A Plugin can bring tables (stored by every Adapter through one generic `records` verb group), Actions on `scheduler.<plugin>` in both forms, Policies, busy time that no Booking may overlap, and Hooks. Write one with plain async functions (`definePlugin`, `ok`, `fail` from the root) or natively in Effect (`definePlugin` from `@fastijs/scheduler/effect`). New column kinds for Plugin tables: `column.date()`, `column.time()`, `column.json<T>()` and `column.dates()`. See the README's Plugins section and ADR 018.

Availability and Blocks are now first-party Plugins, `availability()` and `blocks({ fields })`. Their tables don't change, so there is **no database migration**. Breaking changes, each with its one-line migration:

- **Availability is off unless installed.** Add `plugins: [availability()]` to keep `scheduler.availability`, the `availability` Policy and `relax: ["availability"]`.
- **`defineSchema({ block: { fields } })` is gone.** Use `plugins: [blocks({ fields })]`.
- **Drizzle:** use `recordTables(schema)` (one table per Plugin table, by logical name) in place of `blockTable(schema)` and `availabilityRuleTable(schema)`. The old names stay in `0.7` as **deprecated aliases** and go in a later minor.
- **Custom Adapters:** replace `getRules`, `replaceRules` and the Block verbs with the `records` group (`getRecord`, `listRecords`, `insertRecord`, `updateRecord`, `deleteRecord`, `replaceRecords`), and `Adapter<Tx, "blocks">` with `Adapter<Tx, "records">`. Removed types: `BlockReads`, `BlockWrites`, `ListBlocksQuery`, `UpdateBlockResult`, `DeleteBlockResult`, `ReplaceRulesParams`, `BlockRecord`, `BlockChanges`, `BlockFieldsOf`, `BlockColumn`, `AvailabilityRuleColumn`, `HasBlocks`.
- **Policies:** `load`'s `reads` no longer has `getRules` or `listBlocks`.
- **Policy names** are unique across your Policies and every installed Plugin's; `definePolicy` no longer reserves `availability`.
- **`SlotConflict`'s `kind`** is `"booking"` plus every installed Plugin's busy `kind` (`"block"` with `blocks()`).
- **Conformance Suite:** rule cases now run only when your test schema installs `availability()`. Install `conformancePlugin` (from `@fastijs/scheduler/testing`) to run the new `records` cases.
