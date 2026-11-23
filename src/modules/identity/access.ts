import { auth } from "./auth";
import { resolveMembership } from "./active-academy";
import { DomainError } from "../training/domain/rules";
import { accountGate } from "./account-gate";
import { MEMBERSHIP_MESSAGES } from "./membership-messages";
import { authorityOf, can } from "./authority";
export type Actor = {
  id: string;
  name: string;
  academyId: string;
  role: string;
  timezone: string;
  academyName: string;
};
export async function resolveActor(
  headers: Headers,
  audience: "training" | "academy" = "training",
): Promise<Actor> {
  const authenticated = await auth().api.getSession({ headers });
  if (!authenticated) throw new DomainError("Sign in to continue.", 401);
  // Which academy this request acts in is decided here, on the server, from the person's CURRENT memberships and the
  // choice stored for this session (active-academy.ts). No client academy id is ever accepted. Each way of having no
  // usable academy gets its own stable code and an answer the person can act on; none names an academy, a
  // membership or an identifier, and none grants anything.
  const resolution = await resolveMembership(authenticated.user.id, authenticated.session.id);
  if (resolution.status === "none")
    throw new DomainError(MEMBERSHIP_MESSAGES[resolution.code], 403, resolution.code);
  const membership = resolution.status === "resolved" ? resolution.chosen : null;
  // Forced password rotation / MFA enrolment apply to the application APIs as well as to the
  // authentication endpoints, so a gated session cannot read or write academy data. The two-factor requirement is
  // about the PERSON (the authenticator is theirs, not an academy's), so the strictest requirement across ALL their
  // active memberships applies wherever they are working.
  const gate = await accountGate({
    userId: authenticated.user.id,
    twoFactorEnabled: !!(authenticated.user as { twoFactorEnabled?: boolean })
      .twoFactorEnabled,
    memberships: resolution.active.map((m) => ({ academyId: m.academyId, role: m.role })),
  });
  if (gate) throw new DomainError(gate.message, 403, gate.code);
  // Several academies and none chosen for this session: nothing is readable until the person chooses. (The gate is
  // answered first, so a person who still has to replace a temporary password is told that, not asked to choose.)
  if (!membership)
    throw new DomainError(
      MEMBERSHIP_MESSAGES.ACADEMY_SELECTION_REQUIRED,
      409,
      "ACADEMY_SELECTION_REQUIRED",
    );
  if (audience === "training" && !can(membership, "training.studio"))
    throw new DomainError(
      "Training Studio is available to authorised coaching staff.",
      403,
    );
  // Only the eight stored roles have an authority; anything else is refused (and would be denied everything).
  if (authorityOf(membership.role) === null)
    throw new DomainError(
      "This role has no workspace access.",
      403,
      "ROLE_NOT_SUPPORTED",
    );
  return {
    id: authenticated.user.id,
    // How THIS academy shows the person; their own name when the academy has not set one.
    name: membership.displayName ?? authenticated.user.name,
    academyId: membership.academyId,
    role: membership.role,
    timezone: membership.timezone,
    academyName: membership.academyName,
  };
}
/** Sees and manages every training session and batch, not only its own (capability `training.allSessions`). */
export const isManager = (actor: Actor) => can(actor, "training.allSessions");
