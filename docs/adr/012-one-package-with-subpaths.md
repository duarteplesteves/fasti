# ADR 012: One Package With Subpaths, and `effect` as a Dependency

**Status:** Accepted

**Date:** 2026-11-10

## Context

fasti ships a Core, a Framework in two forms (ADR 010), several first-party Adapters, an Adapter contract for custom Adapters and a Conformance Suite (ADR 008). A developer who uses only the Core must not pay for the rest in their bundle. The Framework is built on Effect, but the plain API must not ask its users to know that.

Options considered:

1. **Several packages** (`@fasti/core`, `fasti`, `@fasti/drizzle`, …), as better-auth does. Each Adapter gets its own release schedule, and a Core-only user installs nothing extra, but there are more packages to version and keep in step.
2. **One package with subpaths**, as files-sdk does, with `effect` as an optional peer. A Core-only user installs nothing extra, but every user of the plain Framework must install `effect` themselves, which puts Effect into the plain API's setup.
3. **One package with subpaths**, with `effect` in `dependencies`.

## Decision

We choose option 3.

- One package, `fasti`. Every export has exactly one home: `fasti` (plain Framework, `defineSchema`, and the shared `Result` / `InvalidParams` / `Issue`), `fasti/core`, `fasti/effect`, `fasti/adapter` (the contract for custom Adapters), `fasti/memory`, `fasti/drizzle/pg`, `fasti/drizzle/sqlite`, `fasti/prisma` and `fasti/testing` (the Conformance Suite). `fasti` does not re-export the Core.
- `effect@^4.1` is a regular dependency. Every ORM is an optional peer with a bounded major range, and `vitest` is an optional peer used only by `fasti/testing`.
- Lint rules enforce the boundaries that make tree-shaking work: `src/core` imports nothing outside itself, Adapters never import `effect` and each imports only its own ORM, and no module runs top-level calls unless they are marked `/* #__PURE__ */`. With `"sideEffects": false`, this means a Core-only bundle contains nothing else. We enforce the boundaries rather than measure bundle size.
- `tsc` is the only build step. The package is ESM only, with `types` and `default` conditions. `publint` and `@arethetypeswrong/cli` check the `exports` map in CI.

## Consequences

- **Positive:** One install and one version line. The plain Framework works without the developer knowing Effect exists.
- **Positive:** Core-only bundles contain no Effect and no Framework code, and the lint rules keep it that way.
- **Negative:** A Core-only user still downloads `effect` (about 10 MB packed, 61 MB on disk). If that becomes a real complaint, the Core can move to its own dependency-free package, with `fasti/core` re-exporting it so no import breaks.
- **Negative:** An ORM major release can force a `fasti` release. Widening a peer range is a minor release; dropping an old major is a breaking one. An Adapter whose release schedule diverges can split into its own package behind its existing subpath.
- **Negative:** Breaking for v0.1 users: Core functions are no longer exported from `fasti`, and `withBlockingFlag` moves to `fasti/core`.

## Amendment (2026-11-11): published as `@fastijs/scheduler`

npm rejects the unscoped name `fasti` because its typosquatting check finds it too similar to `fastify` and `fastq`. Scoped names are exempt from that check, so the package is published as `@fastijs/scheduler` under the `@fastijs` npm org. The scope `@fasti` is not available: it is the personal scope of an npm user called `fasti`, which has no public packages. The product is still called fasti, and the layout above is unchanged. Only the import specifiers change: `fasti` → `@fastijs/scheduler`, and `fasti/<subpath>` → `@fastijs/scheduler/<subpath>` (for example `@fastijs/scheduler/core`). The other ADRs still use the short `fasti/<subpath>` form to mean these paths.

Owning the scope also keeps the escape hatches above open. If the Core or an Adapter ever splits out, it becomes a sibling package such as `@fastijs/core`, and `@fastijs/scheduler/core` re-exports it.
