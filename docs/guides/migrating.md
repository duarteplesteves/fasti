# Migrating

Every release is in the [changelog](../../CHANGELOG.md). This page covers upgrades that need code changes.

## From `0.6`

`availability()` and `blocks()` build the same tables, columns and foreign keys as `0.6`, so no database migration is required. Versions after `0.7` add [indexes](./databases.md#indexes), which your migration tool generates; fasti works without them, only slower. The code changes:

- **Opening hours are a Plugin.** Add `plugins: [availability()]` to keep `scheduler.availability`, the `availability` Policy and `relax: ["availability"]`. Without it, everything outside Bookings and busy time is bookable.
- **`block: { fields }` becomes `blocks({ fields })`** in `plugins`. `scheduler.blocks`, `kind: "block"` and the `blocks.*` Hook targets stay.
- **Drizzle:** `blockTable(schema)` and `availabilityRuleTable(schema)` become `recordTables(schema).block` and `.availabilityRule` (same `references` option). The old names still work in `0.7`, deprecated.
- **Custom Adapters:** replace `getRules`, `replaceRules` and the Block verbs with the [`records` group](./custom-adapter.md#the-records-group), and `"blocks"` with `"records"` in `Adapter<Tx, …>`.
- **Policies:** `load`'s `reads` no longer has `getRules` or `listBlocks`, and nothing replaces them yet: a Plugin's Policies read only its own tables. A Policy of yours that read rules or Blocks has no equivalent in `0.7`. The nearest is a Veto in `also`, reading your own database, which can't be relaxed and doesn't show in `findSlots`.
- **`definePolicy`** no longer reserves the name `availability`; names are unique across your Policies and the installed Plugins'.
- **The Conformance Suite** runs the Blocks cases when your test schema installs `blocks()`, the rule cases (new tag `availability`) when it installs `availability()`, and the new `records` cases when it installs `conformancePlugin`. Rules used to be tested on every schema.
