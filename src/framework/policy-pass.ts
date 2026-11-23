import { Cause, Effect, Exit } from "effect";

import type { Issue } from "../core/result.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { EffectReads } from "./effect-adapter.js";
import { AdapterError } from "./errors.js";
import type { PolicyViolation } from "./errors.js";
import type {
  AnyPolicyOf,
  Candidate,
  LoadContext,
  PolicyReads,
  Violation,
  ViolationOf,
} from "./policy.js";
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

/** `target` as `relax` issues name it. */
function label(target: CalledTarget): string {
  return isNamedTarget(target) ? target : `${target.from} → ${target.to}`;
}

/** The Policies `target` runs: the Plugins' first, then the developer's, in registration order. */
export function applicable<S extends AnySchema, Tx>(
  ctx: ActionContext<S, Tx>,
  target: CalledTarget
): readonly RunnablePolicy<S>[] {
  return [...ctx.pluginPolicies, ...ctx.policies].filter((policy) =>
    policy.appliesTo.some((t) => matchesTarget(t, target))
  );
}

/** Run a read, rejecting with its `AdapterError` on failure. */
async function run<A>(read: Effect.Effect<A, AdapterError>): Promise<A> {
  const exit = await Effect.runPromiseExit(read);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  throw Cause.squash(exit.cause);
}

/** fasti's Effect reads as the Promises `load` gets. */
function promiseReads<S extends AnySchema>(
  reads: EffectReads<S>
): PolicyReads<S> {
  return {
    getBooking: async (id) => await run(reads.getBooking(id)),
    listBookings: async (query) => await run(reads.listBookings(query)),
  };
}

/** An app Policy, with its Promise `load` run on fasti's reads: a rejection with `AdapterError` is that failure; any other is a defect. */
export function appPolicy<S extends AnySchema>(
  policy: AnyPolicyOf<S>
): RunnablePolicy<S> {
  const { load } = policy;

  return {
    ...policy,
    load:
      load &&
      ((reads, ctx) =>
        // A rejection other than AdapterError escapes Effect.promise as a defect.
        Effect.flatMap(
          Effect.promise(async () => {
            try {
              return {
                data: await load({ ...ctx, reads: promiseReads(reads) }),
                ok: true,
              } as const;
            } catch (error) {
              if (error instanceof AdapterError) {
                return { error, ok: false } as const;
              }

              throw error;
            }
          }),
          (r) => (r.ok ? Effect.succeed(r.data) : Effect.fail(r.error))
        )),
  };
}

/** A Policy with what its `load` returned. */
interface Loaded<S extends AnySchema> {
  readonly policy: RunnablePolicy<S>;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the Policy's own `Data`, handed back to its `check`.
  readonly data: unknown;
}

/** Run each Policy's `load` once, in order. A failing read is `AdapterError`; any other throw is a defect. */
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

/** Each `relax` entry that names no Policy in `policies`, as an issue at its index; `[]` when all apply. Runs before any Adapter call. */
export function checkRelax<S extends AnySchema>(
  policies: readonly RunnablePolicy<S>[],
  target: CalledTarget,
  relax: readonly string[] | undefined
): Issue[] {
  if (relax === undefined) {
    return [];
  }

  // Plain-JS callers can get past the types.
  if (!Array.isArray(relax)) {
    return [
      { message: "relax must be an array of Policy names", path: ["relax"] },
    ];
  }

  const names = new Set(policies.map((p) => p.name));

  return relax.flatMap((name: string, i: number) =>
    names.has(name)
      ? []
      : [
          {
            message: `relax: ${name} is not a Policy that applies to ${label(target)}`,
            path: ["relax", i],
          },
        ]
  );
}

/** The broken Policies, split by `relax`. */
interface Judged {
  readonly violations: Violation<string, unknown>[];
  readonly waived: Violation<string, unknown>[];
}

/** Every loaded Policy's Violation for `candidate`, in order, split by `relax`. A throw in `check` is a defect. */
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

/** Load and check every Policy in `policies` for `candidate`, under the lock, after the Invariants (ADR 014). Every one runs, relaxed ones too: fails `PolicyViolation` with the unrelaxed broken ones, else succeeds with the relaxed broken ones (`waived`). */
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
