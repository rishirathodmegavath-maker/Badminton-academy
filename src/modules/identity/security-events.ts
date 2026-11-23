import { and, eq } from "drizzle-orm";
import { database } from "../../infrastructure/database/client";
import {
  memberships,
  securityEvent,
} from "../../infrastructure/database/schema";
type Db = Pick<ReturnType<typeof database>, "insert" | "select">;
/**
 * Events about a PERSON's own sign-in and credentials rather than about an academy. They carry no academy when the person
 * belongs to several (soleAcademy below finds none), and an academy's security log shows them for every ACTIVE member
 * it has, so a person in two academies is not invisible in both. They hold no free text and name no academy (their
 * `detail` is reduced to the log's allow-list), so showing one academy a person's sign-in history discloses nothing
 * about another. Operator events are deliberately NOT here: they carry the operator's written reason.
 */
export const ACCOUNT_LEVEL_EVENTS = [
  "PASSWORD_CHANGED",
  "PASSWORD_CHANGE_FAILED",
  "TEMPORARY_PASSWORD_EXPIRED_SIGNIN",
  "SIGN_IN_LOCKED",
  "MFA_ENROLLMENT_STARTED",
  "MFA_ENABLED",
  "MFA_DISABLED",
  "MFA_RECOVERY_CODES_REGENERATED",
  "MFA_RECOVERY_CODE_USED",
  "GOOGLE_LINKED",
  "GOOGLE_UNLINKED",
  "GOOGLE_SIGN_IN",
  "GOOGLE_SIGN_IN_REFUSED",
  "PASSWORD_RESET_REQUESTED",
  "PASSWORD_RESET_COMPLETED",
  "PASSWORD_RESET_REFUSED",
] as const;
/**
 * Security events a person or an auditor may need later. `detail` is free-form but must never hold
 * a password, token, TOTP secret or recovery code; callers pass only identifiers, counts, times
 * and the human-written reason.
 */
export type SecurityEventName =
  | "PASSWORD_CHANGED"
  | "PASSWORD_CHANGE_FAILED"
  | "ADMIN_PASSWORD_RESET"
  | "ADMIN_RESET_DENIED"
  | "MEMBER_CREDENTIAL_ISSUED"
  | "OPERATOR_RECOVERY"
  | "TEMPORARY_PASSWORD_EXPIRED_SIGNIN"
  | "SIGN_IN_LOCKED"
  | "MFA_ENROLLMENT_STARTED"
  | "MFA_ENABLED"
  | "MFA_DISABLED"
  | "MFA_RECOVERY_CODES_REGENERATED"
  | "MFA_RECOVERY_CODE_USED"
  | "MFA_RESET_BY_ADMIN"
  | "MEMBER_DEACTIVATED"
  | "MEMBER_REACTIVATED"
  | "MEMBER_ROLE_CHANGED"
  | "MEMBER_RENAMED"
  | "PROFILE_UPDATE_REFUSED"
  | "MFA_POLICY_CHANGED"
  | "MFA_EMERGENCY_OVERRIDE"
  | "CONSENT_GRANTED"
  | "CONSENT_RENEWED"
  | "CONSENT_WITHDRAWN"
  | "CONSENT_VERSION_SAVED"
  | "CONSENT_VERSION_PUBLISHED"
  | "REPORT_WITHDRAWN"
  | "NUTRITION_PLAN_WITHDRAWN"
  | "ERASURE_REQUESTED"
  | "ERASURE_APPROVED"
  | "ERASURE_REJECTED"
  | "ERASURE_CANCELLED"
  | "ERASURE_BLOCKED"
  | "ERASURE_COMPLETED"
  | "ERASURE_FAILED"
  | "LEGAL_HOLD_PLACED"
  | "LEGAL_HOLD_RELEASED"
  | "RETENTION_POLICY_CHANGED"
  | "GOOGLE_LINKED"
  | "GOOGLE_UNLINKED"
  | "GOOGLE_SIGN_IN"
  | "GOOGLE_SIGN_IN_REFUSED"
  // Multi-academy (0017): a person chose, or switched to, the academy their session works in.
  | "ACADEMY_SELECTED"
  // A signed-in person started an academy of their own and became its owner.
  | "ACADEMY_CREATED"
  // Invitations (0018): an academy invited a person, withdrew the invitation, or the person accepted or was refused.
  | "INVITATION_CREATED"
  | "INVITATION_REVOKED"
  | "INVITATION_ACCEPTED"
  | "INVITATION_REFUSED"
  // RC-2: owner grant/revoke with in-request password + authenticator step-up (TD-1/TD-2).
  | "OWNER_GRANTED"
  | "OWNER_REVOKED"
  | "OWNER_CHANGE_REAUTH_FAILED"
  // RC-2: two-person operator owner recovery (TD-5 with independent approval, PD-5).
  | "OPERATOR_OWNER_RESTORE_REQUESTED"
  | "OPERATOR_OWNER_RESTORE_DENIED"
  | "OPERATOR_OWNER_RESTORED"
  // Public onboarding: self-service signup, email verification and password recovery.
  | "ACCOUNT_SIGNED_UP"
  | "EMAIL_VERIFIED"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET_COMPLETED"
  | "PASSWORD_RESET_REFUSED";
/**
 * The academy an account unambiguously belongs to (exactly one active membership), else null.
 * Events about self-service actions (password change, authenticator changes, lockouts) carry no
 * academy of their own; resolving it when they are written is what lets the owners of that
 * academy, and only them, review them later.
 */
async function soleAcademy(db: Db, userId: string | null | undefined) {
  if (!userId) return null;
  const rows = await db
    .select({ academyId: memberships.academyId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.active, true)));
  return rows.length === 1 ? rows[0].academyId : null;
}
export async function recordSecurityEvent(
  db: Db,
  event: {
    event: SecurityEventName;
    academyId?: string | null;
    actorId?: string | null;
    targetUserId?: string | null;
    detail?: Record<string, unknown>;
  },
) {
  const academyId =
    event.academyId ??
    (await soleAcademy(db, event.targetUserId)) ??
    (await soleAcademy(db, event.actorId));
  await db.insert(securityEvent).values({
    id: crypto.randomUUID(),
    event: event.event,
    academyId,
    actorId: event.actorId ?? null,
    targetUserId: event.targetUserId ?? null,
    detail: event.detail ?? {},
    // Millisecond precision from the application clock, so the log can be paged by (time, id)
    // without a database clock or time-zone difference reordering rows.
    createdAt: new Date(),
  });
}
