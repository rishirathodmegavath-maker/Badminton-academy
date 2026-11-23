import type { SecurityEventName } from "./security-events";
/**
 * How each security event is presented. Pure data (no server imports) so the Settings page and the
 * API share one vocabulary. `outcome` is what the person reviewing the log cares about first.
 */
export type SecurityOutcome =
  "success" | "failed" | "denied" | "locked" | "refused";
export const SECURITY_OUTCOMES: readonly SecurityOutcome[] = [
  "success",
  "failed",
  "denied",
  "locked",
  "refused",
];
export const SECURITY_EVENT_META: Record<
  SecurityEventName,
  { label: string; outcome: SecurityOutcome }
> = {
  PASSWORD_CHANGED: { label: "Password changed", outcome: "success" },
  PASSWORD_CHANGE_FAILED: {
    label: "Password change failed (current password wrong)",
    outcome: "failed",
  },
  ADMIN_PASSWORD_RESET: {
    label: "Password reset by an owner",
    outcome: "success",
  },
  ADMIN_RESET_DENIED: {
    label: "Password reset refused",
    outcome: "denied",
  },
  MEMBER_CREDENTIAL_ISSUED: {
    label: "Temporary password issued to a new member",
    outcome: "success",
  },
  OPERATOR_RECOVERY: {
    label: "Account recovered by the server operator",
    outcome: "success",
  },
  TEMPORARY_PASSWORD_EXPIRED_SIGNIN: {
    label: "Sign-in refused: temporary password expired",
    outcome: "refused",
  },
  SIGN_IN_LOCKED: {
    label: "Sign-in paused after repeated failures",
    outcome: "locked",
  },
  MFA_ENROLLMENT_STARTED: {
    label: "Two-factor setup started",
    outcome: "success",
  },
  MFA_ENABLED: { label: "Two-factor authentication enabled", outcome: "success" },
  MFA_DISABLED: {
    label: "Two-factor authentication disabled",
    outcome: "success",
  },
  MFA_RECOVERY_CODES_REGENERATED: {
    label: "Recovery codes regenerated",
    outcome: "success",
  },
  MFA_RECOVERY_CODE_USED: { label: "Recovery code used", outcome: "success" },
  MFA_RESET_BY_ADMIN: {
    label: "Authenticator removed by an owner",
    outcome: "success",
  },
  MEMBER_DEACTIVATED: {
    label: "Member deactivated (sessions ended)",
    outcome: "success",
  },
  MEMBER_REACTIVATED: { label: "Member reactivated", outcome: "success" },
  MEMBER_ROLE_CHANGED: { label: "Member role changed", outcome: "success" },
  MEMBER_RENAMED: { label: "Member name changed by an owner", outcome: "success" },
  PROFILE_UPDATE_REFUSED: {
    label: "Self-service profile change refused",
    outcome: "refused",
  },
  MFA_POLICY_CHANGED: {
    label: "Two-factor policy changed",
    outcome: "success",
  },
  MFA_EMERGENCY_OVERRIDE: {
    label: "Two-factor warning period skipped (owner emergency override)",
    outcome: "success",
  },
  CONSENT_GRANTED: { label: "Consent granted", outcome: "success" },
  CONSENT_RENEWED: { label: "Consent renewed", outcome: "success" },
  CONSENT_WITHDRAWN: { label: "Consent withdrawn", outcome: "success" },
  CONSENT_VERSION_SAVED: {
    label: "Consent document draft saved",
    outcome: "success",
  },
  CONSENT_VERSION_PUBLISHED: {
    label: "Consent document published",
    outcome: "success",
  },
  REPORT_WITHDRAWN: {
    label: "Report withdrawn from families",
    outcome: "success",
  },
  NUTRITION_PLAN_WITHDRAWN: {
    label: "Nutrition plan withdrawn from families",
    outcome: "success",
  },
  ERASURE_REQUESTED: { label: "Erasure requested", outcome: "success" },
  ERASURE_APPROVED: { label: "Erasure approved (grace period started)", outcome: "success" },
  ERASURE_REJECTED: { label: "Erasure rejected", outcome: "refused" },
  ERASURE_CANCELLED: { label: "Erasure cancelled", outcome: "success" },
  ERASURE_BLOCKED: { label: "Erasure blocked by a legal hold", outcome: "refused" },
  ERASURE_COMPLETED: { label: "Erasure completed", outcome: "success" },
  ERASURE_FAILED: { label: "Erasure failed (needs attention)", outcome: "failed" },
  LEGAL_HOLD_PLACED: { label: "Legal hold placed", outcome: "success" },
  LEGAL_HOLD_RELEASED: { label: "Legal hold released", outcome: "success" },
  RETENTION_POLICY_CHANGED: { label: "Retention rule changed", outcome: "success" },
  GOOGLE_LINKED: { label: "Google sign-in linked to the account", outcome: "success" },
  GOOGLE_UNLINKED: { label: "Google sign-in unlinked from the account", outcome: "success" },
  GOOGLE_SIGN_IN: { label: "Signed in with Google", outcome: "success" },
  GOOGLE_SIGN_IN_REFUSED: { label: "Google sign-in refused", outcome: "refused" },
  ACADEMY_SELECTED: { label: "Chose this academy to work in", outcome: "success" },
  ACADEMY_CREATED: { label: "Started this academy and became its owner", outcome: "success" },
  INVITATION_CREATED: { label: "Invitation to join the academy created", outcome: "success" },
  INVITATION_REVOKED: { label: "Invitation to join the academy withdrawn", outcome: "success" },
  INVITATION_ACCEPTED: { label: "Invitation accepted: joined the academy", outcome: "success" },
  INVITATION_REFUSED: { label: "Invitation could not be accepted", outcome: "refused" },
  OWNER_GRANTED: { label: "Owner access granted (password and code confirmed)", outcome: "success" },
  OWNER_REVOKED: { label: "Owner access removed (password and code confirmed)", outcome: "success" },
  OWNER_CHANGE_REAUTH_FAILED: {
    label: "Owner change refused: confirmation failed",
    outcome: "denied",
  },
  OPERATOR_OWNER_RESTORE_REQUESTED: {
    label: "Owner recovery requested by the server operator",
    outcome: "success",
  },
  OPERATOR_OWNER_RESTORE_DENIED: {
    label: "Owner recovery approval refused",
    outcome: "denied",
  },
  OPERATOR_OWNER_RESTORED: {
    label: "Owner restored by two server operators",
    outcome: "success",
  },
  ACCOUNT_SIGNED_UP: { label: "Account created by self-service signup", outcome: "success" },
  EMAIL_VERIFIED: { label: "Email address verified", outcome: "success" },
  PASSWORD_RESET_REQUESTED: {
    label: "Password reset link requested",
    outcome: "success",
  },
  PASSWORD_RESET_COMPLETED: {
    label: "Password reset by email link",
    outcome: "success",
  },
  PASSWORD_RESET_REFUSED: {
    label: "Password reset by email refused",
    outcome: "refused",
  },
};
export const SECURITY_EVENT_NAMES = Object.keys(
  SECURITY_EVENT_META,
) as SecurityEventName[];
