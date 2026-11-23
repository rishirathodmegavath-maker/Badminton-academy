/**
 * Who may reset whose password through the administrative workflow. Pure and exhaustive so the
 * rules can be tested without a server. Authority comes from the database membership rows the
 * caller passes in, never from anything the client claims.
 *
 *  - Only an OWNER may start a reset; no other role (including ADMIN) is given this power.
 *  - Never your own account: use the password-change flow instead.
 *  - Only members of the owner's own academy; any other target looks exactly like a non-member.
 *  - Never another OWNER: an owner reset is an operator recovery, not something a peer can do.
 *  - Never an account that also belongs to another academy: one academy must not be able to cut
 *    off a person's access to a different one.
 */
import { can } from "./authority";
export type ResetDenial =
  | "NOT_OWNER"
  | "SELF"
  | "TARGET_NOT_MEMBER"
  | "TARGET_IS_OWNER"
  | "TARGET_MULTI_ACADEMY";
export type ResetActor = { id: string; academyId: string; role: string };
export type ResetTarget = {
  id: string;
  /** Every active membership the target holds, in any academy. */
  memberships: readonly { academyId: string; role: string }[];
};
export function resetDecision(
  actor: ResetActor,
  target: ResetTarget,
): { allowed: true } | { allowed: false; reason: ResetDenial } {
  if (!can(actor, "members.resetCredentials")) return { allowed: false, reason: "NOT_OWNER" };
  if (target.id === actor.id) return { allowed: false, reason: "SELF" };
  const here = target.memberships.find((m) => m.academyId === actor.academyId);
  if (!here) return { allowed: false, reason: "TARGET_NOT_MEMBER" };
  if (target.memberships.some((m) => m.academyId !== actor.academyId))
    return { allowed: false, reason: "TARGET_MULTI_ACADEMY" };
  if (here.role === "OWNER")
    return { allowed: false, reason: "TARGET_IS_OWNER" };
  return { allowed: true };
}
export const DENIAL_RESPONSE: Record<
  ResetDenial,
  { status: "FORBIDDEN" | "NOT_FOUND" | "CONFLICT"; message: string }
> = {
  NOT_OWNER: {
    status: "FORBIDDEN",
    message: "Only an academy owner can reset a member's password.",
  },
  SELF: {
    status: "FORBIDDEN",
    message: "You cannot reset your own password here. Use Change password.",
  },
  // Identical to a genuinely unknown id, so the endpoint cannot be used to discover accounts.
  TARGET_NOT_MEMBER: { status: "NOT_FOUND", message: "Member not found." },
  TARGET_IS_OWNER: {
    status: "FORBIDDEN",
    message:
      "An owner account cannot be reset by another account. Use the operator recovery procedure.",
  },
  TARGET_MULTI_ACADEMY: {
    status: "CONFLICT",
    message:
      "This login belongs to more than one academy, so one academy cannot reset it. The person can reset it themselves by email if their address is verified, or the operator can recover the account.",
  },
};
