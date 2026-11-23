import { STORED_ROLES, authorityOf, type StoredRole } from "../identity/authority";
/**
 * What the invitation screens say, by the stable code the server answers with. Client-safe (no server imports).
 * None of these names an academy, a person or an identifier: a token holder gets those from the preview, not from an error.
 */
export const INVITATION_MESSAGES = {
  INVALID_INVITATION: "This invitation link is not valid. Ask the academy to send you a new one.",
  INVITATION_EXPIRED: "This invitation has expired. Ask the academy to send you a new one.",
  INVITATION_REVOKED: "This invitation was withdrawn by the academy. Ask them to send you a new one if you still need access.",
  INVITATION_ALREADY_USED: "This invitation has already been used.",
  WRONG_ACCOUNT:
    "This invitation was sent to a different email address. Sign in with the account it was sent to, or ask the academy to invite the address you use.",
  ALREADY_MEMBER:
    "Your account already has a place in this academy, so there is nothing to accept. If your access was switched off, ask the academy owner to restore it.",
  INVITATION_NO_LONGER_VALID:
    "This invitation can no longer be accepted because the person who sent it no longer has the authority to. Ask the academy to send you a new one.",
} as const;
export type InvitationCode = keyof typeof INVITATION_MESSAGES;
/** The three kinds of invitation. (Two share a name with the stored role they create; they are kinds, not authority.) */
export const INVITATION_KIND = { STAFF: "STAFF", GUARDIAN: "GUARDIAN", ADULT_PLAYER: "ADULT_PLAYER" } as const;
export const INVITATION_KINDS = [INVITATION_KIND.STAFF, INVITATION_KIND.GUARDIAN, INVITATION_KIND.ADULT_PLAYER] as const;
export type InvitationKind = (typeof INVITATION_KINDS)[number];
/** Granting this role makes somebody an OWNER, so creating the invitation needs the owner's password + authenticator step-up. */
export const grantsOwnership = (role: string) => authorityOf(role)?.accountType === "OWNER";
/** This role is a nutrition professional, whose professional authorisation must be recorded. */
export const needsAttestation = (role: string) => authorityOf(role)?.designation === "NUTRITION_PRO";
/**
 * The roles a STAFF invitation may grant: every stored role whose account type is an owner or staff (so not the family roles).
 * Derived from the authority module, so a new staff role appears here without a second list to keep in step. The database
 * CHECK on academy_invitation (0018) pins the same six.
 */
export const STAFF_INVITATION_ROLES = STORED_ROLES.filter((role) => {
  const type = authorityOf(role)?.accountType;
  return type === "OWNER" || type === "STAFF";
}) as readonly StoredRole[];
/** How the invitations list names a player link (its stored address is generated and never shown). */
export const PLAYER_LINK_LABEL = "Player invitation link";
export type InvitationStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
/** How long a new invitation stays valid unless the owner chooses otherwise. */
export const INVITATION_DEFAULT_DAYS = 7;
export const INVITATION_MAX_DAYS = 30;
