import { Effect } from "effect";

import { toCoreBooking } from "../adapter/records.js";
import type { ResourceIdOf, StatusOf } from "../adapter/records.js";
import { detectConflicts } from "../core/detect-conflicts.js";
import type { Booking, BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";
import type { EffectReads } from "./effect-adapter.js";
import { AdapterError } from "./errors.js";
import type { Conflict } from "./errors.js";

/** What occupies a Resource over a range, as the Core sees it, plus each occupant's kind for mapping hits back. */
interface Occupants {
  readonly bookings: readonly Booking<BookingId>[];
  readonly kindById: ReadonlyMap<string, Conflict["kind"]>;
}

/** Everything occupying `resourceId` over the half-open `[from, to)`: the one place occupants enter the Core. Internal. */
export function occupants<S extends AnySchema>(
  reads: Pick<EffectReads<S>, "listBookings">,
  codec: StatusCodec<StatusOf<S>>,
  resourceId: ResourceIdOf<S>,
  overlapping: {
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
  }
): Effect.Effect<Occupants, AdapterError> {
  return Effect.map(
    reads.listBookings({ overlapping, resourceId }),
    (bookings) => ({
      bookings: bookings.map((b) => toCoreBooking(codec, b)),
      kindById: new Map(bookings.map((b) => [b.id, "booking"] as const)),
    })
  );
}

/** The Core's hits as Conflicts, sorted by start, then id. Ids, kinds and times only: no Developer Fields. */
export function toConflicts(
  hits: readonly Booking<BookingId>[],
  kindById: ReadonlyMap<string, Conflict["kind"]>
): readonly Conflict[] {
  return hits
    .map(({ end, id, start }) => {
      const kind = kindById.get(id);

      // Every hit came from `occupants`, which tagged it: a miss is a defect.
      if (kind === undefined) {
        throw new Error(`fasti: occupant ${id} has no kind`);
      }

      return { end, id, kind, start };
    })
    .toSorted(
      (a, b) =>
        Temporal.Instant.compare(a.start, b.start) ||
        (a.id < b.id ? -1 : Number(a.id > b.id))
    );
}

/**
 * What a candidate `[start, end)` on `resourceId` would overlap, as Conflicts: the overlap Invariant's one check (ADR 014, ADR 016).
 * Blocking Bookings only, for now; when Blocks occupy time (#86) it takes the candidate's kind, since a Block never conflicts with a Block.
 */
export function conflictsAt<S extends AnySchema>(
  reads: Pick<EffectReads<S>, "listBookings">,
  codec: StatusCodec<StatusOf<S>>,
  {
    end,
    resourceId,
    start,
  }: {
    readonly resourceId: ResourceIdOf<S>;
    readonly start: Temporal.Instant;
    readonly end: Temporal.Instant;
  }
): Effect.Effect<readonly Conflict[], AdapterError> {
  return Effect.flatMap(
    occupants(reads, codec, resourceId, { from: start, to: end }),
    ({ bookings, kindById }) => {
      const r = detectConflicts({
        bookings,
        candidate: { end, start },
        resourceId: String(resourceId),
      });

      // Callers check the params up front, so only invalid stored data fails here (Invariant 6).
      return r.ok
        ? Effect.succeed(toConflicts(r.value, kindById))
        : Effect.fail(new AdapterError(r.error));
    }
  );
}
