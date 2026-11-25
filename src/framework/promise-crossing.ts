// Where the developer's Promises and fasti's Effects cross: shared by the plain form, app Policies and the Promise face.
import { Cause, Effect, Exit, Result as EffectResult } from "effect";
import type { Context } from "effect";

import type { Result } from "../core/result.js";
import { AdapterError } from "./errors.js";

/**
 * A typed failure becomes `error`; a defect or interruption is thrown, so the promise rejects.
 *
 * @returns The success as `{ ok: true, value }`, or the typed failure as `{ ok: false, error }`.
 */
export function exitToResult<A, E>(exit: Exit.Exit<A, E>): Result<A, E> {
  if (Exit.isSuccess(exit)) {
    return { ok: true, value: exit.value };
  }

  const { cause } = exit;
  const found = Cause.findError(cause);

  if (
    Cause.hasDies(cause) ||
    Cause.hasInterrupts(cause) ||
    EffectResult.isFailure(found)
  ) {
    throw Cause.squash(cause);
  }

  return { error: found.success, ok: false };
}

/**
 * Run `effect` with the caller's `services`: interrupted on `signal`; a typed failure becomes `error`, a defect or interrupt rejects.
 *
 * @returns A promise of `effect`'s success as `{ ok: true, value }`, or its typed failure as `{ ok: false, error }`.
 */
export async function settle<A, E>(
  services: Context.Context<never>,
  signal: AbortSignal,
  effect: Effect.Effect<A, E>
): Promise<Result<A, E>> {
  return exitToResult(
    await Effect.runPromiseExitWith(services)(effect, { signal })
  );
}

/**
 * An {@link AdapterError} stays the failure; anything else thrown is a defect.
 *
 * @returns An Effect that fails with `thrown` when it is an `AdapterError`, and dies with it otherwise.
 */
function adapterErrorOrDie(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- whatever the developer's Promise rejected with.
  thrown: unknown
): Effect.Effect<never, AdapterError> {
  return thrown instanceof AdapterError
    ? Effect.fail(thrown)
    : Effect.die(thrown);
}

/**
 * Await `run`: a rejection with an {@link AdapterError} is that failure; any other rejection is a defect.
 *
 * @returns An Effect of `run`'s value; it fails with `AdapterError`.
 */
export function attempt<A>(
  run: (signal: AbortSignal) => Promise<A>
): Effect.Effect<A, AdapterError> {
  // A rejection is a defect first, so the error channel never holds `unknown`.
  return Effect.promise(run).pipe(Effect.catchDefect(adapterErrorOrDie));
}

/**
 * A native verb as a Promise, run with the caller's services; a failure rejects with its AdapterError.
 *
 * @returns The verb, returning a Promise.
 */
export function promisedVerb<Args extends readonly unknown[], A>(
  verb: (...args: Args) => Effect.Effect<A, AdapterError>,
  services: Context.Context<never>,
  signal: AbortSignal
): (...args: Args) => Promise<A> {
  return async (...args) => {
    const result = await settle(services, signal, verb(...args));

    if (!result.ok) {
      throw result.error;
    }

    return result.value;
  };
}
