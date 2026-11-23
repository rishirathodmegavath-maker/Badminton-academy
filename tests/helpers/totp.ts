import { createHmac } from "node:crypto";
/**
 * An independent RFC 6238 / RFC 4226 implementation for tests, so the authenticator codes the
 * tests present come from code that shares nothing with the application. Verified against the
 * RFC 6238 appendix vectors in tests/mfa-primitives.test.ts.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Decode(input: string) {
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error("Not base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function hotp(key: Buffer, counter: number, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(message).digest();
  const offset = mac[mac.length - 1] & 15;
  const binary =
    ((mac[offset] & 127) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}
/** The code for the 30-second step that is `stepOffset` steps away from now. */
export function totpAt(
  key: Buffer,
  stepOffset = 0,
  options: { now?: number; period?: number; digits?: number } = {},
) {
  const period = options.period ?? 30;
  const counter =
    Math.floor((options.now ?? Date.now()) / 1000 / period) + stepOffset;
  return hotp(key, counter, options.digits ?? 6);
}
export type ProvisioningUri = {
  secret: Buffer;
  issuer: string;
  account: string;
  digits: number;
  period: number;
  raw: string;
};
export function parseProvisioningUri(uri: string): ProvisioningUri {
  const url = new URL(uri);
  if (url.protocol !== "otpauth:" || url.hostname !== "totp")
    throw new Error("Not an otpauth://totp URI.");
  const secret = url.searchParams.get("secret");
  if (!secret) throw new Error("URI has no secret.");
  return {
    secret: base32Decode(secret),
    issuer: url.searchParams.get("issuer") ?? "",
    account: decodeURIComponent(url.pathname.slice(1)),
    digits: Number(url.searchParams.get("digits") ?? 6),
    period: Number(url.searchParams.get("period") ?? 30),
    raw: uri,
  };
}
