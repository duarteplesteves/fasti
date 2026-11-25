import type * as Effect from "effect/Effect";

import type { Result } from "../core/result.js";
import type { Vetoed } from "./errors.js";
import type { PolicyErrorOf, Violation, WithWaived } from "./policy.js";

/** The two forms of every Action (ADR 010): Effect, or a Promise of a {@link Result}. */
export type Form = "effect" | "plain";

/** What an Action returns in form `F`. */
export type Run<F extends Form, V, E, R> = F extends "effect"
  ? Effect.Effect<V, E, R>
  : Promise<Result<V, E>>;

/** The developer's `also` in form `F`; `never` while the Action has no `also` context (`Ctx` is `never`). */
export type AlsoFn<F extends Form, Ctx, A, E, R> = [Ctx] extends [never]
  ? never
  : F extends "effect"
    ? (ctx: Ctx) => Effect.Effect<A, E, R>
    : (ctx: Ctx) => Result<A, E> | Promise<Result<A, E>>;

/** The value with `also: A` added: on objects merged, on void wrapped; a repeat cancel never carries it. */
export type WithAlso<V, A> = V extends { readonly alreadyCancelled: true }
  ? V
  : // oxlint-disable-next-line typescript/no-invalid-void-type -- a write Action may return void; it gets wrapped.
    [V] extends [void]
    ? { readonly also: A }
    : V & { readonly also: A };

/** An Action that only reads. */
export type ReadAction<F extends Form, P, V, E> = (
  params: P
) => Run<F, V, E, never>;

/** An Action that writes, without Policies. The overload with `also` comes first: TypeScript resolves overloads in order. */
interface UnpolicedWriteAction<F extends Form, P, Ctx, V, E> {
  <A, AE, R = never>(
    params: P & { readonly also: AlsoFn<F, Ctx, A, AE, R> }
  ): Run<F, WithAlso<V, A>, E | Vetoed<AE>, R>;
  (params: P): Run<F, V, E, never>;
}

/** An Action that writes, checked by Policies whose Violations are `W`: generic over `relax`, so one signature per `also` overload. */
export interface PolicedWriteAction<
  F extends Form,
  P,
  Ctx,
  V,
  E,
  W extends Violation<string, unknown>,
> {
  <
    A,
    AE,
    R = never,
    const X extends readonly W["policy"][] | undefined = undefined,
  >(
    params: P & {
      /** Skip these Policies: they still run, and come back as `waived` when broken. */
      readonly relax?: X;
      readonly also: AlsoFn<F, Ctx, A, AE, R>;
    }
  ): Run<
    F,
    WithAlso<WithWaived<V, W, X>, A>,
    E | PolicyErrorOf<W, X> | Vetoed<AE>,
    R
  >;
  <const X extends readonly W["policy"][] | undefined = undefined>(
    params: P & {
      /** Skip these Policies: they still run, and come back as `waived` when broken. */
      readonly relax?: X;
    }
  ): Run<F, WithWaived<V, W, X>, E | PolicyErrorOf<W, X>, never>;
}

/** An Action that writes; `W` is the Violations of the Policies that apply to it, `never` when none do (then it takes no `relax`). */
export type WriteAction<
  F extends Form,
  P,
  Ctx,
  V,
  E,
  W extends Violation<string, unknown> = never,
> = [W] extends [never]
  ? UnpolicedWriteAction<F, P, Ctx, V, E>
  : PolicedWriteAction<F, P, Ctx, V, E, W>;
