/**
 * A PLAYER LINK is an invitation that is not addressed to a person: whoever opens it first signs in (with any email) and
 * becomes the player's own login for the academy. It reuses the invitation table exactly as it is (no migration): the kind
 * is the existing player kind, and the one column that has to hold an address holds a generated, non-deliverable one that
 * also carries the batch the staff member chose when they made the link. Nothing is ever sent to it.
 *
 *   player-link.<batch id, hex>.<random, hex>@links.invalid
 *
 * `.invalid` is reserved (RFC 2606): it can never receive mail and never equals a real account's email, so the normal
 * "addressed to this account" check cannot be satisfied by accident, and accepting is the one place that treats it specially.
 */
export const PLAYER_LINK_DOMAIN = "links.invalid";
export const PLAYER_LINK_DEFAULT_DAYS = 3;
/** The longest a player link may stay open. */
export const PLAYER_LINK_MAX_DAYS = 7;
/** Longest batch id the address can carry inside the table's 254 character limit. */
export const PLAYER_LINK_MAX_BATCH_ID = 90;
const PATTERN = /^player-link\.([0-9a-f]{2,180})\.([0-9a-f]{32})@links\.invalid$/;

export function playerLinkAddress(batchId: string, nonce: string): string {
  if (!batchId || batchId.length > PLAYER_LINK_MAX_BATCH_ID || !/^[0-9a-f]{32}$/.test(nonce)) throw new Error("Invalid player link parts.");
  return `player-link.${Buffer.from(batchId, "utf8").toString("hex")}.${nonce}@${PLAYER_LINK_DOMAIN}`;
}
/** The batch a player link was made for, or null when this address is not a player link. */
export function parsePlayerLinkAddress(email: string): { batchId: string } | null {
  const m = PATTERN.exec(email);
  if (!m || m[1].length % 2 !== 0) return null;
  const batchId = Buffer.from(m[1], "hex").toString("utf8");
  return batchId ? { batchId } : null;
}
export const isPlayerLinkAddress = (email: string) => parsePlayerLinkAddress(email) !== null;
