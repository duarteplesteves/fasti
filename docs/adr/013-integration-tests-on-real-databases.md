# ADR 013: Integration Tests Run the Conformance Suite on Real Databases

**Status:** Accepted

**Date:** 2026-11-11

## Context

ADR 008 requires every first-party Adapter to pass the published Conformance Suite (`testAdapter({ makeAdapter, reset })` from `fasti/testing`) against in-memory, Postgres and SQLite, including concurrency tests, and requires that a broken Adapter (lock off) fails it. The suite is only worth something if its concurrency tests can actually catch a missing lock.

Options considered for Postgres:

1. **PGlite.** No server, no Docker. But it has one connection, so calls never overlap and the advisory lock is never contested: a lock-off Adapter would pass.
2. **Alchemy + Neon**, a throwaway database per CI run. Needs a cloud account and secrets (invisible to PRs from forks), the network, and money.
3. **Testcontainers** from inside Vitest. Same flow everywhere, but Docker becomes a requirement for every local run.
4. **A GitHub Actions service container** (official `postgres` image, which includes `btree_gist`), found by the tests through an env var.

## Decision

We choose option 4.

- **One env var.** Tests find Postgres through `FASTI_TEST_POSTGRES_URL` and never start a database. CI sets it from the service container; locally the developer starts Postgres however they like. Unset, the Postgres projects are skipped with a visible notice locally and fail when `CI=true`.
- **Node.** Integration tests target Node 26, matching `engines`. Bun stays the package manager.
- **Vitest projects.** `unit` holds today's `src/**/*.test.ts`. `conformance` holds one entry per (Adapter × database) pair, each calling `testAdapter` exactly as a developer would, next to its Adapter (e.g. `src/drizzle/pg/conformance.test.ts`). `bun run test` runs `unit`, `test:integration` runs `conformance`, CI runs both.
- **One database per test file**: a fresh `CREATE DATABASE fasti_<random>` or a fresh SQLite file in a temp dir, so files run in parallel; `reset` truncates between tests.
- **Concurrency tests** run N = 20 parallel calls in one process, with an artificial `await` between read and write inside the locked work. `makeAdapter` must supply at least N connections, and the suite asserts it. Cases: exactly one of N parallel `book()` calls succeeds, and N locked units of work on one Resource never interleave. Each repeats a few times.
- **Negative control.** `fasti/testing` also exports its cases one by one. This repo wraps each Adapter with the lock off (`withResourceLock` becomes a plain transaction) and runs the concurrency cases against every real database as `test.fails`. A case that passes against the broken Adapter turns CI red.
- **Tables come from the developer's path**: Drizzle from the `defineSchema` output pushed through drizzle-kit's programmatic API, Prisma from `contract.ts`. Never hand-written SQL. The run uses a fully renamed schema (tables, columns, Status values); default names are covered by the `examples/` app.
- **Backstop group** runs when the Adapter declares the `EXCLUDE` backstop (always on Postgres here): it inserts overlapping rows around the lock and expects the same typed `conflict`.
- **Versions**: latest only for now, Postgres 18 and the SQLite bundled with the driver.

## Consequences

- **Positive:** The suite's claim that a broken Adapter fails is itself tested.
- **Positive:** No secrets, works for fork PRs; test code stays free of database start-up.
- **Positive:** The schema builders are exercised under non-default names on every run.
- **Negative:** Running integration tests locally needs a Postgres the developer starts, and Node rather than Bun.
- **Negative:** Default names aren't covered by the suite, only by the `examples/` app.

## Amendment (2026-11-14): the negative control replaces asserting the pool size

The suite does not assert that `makeAdapter` supplies at least N connections. No Adapter-agnostic check exists: the contract has no notion of a pool, and a pool smaller than N makes units of work queue for a connection, which still serializes them. The negative control already covers the failure that matters: if a small pool, or anything else, kept calls from overlapping, the lock-off concurrency cases would pass, their `it.fails` would fail, and CI would turn red. `TestAdapterParams.makeAdapter` documents the requirement of 20 concurrent units of work instead.
