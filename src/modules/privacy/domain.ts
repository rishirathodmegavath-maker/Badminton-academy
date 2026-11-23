/**
 * Phase 8: the pure rules of retention and controlled erasure (no server imports), shared by the
 * services, the Settings screen and the tests.
 *
 * IMPORTANT: this file contains NO retention periods and NO legal conclusions. Every category that
 * could be erased is `REQUIRES POLICY APPROVAL` until the academy's owner approves a rule for it
 * (`retention_policy`); the categories that are evidence (finance, consent, audit) can never be given
 * an erase rule by this application at all.
 */
export const ERASED_NAME = "Erased player";
export const POLICY_PENDING = "REQUIRES POLICY APPROVAL";
export const RETENTION_ACTIONS = ["ERASE", "ANONYMIZE"] as const;
export type RetentionAction = (typeof RETENTION_ACTIONS)[number];
export type CategoryKey =
  | "PLAYER_PROFILE"
  | "GUARDIAN_LINKS"
  | "ADMISSIONS"
  | "TRAINING_RECORDS"
  | "REPORTS"
  | "NUTRITION"
  | "MEDIA"
  | "CONVERSATIONS"
  | "GOALS_AND_HISTORY"
  | "FINANCE"
  | "CONSENT_EVIDENCE"
  | "AUDIT_RECORDS"
  | "MESSAGES_AND_CALENDAR";
export type CategoryInfo = {
  key: CategoryKey;
  label: string;
  /** Why the academy holds it. */
  purpose: string;
  /** Who is responsible for it day to day. */
  owner: string;
  /** What starts a retention clock for it. */
  trigger: string;
  /** What the application does with it today, before Phase 8. */
  existing: string;
  /** Actions an owner may approve. Empty = fixed: this application never erases or rewrites it. */
  actions: RetentionAction[];
  /** For fixed categories: why. */
  fixedReason?: string;
  /** Whether a legal or operational retention duty may apply (a question for the academy, never assumed here). */
  legal: string;
};
/** In the order they are executed: private files first, identity last, so a failure never leaves a named empty shell. */
export const CATEGORIES: CategoryInfo[] = [
  { key: "MEDIA", label: "Private media and video", purpose: "Coaching feedback on a player's technique", owner: "Coaching staff", trigger: "Upload, then the retention expiry already stored on each file", existing: "Access stops at the expiry date; files and rows were never removed", actions: ["ERASE"], legal: POLICY_PENDING },
  { key: "REPORTS", label: "Player development reports and revisions", purpose: "Coach-reviewed progress reports shared with families", owner: "Head coach / owner", trigger: "Report period end or the player leaving", existing: "Kept forever; withdrawal (Phase 6) hides from families only", actions: ["ERASE"], legal: POLICY_PENDING },
  { key: "NUTRITION", label: "Nutrition plans, restrictions and questions", purpose: "Professionally approved nutrition guidance and reported allergies", owner: "Nutrition professional", trigger: "Assignment ending or the player leaving", existing: "Kept forever", actions: ["ERASE"], legal: POLICY_PENDING },
  { key: "CONVERSATIONS", label: "Private conversations with guardians", purpose: "Direct communication about one player", owner: "Coaching staff", trigger: "Last message or the player leaving", existing: "Kept forever", actions: ["ERASE"], legal: POLICY_PENDING },
  { key: "GOALS_AND_HISTORY", label: "Individual goals and player history notes", purpose: "Development goals and profile change notes", owner: "Coaching staff", trigger: "The player leaving", existing: "Kept forever", actions: ["ERASE"], legal: POLICY_PENDING },
  { key: "TRAINING_RECORDS", label: "Attendance, observations and roster entries in training sessions", purpose: "Session records shared with the other players of a session", owner: "Coach", trigger: "Session date or the player leaving", existing: "Kept forever", actions: ["ANONYMIZE"], legal: POLICY_PENDING },
  { key: "ADMISSIONS", label: "Admissions and trial records", purpose: "Enquiry, trial and conversion into a player", owner: "Admissions / owner", trigger: "Enquiry closed or the player leaving", existing: "Kept forever", actions: ["ANONYMIZE"], legal: POLICY_PENDING },
  { key: "GUARDIAN_LINKS", label: "Guardian links to the player", purpose: "Which account may see which child", owner: "Owner / admin", trigger: "The player leaving", existing: "Links can be deactivated, never removed (consent history refers to them)", actions: ["ANONYMIZE"], legal: POLICY_PENDING },
  { key: "PLAYER_PROFILE", label: "Player identity, profile and profile revisions", purpose: "Who the player is and how to reach the family", owner: "Owner / admin", trigger: "The player leaving", existing: "Profiles can be archived, never removed", actions: ["ANONYMIZE"], legal: POLICY_PENDING },
  { key: "FINANCE", label: "Invoices, payments, refunds and lesson credits", purpose: "Financial evidence", owner: "Finance / owner", trigger: "Financial year end (to be confirmed)", existing: "Kept forever", actions: [], fixedReason: "Financial evidence is retained; whether and when it may be erased is a legal and accounting decision, not made here", legal: POLICY_PENDING },
  { key: "CONSENT_EVIDENCE", label: "Consent history and evidence references", purpose: "Proof of what was agreed, by whom, when", owner: "Owner", trigger: "To be confirmed", existing: "Append-only; the database refuses changes", actions: [], fixedReason: "Consent history is append-only evidence (Phase 5); it refers to the opaque player id and the guardian account, not to the player's name", legal: POLICY_PENDING },
  { key: "AUDIT_RECORDS", label: "Audit, security and access history", purpose: "Accountability for who did and saw what", owner: "Owner / operator", trigger: "To be confirmed", existing: "Append-only; the database refuses changes", actions: [], fixedReason: "Audit integrity (Phases 3 and 7); these records hold identifiers, not content", legal: POLICY_PENDING },
  { key: "MESSAGES_AND_CALENDAR", label: "Broadcast messages and calendar entries that mention the player", purpose: "Academy-wide communication and scheduling", owner: "Admin / coaching staff", trigger: "To be confirmed", existing: "Kept forever", actions: [], fixedReason: "These are academy-authored records shared with other families; erasing them for one player is not supported yet and needs a policy decision", legal: POLICY_PENDING },
];
export const categoryInfo = (key: string) => CATEGORIES.find((c) => c.key === key);
export const EXECUTION_ORDER = CATEGORIES.filter((c) => c.actions.length).map((c) => c.key);
export type RequestStatus =
  | "PREVIEW_READY"
  | "GRACE_PERIOD"
  | "PROCESSING"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELLED"
  | "BLOCKED"
  | "FAILED";
export const REQUEST_STATUSES: RequestStatus[] = ["PREVIEW_READY", "GRACE_PERIOD", "PROCESSING", "COMPLETED", "REJECTED", "CANCELLED", "BLOCKED", "FAILED"];
/** Every allowed move; anything else is refused by the server. Terminal states have no way out. */
export const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  PREVIEW_READY: ["GRACE_PERIOD", "REJECTED", "CANCELLED", "BLOCKED"],
  GRACE_PERIOD: ["PROCESSING", "CANCELLED", "BLOCKED"],
  BLOCKED: ["PREVIEW_READY", "CANCELLED"],
  PROCESSING: ["COMPLETED", "FAILED", "BLOCKED"],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
  FAILED: [],
};
export const canTransition = (from: string, to: string) => (TRANSITIONS[from as RequestStatus] ?? []).includes(to as RequestStatus);
export const OPEN_STATUSES: RequestStatus[] = ["PREVIEW_READY", "GRACE_PERIOD", "PROCESSING", "BLOCKED"];
export const MAX_ATTEMPTS = 5;
/** Minutes to wait before attempt n+1 (2, 4, 8, ... capped at one hour). */
export const backoffMinutes = (attempts: number) => Math.min(60, 2 ** Math.max(1, attempts));
export const LOCK_MINUTES = 10;
/** Deployment setting: whole days between approval and the first possible execution. Bounded; never zero. */
export function graceDays(env: Record<string, string | undefined> = process.env) {
  const raw = Number(env.ERASURE_GRACE_DAYS);
  return Number.isInteger(raw) && raw >= 1 && raw <= 365 ? raw : 14;
}
export type PolicyRow = { category: string; status: string; action: string; retentionDays: number | null } | null;
/**
 * Is a category eligible for the academy's configured action right now?
 * No approved rule = not eligible (REQUIRES POLICY APPROVAL), whatever else is true. `leftAt` is when the
 * subject stopped being an active player (null while active or unknown).
 */
export function evaluateEligibility(policy: PolicyRow, subject: { leftAt: Date | null }, now: Date):
  | { eligible: true; action: RetentionAction; basis: "ON_REQUEST" | "PERIOD_ELAPSED" }
  | { eligible: false; reason: "REQUIRES_POLICY_APPROVAL" | "SUBJECT_STILL_ACTIVE" | "PERIOD_NOT_ELAPSED"; eligibleFrom?: Date } {
  if (!policy || policy.status !== "APPROVED") return { eligible: false, reason: "REQUIRES_POLICY_APPROVAL" };
  const action = policy.action as RetentionAction;
  if (policy.retentionDays === null) return { eligible: true, action, basis: "ON_REQUEST" };
  if (!subject.leftAt) return { eligible: false, reason: "SUBJECT_STILL_ACTIVE" };
  const from = new Date(subject.leftAt.getTime() + policy.retentionDays * 86_400_000);
  return now.getTime() >= from.getTime() ? { eligible: true, action, basis: "PERIOD_ELAPSED" } : { eligible: false, reason: "PERIOD_NOT_ELAPSED", eligibleFrom: from };
}
export type PreviewCategory = {
  key: CategoryKey;
  label: string;
  /** What this request would do to the category. */
  outcome: "WILL_ERASE" | "WILL_ANONYMIZE" | "RETAINED_FIXED" | "REQUIRES_POLICY_APPROVAL" | "NOT_ELIGIBLE" | "HELD" | "NOTHING_TO_DO";
  records: number;
  /** Extra counts (never record contents), e.g. { files: 3 }. */
  detail: Record<string, number>;
  note?: string;
};
export type Preview = {
  generatedAt: string;
  held: boolean;
  categories: PreviewCategory[];
  /** What approval would authorise: the categories that WILL act. */
  willAct: { category: CategoryKey; action: RetentionAction }[];
};
export const SOURCES = ["STAFF", "FAMILY_REQUEST", "DATA_SUBJECT"] as const;
export type RequestSource = (typeof SOURCES)[number];
export type StepStatus = "PENDING" | "DONE" | "SKIPPED" | "FAILED";
export type Step = { category: CategoryKey; action: RetentionAction; status: StepStatus; records?: number; code?: string };
/** A request/hold/policy reason has to say something. */
export function validPrivacyReason(text: string) {
  const reason = text.trim();
  const words = reason.toLowerCase().match(/\p{L}{2,}/gu) ?? [];
  return reason.length >= 10 && reason.length <= 500 && words.length >= 3 && new Set(words).size >= 2;
}
