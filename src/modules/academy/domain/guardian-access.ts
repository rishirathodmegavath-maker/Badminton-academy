/**
 * RC-4: the seven sections of an ADULT player's record that the adult may open to a guardian (decision D5, TD-4).
 *
 * Pure: no database, no request. The adult player alone grants, changes and revokes them, per guardian. Consent is
 * deliberately NOT a scope and must never become one: an adult cannot delegate consent.
 *
 *   SCHEDULE   training sessions, attendance, calendar events
 *   REPORTS    published reports and their PDF
 *   NUTRITION  shared nutrition plans
 *   HEALTH     allergies and restrictions, private nutrition questions
 *   FEES       invoices, payments, receipts, credits, paying
 *   MEDIA      shared photos and videos
 *   MESSAGES   portal messages, deliveries, conversations with staff
 */
export const GUARDIAN_ACCESS_SCOPES = [
  "SCHEDULE",
  "REPORTS",
  "NUTRITION",
  "HEALTH",
  "FEES",
  "MEDIA",
  "MESSAGES",
] as const;
export type GuardianAccessScope = (typeof GUARDIAN_ACCESS_SCOPES)[number];

/** Every event the append-only guardian_access_event history may hold (CHECK constraint in migration 0014). */
export const GUARDIAN_ACCESS_EVENTS = [
  "ACCESS_ENDED_ADULTHOOD",
  "GRANTED",
  "SCOPES_CHANGED",
  "REVOKED",
  "ENDED_LINK_INACTIVE",
  "ENDED_ADULT_FLAG_CLEARED",
] as const;
export type GuardianAccessEvent = (typeof GUARDIAN_ACCESS_EVENTS)[number];

const KNOWN: ReadonlySet<string> = new Set(GUARDIAN_ACCESS_SCOPES);
const NOTHING: ReadonlySet<GuardianAccessScope> = Object.freeze(new Set<GuardianAccessScope>());
/** What a guardian of a minor, and the adult themself, hold: every section. */
export const EVERY_SCOPE: ReadonlySet<GuardianAccessScope> = Object.freeze(
  new Set<GuardianAccessScope>(GUARDIAN_ACCESS_SCOPES),
);

/**
 * The scopes a stored value stands for. Fail-closed: anything that is not an array made only of known scope
 * names, each at most once, stands for NOTHING. A partly readable value is never partly honoured.
 */
export function storedScopes(value: unknown): ReadonlySet<GuardianAccessScope> {
  if (!Array.isArray(value)) return NOTHING;
  const seen = new Set<GuardianAccessScope>();
  for (const item of value) {
    if (typeof item !== "string" || !KNOWN.has(item) || seen.has(item as GuardianAccessScope)) return NOTHING;
    seen.add(item as GuardianAccessScope);
  }
  return seen;
}

/** Canonical order for storage, comparison and display. */
export function orderedScopes(scopes: Iterable<GuardianAccessScope>): GuardianAccessScope[] {
  const set = new Set(scopes);
  return GUARDIAN_ACCESS_SCOPES.filter((s) => set.has(s));
}

/**
 * Whether a stored profile hands the record to the player themself. Fail-closed for guardians: a profile whose
 * `adult` flag is anything other than the boolean false, or that names an own account, is adult-controlled, so a
 * malformed or inconsistent profile narrows guardian access and never widens it. No profile row at all is a minor
 * (the state of a player created before profiles existed), exactly as before RC-4.
 */
export function adultControlled(profile: { adult?: unknown; selfUserId?: unknown } | null | undefined): boolean {
  if (!profile) return false;
  return profile.adult !== false || (profile.selfUserId !== null && profile.selfUserId !== undefined && profile.selfUserId !== "");
}
