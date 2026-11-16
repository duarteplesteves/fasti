import { Effect } from "effect";

import { toCoreBooking } from "../adapter/records.js";
import type { ResourceIdOf, StatusOf } from "../adapter/records.js";
import type { Booking, BookingId } from "../core/types.js";
import type { AnySchema } from "../schema/define-schema.js";
import type { StatusCodec } from "../schema/status-codec.js";
import type { EffectReads } from "./effect-adapter.js";
import type { AdapterError, Conflict } from "./errors.js";

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
