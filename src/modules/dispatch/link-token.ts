import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A report link is `<link id>.<mac>`. The mac is an HMAC of the link id with the server secret, so a link cannot be made up or
 * altered, and nothing secret has to be stored: the database holds only the link id, its expiry and whether it was revoked.
 * The token travels in the URL FRAGMENT (never sent to a server in a request line, so it reaches no access log or Referer) and
 * in request bodies. Possessing a link is not enough to read a report: opening it also requires a signed-in account that is
 * actually linked to that player as a parent (see report-links.ts).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mac = (secret: string, id: string) => createHmac("sha256", secret).update(`report-link|${id}`).digest("base64url");

export const makeLinkToken = (secret: string, linkId: string) => `${linkId}.${mac(secret, linkId)}`;
/** The link id inside a valid token, or null for anything that is not exactly a token this server made. */
export function readLinkToken(secret: string, token: unknown): string | null {
  if (typeof token !== "string" || token.length > 120) return null;
  const [id, given, ...rest] = token.split(".");
  if (rest.length || !id || !given || !UUID.test(id)) return null;
  const expected = Buffer.from(mac(secret, id));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? id.toLowerCase() : null;
}
export const reportLinkUrl = (baseUrl: string, token: string) => `${baseUrl.replace(/\/+$/, "")}/report-link#${token}`;
export const LINK_VALID_DAYS = 30;
