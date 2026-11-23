import {
  GUARDIAN_ACCESS_SCOPES,
  orderedScopes,
  type GuardianAccessScope,
} from "../domain/guardian-access";
import { accountLabel } from "./navigation";
/**
 * RC-5: the pure rules behind the adult player's guardian-access screen (no request, no React).
 *
 * Everything here is PRESENTATION of the RC-4 endpoint contract (`GET /api/academy/guardian-access`,
 * `POST /api/academy/guardian-access/save`, RC4_ENDPOINT_CONTRACTS.md). Who may grant, which guardian is eligible,
 * what a grant gives and whether a version is current are decided by the server on every request; nothing in this
 * file decides authority, and hiding a control here is never what protects data.
 *
 * There is NO time-based expiry: the states are exactly `none`, `active`, `revoked` and `void`. Consent is not a
 * scope and is never offered.
 */
export type GrantState = "none" | "active" | "revoked" | "void";
export type HistoryEntry = {
  id: string;
  guardianUserId: string;
  event: string;
  scopes: string[] | null;
  byPlayer: boolean;
  actorRole: string | null;
  at: string;
};
export type GuardianRow = {
  userId: string;
  name: string;
  relationship: string;
  eligible: boolean;
  state: GrantState;
  scopes: string[];
  version: number;
  grantedAt: string | null;
  revokedAt: string | null;
  lastEvent: HistoryEntry | null;
};
export type PlayerAccess = {
  playerId: string;
  name: string;
  guardians: GuardianRow[];
  history: HistoryEntry[];
};
export type GuardianAccessView = { scopes: string[]; manage: boolean; players: PlayerAccess[] };

/** The seven sections, in the contract's order, each with plain-language wording. */
export const SCOPE_INFO: Readonly<Record<GuardianAccessScope, { label: string; detail: string }>> = Object.freeze({
  SCHEDULE: { label: "Schedule", detail: "Training sessions, attendance and calendar events" },
  REPORTS: { label: "Reports", detail: "Published progress reports and their PDFs" },
  NUTRITION: { label: "Nutrition", detail: "Shared nutrition plans" },
  HEALTH: { label: "Health", detail: "Allergies, restrictions and private nutrition questions" },
  FEES: { label: "Fees", detail: "Invoices, payments, receipts and credits" },
  MEDIA: { label: "Media", detail: "Shared photos and videos" },
  MESSAGES: { label: "Messages", detail: "Portal messages and conversations with the academy" },
});

/**
 * Keeps only the seven known sections, once each, in canonical order. Anything else (including a value that is not
 * an array, or a name such as CONSENT) is dropped: the screen can only ever show or send a real section.
 */
export function knownScopes(value: unknown): GuardianAccessScope[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(GUARDIAN_ACCESS_SCOPES);
  return orderedScopes(value.filter((v): v is GuardianAccessScope => typeof v === "string" && known.has(v)));
}

export const sameScopes = (a: unknown, b: unknown) => knownScopes(a).join() === knownScopes(b).join();

/** `void` is worded like `none` (RC4_ENDPOINT_CONTRACTS section 8); an unrecognised state is also "no access". */
export function stateLabel(state: unknown): string {
  if (state === "active") return "Active";
  if (state === "revoked") return "Revoked";
  return "No access";
}

export type Plan = {
  /** The primary button, or null when there is nothing to save. `scopes` is what would be sent. */
  save: null | { label: "Grant access" | "Save changes"; scopes: GuardianAccessScope[] };
  /** Revoking closes an `active` grant, or a `void` one; sent as an empty list. */
  revoke: boolean;
  /** Why granting is unavailable, when it is. */
  note: string | null;
};

/**
 * What the buttons on one guardian's card do, from the state the server reported and the sections the adult has
 * ticked. The server re-decides every one of these requests (eligibility, ownership, version).
 */
export function plan(g: Pick<GuardianRow, "state" | "eligible" | "scopes">, draft: unknown): Plan {
  const wanted = knownScopes(draft);
  const stored = knownScopes(g.scopes);
  const open = g.state === "active" || g.state === "void";
  const revoke = open;
  if (!g.eligible)
    return {
      save: null,
      revoke,
      note: "This guardian’s link to you is no longer active, so access cannot be granted. Contact the academy to restore it.",
    };
  if (g.state === "active") {
    const changed = wanted.length > 0 && !sameScopes(wanted, stored);
    return { save: changed ? { label: "Save changes", scopes: wanted } : null, revoke, note: null };
  }
  // none, revoked, void (and anything unrecognised): a new grant.
  return { save: wanted.length > 0 ? { label: "Grant access", scopes: wanted } : null, revoke, note: null };
}

const EVENT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  GRANTED: "Access granted",
  SCOPES_CHANGED: "Sections changed",
  REVOKED: "Access revoked",
  ENDED_LINK_INACTIVE: "Access ended: the academy deactivated this guardian’s link",
  ENDED_ADULT_FLAG_CLEARED: "Access ended: the academy cleared your adult status",
  ACCESS_ENDED_ADULTHOOD: "Guardian access ended when your adult status was recorded",
});
export const eventLabel = (event: string) => EVENT_TEXT[event] ?? "Access updated";

export const scopeSummary = (scopes: unknown) => {
  const known = knownScopes(scopes);
  return known.length ? known.map((s) => SCOPE_INFO[s].label).join(", ") : "";
};

/** Who made an entry: the adult themself, or the academy (named only by account type and designation). */
export const actorText = (e: Pick<HistoryEntry, "byPlayer" | "actorRole">) =>
  e.byPlayer ? "You" : e.actorRole ? `The academy (${accountLabel(e.actorRole)})` : "The academy";
