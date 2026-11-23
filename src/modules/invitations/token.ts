import { createHmac, randomBytes } from "node:crypto";
/**
 * Invitation tokens: 256 random bits, shown ONCE to the person who creates the invitation and never stored. The database
 * holds only a keyed hash (HMAC-SHA-256 under a key derived from BETTER_AUTH_SECRET), so a copy of the table cannot be
 * used to accept anything, and a token cannot be recomputed from an address, a person or an academy.
 */
export const newInvitationToken = () => randomBytes(32).toString("base64url");
export const hashInvitationToken = (token: string, secret: string) =>
  createHmac("sha256", createHmac("sha256", secret).update("sportozen/invitation/v1").digest()).update(token).digest("hex");
/** Tokens are exactly 43 base64url characters; anything else is refused before it touches the database. */
export const looksLikeInvitationToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
/** "j***@example.com": enough for the recipient to recognise the address the invitation was sent to. */
export function maskEmail(email: string) {
  const [local, domain = ""] = email.split("@");
  return `${local.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}
