import { Effect } from "effect";

import { toCoreBooking } from "../adapter/records.js";
import type { ResourceIdOf, StatusOf } from "../adapter/records.js";
import { detectConflicts } from "../core/detect-conflicts.js";
import type { DetectConflictsParams } from "../core/detect-conflicts.js";
import type { BlockId, Booking, BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";
import type { EffectReads } from "./effect-adapter.js";
import { AdapterError } from "./errors.js";
import type { Conflict, SlotConflict } from "./errors.js";

/** What occupies a Resource over a range, as the Core sees it, plus each occupant's kind for mapping hits back. */
interface Occupants {
  readonly bookings: readonly Booking<BookingId | BlockId>[];
  readonly kindById: ReadonlyMap<string, Conflict["kind"]>;
}

/**
 * Everything occupying `resourceId` over the half-open `[from, to)` for a candidate of kind `candidate`: the one place occupants enter the Core.
 * A Block candidate doesn't see Blocks, since Blocks may overlap each other (ADR 016). Internal.
 */
export function occupants<S extends AnySchema>(
  reads: Pick<EffectReads<S>, "listBookings" | "listBlocks">,
  codec: StatusCodec<StatusOf<S>>,
  candidate: Conflict["kind"],
  resourceId: ResourceIdOf<S>,
  overlapping: {
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
  }
): Effect.Effect<Occupants, AdapterError> {
  const query = { overlapping, resourceId };

  return Effect.map(
    Effect.all([
      reads.listBookings(query),
      candidate === "booking" ? reads.listBlocks(query) : Effect.succeed([]),
    ]),
    ([bookings, blocks]) => ({
      bookings: [
        ...bookings.map((b) => toCoreBooking(codec, b)),
        ...blocks.map(({ end, id, start }) => ({
          end,
          id,
          isBlocking: true,
          resourceId: String(resourceId),
          start,
        })),
      ],
      kindById: new Map<string, Conflict["kind"]>([
        ...bookings.map((b) => [b.id, "booking"] as const),
        ...blocks.map((b) => [b.id, "block"] as const),
      ]),
    })
  );
}

/** The Core's hits as Conflicts, sorted by start, then id. Ids, kinds and times only: no Developer Fields. */
export function toConflicts(
  hits: readonly Booking<BookingId | BlockId>[],
  kindById: ReadonlyMap<string, Conflict["kind"]>
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
export function conflictsAt<S extends AnySchema>(
  reads: Pick<EffectReads<S>, "listBookings" | "listBlocks">,
  codec: StatusCodec<StatusOf<S>>,
  {
    end,
    excludeBookingId,
    kind,
    resourceId,
    start,
  }: {
    readonly kind: Conflict["kind"];
    readonly resourceId: ResourceIdOf<S>;
    readonly start: Temporal.Instant;
    readonly end: Temporal.Instant;
    /** Leave this Booking out, e.g. the one being moved; `null` for none. */
    readonly excludeBookingId: BookingId | null;
  }
): Effect.Effect<readonly Conflict[], AdapterError> {
  return Effect.flatMap(
    occupants(reads, codec, kind, resourceId, { from: start, to: end }),
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
export function checkOverlap<S extends AnySchema>(
  reads: Pick<EffectReads<S>, "listBookings" | "listBlocks">,
  codec: StatusCodec<StatusOf<S>>,
  range: CheckOverlapParams<S>
): Effect.Effect<void, SlotConflict | AdapterError> {
  return Effect.flatMap(
    conflictsAt(reads, codec, { ...range, kind: "booking" }),
    (conflicts) =>
      conflicts.length > 0
        ? Effect.fail<SlotConflict>({ _tag: "SlotConflict", conflicts })
        : Effect.void
  );
}
