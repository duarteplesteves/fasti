# How better-auth and files-sdk define Adapters and plugins

Research for [#5](https://github.com/duarteplesteves/better-schedule/issues/5), under the map [#2](https://github.com/duarteplesteves/better-schedule/issues/2).

**Question:** using primary sources (docs and source code), how do better-auth and files-sdk define their Adapter interfaces, generate or own schema, test Adapters (conformance suites), let plugins extend behaviour and types, and package Adapters (subpath exports, optional peer dependencies)? Which patterns are worth borrowing for a scheduling **Framework**, and which should we avoid?

Terms follow `GLOSSARY.md`: **Framework** (the stateful layer built from a config object), **Core** (stateless pure functions), **Adapter** (persistence boundary), **Action** (server-side operation).

## Sources

Read on 2026-11-09:

- **better-auth** source at [`ac778b7`](https://github.com/better-auth/better-auth/tree/ac778b70e9c35ce3fb13014fe7122f8faa1cd178) (`@better-auth/core` 1.7.18), plus its docs (the MDX under `docs/content/docs/` in the same tree, published at better-auth.com/docs).
- **files-sdk** source at [`59afe36`](https://github.com/haydenbleasel/files-sdk/tree/59afe36edd603f1304427f098197b0a62d7b2d41) (npm `files-sdk` 3.1.2, repo `haydenbleasel/files-sdk` per the npm `repository` field), plus its docs (MDX under `apps/web/docs/`, published at files-sdk.dev/docs).

Abbreviations used below: `BA:` = `https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/`, `FS:` = `https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/`.

---

## 1. Adapter interface shape

### better-auth: one generic, model-agnostic CRUD contract with two layers

better-auth has **one Adapter interface for every model**. It is not generic over a typed model map. Every method takes `model: string` and untyped `where`/`data`, and the caller picks the row type with a method type parameter (`findOne<T>`).
([BA: packages/core/src/db/adapter/index.ts#L403](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/db/adapter/index.ts#L403))

```ts
type DBAdapter<Options> = {
  id: string;
  create<T, R = T>({ model, data, select?, forceAllowId? }): Promise<R>;
  findOne<T>({ model, where, select?, join? }): Promise<T | null>;
  findMany<T>({ model, where?, limit?, select?, sortBy?, offset?, join? }): Promise<T[]>;
  count({ model, where? }): Promise<number>;
  update<T>({ model, where, update }): Promise<T | null>;
  updateMany({ model, where, update }): Promise<number>;
  delete({ model, where }): Promise<void>;
  deleteMany({ model, where }): Promise<number>;
  consumeOne<T>({ model, where }): Promise<T | null>;      // atomic delete-and-return
  incrementOne<T>({ model, where, increment, set? }): Promise<T | null>; // guarded atomic counter
  transaction<R>(cb: (trx) => Promise<R>): Promise<R>;
  createSchema?(options, file?): Promise<{ code, path, append?, overwrite? }>;
  options?: { adapterConfig, ... };
};
```

- **`Where` is a small portable query language:** `{ field, value, operator?: eq|ne|lt|lte|gt|gte|in|not_in|contains|starts_with|ends_with, connector?: AND|OR, mode?: sensitive|insensitive }`. Joins go through `join: { [model]: true | { limit } }`.
  ([BA: …/adapter/index.ts#L308-L345](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/db/adapter/index.ts#L308))
- **The atomic primitives are recent and carefully specified.** `consumeOne` exists for single-use tokens: under concurrency, exactly one caller gets the row. `incrementOne` treats its `where` as both selector and guard (for example `remaining > 0`). The JSDoc says plain `update` "is not the race-safe primitive for guarded state transitions".
  ([BA: …/adapter/index.ts#L441-L520](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/db/adapter/index.ts#L441))
- **Two layers.** Adapter authors implement a smaller `CustomAdapter`: CRUD that receives already-cleaned `where` and physical model/field names, with `consumeOne`/`incrementOne` optional. They wrap it in `createAdapterFactory({ config, adapter })`, which produces the full `DBAdapter`.
  ([BA: …/adapter/index.ts#L548](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/db/adapter/index.ts#L548), [BA: …/adapter/factory.ts#L55](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/db/adapter/factory.ts#L55))
- **The factory does the cross-cutting work.** It maps logical names to physical ones (`getModelName`/`getFieldName`, `usePlural`), generates ids, applies default values, and runs input/output transforms. It also translates for databases that lack JSON, dates, booleans or arrays, and remaps keys (`id` to `_id` for Mongo). Adapters declare what they support with flags such as `supportsJSON`, `supportsDates`, `supportsBooleans`, `supportsArrays`, `supportsNumericIds`, `supportsUUIDs` and `transaction`. When an adapter omits `consumeOne`/`incrementOne`, the factory falls back to a snapshot-guarded delete or bounded compare-and-swap retries.
  ([BA: …/adapter/index.ts#L52-L300](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/db/adapter/index.ts#L52), [BA: …/adapter/atomic-fallback.ts](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/db/adapter/atomic-fallback.ts), [docs: guides/create-a-db-adapter.mdx](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/docs/content/docs/guides/create-a-db-adapter.mdx))
- **The adapter is a curried factory:** `drizzleAdapter(db, cfg)` returns `(options: BetterAuthOptions) => DBAdapter`. The instance therefore builds the adapter late, once it knows the full schema, including plugin schema.
  ([BA: …/adapter/index.ts `DBAdapterInstance`](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/db/adapter/index.ts))
- **Transactions are opt-in, and the fallback is silent.** `transaction` defaults to `false`. The docs say: "If the adapter doesn't support transactions, operations will be executed sequentially." The Drizzle adapter defaults `transaction` to `false` ([BA: packages/drizzle-adapter/src/drizzle-adapter.ts#L1256](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/drizzle-adapter/src/drizzle-adapter.ts#L1256)). The `transaction` JSDoc also warns that the callback may run more than once (Mongo transient aborts), so side effects belong in after-commit hooks.

### files-sdk: one fixed, domain-specific verb set plus declared capabilities

files-sdk's `Adapter<Raw>` is a **fixed set of storage verbs**: there is no model concept, and the only generic is `Raw`, the native client type.
([FS: packages/files-sdk/src/index.ts#L969](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/packages/files-sdk/src/index.ts#L969))

```ts
interface Adapter<Raw = unknown> {
  readonly name: string;
  readonly raw: Raw;                                  // escape hatch, typed per adapter
  readonly capabilities?: AdapterCapabilityDeclaration;
  readonly conditional?: AdapterConditionalOperations; // native compare-and-set
  upload; download; head; exists; delete; copy; list; url; signedUploadUrl;
  deleteMany?; move?; resumableUpload?;               // optional; the SDK falls back
}
```

- **Capabilities are declared, and the wrapper enforces them.** Each adapter instance declares `capabilities` (`rangeRead`, `metadata`, `cacheControl`, `delimiter`, `signedUrl`, `signedUpload`, …). Every flag defaults to the conservative value, "so an adapter that says nothing never advertises a wrong `true`". The `Files` wrapper refuses unsupported options *before any provider I/O*; it never drops them silently.
  ([FS: …/src/index.ts#L855-L967](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/packages/files-sdk/src/index.ts#L855))
- **Optional methods have SDK fallbacks:** `move` falls back to `copy` plus `delete`, and `deleteMany` to a bounded fan-out. Conditional operations do not: "Omitting an operation means it cannot be implemented atomically and the public call fails before provider I/O."
- **Escape hatch.** `files.raw` is the native client, typed through the adapter's generic, so anything outside the unified surface needs no wrapper.
  ([FS: apps/web/docs/(concepts)/escape-hatch.mdx](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/apps/web/docs/(concepts)/escape-hatch.mdx))
- **Construction:** `new Files({ adapter: s3({ bucket }) })`. The adapter is a plain factory call that returns an `Adapter` object. Unlike better-auth, it does not receive instance options.

---

## 2. Schema ownership and generation (better-auth only)

files-sdk stores objects, so it has no schema. Everything in this section is about better-auth.

- **better-auth owns a logical schema as data.** Core tables (`user`, `session`, `account`, `verification`, and optionally `rateLimit`) are assembled in `buildAuthTables(options)` into a `BetterAuthDBSchema`: `Record<key, { modelName, fields: Record<field, DBFieldAttribute>, indexes?, disableMigrations?, order? }>`. Plugin schemas are merged in by key, so a plugin can add a table or extend a core one.
  ([BA: packages/core/src/db/get-tables.ts#L29](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/db/get-tables.ts#L29), [BA: …/db/type.ts](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/db/type.ts))
- **`DBFieldAttribute` is a portable column description.** Its `type` is one of `string|number|boolean|date|json|string[]|number[]|literal-union`. It also carries `required`, `unique`, `index`, `references {model, field, onDelete}`, `defaultValue` (JS-side only, not a database default), `onUpdate`, `input`/`returned` (API exposure), `transform`, `validator` (Standard Schema), `fieldName` (physical column), `bigint` and `sortable`. Tables also take compound `indexes`.
- **Renaming for existing tables is config, not code.** `user: { modelName: "users", fields: { name: "full_name" } }` renames the table and its columns. Plugins accept the same `schema: { user: { fields: { twoFactorEnabled: "two_factor_enabled" } } }`, typed by `InferOptionSchema`. The docs state: "Type inference in your code will still use the original field names." Logical names stay stable while physical names change.
  ([docs: concepts/database.mdx, "Custom Table Names"](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/docs/content/docs/concepts/database.mdx), [BA: packages/better-auth/src/types/plugins.ts `InferOptionSchema`](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/better-auth/src/types/plugins.ts))
- **Extending core tables:** `user.additionalFields` / `session.additionalFields` take `DBFieldAttribute`s. They are added to the schema, and their types flow into inferred `User`/`Session` (see §4).
- **The CLI (`npx auth@latest …`)** ([docs: concepts/cli.mdx](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/docs/content/docs/concepts/cli.mdx)):
  - `generate` writes **ORM-native schema** (Prisma `schema.prisma`, a Drizzle `schema.ts`, or raw SQL for the built-in Kysely path). It loads the user's `auth.ts` so that plugins and renames are included. Dispatch order: the adapter's own `createSchema()` wins, then built-in generators keyed by `adapter.id` (`prisma`/`drizzle`/`kysely`); otherwise it errors with "please request the maintainer to implement the `createSchema` method".
    ([BA: packages/cli/src/generators/index.ts](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/cli/src/generators/index.ts))
  - `migrate` **applies** schema directly, but only for the built-in Kysely adapter. "For other adapters, you'll need to apply the schema using your ORM's migration tool." A programmatic `getMigrations(auth.options)` exists for runtimes without a CLI, also Kysely-only.
  - `check schema` verifies that the configured schema can hold what better-auth writes. It reads the live database for Kysely, the schema object for Drizzle, and the generated client for Prisma.
- **Runtime schema validation runs at init, on by default.** It reports missing tables or columns and required columns that better-auth never fills, together with fixes. Requests await the check and fail on mismatch. It can be turned off with `advanced.database.validateSchema: false`. Custom adapters without a registered check are not validated.
  ([docs: concepts/database.mdx, "Schema Validation"](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/docs/content/docs/concepts/database.mdx))
- **Escape hatches:** `disableMigration` per table, a plugin `migrations` field (raw Kysely migrations), and "If you prefer adding tables manually, you can do that as well."

**The underlying stance:** the developer's ORM and migration tool own the database. better-auth owns a *logical* schema and *emits* it in the developer's ORM dialect. It runs migrations itself only on its own Kysely path.

---

## 3. Adapter conformance test suites

### better-auth: a published, reusable suite (`@better-auth/test-utils/adapter`)

- **Packaging.** It is a separate package, `@better-auth/test-utils`, with subpath `./adapter`. `vitest`, `better-auth` and `@better-auth/core` are peer dependencies. The older `better-auth/adapters/test` export was removed in v1.5.
  ([BA: packages/test-utils/package.json](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/test-utils/package.json), [docs: guides/create-a-db-adapter.mdx#test-your-adapter](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/docs/content/docs/guides/create-a-db-adapter.mdx))
- **The harness is `testAdapter({ adapter, runMigrations, tests, overrideBetterAuthOptions?, additionalCleanups?, prefixTests?, onFinish?, customIdGenerator?, transformIdOutput? })`.** The adapter author supplies two things: a function from options to adapter, and a function that migrates a real database for given options. The harness refreshes the adapter per options and cleans every table between tests.
  ([BA: packages/test-utils/src/adapter/test-adapter.ts](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/test-utils/src/adapter/test-adapter.ts))
- **Suites are built with `createTestSuite(name, config, fn)`.** Shipped suites: `normalTestSuite` (CRUD, joins, renamed fields/models, additional fields, select, sort/limit/offset, operator edge cases such as "starts_with should not interpret regex patterns"), `transactionsTestSuite`, `authFlowTestSuite`, `numberIdTestSuite`, `uuidTestSuite`, `joinsTestSuite` and `caseInsensitiveTestSuite`. Tests can be disabled individually, `disableTests: { ALL: true }` or per name, which is how an adapter opts out of features it lacks. A test entry can also carry `migrateBetterAuth` options, so a single test can run against a different schema (renamed model, numeric ids).
  ([BA: packages/test-utils/src/adapter/suites/](https://github.com/better-auth/better-auth/tree/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/test-utils/src/adapter/suites), [BA: …/create-test-suite.ts](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/test-utils/src/adapter/create-test-suite.ts))
- **It runs against real databases.** The first-party adapters run it in `e2e/adapter/test/*`: Drizzle, Prisma and Kysely against Postgres, MySQL and SQLite. Example: [BA: e2e/adapter/test/drizzle-adapter/adapter.drizzle.pg.test.ts](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/e2e/adapter/test/drizzle-adapter/adapter.drizzle.pg.test.ts) generates the Drizzle schema, pushes it, then runs every suite.

### files-sdk: no exported conformance suite

- **No shared contract suite is published.** Each adapter has its own `test/<adapter>.test.ts`, mostly against mocks or fakes (`fake-s3-server.ts`, `fake-adapter.ts`). There are opt-in **live** tests (`*.live.test.ts`) gated on `LIVE_TESTS=1` plus credentials; CI runs them only on manual dispatch, so secrets never reach fork PRs.
  ([FS: packages/files-sdk/test/live-helper.ts](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/packages/files-sdk/test/live-helper.ts))
- **Capabilities get a snapshot test instead.** `adapter-capabilities.test.ts` builds every adapter offline and compares `files.capabilities` with a committed JSON file, which also drives the docs comparison table, "so the table can't drift from the adapters".
  ([FS: packages/files-sdk/test/adapter-capabilities.test.ts](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/packages/files-sdk/test/adapter-capabilities.test.ts))
- **A `memory()` adapter ships as a public subpath,** used as a test double and for fixtures (`initial` seed).
  ([FS: packages/files-sdk/src/memory/index.ts](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/packages/files-sdk/src/memory/index.ts))

---

## 4. Plugin systems

### better-auth: plugins are config objects that contribute endpoints, schema, hooks and context

A plugin is a factory that returns an object satisfying `BetterAuthPlugin`. Only `id` is required.
([BA: packages/core/src/types/plugin.ts#L39](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/types/plugin.ts#L39), [docs: concepts/plugins.mdx](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/docs/content/docs/concepts/plugins.mdx))

| Field | Purpose |
|---|---|
| `id` | Unique literal id. |
| `endpoints` | `{ [name]: createAuthEndpoint(path, opts, handler) }`. These become both HTTP routes and **typed server-side functions on `auth.api`**. |
| `schema` | `BetterAuthPluginDBSchema`: new tables, or extra fields on core tables. Merged into the logical schema and the CLI output. |
| `hooks.before/after` | `{ matcher(ctx), handler }[]` around endpoints. They run even when an endpoint is called directly on the server. |
| `middlewares`, `onRequest`, `onResponse` | Request-level interception (HTTP-only concerns). |
| `init(ctx)` | Runs at startup. Can return extra `context` (typed into `$context`) and default `options`. |
| `$ERROR_CODES`, `$Infer`, `rateLimit`, `options`, `migrations`, `adapter` | Error codes, extra inferred types, rate-limit rules, and so on. |

Separately, **database hooks** (`databaseHooks.user.create.before/after`, etc.) sit on the *instance config*, not on plugins. A `before` hook can return `false` to abort or `{ data }` to replace the payload. An `after` hook runs after commit when the operation is inside a transaction.
([docs: concepts/database.mdx, "Database Hooks"](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/docs/content/docs/concepts/database.mdx))

**Type inference, end to end.** `betterAuth<Options>(options): Auth<Options>` captures the literal options type ([BA: packages/better-auth/src/auth/full.ts](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/better-auth/src/auth/full.ts)). From it:

- **`auth.api`** = `InferAPI<router<Options>.endpoints>`. Endpoints are core endpoints intersected with `UnionToIntersection<plugin["endpoints"]>` across `Options["plugins"]`.
  ([BA: packages/better-auth/src/api/index.ts#L186](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/better-auth/src/api/index.ts#L186), [BA: …/types/auth.ts](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/better-auth/src/types/auth.ts))
- **Model types:** `User<Options["user"], Options["plugins"]>` = `BaseUser & InferDBFieldsFromOptions<additionalFields> & InferDBFieldsFromPlugins<"user", Plugins>`. The plugin part walks the plugins tuple recursively, reading `schema.user.fields`. Field-level `required`, `defaultValue`, `input` and `returned` decide optionality and visibility in separate input and output types.
  ([BA: packages/core/src/db/type.ts#L142](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/db/type.ts#L142), [BA: …/db/schema/user.ts](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/src/db/schema/user.ts))
- **`$context`, `$ERROR_CODES`, `$Infer`** are inferred from plugins' `init` return values, `$ERROR_CODES` and `$Infer`.
  ([BA: packages/better-auth/src/types/plugins.ts](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/better-auth/src/types/plugins.ts))
- **Plugin registry:** reusable plugins can augment `interface BetterAuthPluginRegistry` with `declare module "@better-auth/core"`, so that `getPlugin("id")` is typed. The docs add: "If you publish the plugin as a separate package, declare `@better-auth/core` as a peer dependency."

**Caveats the docs admit:** database hooks support additional fields, "however full type inference for these fields isn't yet supported". Endpoint path collisions between plugins are only detected at runtime, with a formatted error ([BA: …/api/index.ts#L134-L170](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/better-auth/src/api/index.ts#L134)).

### files-sdk: an ordered onion around a fixed verb set, plus explicit `extend`

A `FilesPlugin<Ext>` has a `name` and up to four optional hooks.
([FS: packages/files-sdk/src/index.ts#L1415](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/packages/files-sdk/src/index.ts#L1415), [docs: plugins/index.mdx](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/apps/web/docs/plugins/index.mdx))

| Hook | What it does | Changes the instance type? |
|---|---|---|
| `wrap(op, next)` | Intercepts every operation. It can transform `op`, veto by throwing, or rewrite the result. `op` is a discriminated union `FilesOperation` (one variant per verb), and `OperationResult<O>` keeps `next` typed per verb. | No |
| `extend(files)` | Contributes namespaced methods (`files.usage()`). Runs once at construction against the *fully wrapped* instance, so an extension that calls `files.upload` still goes through the onion. Name collisions fail closed. | Yes, via `createFiles` |
| `capabilities(caps)` | Can only *narrow* the advertised capabilities. The core then refuses the narrowed options before any plugin runs. | No |
| `event(e)` | Maps or drops provider storage events, folded innermost first. | No |

- **Ordering is explicit.** `plugins[0]` is outermost: with `[a, b]`, a write runs a → b → op → b → a. Read-side inverses therefore "self-order": `[validate, compress, encrypt]` unwinds decrypt → decompress → validate on download.
- **Placement is specified.** Plugins run *inside* the observability hooks (`onAction`/`onError`) but *outside* retries and key prefixing. So a `wrap` runs once per logical operation, and plugins only see caller-facing keys.
- **Bulk calls fan out per item** (`bulk: true`), so a transforming plugin cannot be bypassed by the array form.
- **`handlers({ upload, download })`** builds a per-verb `wrap` in which unlisted verbs pass through. The library confines the internal type erasure there "so plugin authors never write one".
- **Type extension is explicit.** A class constructor cannot return `this & Ext`, so `createFiles({ adapter, plugins })` returns `Files<A> & ExtensionsOf<P>`, where `ExtensionsOf` is `UnionToIntersection` over each plugin's `extend` return type. `const P` captures the tuple. Wrap-only plugins work with `new Files(...)`.
  ([FS: …/src/index.ts#L1503](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/packages/files-sdk/src/index.ts#L1503), [FS: …/src/index.ts#L4375](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/packages/files-sdk/src/index.ts#L4375))
- **Hooks are kept separate from plugins.** `FilesHooks { onAction, onError, onRetry }` are fire-and-forget observability: not awaited, and a throwing hook "can never fail the operation it observes".
  ([FS: …/src/index.ts#L1185](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/packages/files-sdk/src/index.ts#L1185))
- **Effect bridge.** `files-sdk/effect` wraps an instance; it does not reimplement anything. `Files.layer(options | instance)` gives a service whose methods return `Effect<A, FilesError>`, with tagged `reason`s per error code, fiber interruption that aborts the provider call, and `Stream`s for listings. `effect` is an optional peer dependency.
  ([docs: integrations/effect.mdx](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/apps/web/docs/integrations/effect.mdx))

---

## 5. Packaging Adapters

### better-auth: one package per adapter, re-exported through subpaths

- **Each first-party adapter is its own package** (`@better-auth/drizzle-adapter`, `-prisma-`, `-kysely-`, `-mongo-`, `-memory-`). Its ORM is an **optional peer dependency** (for example `drizzle-orm` with `peerDependenciesMeta.optional: true`), and `@better-auth/core` is also a peer.
  ([BA: packages/drizzle-adapter/package.json](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/drizzle-adapter/package.json))
- **The umbrella `better-auth` package depends on all adapter packages** and re-exports them at `better-auth/adapters/drizzle` and similar subpaths (each file is `export * from "@better-auth/drizzle-adapter"`). The ORMs (`drizzle-orm`, `@prisma/client`, `mongodb`, `pg`, `mysql2`, …) and framework integrations are listed as optional peers there too.
  ([BA: packages/better-auth/package.json](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/better-auth/package.json))
- **Every plugin is a subpath** (`better-auth/plugins/admin`, …). Some heavier plugins are separate packages (`@better-auth/passkey`, `@better-auth/sso`, `@better-auth/stripe`).
- **`better-auth/minimal`** is an entry point without Kysely, for users who bring an ORM adapter.
  ([BA: packages/better-auth/src/auth/full.ts](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/better-auth/src/auth/full.ts))
- **`@better-auth/core` exposes the adapter-author surface** at `@better-auth/core/db/adapter` (`createAdapterFactory`, types), separate from `@better-auth/core/db/internal`. Exports carry a `dev-source` condition that points at `src` for monorepo development.
  ([BA: packages/core/package.json](https://github.com/better-auth/better-auth/blob/ac778b70e9c35ce3fb13014fe7122f8faa1cd178/packages/core/package.json))

### files-sdk: one package, one subpath per adapter and per plugin

- **There is a single package, `files-sdk`, with around 90 subpath exports.** Adapters (`files-sdk/s3`, `/r2`, `/memory`, …), plugins (`/encryption`, `/validation`, …), framework bindings, `/effect` and `/client` are all subpaths. It has `"sideEffects": false` and is ESM only.
  ([FS: packages/files-sdk/package.json](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/packages/files-sdk/package.json))
- **Every provider SDK is an optional peer dependency** (about 50 in total, from `@aws-sdk/client-s3` to `effect` and `zod`). Runtime dependencies are a handful of small libraries. "Anything you don't import is never bundled."
  ([docs: installation.mdx](https://github.com/haydenbleasel/files-sdk/blob/59afe36edd603f1304427f098197b0a62d7b2d41/apps/web/docs/installation.mdx))
- **A missing peer fails loudly.** Node throws `ERR_MODULE_NOT_FOUND` naming the package; a few adapters lazy-load and surface it as the `cause` of a `FilesError` on first call. A provider catalog (`files-sdk/providers`) exposes each adapter's `peerDeps` as data.

---

## Patterns worth borrowing / to avoid

These are for a scheduling Framework that sits between a developer's backend and *their own* database, with Actions that trust their caller.

### Borrow

1. **A small, explicit verb set over a generic `model: string` CRUD.** better-auth's generic CRUD exists because plugins add arbitrary tables. A scheduling Framework has a small fixed domain (resources, availability rules, bookings, …). A files-sdk-style **domain-specific** Adapter, along the lines of `listBookings(resourceId, range)`, `insertBooking`, `listRules(resourceId)`, is easier to implement, test and type. Keep it generic over the developer's row types only if it pays for itself.
2. **Make race-safety part of the Adapter contract, in writing.** better-auth's `consumeOne`/`incrementOne` JSDoc spells out the atomicity guarantee ("exactly one caller receives the row") and why plain `update` is not enough. Booking is the same problem: two Actions racing for one slot. The Adapter contract should name an atomic "insert booking if no blocking overlap" primitive (or require a transaction with a stated isolation guarantee) and document what a fallback may and may not do.
3. **Declared capabilities, enforced before I/O.** files-sdk's conservative-by-default `capabilities` and its fail-closed gate are a good fit for Adapters that differ (transactions, exclusion constraints, row locks). Refuse what the Adapter cannot guarantee instead of degrading silently.
4. **A published conformance suite run against real databases.** better-auth's `testAdapter({ adapter, runMigrations, tests })` plus composable suites with `disableTests` is the model to copy, shipped as its own subpath or package with `vitest` as a peer. This matches the map's "integration tests against a real Adapter". Include a concurrency suite for double booking.
5. **An in-memory Adapter as a public export.** Both libraries ship one. It serves as the reference implementation, the test double, and the target the conformance suite proves first.
6. **A logical schema as data, with physical renaming as config.** Developers own their database and may already have a `bookings` table. better-auth's `modelName` + `fields: { logical: "physical_column" }`, with types keyed on logical names, lets them map onto existing tables without forking. Emitting ORM-native schema (`generate`) instead of running migrations respects that the developer's migration tool owns the database. The CLI itself is out of scope for this destination; the logical-schema-as-data shape is what makes a later generator cheap.
7. **files-sdk's plugin semantics: an ordered onion with precise placement.** `wrap(op, next)` over a discriminated union of Actions, `plugins[0]` outermost, and documented placement relative to transactions, retries and observability hooks. Pair it with `handlers({...})` for per-Action plugins and an explicit `createX` factory that types `extend` contributions (`X & ExtensionsOf<P>`, `const P` tuple).
8. **Keep observability hooks separate from interceptors.** files-sdk's hooks are fire-and-forget and cannot fail the operation; plugins can. For a lifecycle base this separates "notify on booking confirmed" from "veto or transform a booking".
9. **Effect as a wrapper, not a rewrite.** `files-sdk/effect` wraps the Promise instance into a `Layer`/service with tagged error reasons and interruption-to-abort, behind an optional `effect` peer. This keeps "the plain API must not get weirder because of Effect". The reverse also works (Effect inside, Promise facade outside), but the boundary should look like this one.
10. **One package with subpath exports and optional peers** (files-sdk style), at least until an Adapter needs its own release cadence: `better-schedule/core`, `better-schedule/adapters/drizzle`, `better-schedule/test`, `better-schedule/effect`. Use `sideEffects: false` and make a missing peer fail loudly.
11. **Late-bound Adapter construction.** better-auth's `adapter(options) => DBAdapter` lets the instance hand the Adapter the resolved schema, including renames and plugin fields. That is useful if plugins can add fields.

### Avoid

1. **Silent sequential fallback when transactions are off.** better-auth runs "sequentially" when an adapter has no transaction support, and its Drizzle adapter defaults `transaction: false`. For booking that means double bookings under load. Make the atomic booking primitive required, or refuse the operation (files-sdk's fail-closed stance).
2. **Coupling Actions to HTTP endpoints.** better-auth plugin endpoints are HTTP routes first (`createAuthEndpoint(path, { method })`, kebab-case path rules, path-collision detection, `onRequest`/`middlewares`), and `auth.api` is derived from them. HTTP handlers are out of scope here, and Actions trust their caller. Define Actions as plain functions keyed by name; HTTP can be layered on later.
3. **Too many extension points.** better-auth has `hooks`, `middlewares`, `onRequest`/`onResponse`, `init`, `databaseHooks`, `adapter` overrides and `migrations`, plus a known gap ("full type inference for these fields isn't yet supported" in database hooks). Start with files-sdk's two (`wrap`, `extend`) plus fire-and-forget hooks.
4. **A runtime-only path-collision check and implicit plugin merge order.** better-auth merges plugin endpoints and schema by spreading in array order, and collisions surface at runtime. files-sdk fails closed on `extend` name collisions at construction. Do that, and type-check name clashes where cheap.
5. **Large conditional types as the only source of truth.** better-auth's model inference recurses over plugin tuples, and `additionalFields` attributes drive optionality. That is powerful but hard to read and slow to type-check. Prefer the files-sdk approach (an explicit `Ext` generic per plugin, one `UnionToIntersection`) and keep schema-driven inference shallow.
6. **A test helper that requires the full Framework and one test runner.** better-auth's suite pulls in `better-auth` itself and hard-depends on `vitest`. That is acceptable, but keep the conformance suite a thin layer over the Adapter contract so it runs with only the Core, the Adapter and a test runner.
7. **No conformance suite (files-sdk), or JS-side "defaults" mistaken for database defaults.** better-auth's `defaultValue` is JS-only ("will not create a default value on the database level"), which surprises anyone writing rows outside the library. Document clearly which invariants the Framework enforces and which the database enforces.
