import { DomainError } from "../training/domain/rules";
/**
 * Role consolidation RC-1: the one place that decides what a stored membership role may do.
 *
 * Pure: no database, no request, no I/O. Every decision is a function of the stored role string alone, read
 * by `resolveActor` from the person's one active membership on every request. Player- and record-level scope
 * (which players, which sessions, which invoices) is NOT decided here: `accessiblePlayers`, `familyScope`,
 * `billablePlayers` and the per-record checks keep doing that. `can()` answers exactly the question the old
 * role lists answered: "may this role use this function at all?".
 *
 * Stored roles stay the source of truth (decision D2): the database keeps the eight legacy values, history keeps
 * writing them, and the account type and staff designation below are derived, never stored.
 *
 *   stored role    account type  staff designation  player scope
 *   OWNER          OWNER         -                  ALL
 *   ADMIN          STAFF         ADMINISTRATOR      ALL                  (never OWNER: decision D1)
 *   HEAD_COACH     STAFF         HEAD_COACH         ALL
 *   COACH          STAFF         COACH              COACHED_BATCHES
 *   FINANCE        STAFF         FINANCE            NONE_BILLING_ROSTER
 *   NUTRITION_PRO  STAFF         NUTRITION_PRO      ASSIGNED
 *   GUARDIAN       GUARDIAN      -                  LINKED
 *   ADULT_PLAYER   PLAYER        -                  SELF
 *   anything else  (none)        (none)             (none): every check denies
 *
 * Changing a grant below changes who may do what. It requires a T-EQ update (tests/authority-equivalence.test.ts)
 * and an explicit approval; RC-1 itself changes no permission.
 *
 * RC-5 adds `portal.staff` (FINAL_PERMISSION_MATRIX "Access Staff Workspace UI"): exactly the six STAFF/OWNER roles
 * of the pre-RC-5 navigation list STAFF_ROLES. It formalises an existing check and grants nothing new.
 */

export const STORED_ROLES = [
  "OWNER",
  "ADMIN",
  "HEAD_COACH",
  "COACH",
  "FINANCE",
  "NUTRITION_PRO",
  "GUARDIAN",
  "ADULT_PLAYER",
] as const;
export type StoredRole = (typeof STORED_ROLES)[number];
/** The stored role of a player's own login. Players are under 18 and no longer get one; kept so old rows still read and so new ones can be refused by name. */
export const PLAYER_LOGIN_ROLE: StoredRole = STORED_ROLES[7];

export const ACCOUNT_TYPES = ["OWNER", "STAFF", "GUARDIAN", "PLAYER"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const STAFF_DESIGNATIONS = [
  "ADMINISTRATOR",
  "HEAD_COACH",
  "COACH",
  "FINANCE",
  "NUTRITION_PRO",
] as const;
export type StaffDesignation = (typeof STAFF_DESIGNATIONS)[number];

/** Display names. Presentation only; nothing is decided from a label. */
export const ACCOUNT_TYPE_LABELS: Readonly<Record<AccountType, string>> = Object.freeze({
  OWNER: "Owner",
  STAFF: "Staff",
  GUARDIAN: "Guardian",
  PLAYER: "Player",
});
export const DESIGNATION_LABELS: Readonly<Record<StaffDesignation, string>> = Object.freeze({
  ADMINISTRATOR: "Administrator",
  HEAD_COACH: "Head Coach",
  COACH: "Coach",
  FINANCE: "Finance",
  NUTRITION_PRO: "Nutrition Pro",
});

export type PlayerScope =
  | "ALL"
  | "COACHED_BATCHES"
  | "ASSIGNED"
  | "NONE_BILLING_ROSTER"
  | "LINKED"
  | "SELF";

/**
 * Every function-level permission the application checks today. The comment names the code that decided it
 * before RC-1. "S" in the permission matrix (own batches, linked children, published content) is enforced by
 * the scope code, not here.
 */
export const CAPABILITIES = [
  "workspace.access", // resolveActor: the eight supported roles
  "training.studio", // resolveActor training audience
  "training.allSessions", // isManager: every session and batch, not only one's own
  "academy.settings", // saveSettings
  "academy.structure", // saveBranch, saveBatch
  "members.manage", // saveMember                                     OWNER only (1)
  "members.resetCredentials", // resetDecision (password, MFA reset)  OWNER only (2)
  "security.mfa.view", // MFA_POLICY_VIEWERS
  "security.mfa.edit", // MFA_POLICY_EDITORS, MFA policy endpoint     OWNER only (3)
  "logs.security", // SECURITY_EVENT_VIEWERS
  "logs.access", // ACCESS_LOG_VIEWERS
  "logs.audit", // bootstrap audit tail (ops)
  "admissions.manage", // enquiries, trials, conversion
  "players.manage", // savePlayer
  "guardians.link", // linkGuardian
  "consent.admin", // CONSENT_ADMIN_ROLES
  "consent.self", // CONSENT_FAMILY_ROLES
  "calendar.manage", // calendar events, cancellation preview
  "sessions.schedule", // scheduleSession
  "sessions.coach", // may be assigned as batch or session coach (canCoach; migration 0011 SQL)
  "reports.author", // observations, create, save, submit
  "reports.approve", // approve, publish, revise, withdraw
  "reports.read", // reportAccess (families: published only)
  "media.manage", // upload, review, timestamp notes
  "media.view", // mediaAccess (families: shared only)
  "nutrition.author", // plan save or submit
  "nutrition.approve", // plan approval
  "nutrition.share", // plan share or withdraw
  "nutrition.restricted", // allergies and restrictions
  "nutrition.answer", // answer a private nutrition question
  "nutrition.ask", // ask a private nutrition question
  "nutrition.assign", // assign players to a nutrition professional
  "comms.author", // draft, preview
  "comms.approve", // approve, send, outbox, templates
  "comms.conversation", // saveConversation
  "finance.manage", // financeRoles
  "finance.pay", // submitPayment
  "privacy.manage", // privacy overview, requests, holds, processing
  "privacy.retention", // setRetentionPolicy                          OWNER only (4)
  "privacy.releaseHold", // releaseLegalHold                          OWNER only (5)
  "family.portal", // family(a): the Family Portal read model
  "portal.staff", // RC-5: the staff workspace (navigation STAFF_ROLES; the staff read model bootstrapStaff)
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Decision D1: the five capabilities that only an OWNER holds. An Administrator never holds any of them. */
export const OWNER_EXCLUSIVE_CAPABILITIES = [
  "members.manage",
  "members.resetCredentials",
  "security.mfa.edit",
  "privacy.retention",
  "privacy.releaseHold",
] as const satisfies readonly Capability[];

export type Authority = Readonly<{
  role: StoredRole;
  accountType: AccountType;
  designation: StaffDesignation | null;
  scope: PlayerScope;
  capabilities: ReadonlySet<Capability>;
}>;

// ---------------------------------------------------------------------------------------------------------------
// Grants per account type and designation. Each set is today's verified behaviour for that stored role
// (CURRENT_ROLE_PERMISSION_MATRIX.md); T-EQ proves it cell by cell against the pre-RC-1 role lists.
// ---------------------------------------------------------------------------------------------------------------

const OWNER_CAPABILITIES: readonly Capability[] = [
  "workspace.access",
  "training.studio",
  "training.allSessions",
  "academy.settings",
  "academy.structure",
  "members.manage",
  "members.resetCredentials",
  "security.mfa.view",
  "security.mfa.edit",
  "logs.security",
  "logs.access",
  "logs.audit",
  "admissions.manage",
  "players.manage",
  "guardians.link",
  "consent.admin",
  "calendar.manage",
  "sessions.schedule",
  "sessions.coach",
  "reports.author",
  "reports.approve",
  "reports.read",
  "media.manage",
  "media.view",
  "nutrition.author",
  "nutrition.share",
  "nutrition.assign",
  "comms.author",
  "comms.approve",
  "comms.conversation",
  "finance.manage",
  "finance.pay",
  "privacy.manage",
  "privacy.retention",
  "privacy.releaseHold",
  "portal.staff",
];

const EXCLUSIVE: ReadonlySet<Capability> = new Set(OWNER_EXCLUSIVE_CAPABILITIES);

/** Administrator = everything an OWNER may do except the five OWNER-only capabilities (D1), by construction. */
const ADMINISTRATOR_CAPABILITIES: readonly Capability[] = OWNER_CAPABILITIES.filter(
  (c) => !EXCLUSIVE.has(c),
);

const HEAD_COACH_CAPABILITIES: readonly Capability[] = [
  "workspace.access",
  "training.studio",
  "training.allSessions",
  "academy.structure",
  "logs.audit",
  "admissions.manage",
  "players.manage",
  "guardians.link",
  "calendar.manage",
  "sessions.schedule",
  "sessions.coach",
  "reports.author",
  "reports.approve",
  "reports.read",
  "media.manage",
  "media.view",
  "nutrition.author",
  "nutrition.share",
  "comms.author",
  "comms.approve",
  "comms.conversation",
  "portal.staff",
];

const COACH_CAPABILITIES: readonly Capability[] = [
  "workspace.access",
  "training.studio",
  "sessions.schedule",
  "sessions.coach",
  "reports.author",
  "reports.read",
  "media.manage",
  "media.view",
  "nutrition.author",
  "comms.author",
  "comms.conversation",
  "portal.staff",
];

const FINANCE_CAPABILITIES: readonly Capability[] = [
  "workspace.access",
  "finance.manage",
  "finance.pay",
  "portal.staff",
];

const NUTRITION_PRO_CAPABILITIES: readonly Capability[] = [
  "workspace.access",
  "nutrition.author",
  "nutrition.approve",
  "nutrition.share",
  "nutrition.restricted",
  "nutrition.answer",
  "portal.staff",
];

/** GUARDIAN and PLAYER: the family account types. Data is limited to their scope (LINKED / SELF). */
const FAMILY_CAPABILITIES: readonly Capability[] = [
  "workspace.access",
  "consent.self",
  "reports.read",
  "media.view",
  "nutrition.restricted",
  "nutrition.ask",
  "comms.conversation",
  "finance.pay",
  "family.portal",
];

type Mapping = {
  accountType: AccountType;
  designation: StaffDesignation | null;
  scope: PlayerScope;
  capabilities: readonly Capability[];
};

const MAPPING: Readonly<Record<StoredRole, Mapping>> = {
  OWNER: { accountType: "OWNER", designation: null, scope: "ALL", capabilities: OWNER_CAPABILITIES },
  ADMIN: {
    accountType: "STAFF",
    designation: "ADMINISTRATOR",
    scope: "ALL",
    capabilities: ADMINISTRATOR_CAPABILITIES,
  },
  HEAD_COACH: {
    accountType: "STAFF",
    designation: "HEAD_COACH",
    scope: "ALL",
    capabilities: HEAD_COACH_CAPABILITIES,
  },
  COACH: {
    accountType: "STAFF",
    designation: "COACH",
    scope: "COACHED_BATCHES",
    capabilities: COACH_CAPABILITIES,
  },
  FINANCE: {
    accountType: "STAFF",
    designation: "FINANCE",
    scope: "NONE_BILLING_ROSTER",
    capabilities: FINANCE_CAPABILITIES,
  },
  NUTRITION_PRO: {
    accountType: "STAFF",
    designation: "NUTRITION_PRO",
    scope: "ASSIGNED",
    capabilities: NUTRITION_PRO_CAPABILITIES,
  },
  GUARDIAN: { accountType: "GUARDIAN", designation: null, scope: "LINKED", capabilities: FAMILY_CAPABILITIES },
  ADULT_PLAYER: { accountType: "PLAYER", designation: null, scope: "SELF", capabilities: FAMILY_CAPABILITIES },
};

/**
 * A Map, not an object lookup: a role such as "constructor", "__proto__" or "toString" must find nothing,
 * and lookups are exact (case-sensitive, no trimming), as the old `includes` checks were.
 */
const AUTHORITY: ReadonlyMap<string, Authority> = new Map(
  STORED_ROLES.map((role) => {
    const m = MAPPING[role];
    const authority: Authority = Object.freeze({
      role,
      accountType: m.accountType,
      designation: m.designation,
      scope: m.scope,
      capabilities: freezeSet(new Set(m.capabilities)),
    });
    return [role, authority] as const;
  }),
);

function freezeSet<T>(set: Set<T>): ReadonlySet<T> {
  // A Set's contents are not protected by Object.freeze; refuse mutation explicitly.
  const refuse = () => {
    throw new TypeError("Authority capability sets are read-only.");
  };
  set.add = refuse;
  set.delete = refuse;
  set.clear = refuse;
  return Object.freeze(set);
}

/** The derived authority of a stored role, or null for any value that is not one of the eight. */
export function authorityOf(storedRole: unknown): Authority | null {
  if (typeof storedRole !== "string") return null;
  return AUTHORITY.get(storedRole) ?? null;
}

export const isStoredRole = (value: unknown): value is StoredRole => authorityOf(value) !== null;

/** Anything that carries a stored role: the request Actor, or a membership row read from the database. */
export type RoleHolder = { readonly role: string } | null | undefined;

/** The single authorization question: may this role use this capability? Unknown roles and missing actors: no. */
export function can(actor: RoleHolder, capability: Capability): boolean {
  if (!actor) return false;
  return authorityOf(actor.role)?.capabilities.has(capability) ?? false;
}

/** Same refusal as the pre-RC-1 `requireRole`: HTTP 403, "Your role cannot perform this action.". */
export function requireCapability(actor: RoleHolder, capability: Capability): void {
  if (!can(actor, capability))
    throw new DomainError("Your role cannot perform this action.", 403);
}

/** The stored roles holding a capability, in canonical order. For SQL filters and the legacy role lists. */
export function rolesWith(capability: Capability): StoredRole[] {
  return STORED_ROLES.filter((role) => can({ role }, capability));
}
