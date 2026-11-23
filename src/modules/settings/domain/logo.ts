/**
 * The academy logo: one small PNG, kept with the academy's settings and checked on the SERVER (the browser's own checks are
 * only a convenience). Nothing else is accepted: no JPG, no SVG (an SVG can carry script), no animated or oversized image.
 *
 *  - a PNG data URL ("data:image/png;base64,...") whose bytes really start with the PNG signature
 *  - at most 200 000 bytes once decoded
 *  - between 16 and 2048 pixels on each side, read from the PNG header, so a tiny file cannot unpack into a huge picture
 */
export const LOGO_MAX_BYTES = 200_000;
export const LOGO_MIN_SIDE = 16;
export const LOGO_MAX_SIDE = 2048;
export const LOGO_MAX_DATA_URL = 300_000;
const PREFIX = "data:image/png;base64,";
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type LogoCheck = { ok: true; bytes: Uint8Array; width: number; height: number } | { ok: false; message: string };

export function checkLogo(value: unknown): LogoCheck {
  const refuse = (message: string): LogoCheck => ({ ok: false, message });
  if (typeof value !== "string" || !value.startsWith(PREFIX) || value.length > LOGO_MAX_DATA_URL)
    return refuse("Choose a PNG logo under 200 KB. JPG is not supported.");
  const encoded = value.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return refuse("This file is not a supported PNG logo.");
  const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
  if (bytes.length > LOGO_MAX_BYTES) return refuse("The logo is larger than 200 KB. Choose a smaller PNG.");
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) return refuse("This file is not a supported PNG logo.");
  // The first chunk of every PNG is IHDR: length(4) "IHDR"(4) width(4) height(4) ...
  const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (type !== "IHDR") return refuse("This file is not a supported PNG logo.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < LOGO_MIN_SIDE || height < LOGO_MIN_SIDE)
    return refuse(`The logo is too small. Use at least ${LOGO_MIN_SIDE} × ${LOGO_MIN_SIDE} pixels (512 × 512 is recommended).`);
  if (width > LOGO_MAX_SIDE || height > LOGO_MAX_SIDE)
    return refuse(`The logo is too large. Use at most ${LOGO_MAX_SIDE} × ${LOGO_MAX_SIDE} pixels (512 × 512 is recommended).`);
  return { ok: true, bytes, width, height };
}

/**
 * Settings as the browser receives them: the logo itself is never inside (it would be sent again with every page load).
 * The screen shows it through GET /api/academy/logo and only needs to know that one exists.
 */
export function publicSettings<S extends { data: object }>(
  settings: S,
): Omit<S, "data"> & { data: Omit<S["data"], "logoData"> & { hasLogo: boolean } } {
  const { logoData, ...rest } = settings.data as { logoData?: string };
  return { ...settings, data: { ...rest, hasLogo: !!logoData } } as Omit<S, "data"> & {
    data: Omit<S["data"], "logoData"> & { hasLogo: boolean };
  };
}
