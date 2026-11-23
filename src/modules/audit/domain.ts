/**
 * Phase 7: the vocabulary of the sensitive-data access history. Pure (no server imports) so the
 * recorder, the investigation API, the Settings screen and the tests share one definition.
 *
 * An access event says WHO looked at WHICH KIND of sensitive information, WHEN, through WHAT, and
 * whether it was allowed. It never holds the information itself.
 */
import { rolesWith } from "../identity/authority";
export const ACCESS_CATEGORIES = [
  "WORKSPACE",
  "CONSENT",
  "REPORT",
  "NUTRITION",
  "MEDIA",
  "FINANCE",
  "ACCOUNT_SECURITY",
  "AUDIT_LOG",
  "TRAINING",
  "PRIVACY",
] as const;
export type AccessCategory = (typeof ACCESS_CATEGORIES)[number];
/**
 * VIEW      one record's data (for example a player's consent history)
 * LIST      several records, shown to a family member (their own children) or a narrow staff list
 * BULK      a staff-wide payload or report (many players at once)
 * DOWNLOAD  file bytes (private media)
 * PDF       a generated document (report, receipt)
 * HISTORICAL  withdrawn or superseded content opened by authorised staff
 * THROTTLED marker: further denials by this person were not stored individually for a while
 */
export const ACCESS_OPERATIONS = [
  "VIEW",
  "LIST",
  "BULK",
  "DOWNLOAD",
  "PDF",
  "HISTORICAL",
  "THROTTLED",
] as const;
export type AccessOperation = (typeof ACCESS_OPERATIONS)[number];
export const ACCESS_OUTCOMES = ["SUCCESS", "DENIED"] as const;
export type AccessOutcome = (typeof ACCESS_OUTCOMES)[number];
/** Who may read the history: the people who administer the academy's accounts, as for the security log. */
/** Derived from the authority module (RC-1); kept under its old name. */
export const ACCESS_LOG_VIEWERS = rolesWith("logs.access");
export const ACCESS_LABEL: Record<AccessCategory, string> = {
  WORKSPACE: "Academy workspace (players, families, records)",
  CONSENT: "Consent records",
  REPORT: "Player reports",
  NUTRITION: "Nutrition",
  MEDIA: "Private media",
  FINANCE: "Fees and receipts",
  ACCOUNT_SECURITY: "Account security information",
  AUDIT_LOG: "This access history",
  TRAINING: "Training sessions and observations",
  PRIVACY: "Retention, erasure requests and legal holds",
};
export const OPERATION_LABEL: Record<AccessOperation, string> = {
  VIEW: "Viewed",
  LIST: "Listed",
  BULK: "Staff-wide listing",
  DOWNLOAD: "Downloaded",
  PDF: "PDF opened",
  HISTORICAL: "Withdrawn/historical opened",
  THROTTLED: "Further denials not itemised",
};
/** The only things a payload summary may count. Anything else is dropped before storage and again before display. */
export const COUNT_KEYS = [
  "players",
  "guardianLinks",
  "reports",
  "nutrition",
  "restrictions",
  "questions",
  "invoices",
  "payments",
  "media",
  "messages",
  "conversations",
  "history",
  "versions",
  "withdrawn",
  "sessions",
  "goals",
  "events",
  "members",
] as const;
export const DENIAL_REASONS = ["ROLE", "NOT_FOUND", "BAD_ID"] as const;
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000;
/** Allow-list for the free-form `context`: unknown keys and wrong types are dropped, never stored. */
export function safeContext(raw: unknown) {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const c = raw as Record<string, unknown>;
  if (typeof c.status === "number" && Number.isInteger(c.status) && c.status >= 100 && c.status <= 599)
    out.status = c.status;
  if (typeof c.reason === "string" && (DENIAL_REASONS as readonly string[]).includes(c.reason))
    out.reason = c.reason;
  for (const key of ["count", "limit", "windowMinutes"])
    if (isCount(c[key])) out[key] = c[key];
  if (c.withdrawn === true) out.withdrawn = true;
  if (c.counts && typeof c.counts === "object" && !Array.isArray(c.counts)) {
    const counts: Record<string, number> = {};
    for (const key of COUNT_KEYS) {
      const v = (c.counts as Record<string, unknown>)[key];
      if (isCount(v)) counts[key] = v;
    }
    if (Object.keys(counts).length) out.counts = counts;
  }
  return out;
}
/** A resource id is stored only if it looks like one of ours; anything else is recorded as a bad id, never verbatim. */
export function cleanResourceId(raw: unknown): string | null {
  return typeof raw === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw) ? raw : null;
}
