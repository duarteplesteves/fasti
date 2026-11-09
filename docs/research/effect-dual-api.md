# Research: how libraries built on Effect offer a non-Effect API

- **Ticket:** #7 (map: #2)
- **Date:** 2026-11-09
- **Question:** The Framework will be built with Effect but must offer a plain Promise API by default plus an Effect API. How do libraries built on Effect expose a non-Effect surface, and how do they surface errors in each? What is the state of the latest Effect major version, and what does depending on `effect` cost in install and bundle size for a developer who only uses the plain API?

## TL;DR

1. **Effect 4 is stable.** `effect@4.0.0` shipped on 2026-10-01. `latest` is now `4.1.2` (2026-11-02), and 3.x lives on under the `prev` dist-tag (`3.22.4`). v4 has **no runtime dependencies**, folds `@effect/platform`, `@effect/rpc`, `@effect/sql` and others into `effect`, and uses one version number for every package. [R1][R2]
2. **The common pattern:** write each operation once as an `Effect`, build services from a `Layer` with `ManagedRuntime.make`, and expose `async` methods that call `runtime.runPromise(...)`. The Effect form is either the same program exported on a subpath or a separately named function. UploadThing (v3) and LiveStore (v4) both do this. [U1][U2][L1]
3. **Errors in the plain API:** in **v4**, `runPromise` rejects with **the typed error itself** (`Cause.squash`), so `instanceof MyError`, `err._tag` and the error's own fields all work. v3 wrapped it in a `FiberFailure`. UploadThing on v3 had to unwrap the error by hand (`runPromiseExit` + `Cause.squash`). For partial failures it returns **plain `{ data, error }` values**, not Effect's `Either`/`Result`. [E3][E4][U1]; we verified this by running code ourselves.
4. **Bundle cost (we measured it, v4.1.2, minified + gzip):** a plain `async` wrapper over `Effect.gen` + `runPromise` is about **9 kB**. Adding `Context.Service` + `Layer` + `ManagedRuntime` brings it to about **13 kB**, and adding `Schema` decoding to about **27 kB**. That is roughly **3x smaller than v3** at the same level of use. Importing from the `"effect"` barrel under esbuild inflates this to 32–117 kB, so **the library must use deep imports** (`effect/Effect`).
5. **Install cost:** one package, a 10.4 MB tarball, 56.6 MB unpacked (61 MB on disk). That is large on disk, but it adds nothing to the dependency tree and nothing to bundles beyond what is actually imported.
6. **Recommendation:** use Effect v4 inside the Framework and expose a Promise-first API whose methods return plain data and **throw real `Error` subclasses with a `_tag`, a human `message` and typed fields**. Put the Effect API on a separate `better-schedule/effect` subpath that shares the same program and error classes. Never leak `Effect`, `Exit`, `Result`, `Layer` or `Schema` types into the plain API's signatures.

---

## (a) Patterns for exposing a Promise API and an Effect API from one implementation

### Pattern 1: a class or instance that owns a `ManagedRuntime` (UploadThing `UTApi`)

UploadThing's server SDK is written in Effect (v3: `effect@3.21.0`, `@effect/platform@0.96.0` [U0]). Its public `UTApi` class exposes only Promise methods. The constructor builds a `ManagedRuntime` from a `Layer` that provides an HTTP client, logging and config [U1][U2]:

```ts
// packages/uploadthing/src/_internal/runtime.ts [U2]
export const makeRuntime = (fetch: FetchEsque, config: unknown) => {
  const fetchHttpClient = Layer.provideMerge(
    FetchHttpClient.layer,
    Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
  );
  // ...log format, log level, redacted headers
  const layer = Layer.provide(Layer.mergeAll(/* ... */), Layer.setConfigProvider(configProvider(config)));
  return ManagedRuntime.make(layer);
};
```

Every public method builds an `Effect` and runs it through one private bridge [U1]:

```ts
// packages/uploadthing/src/sdk/index.ts [U1]
private executeAsync = async <A>(program: Effect.Effect<A, UploadThingError | ParseError | HttpClientError, HttpClient>, signal?: AbortSignal) => {
  const exit = await program.pipe(
    Effect.withLogSpan("utapi.#executeAsync"),
    (e) => this.runtime.runPromiseExit(e, signal ? { signal } : undefined),
  );
  if (exit._tag === "Failure") {
    throw Cause.squash(exit.cause);   // rethrow the original typed error, not FiberFailure
  }
  return exit.value;
};
```

What the plain caller sees:

- **Normal `Promise`s and an `AbortSignal` option.** The signal is passed through to `runPromiseExit`, which cancels the fiber. [U1]
- **Thrown `UploadThingError`s** for request-level failures. `UploadThingError` extends `Micro.Error` (a real `Error`) and adds a `_tag`, `name`, `code`, `data` and `cause`, along with `toObject`/`serialize` helpers. [U3]
- **Per-item `{ data, error }` objects** for batch operations. `uploadFiles` maps each item's outcome with `Effect.match` to `{ data, error: null }` or `{ data: null, error }`, so one failed file does not reject the whole batch. [U1]
- **Validation done in plain JavaScript before Effect runs.** For example, `concurrency` outside 1–25 makes the method throw `UploadThingError` synchronously. [U1]

The Effect-native surface is a separate **subpath, `uploadthing/effect-platform`**. It returns an `HttpApp` that needs `HttpClient` from the caller's runtime, and it deliberately drops the `fetch` and `logLevel` options "to obey by Effect conventions", leaving Effect users to supply them as Layers. [U4] UploadThing's exports also include `./server`, `./next`, `./express` and others, each a thin adapter over the same Effect core. [U0]

### Pattern 2: twin functions with a naming convention (LiveStore, on Effect v4)

LiveStore (`@livestore/livestore@0.5.0`, which depends on `effect ^4.0.3` [L0]) exports both forms from its main entry point [L1]:

```ts
// packages/@livestore/livestore/src/store/create-store.ts [L1]
export const createStore = (opts): Effect.Effect<Store, UnknownError, Scope.Scope | OtelTracer.OtelTracer> => /* ... */

export const createStorePromise = async ({ signal, otelOptions, ...options }): Promise<Store> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const services = yield* Effect.context()
    if (signal !== undefined) {
      signal.addEventListener('abort', () => {
        Scope.close(scope, Exit.void).pipe(Effect.tapCauseLogPretty, Effect.runForkWith(services))
      })
    }
    return yield* createStore({ ...options }).pipe(Scope.provide(scope))
  }).pipe(
    /* provide tracing, logger, log level */
    Effect.runPromise,
  )
```

Points to note:

- The **Effect form takes the plain name** and the Promise form gets a `Promise` suffix, so Effect users are the default audience. The Framework needs the opposite default.
- The Promise wrapper swaps `Scope` for an **`AbortSignal`** and turns `Layer` options into plain values such as `logLevel`.
- More idiomatic Effect APIs (`Store.Tag`, Layers) sit on a separate **`@livestore/livestore/effect` subpath**. [L2]
- The plain `Store` object it returns has ordinary methods. Only the creation step crosses the Effect boundary.

### Pattern 3: plain `Effect.runPromise` per call (no shared runtime)

When an operation needs no long-lived services, a wrapper can call `Effect.runPromise(program)` directly. LiveStore's `createStorePromise` above does this. The v4 docs recommend `ManagedRuntime` for cases where Effect is not the main framework and the library does not control the entry point; it builds the Layer once, lazily, and caches the result. [E5][E6]

### Pattern 0 (counter-example): dropping Effect altogether

Evolu was one of the early libraries built on Effect. In 6.0.0 it **removed the Effect dependency** and introduced its own "Evolu Library". [V1] This is a reminder that the dual-API approach has a cost: the Effect parts must stay invisible to plain users.

### How typed errors cross into the plain API

| Mechanism | v3 behaviour | v4 behaviour |
|---|---|---|
| `Effect.runPromise` / `runtime.runPromise` rejection | rejects with a **`FiberFailure`** wrapper (`name: "(FiberFailure) SlotTaken"`, `message: "An error has occurred"`, `instanceof SlotTaken === false`) [E4] | rejects with **the original error**: `causeSquash` returns the first `Fail` error, otherwise the first defect, otherwise an `Error("All fibers interrupted without error")` [E3] |
| `runPromiseExit` + `Cause.squash` | the standard workaround, used by UploadThing [U1] | no longer needed |
| `Data.TaggedError` instances | `Error` subclasses with a `_tag` | `Error` subclasses (`Cause.YieldableError extends Error`) [E7] with a `_tag`. **`message` is `""` unless the props include a `message` field.** |

We checked this ourselves on `effect@4.1.2` versus `3.22.4` by running `await Effect.runPromise(Effect.fail(new SlotTaken({ slotId: "s1" })))`:

```text
v4: { isSlotTaken: true,  isError: true, ctor: "SlotTaken",        name: "SlotTaken",              tag: "SlotTaken", slotId: "s1", message: "" }
v3: { isSlotTaken: false, isError: true, ctor: "FiberFailureImpl", name: "(FiberFailure) SlotTaken", tag: undefined, slotId: undefined, message: "An error has occurred" }
```

With `{ slotId, message: "Slot s1 is already booked" }` as props, v4 gives `String(err) === "SlotTaken: Slot s1 is already booked"`.

What this means for the plain API:

- In v4, **`runtime.runPromise` already gives non-Effect users ordinary `try/catch` semantics** with typed, `instanceof`-checkable errors. No unwrapping layer is needed.
- **Defects** (bugs, thrown non-typed exceptions) surface as the raw thrown value, and interruption surfaces as a generic `Error`. The plain API should document that only the listed error classes are part of its contract.
- If a plain API wants **errors as values**, it should return its own discriminated union, as UploadThing does with `{ data, error }`, and **not** Effect's `Result`. A v4 `Result` is `{ _tag: "Success" | "Failure", success | failure }` from `effect/Result`, which replaces v3's `Either` [E8], and putting it in a signature would leak an Effect type.

---

## (b) State of the latest Effect major version (as of 2026-11-09)

- **Released and stable.** `effect@4.0.0` was published on 2026-10-01 after `4.0.0-beta.*` (from 2026-02-18) and `4.0.0-rc.*` (up to rc.118, 2026-09-28). Since then there have been seven patches, `4.1.0` (2026-10-29) and `4.1.2` (2026-11-02). The npm dist-tags are `latest: 4.1.2` and `prev: 3.22.4`. v3 still gets maintenance releases (3.22.3 and 3.22.4 in October). [R1][R2]
- **Repository:** v4 development, previously in `Effect-TS/effect-smol` ("Core libraries and experimental work for Effect v4"), now lives on `Effect-TS/effect` main. The npm package's `repository` field points at `Effect-TS/effect` `packages/effect`. [R1]
- **Packaging** [R2][E1]:
  - Every Effect package shares one version and is released together.
  - `@effect/platform`, `rpc`, `cluster`, `cli`, `ai`, `sql`, `workflow` and `experimental` are merged into `effect` and imported as `effect/http`, `effect/sql` and so on. Separate packages remain for platforms (`@effect/platform-*`), SQL drivers, AI providers, Atom bindings, OpenTelemetry, Vitest and tooling.
  - `effect` has **no runtime dependencies**. v3 depended on `fast-check` and `@standard-schema/spec`.
- **Stability tiers:** an API without a tag, or tagged `@stability stable`, follows semver. `@stability unstable` APIs may break in minor releases, and `@stability experimental` ones in patches. Unstable areas include `ai`, `cli`, `cluster`, `http`, `http-api`, `rpc`, `sql`, `workflow`, `persistence`, `reactivity` and the `effect/schema/*` compilers. Core modules such as `Effect`, `Layer`, `Context`, `ManagedRuntime` and `Schema` are tagged `@stability stable` (for example, `Schema.ts` is `@stability stable @since 4.0.0`). [E1][E5][E9] The 4.1.0 minor already made breaking changes to unstable modules (it replaced `effect/Crypto`). [R3]
- **Requirements:** TypeScript 5.9 or later (7 recommended). `@effect/vitest` requires Vitest 5. [R2] This repo already uses TS 7 beta and Vitest 5.
- **API changes from v3 that matter to us** [E1][E2][E10][E11]:
  - Services: `Context.Tag` → `Context.Service`, as in `class X extends Context.Service<X, Shape>()("X") {}`, and `Layer.succeed(Tag)(impl)` is now curried.
  - `Runtime<R>` is **removed**. Use `Context<R>` with `Effect.runForkWith(services)` / `Effect.context<R>()`. `ManagedRuntime` remains and is stable, and adds `[Symbol.asyncDispose]` for `await using`.
  - `FiberRef` → `Context.Reference`, `Either` → `Result`, `ParseResult` → `SchemaIssue` / `SchemaParser`, and `Schema.decodeUnknown` → `Schema.decodeUnknownEffect`.
  - `catchAll` → `catch`, `catchAllCause` → `catchCause`, and `catchSome` → `catchFilter`. Defects now take precedence over typed errors in mixed causes for **all** recovery operators.
  - **`Micro` is removed.** The guide says "the rewritten Effect runtime is itself lightweight and replaces it". UploadThing's client-bundle optimisation ([U5]) has no direct v4 equivalent, and none is needed (see below).
  - `runPromise` rejects with the squashed typed error instead of `FiberFailure` (section a).
- **Ecosystem uptake:** LiveStore (`effect ^4.0.3`), Alchemy 2 beta (`^4.1.0`), Confect (`~4.1.0`) and `@effect-aws/lambda` (`>=4.0.0-beta.66 <5`) already target v4. UploadThing is still on v3 (`3.21.0`). [L0][N1]

---

## (c) Install and bundle-size cost for a plain-API-only user

### Install (npm registry metadata, plus our measurement)

| | `effect@4.1.2` | `effect@3.22.4` |
|---|---|---|
| Runtime dependencies | none | `fast-check`, `@standard-schema/spec` (plus `pure-rand`, transitively) |
| Tarball (download) | 10.4 MB | 4.2 MB |
| Unpacked (`dist.unpackedSize`) | 56.6 MB, 3,013 files | 27.2 MB, 2,722 files |
| On disk after `bun add` | 61 MB | 33 MB (`effect` only) |

v4 is bigger on disk because the former `@effect/platform`, `sql`, `ai`, `cluster` and similar packages now ship inside `effect`, along with `src/`. [R1] This affects `node_modules` size and cold CI installs, **not** runtime bundles.

### Bundle size: our own measurement

Setup: scratch projects with `effect@4.1.2` or `effect@3.22.4` and `esbuild@0.25.10`, plus Bun 1.4 `bun build`, using `--minify` and browser/ESM targets, and `gzip -9`. Each entry point mirrors something a Framework would ship. Sizes are **minified + gzipped bytes**.

| Scenario | v4 esbuild (deep imports) | v4 bun | v4 esbuild (`from "effect"` barrel) | v3 esbuild (deep) | v3 bun |
|---|---|---|---|---|---|
| A: `Effect.runPromise(Effect.succeed(x))` | **9.3 kB** | 8.7 kB | 31.5 kB | 42.7 kB | 38.6 kB |
| B: A + `Effect.gen` + `Data.TaggedError` + `Effect.tryPromise` (an Action) | — | 9.8 kB | 31.7 kB | — | — |
| C: B + `Context.Service` + `Layer` + `ManagedRuntime` (instance with services) | **13.0 kB** | 12.9 kB | 33.8 kB | 47.1 kB | 43.0 kB |
| D: C + `Schema.Struct` input decoding | **26.9 kB** | 26.9 kB | 117.2 kB | 59.2 kB | 54.8 kB |
| `Schema` alone (`decodeUnknownSync` of a struct) | 24.2 kB | 24.2 kB | — | — | — |
| E: import only a non-Effect export from a module that also uses Effect | 0.07 kB | — | 0.07 kB | 0.07 kB | — |

Findings:

- **v4's runtime is about 3–4x smaller than v3's** for the same code. This matches the v4 claim of "smaller bundles and better tree-shaking", and its stated **7.1 kB** minimal program [E1][R2] is close to our 8.7–9.3 kB, though our test program differs from theirs.
- **The `"effect"` barrel defeats esbuild's tree-shaking** (A goes from 9.3 kB to 31.5 kB, and D from 26.9 kB to 117 kB, because D pulled in `toJsonSchemaDocument`, `chacha` and other unused code), while `bun build` handles it. A library cannot control which bundler its users run, so **the Framework's source must import from `effect/<Module>` paths**, and its own `dist` must keep those imports intact.
- **`Schema` is the biggest single cost** (about 14 kB on top of C). It is worth using where we decode untrusted input, but the plain API should not require it.
- **Tree-shaking works through `sideEffects`.** `effect` v4 marks only the Schema JIT enabler as having side effects [R1]. Combined with `"sideEffects": false` in this repo's `package.json`, a user who imports only `better-schedule/core` (pure functions) pays **nothing** for Effect (scenario E). UploadThing hit and fixed one way this can fail: Effect calls at module top level that are not marked `/* #__PURE__ */` [U5].
- For context: the Framework runs on the server, next to the developer's database Adapter, so bundle size matters mainly for edge and serverless cold starts and much less for browser payloads.

---

## Recommendations for the better-schedule Framework

1. **Target Effect v4 (`effect@^4.1`)**, which is stable, has no dependencies and is the smaller runtime. Use only `@stability stable` modules (`Effect`, `Context`, `Layer`, `ManagedRuntime`, `Data`, `Schema`, `Result`) in anything reachable from the public API, and avoid the unstable `effect/http`, `effect/sql` and `effect/schema/*` areas there. Pin the minor version (`~4.1.x`) if we use anything unstable internally.
2. **One program, two front doors.** Write each Action once as an `Effect` with typed errors and `Context.Service` dependencies (the Adapter becomes a service). The **default export, `createScheduler(config)`, returns an object of `async` methods**, each of which is `runtime.runPromise(action(input))` against a `ManagedRuntime` built from the config's Adapter. A **`better-schedule/effect` subpath** exports the same Actions as `Effect`s plus a `Layer` for the Adapter. This is UploadThing's subpath approach combined with LiveStore's twin functions, but with plain as the default name.
3. **Errors in the plain API are plain JavaScript errors.**
   - Define each domain error once as `Data.TaggedError` (or `Schema.TaggedErrorClass`) **with a `message` field**, so `err.message` and `String(err)` read well. Export the classes from both entry points.
   - Rely on v4's `runPromise` rejecting with the original error. Plain users then write `catch (e) { if (e instanceof SlotUnavailable) ... }` or `switch (e._tag)`.
   - Document the closed set of errors for each Action. Leave defects as ordinary thrown exceptions.
   - Do **not** return `Exit`, `Cause`, `Result` or `Either` from the plain API. Where partial failure is a normal outcome (for example, batch or multi-resource Actions), return a plain discriminated union such as `{ data, error }`, as UploadThing does.
4. **Hide the runtime's lifecycle unless it is needed.** Build the `ManagedRuntime` lazily (that is its default behaviour). Only expose `dispose()` / `[Symbol.asyncDispose]` if a resource-owning Layer exists. Accept an optional `signal?: AbortSignal` on Actions and pass it to `runPromise` [E5].
   - Gotcha: a failed Layer build is **cached forever** in that runtime. Retry inside the Layer, or rebuild the runtime. [E5][E6]
5. **Keep `better-schedule/core` free of Effect**, with no Effect imports, so it stays usable without a Framework instance and costs zero bytes of Effect (scenario E). Effect lives only behind the Framework entry points.
6. **Use deep imports everywhere** (`import * as Effect from "effect/Effect"`) and avoid top-level calls that are not marked `/* #__PURE__ */`. Add a bundle-size check (esbuild, deep imports) to CI. Our baseline for a Framework instance with services is about 13 kB min+gzip, or about 27 kB with Schema validation.
7. **Accept the install cost.** It is one package of 56.6 MB unpacked. Mention it in the docs. List `effect` in `dependencies`, not `peerDependencies`, so plain users never have to think about it. Effect users get deduplication because v4 uses a single version line.
8. **Keep Effect vocabulary out of plain signatures and docs.** Use `Promise<T>`, plain config objects and plain errors. In the plain API's types and docs there should be no `Layer`, `Context`, `Scope`, `Schema` or `R`/`E` type parameters. Evolu's decision to drop Effect [V1] shows the risk if Effect leaks into what users see.

---

## Sources

Effect (primary):

- **[R1]** npm registry metadata for `effect` (dist-tags, publish times, `dependencies`, `exports`, `sideEffects`, `dist.unpackedSize`): https://registry.npmjs.org/effect, https://registry.npmjs.org/effect/4.1.2, https://registry.npmjs.org/effect/3.22.4
- **[R2]** `effect@4.0.0` release notes (first stable v4; packaging, core, requirements): https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0
- **[R3]** `effect@4.1.0` release notes: https://github.com/Effect-TS/effect/releases/tag/effect%404.1.0
- **[E1]** Migration guide v3 → v4 (versioning, consolidation, unstable modules, "7.1 kB" minimal program): https://github.com/Effect-TS/effect/blob/175113ea18f412ec3199e8710ad773b0c081289e/MIGRATION.md
- **[E2]** Runtime migration (`Runtime<R>` removed, `runForkWith`): https://github.com/Effect-TS/effect/blob/175113ea18f412ec3199e8710ad773b0c081289e/migration/runtime.md
- **[E3]** v4 `runPromiseWith` / `causeSquash`: https://github.com/Effect-TS/effect/blob/175113ea18f412ec3199e8710ad773b0c081289e/packages/effect/src/internal/effect.ts#L290-L299 and https://github.com/Effect-TS/effect/blob/175113ea18f412ec3199e8710ad773b0c081289e/packages/effect/src/internal/effect.ts#L5871-L5885
- **[E4]** v3 `unsafeRunPromise` rejecting with `fiberFailure`: https://github.com/Effect-TS/effect/blob/effect%403.22.4/packages/effect/src/internal/runtime.ts#L300-L318
- **[E5]** v4 `ManagedRuntime` source and docs (stable; lazy build; failure caching; `asyncDispose`): https://github.com/Effect-TS/effect/blob/175113ea18f412ec3199e8710ad773b0c081289e/packages/effect/src/ManagedRuntime.ts
- **[E6]** Effect v4 docs, "Introduction to Runtime" (ManagedRuntime for integrating with non-Effect code): https://effect.website/docs/v4/runtime
- **[E7]** v4 `Data.TaggedError` and `Cause.YieldableError extends Error`: https://github.com/Effect-TS/effect/blob/175113ea18f412ec3199e8710ad773b0c081289e/packages/effect/src/Data.ts, https://github.com/Effect-TS/effect/blob/175113ea18f412ec3199e8710ad773b0c081289e/packages/effect/src/Cause.ts
- **[E8]** v3 → v4 import and API rename map (`Either` → `Result`, `Micro` removed, `ParseResult` → `SchemaIssue`/`SchemaParser`): https://github.com/Effect-TS/effect/blob/175113ea18f412ec3199e8710ad773b0c081289e/migration/v3-to-v4.md
- **[E9]** v4 `Schema.ts` (`@stability stable`, `@since 4.0.0`): https://github.com/Effect-TS/effect/blob/175113ea18f412ec3199e8710ad773b0c081289e/packages/effect/src/Schema.ts
- **[E10]** Error-handling migration (`catch*` renames, defects take precedence): https://github.com/Effect-TS/effect/blob/175113ea18f412ec3199e8710ad773b0c081289e/migration/error-handling.md
- **[E11]** Services migration (`Context.Tag` → `Context.Service`): https://github.com/Effect-TS/effect/blob/175113ea18f412ec3199e8710ad773b0c081289e/migration/services.md

Libraries built on Effect (source):

- **[U0]** UploadThing `package.json` (v7.7.4; `effect@3.21.0`; subpath exports): https://github.com/pingdotgg/uploadthing/blob/2656a9a5cc69619e57de76d8b5d2aced40c1fa89/packages/uploadthing/package.json
- **[U1]** UploadThing `UTApi` (`executeAsync`, `uploadFiles` `{ data, error }`): https://github.com/pingdotgg/uploadthing/blob/2656a9a5cc69619e57de76d8b5d2aced40c1fa89/packages/uploadthing/src/sdk/index.ts#L48-L186
- **[U2]** UploadThing `makeRuntime` (`ManagedRuntime.make`): https://github.com/pingdotgg/uploadthing/blob/2656a9a5cc69619e57de76d8b5d2aced40c1fa89/packages/uploadthing/src/_internal/runtime.ts
- **[U3]** `UploadThingError`: https://github.com/pingdotgg/uploadthing/blob/2656a9a5cc69619e57de76d8b5d2aced40c1fa89/packages/shared/src/error.ts
- **[U4]** UploadThing `effect-platform` entry point: https://github.com/pingdotgg/uploadthing/blob/2656a9a5cc69619e57de76d8b5d2aced40c1fa89/packages/uploadthing/src/effect-platform.ts
- **[U5]** UploadThing CHANGELOG (6.10.4 dropped `@effect/schema` from the client; 6.11.0 fixed tree-shaking with `#__PURE__`; 6.13.0 switched the client to `effect/Micro`, -67%; 7.0.0 brought the client to about 25 kB): https://github.com/pingdotgg/uploadthing/blob/2656a9a5cc69619e57de76d8b5d2aced40c1fa89/packages/uploadthing/CHANGELOG.md
- **[L0]** `@livestore/livestore@0.5.0` registry metadata (`effect ^4.0.3`; exports `.` and `./effect`): https://registry.npmjs.org/@livestore/livestore/latest
- **[L1]** LiveStore `createStore` / `createStorePromise`: https://github.com/livestorejs/livestore/blob/85ddd7c96135761111844f7b35b7ba485f25ff92/packages/@livestore/livestore/src/store/create-store.ts#L245-L314
- **[L2]** LiveStore `effect` subpath: https://github.com/livestorejs/livestore/blob/85ddd7c96135761111844f7b35b7ba485f25ff92/packages/@livestore/livestore/src/effect/mod.ts
- **[V1]** Evolu `@evolu/common` CHANGELOG 6.0.0 ("Removed Effect dependency"): https://github.com/evoluhq/evolu/blob/771dc6119aa6cba8325bcde2dddbdd74bc8a2074/packages/common/CHANGELOG.md
- **[N1]** npm registry `latest` metadata for `alchemy`, `@confect/server` and `@effect-aws/lambda` (dependency on `effect` v4): https://registry.npmjs.org/alchemy/latest, https://registry.npmjs.org/@confect/server/latest, https://registry.npmjs.org/@effect-aws/lambda/latest

Our measurements: throwaway projects (not committed) with `effect@4.1.2` / `effect@3.22.4`, `esbuild@0.25.10` and Bun 1.4.4 `bun build`, run on 2026-11-09. Scenario sources are as described in section (c). The rejection-shape check ran under Bun.
