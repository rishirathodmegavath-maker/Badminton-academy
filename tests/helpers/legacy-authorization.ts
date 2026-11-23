/**
 * FROZEN: every role decision of the application as it was BEFORE role consolidation RC-1, copied by hand from
 * the integrated post-Stage-5F repository (HEAD 6f520666, files as listed). The role lists are literal copies,
 * deliberately NOT imported from src/: src now derives them from the authority module, and comparing src with
 * itself would prove nothing. Never import this file from src/, and never "update" it to make a test pass:
 * a difference between this file and the authority module is a permission change.
 *
 * Each entry is one call site (or one family of identical call sites). `legacy(role)` answers "did the old code
 * let this stored role past this check?". `capability` is the authority capability the site now uses (or, for a
 * site that RC-1 deliberately left unchanged, the capability that describes it).
 */
import type { Capability } from "../../src/modules/identity/authority";

// Pre-RC-1 lists, verbatim (src/modules/academy/application/access.ts lines 10-21, identity/access.ts 56-90).
const FAMILY = ["GUARDIAN", "ADULT_PLAYER"];
const OPS = ["OWNER", "ADMIN", "HEAD_COACH"];
const COACHING = ["OWNER", "ADMIN", "HEAD_COACH", "COACH"];
const FINANCE = ["OWNER", "ADMIN", "FINANCE"];
const CONSENT_ADMIN = ["OWNER", "ADMIN"]; // consent/domain.ts:29
const CONSENT_FAMILY = ["GUARDIAN", "ADULT_PLAYER"]; // consent/domain.ts:30
const ADMINS = ["OWNER", "ADMIN"]; // privacy/application/service.ts:41
const KNOWN = [
  "OWNER",
  "ADMIN",
  "HEAD_COACH",
  "COACH",
  "FINANCE",
  "NUTRITION_PRO",
  "GUARDIAN",
  "ADULT_PLAYER",
];
const TRAINING_AUDIENCE = ["OWNER", "ADMIN", "HEAD_COACH", "COACH"];
const TRAINING_COACH_LIST = ["COACH", "HEAD_COACH", "ADMIN", "OWNER"]; // training/application/service.ts:67-70
const TRAINING_COACH_LIST_2 = ["OWNER", "ADMIN", "HEAD_COACH", "COACH"]; // training/application/service.ts:278-281
// RC-5: the pre-RC-5 staff workspace list, verbatim (academy/ui/navigation.ts:27-34 STAFF_ROLES, the roles that use `/`).
const STAFF_WORKSPACE = ["OWNER", "ADMIN", "HEAD_COACH", "COACH", "FINANCE", "NUTRITION_PRO"];

const isIn = (list: readonly string[]) => (role: string) => list.includes(role);
const family = isIn(FAMILY);

/** The literal pre-RC-1 lists, exported for the list-equality checks of T-EQ. */
export const LEGACY_LISTS = {
  family: FAMILY,
  opsRoles: OPS,
  coachingRoles: COACHING,
  financeRoles: FINANCE,
  narrowRoles: ["FINANCE", "NUTRITION_PRO"],
  isManager: OPS,
  trainingAudience: TRAINING_AUDIENCE,
  knownRoles: KNOWN,
  saveMemberRoleEnum: KNOWN, // settings/application/service.ts:213-222
  CONSENT_ADMIN_ROLES: CONSENT_ADMIN,
  CONSENT_FAMILY_ROLES: CONSENT_FAMILY,
  ACCESS_LOG_VIEWERS: ["OWNER", "ADMIN"], // audit/domain.ts:43
  SECURITY_EVENT_VIEWERS: ["OWNER", "ADMIN"], // identity/security-event-log.ts:43
  MFA_POLICY_VIEWERS: ["OWNER", "ADMIN"], // identity/mfa-admin.ts:38
  MFA_POLICY_EDITORS: ["OWNER"], // identity/mfa-admin.ts:39
  privacyAdmins: ADMINS,
  staffWorkspace: STAFF_WORKSPACE,
} as const;

export type LegacySite = {
  /** File and line(s) in the pre-RC-1 repository, and the function. */
  site: string;
  capability: Capability;
  legacy: (role: string) => boolean;
  /** "migrated": the site now calls can()/requireCapability; "derived": it still uses a legacy list or helper, now
   *  derived from the authority module; "unchanged": RC-1 deliberately did not touch it (reason in the report). */
  status: "migrated" | "derived" | "unchanged";
  /** The site is `if (!family(a)) <check>`: family accounts take a separate (unchanged) branch. The new decision
   *  is therefore family(role) || can(role, capability). */
  familyBypass?: true;
};

export const LEGACY_SITES: readonly LegacySite[] = [
  // ---- identity -------------------------------------------------------------------------------------------
  { site: "identity/access.ts:62-80 resolveActor (supported roles)", capability: "workspace.access", legacy: isIn(KNOWN), status: "migrated" },
  { site: "identity/access.ts:55-61 resolveActor (training audience)", capability: "training.studio", legacy: isIn(TRAINING_AUDIENCE), status: "migrated" },
  { site: "identity/access.ts:89-90 isManager", capability: "training.allSessions", legacy: isIn(OPS), status: "migrated" },
  { site: "identity/reset-policy.ts:29 resetDecision (actor)", capability: "members.resetCredentials", legacy: (r) => r === "OWNER", status: "migrated" },
  { site: "identity/account-security.ts:379-382 mfaPolicyView", capability: "security.mfa.view", legacy: isIn(["OWNER", "ADMIN"]), status: "migrated" },
  { site: "identity/account-security.ts:427 mfaPolicyChange", capability: "security.mfa.edit", legacy: (r) => r === "OWNER", status: "migrated" },
  { site: "identity/mfa-admin.ts:233 mfaOverview canEdit", capability: "security.mfa.edit", legacy: isIn(["OWNER"]), status: "migrated" },
  { site: "identity/mfa-admin.ts:278-282 changeMfaPolicy (after lock)", capability: "security.mfa.edit", legacy: isIn(["OWNER"]), status: "migrated" },
  { site: "identity/security-event-log.ts:148 listSecurityEventsRead", capability: "logs.security", legacy: isIn(["OWNER", "ADMIN"]), status: "migrated" },
  { site: "audit/application/access-log.ts:75 listAccessEvents", capability: "logs.access", legacy: isIn(["OWNER", "ADMIN"]), status: "migrated" },
  // ---- academy helpers -------------------------------------------------------------------------------------
  { site: "academy/application/access.ts:10-11 family()", capability: "family.portal", legacy: family, status: "derived" },
  { site: "academy/application/bootstrap.ts:42 ops flag (audit tail and ops read model)", capability: "logs.audit", legacy: isIn(OPS), status: "unchanged" },
  // ---- settings --------------------------------------------------------------------------------------------
  { site: "settings/application/service.ts:38 saveSettings", capability: "academy.settings", legacy: isIn(["OWNER", "ADMIN"]), status: "migrated" },
  { site: "settings/application/service.ts:112 saveBranch", capability: "academy.structure", legacy: isIn(OPS), status: "migrated" },
  { site: "settings/application/service.ts:149 saveBatch", capability: "academy.structure", legacy: isIn(OPS), status: "migrated" },
  { site: "settings/application/service.ts:207 saveMember", capability: "members.manage", legacy: isIn(["OWNER"]), status: "migrated" },
  { site: "settings/application/coach-assignments.ts:35-36 canCoach (target)", capability: "sessions.coach", legacy: isIn(COACHING), status: "derived" },
  // ---- admissions, players, consent ------------------------------------------------------------------------
  { site: "admissions/application/service.ts:28,80,118 enquiry, trial, conversion", capability: "admissions.manage", legacy: isIn(OPS), status: "migrated" },
  { site: "players/application/service.ts:33 savePlayer", capability: "players.manage", legacy: isIn(OPS), status: "migrated" },
  { site: "players/application/service.ts:136 linkGuardian", capability: "guardians.link", legacy: isIn(OPS), status: "migrated" },
  { site: "players/application/service.ts:235 linkGuardian consent change", capability: "consent.admin", legacy: isIn(CONSENT_ADMIN), status: "migrated" },
  { site: "consent/application/service.ts:59-60 isAdmin", capability: "consent.admin", legacy: isIn(CONSENT_ADMIN), status: "migrated" },
  { site: "consent/application/service.ts:644,731,868 consent documents and report", capability: "consent.admin", legacy: isIn(CONSENT_ADMIN), status: "migrated" },
  { site: "consent/application/service.ts:55-58 requireConsentRole (family part)", capability: "consent.self", legacy: (r) => isIn(CONSENT_FAMILY)(r), status: "migrated" },
  // ---- calendar and training -------------------------------------------------------------------------------
  { site: "calendar/application/service.ts:718 saveCalendarEvent", capability: "calendar.manage", legacy: isIn(OPS), status: "migrated" },
  { site: "calendar/application/service.ts:728 previewCalendarCancellation", capability: "calendar.manage", legacy: isIn(OPS), status: "migrated" },
  { site: "calendar/application/service.ts:755 scheduleSession", capability: "sessions.schedule", legacy: isIn(COACHING), status: "migrated" },
  { site: "calendar/application/service.ts:126,203 coach validation (target)", capability: "sessions.coach", legacy: isIn(COACHING), status: "derived" },
  { site: "training/application/service.ts:63-71 coach list (target)", capability: "sessions.coach", legacy: isIn(TRAINING_COACH_LIST), status: "migrated" },
  { site: "training/application/service.ts:276-283 session coach (target)", capability: "sessions.coach", legacy: isIn(TRAINING_COACH_LIST_2), status: "migrated" },
  // ---- reports, media, nutrition, communications -----------------------------------------------------------
  { site: "reports/application/service.ts:24,85,236 observations, create, save, submit", capability: "reports.author", legacy: isIn(COACHING), status: "migrated" },
  { site: "reports/application/service.ts:177-197 reportAccess", capability: "reports.read", legacy: (r) => family(r) || isIn(COACHING)(r), status: "migrated", familyBypass: true },
  { site: "reports/application/service.ts:206,252,271,284 withdraw, approve, publish, revise", capability: "reports.approve", legacy: isIn(OPS), status: "migrated" },
  { site: "media/application/service.ts:40,131,167 upload, review, notes", capability: "media.manage", legacy: isIn(COACHING), status: "migrated" },
  { site: "media/application/service.ts:125-127 mediaAccess", capability: "media.view", legacy: (r) => family(r) || isIn(COACHING)(r), status: "migrated", familyBypass: true },
  { site: "nutrition/application/service.ts:22 savePlan", capability: "nutrition.author", legacy: isIn([...COACHING, "NUTRITION_PRO"]), status: "migrated" },
  { site: "nutrition/application/service.ts:87 approve", capability: "nutrition.approve", legacy: isIn(["NUTRITION_PRO"]), status: "migrated" },
  { site: "nutrition/application/service.ts:101,151 share, withdraw", capability: "nutrition.share", legacy: isIn(["OWNER", "ADMIN", "HEAD_COACH", "NUTRITION_PRO"]), status: "migrated" },
  { site: "nutrition/application/service.ts:195 saveRestrictions", capability: "nutrition.restricted", legacy: (r) => family(r) || r === "NUTRITION_PRO", status: "migrated", familyBypass: true },
  { site: "nutrition/application/service.ts:263 answer question", capability: "nutrition.answer", legacy: isIn(["NUTRITION_PRO"]), status: "migrated" },
  { site: "nutrition/application/service.ts:286 ask question", capability: "nutrition.ask", legacy: family, status: "migrated" },
  { site: "nutrition/application/service.ts:320 assignNutrition", capability: "nutrition.assign", legacy: isIn(["OWNER", "ADMIN"]), status: "migrated" },
  { site: "communications/application/service.ts:100,115 draft, preview", capability: "comms.author", legacy: isIn(COACHING), status: "migrated" },
  { site: "communications/application/service.ts:190,202,233,306 approve, send, outbox, templates", capability: "comms.approve", legacy: isIn(OPS), status: "migrated" },
  { site: "communications/application/service.ts:339-341 saveConversation", capability: "comms.conversation", legacy: (r) => family(r) || isIn(COACHING)(r), status: "migrated", familyBypass: true },
  // ---- fees ------------------------------------------------------------------------------------------------
  { site: "fees/application/service.ts:117,194,412,490,561,608 plans, invoices, verify, refunds, credits, void", capability: "finance.manage", legacy: isIn(FINANCE), status: "migrated" },
  { site: "fees/application/service.ts:61-78 invoiceAccess (family branch, else finance)", capability: "finance.manage", legacy: (r) => family(r) || isIn(FINANCE)(r), status: "migrated", familyBypass: true },
  { site: "fees/application/service.ts:299 submitPayment", capability: "finance.pay", legacy: (r) => family(r) || isIn(FINANCE)(r), status: "migrated", familyBypass: true },
  // ---- privacy ---------------------------------------------------------------------------------------------
  { site: "privacy/application/service.ts:198,222,234,263,278,347,392 requests, preview, review, cancel, hold, overview, detail", capability: "privacy.manage", legacy: isIn(ADMINS), status: "migrated" },
  { site: "app/api/academy/[[...path]]/route.ts:128 privacy/process", capability: "privacy.manage", legacy: isIn(["OWNER", "ADMIN"]), status: "migrated" },
  { site: "privacy/application/service.ts:163 setRetentionPolicy", capability: "privacy.retention", legacy: isIn(["OWNER"]), status: "migrated" },
  { site: "privacy/application/service.ts:300 releaseLegalHold", capability: "privacy.releaseHold", legacy: isIn(["OWNER"]), status: "migrated" },
  // ---- RC-5: staff workspace ------------------------------------------------------------------------------
  { site: "academy/ui/navigation.ts:27-34 STAFF_ROLES (staff workspace; studio.tsx family redirect)", capability: "portal.staff", legacy: isIn(STAFF_WORKSPACE), status: "migrated" },
];
