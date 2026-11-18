import { Cause, Effect, Exit } from "effect";

import { availableWindows, fitsInSomeWindow } from "../core/availability.js";
import { checkRules } from "../core/checks.js";
import { checked } from "../core/result.js";
import type { InstantRange } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { EffectReads } from "./effect-adapter.js";
import { AdapterError } from "./errors.js";
import type { PolicyViolation } from "./errors.js";
import type {
  AnyPolicyOf,
  Candidate,
  LoadContext,
  Policy,
  PolicyReads,
  PolicyTarget,
  Violation,
  ViolationOf,
} from "./policy.js";
import type { ActionContext } from "./scheduler-service.js";

/** The built-in `availability` Policy: the candidate must fit inside one of the Resource's availability windows (ADR 014). */
export function availabilityPolicy<S extends AnySchema>(): Policy<
  S,
  "availability",
  "book",
  Readonly<Record<string, never>>,
  readonly InstantRange[]
> {
  return {
    appliesTo: ["book"],
    check: (candidate, windows) =>
      fitsInSomeWindow(windows, candidate) ? null : {},
    load: async ({ from, reads, resourceId, to }) => {
      const coreId = String(resourceId);

      const stored = await reads.getRules(resourceId);
      const rules = stored.map((r) => ({ ...r, resourceId: coreId }));

      const windows = checked(checkRules(rules), () =>
        availableWindows(rules, { end: to, start: from })
      );

      // Invalid stored rules are the Adapter's data (Invariant 6).
      if (!windows.ok) {
        throw new AdapterError(windows.error);
      }

      return windows.value;
    },
    name: "availability",
  };
}

/** The Policies `target` runs: `availability` first, then the developer's, in registration order. */
export function applicable<S extends AnySchema, Tx>(
  ctx: ActionContext<S, Tx>,
  target: PolicyTarget
): readonly AnyPolicyOf<S>[] {
  return [
    availabilityPolicy<S>(),
    ...ctx.policies.filter((p) => p.appliesTo.includes(target)),
  ];
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
    getRules: async (resourceId) => await run(reads.getRules(resourceId)),
    listBlocks: async (query) => await run(reads.listBlocks(query)),
    listBookings: async (query) => await run(reads.listBookings(query)),
  };
}

/** A Policy with what its `load` returned. */
interface Loaded<S extends AnySchema> {
  readonly policy: AnyPolicyOf<S>;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- the Policy's own `Data`, handed back to its `check`.
  readonly data: unknown;
}

/** Run each Policy's `load` once, in order. A failing read is `AdapterError`; any other throw is a defect. */
function loadPolicies<S extends AnySchema>(
  reads: EffectReads<S>,
  policies: readonly AnyPolicyOf<S>[],
  ctx: Omit<LoadContext<S>, "reads">
): Effect.Effect<readonly Loaded<S>[], AdapterError> {
  const loadCtx = { ...ctx, reads: promiseReads(reads) };

  // Effect.all runs them in order, one at a time.
  return Effect.all(
    policies.map((policy) => {
      const { load } = policy;

      if (load === null) {
        return Effect.succeed({ data: undefined, policy });
      }

      // A rejection other than AdapterError escapes Effect.promise as a defect.
      return Effect.flatMap(
        Effect.promise(async () => {
          try {
            return { data: await load(loadCtx), ok: true } as const;
          } catch (error) {
            if (error instanceof AdapterError) {
              return { error, ok: false } as const;
            }

            throw error;
          }
        }),
        (r) =>
          r.ok ? Effect.succeed({ data: r.data, policy }) : Effect.fail(r.error)
      );
    })
  );
}

/** Every loaded Policy's Violation for `candidate`, in order. A throw in `check` is a defect. */
function judge<S extends AnySchema>(
  loaded: readonly Loaded<S>[],
  candidate: Candidate<S>
): Violation<string, unknown>[] {
  return loaded.flatMap(({ data, policy }) => {
    // SAFETY: `applicable` picked this Policy for `candidate.action`, so it takes this candidate; `data` came from its own `load`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the registry erases each Policy's candidate and Data types.
    const detail = policy.check(candidate as never, data as never);

    return detail === null ? [] : [{ detail, policy: policy.name }];
  });
}

/** Load and check every Policy in `policies` for `candidate`, under the lock, after the Invariants: fails `PolicyViolation` with every broken one (ADR 014). */
export function enforcePolicies<S extends AnySchema, P extends AnyPolicyOf<S>>(
  reads: EffectReads<S>,
  policies: readonly P[],
  candidate: Candidate<S>
): Effect.Effect<void, PolicyViolation<ViolationOf<P>> | AdapterError> {
  const { end, now, resourceId, start } = candidate;

  return Effect.flatMap(
    loadPolicies(reads, policies, { from: start, now, resourceId, to: end }),
    (loaded) => {
      // SAFETY: each Violation carries the name and `check` result of one of `policies`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- judge works over the erased registry.
      const [first, ...rest] = judge(loaded, candidate) as ViolationOf<P>[];

      return first === undefined
        ? Effect.void
        : Effect.fail<PolicyViolation<ViolationOf<P>>>({
            _tag: "PolicyViolation",
            violations: [first, ...rest],
          });
    }
  );
}
