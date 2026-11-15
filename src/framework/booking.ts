import type { BookingRecord } from "../adapter/records.js";
import type { AnySchema } from "../schema/define-schema.js";

/** A Booking as an Action returns it: flat, Developer Fields included. */
export type Booking<S extends AnySchema> = BookingRecord<S>;
