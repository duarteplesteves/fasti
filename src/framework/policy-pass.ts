import { Effect } from "effect";
import type { Context } from "effect";

import { checked } from "../core/result.js";
import type { InvalidParams, Result } from "../core/result.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { EffectReads } from "./effect-adapter.js";
import type { AdapterError, PolicyViolation } from "./errors.js";
import type {
  AnyPolicyOf,
  Candidate,
  LoadContext,
  PolicyReads,
  Violation,
  ViolationOf,
} from "./policy.js";
import { attempt, promisedVerb } from "./promise-crossing.js";
import type { ActionContext } from "./scheduler-service.js";
import { isNamedTarget, matchesTarget } from "./target.js";
import type { CalledTarget, PolicyTarget } from "./target.js";

/** What a Policy's `load` gets besides fasti's reads: the candidate's Resource and range, and the unit's `now`. */
export interface LoadArgs<S extends AnySchema> {
  readonly resourceId: LoadContext<S>["resourceId"];
  readonly from: Temporal.Instant;
  readonly to: Temporal.Instant;
  readonly now: Temporal.Instant;
}

/** A Policy as the pass runs it, the app's and the Plugins' alike: `load` is an Effect over the unit's reads. */
export interface RunnablePolicy<S extends AnySchema> {
  readonly name: string;
  readonly appliesTo: readonly PolicyTarget<S>[];
  readonly load:
    | ((
        reads: EffectReads<S>,
        ctx: LoadArgs<S>
      ) => Effect.Effect<unknown, AdapterError>)
    | null;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- each Policy's own `D`, opaque to the registry.
  readonly check: (candidate: never, data: never) => unknown;
}

/**
 * `target` as `relax` issues name it.
 *
 * @returns The target's name, or `<from> → <to>` for a Transition edge.
 */
function label(target: CalledTarget): string {
  return isNamedTarget(target) ? target : `${target.from} → ${target.to}`;
}

/**
 * The Policies `target` runs: the Plugins' first, then the developer's, in registration order.
 *
 * @returns The Policies, in run order.
 */
export function applicable<S extends AnySchema, Tx>(
  ctx: ActionContext<S, Tx>,
  target: CalledTarget
): readonly RunnablePolicy<S>[] {
  return [...ctx.pluginPolicies, ...ctx.policies].filter((policy) =>
    policy.appliesTo.some((t) => matchesTarget(t, target))
  );
}

/**
 * fasti's Effect reads as the Promises `load` gets, run with the caller's services.
 *
 * @returns The reads in Promise form.
 */
function promiseReads<S extends AnySchema>(
  reads: EffectReads<S>,
  services: Context.Context<never>,
  signal: AbortSignal
): PolicyReads<S> {
  return {
    getBooking: promisedVerb(reads.getBooking, services, signal),
    listBookings: promisedVerb(reads.listBookings, services, signal),
  };
}

/**
 * An app Policy, with its Promise `load` run on fasti's reads: a rejection with `AdapterError` is that failure; any other is a defect.
 *
 * @returns The Policy in the form the Policy pass runs.
 */
export function appPolicy<S extends AnySchema>(
  policy: AnyPolicyOf<S>
): RunnablePolicy<S> {
  const { load } = policy;

  return {
    ...policy,
    load:
      load &&
      ((reads, ctx) =>
        Effect.flatMap(Effect.context(), (services) =>
          attempt(
            async (signal) =>
              await load({
                ...ctx,
                reads: promiseReads(reads, services, signal),
              })
          )
        )),
  };
}

/** A Policy with what its `load` returned. */
interface Loaded<S extends AnySchema> {
  readonly policy: RunnablePolicy<S>;
  readonly data: unknown;
}

/**
 * Run each Policy's `load` once, in order. A failing read is `AdapterError`; any other throw is a defect.
 *
 * @returns An Effect of each Policy with its loaded data, in order; it fails with `AdapterError`.
 */
export function loadPolicies<S extends AnySchema>(
  reads: EffectReads<S>,
  policies: readonly RunnablePolicy<S>[],
  ctx: LoadArgs<S>
): Effect.Effect<readonly Loaded<S>[], AdapterError> {
  // Effect.forEach runs them in order, one at a time.
  return Effect.forEach(policies, (policy) =>
    policy.load === null
      ? Effect.succeed({ data: undefined, policy })
      : Effect.map(policy.load(reads, ctx), (data) => ({ data, policy }))
  );
}

/** `relax` as an Action's implementation receives it: typed for callers by the Action, unparsed here, since plain-JS callers get past the types. */
export interface UnparsedRelax {
  readonly relax?: unknown;
}

/**
 * `params.relax`, parsed: `undefined` when absent, else names of Policies in `policies`; issues at `relax` or each bad index otherwise. Runs before any Adapter call.
 *
 * @returns The Policy names, `undefined` when `relax` is absent, or `InvalidParams` when it isn't an array of names that apply to `target`.
 */
export function parseRelax<S extends AnySchema>(
  policies: readonly RunnablePolicy<S>[],
  target: CalledTarget,
  { relax }: UnparsedRelax
): Result<readonly string[] | undefined, InvalidParams> {
  if (relax === undefined) {
    return { ok: true, value: undefined };
  }

  if (!Array.isArray(relax)) {
    return {
      error: {
        _tag: "InvalidParams",
        issues: [
          {
            message: "relax must be an array of Policy names",
            path: ["relax"],
          },
        ],
      },
      ok: false,
    };
  }

  const entries: readonly unknown[] = relax;

  const named = entries.map(
    (entry) => policies.find((p) => p.name === entry)?.name
  );

  return checked(
    named.flatMap((name, i) =>
      name === undefined
        ? [
            {
              message: `relax: ${String(entries[i])} is not a Policy that applies to ${label(target)}`,
              path: ["relax", i],
            },
          ]
        : []
    ),
    () => named.filter((name) => name !== undefined)
  );
}

/** The broken Policies, split by `relax`. */
interface Judged {
  readonly violations: Violation<string, unknown>[];
  readonly waived: Violation<string, unknown>[];
}

/**
 * Every loaded Policy's Violation for `candidate`, in order, split by `relax`. A throw in `check` is a defect.
 *
 * @returns The broken Policies' Violations, split into unrelaxed and relaxed.
 */
export function judge<S extends AnySchema>(
  loaded: readonly Loaded<S>[],
  candidate: Candidate<S>,
  relax: readonly string[]
): Judged {
  const broken = loaded.flatMap(({ data, policy }) => {
    // SAFETY: `applicable` picked this Policy for `candidate.action`, so it takes this candidate; `data` came from its own `load`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the registry erases each Policy's candidate and Data types.
    const detail = policy.check(candidate as never, data as never);

    return detail === null ? [] : [{ detail, policy: policy.name }];
  });

  return {
    violations: broken.filter((v) => !relax.includes(v.policy)),
    waived: broken.filter((v) => relax.includes(v.policy)),
  };
}

/**
 * Load and check every Policy in `policies` for `candidate`, under the lock, after the Invariants (ADR 014). Every one runs, relaxed ones too: fails `PolicyViolation` with the unrelaxed broken ones, else succeeds with the relaxed broken ones (`waived`).
 *
 * @returns An Effect of the relaxed Violations; it fails with `PolicyViolation` or `AdapterError`.
 */
export function enforcePolicies<
  S extends AnySchema,
  P extends RunnablePolicy<S>,
>(
  reads: EffectReads<S>,
  policies: readonly P[],
  candidate: Candidate<S>,
  relax: readonly string[]
): Effect.Effect<
  ViolationOf<P>[],
  PolicyViolation<ViolationOf<P>> | AdapterError
> {
  const { now } = candidate;

  // `load` gets the candidate's range, or on `cancel` and a Transition the stored Booking's.
  const { end, resourceId, start } =
    candidate.action === "cancel" || candidate.action === "transition"
      ? candidate.booking
      : candidate;

  return Effect.flatMap(
    loadPolicies(reads, policies, { from: start, now, resourceId, to: end }),
    (loaded) => {
      // SAFETY: each Violation carries the name and `check` result of one of `policies`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- judge works over the erased registry.
      const { violations, waived } = judge(loaded, candidate, relax) as {
        readonly violations: ViolationOf<P>[];
        readonly waived: ViolationOf<P>[];
      };

      const [first, ...rest] = violations;

      return first === undefined
        ? Effect.succeed(waived)
        : Effect.fail<PolicyViolation<ViolationOf<P>>>({
            _tag: "PolicyViolation",
            violations: [first, ...rest],
          });
    }
  );
}
