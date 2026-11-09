/**
 * PROTOTYPE: throwaway. Lives on branch `prototype/framework-instance` only.
 *
 * Question: what does creating and calling a Framework instance feel like?
 * Plain (non-Effect) surface only. Run the demo with `bun run prototype:scheduler`.
 *
 * Choices to react to (each is marked `CHOICE` below):
 *  1. Config is `{ adapter }` and nothing else (no plugins, no defaults yet).
 *  2. Actions are flat verbs on the instance (`scheduler.book`), not namespaced
 *     (`scheduler.bookings.create`) and not under `scheduler.api`.
 *  3. Every Action takes one object param, like the Core.
 *  4. Availability rules are stored through the Adapter; `setAvailability`
 *     replaces a Resource's rules. Callers never pass rules into `findSlots`.
 *  5. `book` accepts Instant or ZonedDateTime, so `book(slot)` works directly.
 *  6. `book` enforces availability (not just "no overlap") inside the per-Resource lock.
 *  7. Failures throw real `Error` subclasses (`SlotUnavailableError` with a `reason`),
 *     not a result union.
 *  8. `reschedule` moves the same booking (same id), ignoring itself in the conflict check.
 *  9. `cancel` is idempotent and only flips `isBlocking`/`status`; the lifecycle is a
 *     placeholder (`confirmed` | `cancelled`) until the lifecycle ticket decides it.
 * 10. Bookings carry no developer fields yet (customer id etc.); that waits on the
 *     schema-ownership ticket.
 *
 * NOT the Adapter contract: `PrototypeAdapter` is the least needed to make this run.
 */

import { detectConflicts } from "../core/detect-conflicts.js";
import { findFreeSlots } from "../core/find-free-slots.js";
import { isSlotValid } from "../core/is-slot-valid.js";
import type { AvailabilityRule, Booking, Slot } from "../core/types.js";

// ─── Public types ──────────────────────────────────────────────────────────

/** A rule as the developer writes it: `resourceId` comes from the Action. */
export type RuleInput = Omit<AvailabilityRule, "resourceId">;

/** CHOICE 9: placeholder lifecycle. */
export type BookingStatus = "confirmed" | "cancelled";

export interface StoredBooking extends Booking {
  status: BookingStatus;
  createdAt: Temporal.Instant;
}

/** CHOICE 5: either an absolute instant or a zoned time (e.g. from a Slot). */
export type TimeInput = Temporal.Instant | Temporal.ZonedDateTime;

export interface SchedulerConfig {
  /** CHOICE 1: the only key. */
  adapter: PrototypeAdapter;
}

// ─── Errors (CHOICE 7) ─────────────────────────────────────────────────────

export class SlotUnavailableError extends Error {
  readonly _tag = "SlotUnavailableError";
  readonly reason: "conflict" | "outside-availability";
  readonly conflicts: readonly StoredBooking[];

  constructor(
    reason: "conflict" | "outside-availability",
    conflicts: readonly StoredBooking[] = []
  ) {
    super(
      reason === "conflict"
        ? `Slot overlaps ${conflicts.length} blocking booking(s).`
        : "Slot is outside the Resource's availability."
    );
    this.name = "SlotUnavailableError";
    this.reason = reason;
    this.conflicts = conflicts;
  }
}

export class BookingNotFoundError extends Error {
  readonly _tag = "BookingNotFoundError";
  readonly bookingId: string;

  constructor(bookingId: string) {
    super(`Booking '${bookingId}' not found.`);
    this.name = "BookingNotFoundError";
    this.bookingId = bookingId;
  }
}

// ─── Action params (co-located) ────────────────────────────────────────────

export interface SetAvailabilityParams {
  resourceId: string;
  rules: RuleInput[];
}

export interface FindSlotsParams {
  resourceId: string;
  /** Minutes. */
  duration: number;
  from: Temporal.Instant;
  to: Temporal.Instant;
  /** Minutes; defaults to `duration`. */
  interval?: number;
}

export interface BookParams {
  resourceId: string;
  start: TimeInput;
  end: TimeInput;
}

export interface CancelParams {
  bookingId: string;
}

export interface RescheduleParams {
  bookingId: string;
  start: TimeInput;
  end: TimeInput;
}

export interface ListBookingsParams {
  resourceId: string;
  from?: Temporal.Instant;
  to?: Temporal.Instant;
  /** Defaults to false: cancelled bookings are hidden. */
  includeCancelled?: boolean;
}

// ─── createScheduler ───────────────────────────────────────────────────────

const toInstant = (t: TimeInput): Temporal.Instant =>
  t instanceof Temporal.ZonedDateTime ? t.toInstant() : t;

export function createScheduler(config: SchedulerConfig) {
  const { adapter } = config;

  /** Check + write for one Resource, always under its lock (research: double-booking). */
  async function assertBookable(
    resourceId: string,
    start: Temporal.Instant,
    end: Temporal.Instant,
    ignoreBookingId?: string
  ) {
    const rules = await adapter.getRules(resourceId);

    const existing = (await adapter.findBookings({ resourceId })).filter(
      (b) => b.id !== ignoreBookingId
    );

    const conflicts = detectConflicts({
      bookings: existing,
      candidate: { end, start },
      resourceId,
    }) as StoredBooking[];

    if (conflicts.length > 0) {
      throw new SlotUnavailableError("conflict", conflicts);
    }

    if (
      !isSlotValid({ bookings: [], resourceId, rules, slot: { end, start } })
    ) {
      throw new SlotUnavailableError("outside-availability");
    }
  }

  return {
    // CHOICE 2: flat verbs.

    async setAvailability({ resourceId, rules }: SetAvailabilityParams) {
      const full = rules.map((r) => ({ ...r, resourceId }));
      // Validate through the Core before storing (it throws on bad rules).
      findFreeSlots({
        bookings: [],
        duration: 1,
        from: Temporal.Instant.from("2000-01-01T00:00:00Z"),
        resourceId,
        rules: full,
        to: Temporal.Instant.from("2000-01-01T00:01:00Z"),
      });
      await adapter.setRules(resourceId, full);
    },

    async getAvailability({ resourceId }: { resourceId: string }) {
      return adapter.getRules(resourceId);
    },

    async findSlots(params: FindSlotsParams): Promise<Slot[]> {
      const [rules, bookings] = await Promise.all([
        adapter.getRules(params.resourceId),
        adapter.findBookings({ resourceId: params.resourceId }),
      ]);

      return findFreeSlots({
        bookings,
        duration: params.duration,
        from: params.from,
        resourceId: params.resourceId,
        rules,
        to: params.to,
        ...(params.interval === undefined
          ? {}
          : { options: { interval: params.interval } }),
      });
    },

    async book(params: BookParams): Promise<StoredBooking> {
      const start = toInstant(params.start);
      const end = toInstant(params.end);

      return adapter.withResourceLock(params.resourceId, async () => {
        await assertBookable(params.resourceId, start, end);

        const booking: StoredBooking = {
          createdAt: Temporal.Now.instant(),
          end,
          id: crypto.randomUUID().slice(0, 8),
          isBlocking: true,
          resourceId: params.resourceId,
          start,
          status: "confirmed",
        };

        await adapter.insertBooking(booking);

        return booking;
      });
    },

    async cancel({ bookingId }: CancelParams): Promise<StoredBooking> {
      const found = await adapter.findBookingById(bookingId);

      if (!found) {
        throw new BookingNotFoundError(bookingId);
      }

      if (found.status === "cancelled") {
        return found; // CHOICE 9: idempotent
      }

      return adapter.updateBooking(bookingId, {
        isBlocking: false,
        status: "cancelled",
      });
    },

    async reschedule(params: RescheduleParams): Promise<StoredBooking> {
      const found = await adapter.findBookingById(params.bookingId);

      if (!found) {
        throw new BookingNotFoundError(params.bookingId);
      }

      const start = toInstant(params.start);
      const end = toInstant(params.end);

      return adapter.withResourceLock(found.resourceId, async () => {
        await assertBookable(found.resourceId, start, end, found.id); // CHOICE 8

        return adapter.updateBooking(found.id, { end, start });
      });
    },

    async getBooking({ bookingId }: { bookingId: string }) {
      return (await adapter.findBookingById(bookingId)) ?? null;
    },

    async listBookings(params: ListBookingsParams) {
      const all = await adapter.findBookings({ resourceId: params.resourceId });

      return all.filter(
        (b) =>
          (params.includeCancelled || b.status !== "cancelled") &&
          (!params.from || Temporal.Instant.compare(b.end, params.from) > 0) &&
          (!params.to || Temporal.Instant.compare(b.start, params.to) < 0)
      );
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;

// ─── Placeholder Adapter (NOT the contract) ────────────────────────────────

export interface PrototypeAdapter {
  /** Run `fn` while holding a per-Resource lock (one transaction, in a real DB). */
  withResourceLock<T>(resourceId: string, fn: () => Promise<T>): Promise<T>;
  getRules(resourceId: string): Promise<AvailabilityRule[]>;
  setRules(resourceId: string, rules: AvailabilityRule[]): Promise<void>;
  findBookings(q: { resourceId: string }): Promise<StoredBooking[]>;
  findBookingById(id: string): Promise<StoredBooking | undefined>;
  insertBooking(b: StoredBooking): Promise<void>;
  updateBooking(
    id: string,
    patch: Partial<StoredBooking>
  ): Promise<StoredBooking>;
}

/** In-memory Adapter. Reads are artificially slow so unlocked races would really happen. */
export function memoryAdapter(opts: { lock?: boolean } = {}) {
  const useLock = opts.lock ?? true;
  const rules = new Map<string, AvailabilityRule[]>();
  const bookings = new Map<string, StoredBooking>();
  const locks = new Map<string, Promise<unknown>>();
  const tick = () => new Promise((r) => setTimeout(r, 5));

  const adapter: PrototypeAdapter & {
    snapshot(): { rules: AvailabilityRule[]; bookings: StoredBooking[] };
  } = {
    async findBookingById(id) {
      return bookings.get(id);
    },
    async findBookings({ resourceId }) {
      // Read first, return late: like a real DB round-trip, the result can be stale.
      const rows = [...bookings.values()].filter(
        (b) => b.resourceId === resourceId
      );

      await tick();

      return rows;
    },
    async getRules(resourceId) {
      return rules.get(resourceId) ?? [];
    },
    async insertBooking(b) {
      bookings.set(b.id, b);
    },
    async setRules(resourceId, r) {
      rules.set(resourceId, r);
    },
    snapshot() {
      return {
        bookings: [...bookings.values()],
        rules: [...rules.values()].flat(),
      };
    },
    async updateBooking(id, patch) {
      const next = { ...bookings.get(id)!, ...patch };
      bookings.set(id, next);

      return next;
    },
    async withResourceLock(resourceId, fn) {
      if (!useLock) {
        return fn();
      }

      const prev = locks.get(resourceId) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      locks.set(
        resourceId,
        run.catch(() => {})
      );

      return run;
    },
  };

  return adapter;
}
