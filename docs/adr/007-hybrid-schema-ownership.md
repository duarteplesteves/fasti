# ADR 007: Hybrid Schema Ownership

**Status:** Accepted

**Date:** 2026-11-09

## Context

The Framework persists Bookings and AvailabilityRules through an Adapter, in a database the developer owns. Developers may already have their own scheduling tables, and those tables usually differ from ours by more than names: a `status` column instead of a blocking flag, or one row per weekday instead of one row per rule.

Three ownership models were considered:

1. **The Framework owns the tables** and generates their schema. This is rigid for apps that already have data.
2. **The developer owns everything.** The Adapter is only a set of verbs that each developer implements against their own tables. Every developer then has to write and test the atomic, race-free booking insert themselves, and that is the hardest part.
3. **Hybrid.** The Framework owns a Logical Model, and the developer owns the physical database.

## Decision

We adopt the hybrid model:

- **Logical Model.** The Framework defines the entities and fields it stores: Booking and AvailabilityRule. Physical table and column names can be renamed in config. Types keep the logical names.
- **Custom Adapters.** Tables that differ from the Logical Model by more than names get a custom Adapter written against the same contract. It is checked with the published conformance suite.
- **Resources stay the developer's.** There is no Framework-owned resource table. `resource: { idType, references? }` sets the type of the `resourceId` column and its TypeScript type. It can optionally add a foreign key with `ON DELETE RESTRICT`.
- **Developer Fields** are declared as data on Booking. They are inferred into Action types and stored as real columns.
- **One declaration.** A dependency-free `defineSchema(...)` object feeds both the first-party Adapters' schema builders and `createScheduler`.
- **The Framework never runs DDL.** First-party Adapters export schema builders in their ORM's own language, and the developer's own migration tool applies them. Where the ORM cannot compare schemas, the Adapter ships versioned migration functions. There is no CLI and no runtime schema check. A mismatch surfaces as a typed `AdapterError`.

## Consequences

- **Positive:** Developers adopting an existing app keep their tables. Name remapping covers the common case, and a custom Adapter covers the rest.
- **Positive:** The atomic booking guarantee lives in first-party Adapters and the conformance suite, not in each developer's code.
- **Positive:** Columns and types cannot drift apart, because both come from one `defineSchema` value.
- **Negative:** Every schema change between versions must ship as a builder change or a versioned migration, flagged in the changelog.
- **Negative:** Without a runtime check, a schema mismatch is only found on the first call that touches it.
