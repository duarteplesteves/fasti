import type {
  ListBlocksQuery,
  ListBookingsQuery,
} from "../adapter/contract.js";
import type {
  BlockRecord,
  ResourceIdOf,
  RuleRecord,
} from "../adapter/records.js";
import type { AvailabilityViolation, BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { Booking } from "./booking.js";
import type { PolicyViolation } from "./errors.js";

/** What a Policy can apply to: the Actions that run it. */
export type PolicyTarget = "book" | "reschedule" | "cancel";

/** What `book` asks a Policy about. */
export interface BookCandidate<S extends AnySchema> {
  readonly action: "book";
  readonly resourceId: ResourceIdOf<S>;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
  /** The Clock's time, read once on the unit: `also` sees the same. */
  readonly now: Temporal.Instant;
}

/** What `reschedule` asks a Policy about: the destination Resource and range, and the stored Booking. */
export interface RescheduleCandidate<S extends AnySchema> {
  readonly action: "reschedule";
  /** The Resource the Booking moves to: the stored one when the call names none. */
  readonly resourceId: ResourceIdOf<S>;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
  /** The Booking as stored, before the move. */
  readonly previous: Booking<S>;
  /** The Clock's time, read once on the unit: `also` sees the same. */
  readonly now: Temporal.Instant;
}

/** What `cancel` asks a Policy about: the stored Booking, before it is cancelled. */
export interface CancelCandidate<S extends AnySchema> {
  readonly action: "cancel";
  readonly booking: Booking<S>;
  /** The Clock's time, read once on the unit: `also` sees the same. */
  readonly now: Temporal.Instant;
}

/** One candidate per call, discriminated on `action`. */
export type Candidate<S extends AnySchema> =
  | BookCandidate<S>
  | RescheduleCandidate<S>
  | CancelCandidate<S>;

/** The candidates a Policy with targets `T` sees. */
export type CandidateFor<S extends AnySchema, T extends PolicyTarget> = Extract<
  Candidate<S>,
  { readonly action: T }
>;

/** fasti's reads, as Promises: a database failure rejects with `AdapterError`. No `tx`: they run on fasti's unit. */
export interface PolicyReads<S extends AnySchema> {
  readonly getBooking: (id: BookingId) => Promise<Booking<S> | null>;
  readonly listBookings: (query: ListBookingsQuery<S>) => Promise<Booking<S>[]>;
  /** `[]` on a schema without `block`. */
  readonly listBlocks: (query: ListBlocksQuery<S>) => Promise<BlockRecord<S>[]>;
  readonly getRules: (resourceId: ResourceIdOf<S>) => Promise<RuleRecord[]>;
}

/** What `load` gets: the candidate's Resource and range (on `cancel`, the stored Booking's), the unit's `now`, and fasti's reads. */
export interface LoadContext<S extends AnySchema> {
  readonly resourceId: ResourceIdOf<S>;
  readonly from: Temporal.Instant;
  readonly to: Temporal.Instant;
  readonly now: Temporal.Instant;
  readonly reads: PolicyReads<S>;
}

/** A defined Policy. `load` is `null` when the definition had none, so `Data` is `undefined`. */
export interface Policy<
  S extends AnySchema,
  N extends string,
  T extends PolicyTarget,
  D,
  Data,
> {
  readonly name: N;
  readonly appliesTo: readonly [T, ...T[]];
  readonly load: ((ctx: LoadContext<S>) => Data | Promise<Data>) | null;
  readonly check: (candidate: CandidateFor<S, T>, data: Data) => D | null;
}

/** Any Policy over schema `S`, as the registry holds it. */
export interface AnyPolicyOf<S extends AnySchema> {
  readonly name: string;
  readonly appliesTo: readonly PolicyTarget[];
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- each Policy's own `Data`, opaque to the registry.
  readonly load: ((ctx: LoadContext<S>) => unknown) | null;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- each Policy's own `D`, opaque to the registry.
  readonly check: (candidate: never, data: never) => unknown;
}

/** What a broken Policy reports. */
export interface Violation<N extends string, D> {
  readonly policy: N;
  readonly detail: D;
}

/** The Violation Policy `P` reports, by its name and `detail`. */
export type ViolationOf<P> = P extends {
  readonly name: infer N extends string;
  readonly check: (candidate: never, data: never) => infer R;
}
  ? Violation<N, Exclude<R, null>>
  : never;

/** The Policies in union `P` that apply to `A`. */
type Applies<P, A extends PolicyTarget> = P extends {
  readonly appliesTo: readonly (infer T)[];
}
  ? A extends T
    ? P
    : never
  : never;

/** Every Violation an Action `A` can report: the built-in `availability`'s (on `book` and `reschedule`) and each applicable Policy's in union `P`. */
export type ViolationFor<P, A extends PolicyTarget> =
  | (A extends "cancel" ? never : AvailabilityViolation)
  | ViolationOf<Applies<P, A>>;

/** The names a `relax` value `X` may list; `never` without `relax`. */
type RelaxedNames<X> = X extends readonly (infer N)[] ? N : never;

/** The names a `relax` value `X` surely lists: a literal tuple's; none when it may be `undefined`, or a widened array that may be `[]`. */
type SurelyRelaxed<X> = undefined extends X
  ? never
  : X extends readonly unknown[]
    ? number extends X["length"]
      ? never
      : X[number]
    : never;

/** `V` with `Waived` added; a repeat cancel ran no Policy, so it never carries it. */
type AddWaived<V, Waived> = V extends { readonly alreadyCancelled: true }
  ? V
  : V & Waived;

/** The value with `waived` added exactly when `relax` was passed (optional when it may be `undefined`): the relaxed Policies' Violations. */
export type WithWaived<V, W extends Violation<string, unknown>, X> = [
  X,
] extends [undefined]
  ? V
  : undefined extends X
    ? AddWaived<
        V,
        {
          readonly waived?: readonly Extract<
            W,
            { readonly policy: RelaxedNames<X> }
          >[];
        }
      >
    : AddWaived<
        V,
        {
          readonly waived: readonly Extract<
            W,
            { readonly policy: RelaxedNames<X> }
          >[];
        }
      >;

/** `PolicyViolation` of the applicable Policies `W` that `X` doesn't surely relax; `never` when it relaxes them all. */
export type PolicyErrorOf<W extends Violation<string, unknown>, X> = [
  Exclude<W, { readonly policy: SurelyRelaxed<X> }>,
] extends [never]
  ? never
  : PolicyViolation<Exclude<W, { readonly policy: SurelyRelaxed<X> }>>;

/** Duplicate names in a Policy tuple are a type error. */
export type UniqueNames<
  P extends readonly { readonly name: string }[],
  Seen extends string = never,
> = P extends readonly [
  infer H extends { readonly name: string },
  ...infer Rest extends readonly { readonly name: string }[],
]
  ? [H["name"]] extends [Seen]
    ? never
    : UniqueNames<Rest, Seen | H["name"]>
  : unknown;

/** Params of {@link definePolicy}. */
export interface DefinePolicyParams<
  S extends AnySchema,
  N extends string,
  T extends PolicyTarget,
  D,
  Data,
> {
  /** Unique per scheduler; `availability` is fasti's own. */
  readonly name: N & (N extends "availability" ? never : unknown);
  /** The Actions that run it; at least one. */
  readonly appliesTo: readonly [T, ...T[]];
  /** Optional. Runs once per Action call, under the Resource Lock: does the I/O. */
  readonly load?: (ctx: LoadContext<S>) => Data | Promise<Data>;
  /** Runs once per candidate, synchronously: `null` passes, anything else is the Violation's `detail`. */
  readonly check: (candidate: CandidateFor<S, T>, data: Data) => D | null;
}

/**
 * Define a Policy over `schema`: a rule a booking must keep, reported as `PolicyViolation` when broken.
 * Throws on an empty `appliesTo` or the name `availability`.
 *
 * @example
 * ```ts
 * const maxFourPerDay = definePolicy(schema, {
 *   name: "maxFourPerDay",
 *   appliesTo: ["book"],
 *   load: async ({ resourceId, from, reads }) => (await reads.listBookings({ resourceId, overlapping: day(from) })).length,
 *   check: (_candidate, count) => (count >= 4 ? { count } : null),
 * });
 * ```
 */
export function definePolicy<
  S extends AnySchema,
  const N extends string,
  const T extends PolicyTarget,
  D,
  Data = undefined,
>(
  _schema: S,
  params: DefinePolicyParams<S, N, T, D, Data>
): Policy<S, N, T, D, Data> {
  const { appliesTo, check, load, name } = params;

  // Plain-JS callers can get past the types.
  if (appliesTo.length === 0) {
    throw new Error(`fasti: Policy ${name} must apply to at least one Action`);
  }

  if (name === "availability") {
    throw new Error("fasti: the Policy name availability is fasti's own");
  }

  return { appliesTo, check, load: load ?? null, name };
}
