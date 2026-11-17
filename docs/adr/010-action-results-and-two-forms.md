# ADR 010: Actions Return Typed Results in a Plain Form and an Effect Form

**Status:** Accepted

**Date:** 2026-11-10

## Context

The Framework is built on Effect, but most developers don't know Effect, so every Action comes in two forms: a plain Promise form (the default) and an Effect form. Expected failures (a slot conflict, a booking that doesn't exist, a broken database) must be typed, never thrown. The plain form must not get harder to use because Effect sits underneath it.

Options considered:

1. **Throw `Error` subclasses** from the plain form (Effect 4's `runPromise` rejects with the typed error itself). Common practice, but the failures disappear from the types, and a caller can forget to handle a conflict.
2. **Return Effect's `Result`** from the plain form. This puts Effect inside the plain API.
3. **A separate error vocabulary for each form** (`code` in plain, `_tag` in Effect). Each reads naturally in its own world, but needs two sets of types, a mapping between them, and docs for both.
4. **One error vocabulary, reported the native way in each form**: a discriminated result value in plain, the error channel in Effect.

## Decision

We choose option 4.

- **Plain form (`fasti`).** Every Action returns `{ ok: true; value: T } | { ok: false; error: E }`. Only bugs reject the promise. There is no `unwrap` helper. `createScheduler` owns no resources, so it has no `dispose()`.
- **Effect form (`fasti/effect`).** A `Scheduler` Service and a `Scheduler.layer({ schema, adapter })` Layer. Actions return `Effect<T, E>`, with failures in the error channel.
- **Shared.** Both forms take the same params and have the same `T` and `E`. The plain form is a mechanical wrapper over the Effect form, so the two can't drift apart.
- **Errors.**
  - The discriminator is `_tag` with PascalCase values, which is what `Effect.catchTag` understands.
  - Each Action declares only the failures it can produce, and `AdapterError` is always one of them.
  - Domain failures (`SlotConflict`, `BookingNotFound`, …) are plain readonly objects with structured fields and no `message`, because the developer writes their own user-facing text.
  - `AdapterError` is an `Error` subclass carrying the database `cause`.
  - "No such booking" is always `BookingNotFound`, including from `getBooking`, so `value` is never nullable.
- **Validation.**
  - fasti checks meaning that TypeScript can't express (e.g. `end` after `start`, a sensible AvailabilityRule, a declared Status) and reports it as `InvalidParams`, whose `issues` follow the Standard Schema issue shape.
  - fasti never checks shape. That is TypeScript's job plus the developer's own request parsing.
  - Each check is defined once, in the Core, as a plain TypeScript function that returns issues. The Framework reuses it, with no Effect Schema at the Action boundary.
  - Brands mark validated values inside fasti only. Public params stay plain, apart from fasti-owned ids.

## Consequences

- **Positive:** The compiler shows every expected failure in both forms, and `switch (error._tag)` can be checked for exhaustiveness.
- **Positive:** Domain failures can be sent straight to a client as JSON.
- **Negative:** Plain users see the field name `_tag`, which comes from Effect.
- **Negative:** Adding a resource-owning part to the runtime later (a cache, a timer) would require a `dispose()`, which is a breaking change.

## Amendment (2026-11-15): the service class is the developer's, and `fields` is nested

Building the Framework in checkpoint 4 settled two details:

- **The developer declares the service class.** fasti can't export one ready-made `Scheduler` tag, because the service's type depends on the developer's schema. `fasti/effect` exports a helper instead, and the developer's class is the tag:

  ```ts
  class AppScheduler extends Scheduler<AppScheduler, typeof schema>()("app/Scheduler") {}
  const live = AppScheduler.layer({ schema, adapter });
  ```

  `layer` is a static on the returned class, so the shape above (`layer({ schema, adapter })`) is unchanged. The class follows Effect's own `Context.Service` idiom, and its id is the developer's, so two schedulers over different schemas can live in one app.
- **Developer Fields are nested on input.** `book` takes them under `fields` (`{ resourceId, start, end, fields: { customerName } }`), so a field can never collide with a param fasti adds later. `fields` is absent when the schema declares none, optional when every field is optional, and required otherwise. Returned Bookings stay flat: Developer Fields sit next to `id`, `start` and `status`, as they do in the developer's table.

## Amendment (2026-11-17): the Effect form names the Adapter's `Tx`

`also` (ADR 015) gets the Adapter's transaction handle as `tx`. The plain form infers `Tx` from the Adapter passed to `createScheduler`, but the Effect form's service class is declared before any Adapter exists, so it has to name `Tx` itself.

- **`Tx` is a required third type parameter:** `Scheduler<Self, S, Tx>()`. `fasti/effect` exports `TxOf<A>` to derive it from an Adapter:

  ```ts
  const adapter = drizzleAdapter(db);
  class AppScheduler extends Scheduler<AppScheduler, typeof schema, TxOf<typeof adapter>>()("app/Scheduler") {}
  const live = AppScheduler.layer({ schema, adapter });
  ```

  `layer` then accepts only an Adapter with that `Tx`. This breaks every existing Effect-form declaration, which must add the third argument.
- **Rejected: `Tx = unknown` as a default.** It would keep existing declarations compiling, but `tx` in an Effect-form `also` would be `unknown`, and every developer would cast it. A typed `tx` is the point of `also`, so we accept the break.
- **`also` in the Effect form is a full Effect.** Its requirements join the Action's (`Effect<V, E, R>`), and the Adapter lift runs each unit of work with the caller's services. Its `now` comes from those services' `Clock`, so `TestClock` controls it.
