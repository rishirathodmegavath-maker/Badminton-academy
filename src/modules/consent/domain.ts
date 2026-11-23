/**
 * Consent vocabulary and the pure rules that turn a history into a status. No database access here,
 * so the rules can be tested exhaustively and reused by the service and the UI.
 */
import { rolesWith } from "../identity/authority";
export const CONSENT_CATEGORIES = ["PORTAL", "EMAIL", "WHATSAPP"] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];
/** Key of each category in the derived `guardian_link.consent` flags (the state messaging is gated on). */
export const FLAG_KEY: Record<ConsentCategory, "portal" | "email" | "whatsapp"> =
  { PORTAL: "portal", EMAIL: "email", WHATSAPP: "whatsapp" };
export const CATEGORY_LABEL: Record<ConsentCategory, string> = {
  PORTAL: "Portal updates",
  EMAIL: "Email updates",
  WHATSAPP: "WhatsApp updates",
};
export type ConsentDecision = "GRANTED" | "RENEWED" | "WITHDRAWN" | "LAPSED";
export type ConsentMethod =
  | "PORTAL_SELF"
  | "STAFF_WRITTEN"
  | "STAFF_VERBAL"
  | "IMPORT_LEGACY"
  | "SYSTEM_POLICY";
/** The ways academy staff may record a decision on someone's behalf. */
export const STAFF_METHODS = ["STAFF_WRITTEN", "STAFF_VERBAL"] as const;
/**
 * Who administers consent for an academy (record on behalf, publish documents, see the full history):
 * OWNER and ADMIN only. They already manage every player and every guardian link; coaches, finance and
 * nutrition professionals have no need of families' consent records and receive none.
 */
/** Derived from the authority module (RC-1); kept under their old names. */
export const CONSENT_ADMIN_ROLES = rolesWith("consent.admin");
export const CONSENT_FAMILY_ROLES = rolesWith("consent.self");
export const isGranted = (decision: string) =>
  decision === "GRANTED" || decision === "RENEWED";
export type ConsentStatus =
  /** Nothing recorded and nothing granted. */
  | "NONE"
  /** Granted on the version currently in force (or no version has been published yet). */
  | "CURRENT"
  /** Still granted, but on an older/unversioned text: renewal is requested, nothing lapsed. */
  | "RENEWAL_REQUESTED"
  | "WITHDRAWN"
  /** Ended by the academy publishing a version that requires renewal. */
  | "LAPSED"
  /** The flag says granted but no history explains it (data anomaly; should not occur). */
  | "UNRECORDED";
export function statusOf(
  latest: { decision: string; policyVersionId: string | null } | null,
  currentVersionId: string | null,
  flagGranted: boolean,
): ConsentStatus {
  if (!latest) return flagGranted ? "UNRECORDED" : "NONE";
  if (latest.decision === "WITHDRAWN") return "WITHDRAWN";
  if (latest.decision === "LAPSED") return "LAPSED";
  if (currentVersionId && latest.policyVersionId !== currentVersionId)
    return "RENEWAL_REQUESTED";
  return "CURRENT";
}
/** The history folded back into the flag it must equal (used by tests and the integrity check). */
export function foldHistory(
  events: readonly { decision: string; sequence: number }[],
) {
  const last = [...events].sort((x, y) => y.sequence - x.sequence)[0];
  return !!last && isGranted(last.decision);
}
