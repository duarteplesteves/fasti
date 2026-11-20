import { Effect } from "effect";

import type { ListBlocksQuery } from "../adapter/contract.js";
import { toCoreBooking } from "../adapter/records.js";
import type { ResourceIdOf } from "../adapter/records.js";
import { detectConflicts } from "../core/detect-conflicts.js";
import type { DetectConflictsParams } from "../core/detect-conflicts.js";
import type { BlockId, Booking, BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { EffectReads } from "./effect-adapter.js";
import { AdapterError } from "./errors.js";
import type { Conflict, SlotConflict } from "./errors.js";
import type { ActionContext } from "./scheduler-service.js";

/** A range a Booking can't overlap, from a busy source. */
interface BusyRange {
  readonly id: string;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
}

/** A source of busy time on a Resource, beside Bookings: `kind` tags the Conflicts it causes. */
export interface BusySource<K extends string = string> {
  readonly kind: K;
  readonly list: <S extends AnySchema>(
    reads: EffectReads<S>,
    query: ListBlocksQuery<S>
  ) => Effect.Effect<readonly BusyRange[], AdapterError>;
}

/** Blocks, as busy time: `[]` on a schema without `block` (ADR 016). */
const blockBusy: BusySource<"block"> = {
  kind: "block",
  list: (reads, query) => reads.listBlocks(query),
};

/** Every busy source a scheduler checks Bookings against. */
export const busySources = [blockBusy] as const;

/** What a Conflict can be: a Booking, or a busy source's kind. */
type Kind = "booking" | (typeof busySources)[number]["kind"];

/** What `occupants` reads with: the codec and the busy sources. */
type OccupancyContext<S extends AnySchema, Tx> = Pick<
  ActionContext<S, Tx>,
  "busy" | "codec"
>;

/** What occupies a Resource over a range, as the Core sees it, plus each occupant's kind for mapping hits back. */
interface Occupants {
  readonly bookings: readonly Booking<BookingId | BlockId>[];
  readonly kindById: ReadonlyMap<string, Kind>;
}

/**
 * Everything occupying `resourceId` over the half-open `[from, to)` for a candidate of kind `candidate`: the one place occupants enter the Core.
 * Only a Booking candidate sees the busy sources: Blocks may overlap each other (ADR 016). Internal.
 */
export function occupants<S extends AnySchema, Tx>(
  { busy, codec }: OccupancyContext<S, Tx>,
  reads: EffectReads<S>,
  candidate: Kind,
  resourceId: ResourceIdOf<S>,
  overlapping: {
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
  }
): Effect.Effect<Occupants, AdapterError> {
  const query = { overlapping, resourceId };
  const sources = candidate === "booking" ? busy : [];

  return Effect.map(
    Effect.all([
      reads.listBookings(query),
      Effect.all(
        sources.map((source) =>
          Effect.map(source.list(reads, query), (ranges) =>
            ranges.map((range) => ({ kind: source.kind, range }))
          )
        )
      ),
    ]),
    ([bookings, busyLists]) => {
      const busyRanges = busyLists.flat();

      return {
        bookings: [
          ...bookings.map((b) => toCoreBooking(codec, b)),
          ...busyRanges.map(({ range: { end, id, start } }) => ({
            end,
            // SAFETY: the Core only compares ids; `kindById` keeps each one's kind.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a busy id is a BlockId until Plugins add kinds.
            id: id as BlockId,
            isBlocking: true,
            resourceId: String(resourceId),
            start,
          })),
        ],
        kindById: new Map<string, Kind>([
          ...bookings.map((b) => [b.id, "booking"] as const),
          ...busyRanges.map(({ kind, range }) => [range.id, kind] as const),
        ]),
      };
    }
  );
}

/** The Core's hits as Conflicts, sorted by start, then id. Ids, kinds and times only: no Developer Fields. */
export function toConflicts(
  hits: readonly Booking<BookingId | BlockId>[],
  kindById: ReadonlyMap<string, Kind>
): readonly Conflict[] {
  return hits
    .map(({ end, id, start }) => {
      const kind = kindById.get(id);

      // Every hit came from `occupants`, which tagged it: a miss is a defect.
      if (kind === undefined) {
        throw new Error(`fasti: occupant ${id} has no kind`);
      }

      // SAFETY: `kindById` tags each id with the kind it came from, so the id has that kind's brand.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pairing lives in the map, not the type.
      return { end, id, kind, start } as Conflict;
    })
    .toSorted(
      (a, b) =>
        Temporal.Instant.compare(a.start, b.start) ||
        (a.id < b.id ? -1 : Number(a.id > b.id))
    );
}

/**
 * What a candidate `[start, end)` on `resourceId` would overlap, as Conflicts: the overlap Invariant's one check (ADR 014, ADR 016).
 * `kind` is the candidate's: a Block candidate conflicts with blocking Bookings only.
 */
export function conflictsAt<S extends AnySchema, Tx>(
  ctx: OccupancyContext<S, Tx>,
  reads: EffectReads<S>,
  {
    end,
    excludeBookingId,
    kind,
    resourceId,
    start,
  }: {
    readonly kind: Kind;
    readonly resourceId: ResourceIdOf<S>;
    readonly start: Temporal.Instant;
    readonly end: Temporal.Instant;
    /** Leave this Booking out, e.g. the one being moved; `null` for none. */
    readonly excludeBookingId: BookingId | null;
  }
): Effect.Effect<readonly Conflict[], AdapterError> {
  return Effect.flatMap(
    occupants(ctx, reads, kind, resourceId, { from: start, to: end }),
    ({ bookings, kindById }) => {
      const params: DetectConflictsParams<BookingId | BlockId> = {
        bookings,
        candidate: { end, start },
        resourceId: String(resourceId),
      };

      if (excludeBookingId !== null) {
        params.excludeBookingId = excludeBookingId;
      }

      const r = detectConflicts(params);

      // Callers check the params up front, so only invalid stored data fails here (Invariant 6).
      return r.ok
        ? Effect.succeed(toConflicts(r.value, kindById))
        : Effect.fail(new AdapterError(r.error));
    }
  );
}

/** Params of `checkOverlap`: a Booking's candidate `[start, end)` on a Resource. */
export interface CheckOverlapParams<S extends AnySchema> {
  readonly resourceId: ResourceIdOf<S>;
  readonly start: Temporal.Instant;
  readonly end: Temporal.Instant;
  /** Leave this Booking out, e.g. the one being moved; `null` for none. */
  readonly excludeBookingId: BookingId | null;
}

/** The overlap Invariant for a Booking at `[start, end)`: fails `SlotConflict` if it would overlap a blocking Booking or a Block, ignoring `excludeBookingId` (ADR 014). */
export function checkOverlap<S extends AnySchema, Tx>(
  ctx: OccupancyContext<S, Tx>,
  reads: EffectReads<S>,
  range: CheckOverlapParams<S>
): Effect.Effect<void, SlotConflict | AdapterError> {
  return Effect.flatMap(
    conflictsAt(ctx, reads, { ...range, kind: "booking" }),
    (conflicts) =>
      conflicts.length > 0
        ? Effect.fail<SlotConflict>({ _tag: "SlotConflict", conflicts })
        : Effect.void
  );
}
