import { describe, expect, it } from "vitest";

import type { AnySchema } from "../schema/define-schema.js";
import { statusCodec } from "../schema/status-codec.js";
import { uuidIdSchema } from "../test-utils/conformance-schemas.js";
import { decodeBooking } from "./codec.js";

describe(decodeBooking, () => {
  it("rejects a stored Status the schema doesn't know", () => {
    expect(() =>
      decodeBooking(
        statusCodec<AnySchema>(uuidIdSchema),
        uuidIdSchema.names.columns.booking,
        {
          u_booking_id: "0193b6e2-7c00-7000-8000-0000000000aa",
          u_ends_at: Temporal.Instant.from("2030-06-03T10:00:00Z"),
          u_room_id: "0193b6e2-7c00-7000-8000-000000000001",
          u_starts_at: Temporal.Instant.from("2030-06-03T09:00:00Z"),
          u_state: "U_UNKNOWN",
        }
      )
    ).toThrow('prismaAdapter: stored Status "U_UNKNOWN" is not in the schema');
  });
});
