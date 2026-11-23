import type { BookingId } from "../core/types.js";

/**
 * A new UUIDv7 (RFC 9562): 48-bit Unix ms, version 7, variant 10, the rest random from Web Crypto.
 *
 * @returns The UUID in its canonical lowercase, hyphenated form.
 */
export function uuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer);
  const ms = Date.now();

  view.setUint16(0, Math.floor(ms / 2 ** 32));
  view.setUint32(2, ms % 2 ** 32);
  // Version 7 in the high nibble of byte 6, variant 10 in the top bits of byte 8.
  view.setUint8(6, 0x70 + (view.getUint8(6) % 0x10));
  view.setUint8(8, 0x80 + (view.getUint8(8) % 0x40));

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    ""
  );

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A new Booking id: a UUIDv7.
 *
 * @returns The new id.
 */
export function mintBookingId(): BookingId {
  // SAFETY: a freshly minted UUIDv7 is exactly what a BookingId is.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- brands are applied by assertion.
  return uuidV7() as BookingId;
}
