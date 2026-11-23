import { z } from "zod";
import { and, eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import { config } from "../../../shared/config";
import { accessiblePlayers, requirePlayer, unit } from "../../academy/application/access";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { recordSecurityEvent } from "../../identity/security-events";
import { DomainError } from "../../training/domain/rules";
import {
  INVITATION_DEFAULT_DAYS,
  INVITATION_KIND as KIND,
  INVITATION_MAX_DAYS,
  grantsOwnership,
  needsAttestation,
} from "../messages";
import { hashInvitationToken, newInvitationToken } from "../token";
import { isPlayerLinkAddress } from "../player-link";
import { createInvitation } from "./service";

/**
 * The parts of the invitation lifecycle that go beyond create / revoke / accept: resend and bulk invitation.
 * Both are built on the same rules as `service.ts` (they reuse createInvitation or repeat its checks) and neither weakens one.
 */
const DAY = 86_400_000;

/**
 * Resend: one atomic step that kills the old link and makes a fresh one with the same role, player and relationship.
 * A pending invitation is withdrawn (or settled as expired); a revoked or expired one simply gets a new link; an accepted one
 * cannot be resent. The new link has a new token and the old one stops working at once. An OWNER invitation is never resent
 * (it needs the owner's password and second factor, so a new one is created instead), and a nutrition professional's needs the
 * professional authorisation stated again.
 */
export async function resendInvitation(a: Actor, input: unknown) {
  requireCapability(a, "members.manage");
  const v = z
    .object({
      id: z.uuid(),
      expiresInDays: z.number().int().min(1).max(INVITATION_MAX_DAYS).optional(),
      professionalAttestation: z.string().max(500).optional(),
    })
    .parse(input);
  const secret = config().BETTER_AUTH_SECRET;
  const token = newInvitationToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (v.expiresInDays ?? INVITATION_DEFAULT_DAYS) * DAY);
  return unit(a, async (tx) => {
    const [old] = await tx
      .select()
      .from(t.academyInvitations)
      .where(and(eq(t.academyInvitations.academyId, a.academyId), eq(t.academyInvitations.id, v.id)))
      .for("update");
    if (!old) throw new DomainError("Invitation not found.", 404, "NOT_FOUND");
    if (isPlayerLinkAddress(old.inviteeEmail))
      throw new DomainError("A player invitation link cannot be resent. Withdraw it and create a new link.", 422, "PLAYER_LINK_NO_RESEND");
    const expired = old.status === "EXPIRED" || (old.status === "PENDING" && old.expiresAt.getTime() <= now.getTime());
    if (old.status === "ACCEPTED") throw new DomainError("This invitation was already accepted, so there is nothing to resend.", 409, "NOT_PENDING");
    if (grantsOwnership(old.role))
      throw new DomainError("An owner invitation needs your password and second factor again. Create a new invitation instead.", 422, "STEP_UP_REQUIRED");
    if (needsAttestation(old.role) && (v.professionalAttestation ?? "").trim().length < 10)
      throw new DomainError("Record professional authorisation before inviting a nutrition professional.", 422, "ATTESTATION_REQUIRED");
    if (old.kind === KIND.GUARDIAN) {
      requireCapability(a, "guardians.link");
      await requirePlayer(a, old.playerId!, tx);
    }
    const [existing] = await tx
      .select({ id: t.user.id, role: t.memberships.role, active: t.memberships.active })
      .from(t.user)
      .innerJoin(t.memberships, and(eq(t.memberships.userId, t.user.id), eq(t.memberships.academyId, a.academyId)))
      .where(eq(t.user.email, old.inviteeEmail));
    if (existing && !(old.kind === KIND.GUARDIAN && existing.role === old.role && existing.active))
      throw new DomainError("That person already has an account in this academy.", 409, "ALREADY_MEMBER");
    if (old.status === "PENDING") {
      await tx
        .update(t.academyInvitations)
        .set(expired ? { status: "EXPIRED" } : { status: "REVOKED", revokedAt: now, revokedByUserId: a.id })
        .where(eq(t.academyInvitations.id, old.id));
      if (!expired)
        await recordSecurityEvent(tx, {
          event: "INVITATION_REVOKED",
          academyId: a.academyId,
          actorId: a.id,
          detail: { ref: old.id, kind: old.kind, toRole: old.role, via: "resend" },
        });
    }
    const [row] = await tx
      .insert(t.academyInvitations)
      .values({
        academyId: a.academyId,
        inviteeEmail: old.inviteeEmail,
        kind: old.kind,
        role: old.role,
        playerId: old.playerId,
        relationship: old.relationship,
        tokenHash: hashInvitationToken(token, secret),
        invitedByUserId: a.id,
        createdAt: now,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: t.academyInvitations.id });
    if (!row) throw new DomainError("There is already an open invitation for this address.", 409, "DUPLICATE_INVITATION");
    await recordSecurityEvent(tx, {
      event: "INVITATION_CREATED",
      academyId: a.academyId,
      actorId: a.id,
      detail: { ref: row.id, kind: old.kind, toRole: old.role, expiresAt: expiresAt.toISOString(), resentFrom: old.id },
    });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: row.id,
      action: "invitation-resend",
      version: 1,
      detail: {
        role: old.role,
        kind: old.kind,
        resentFrom: old.id,
        ...(needsAttestation(old.role) ? { professionalAttestation: v.professionalAttestation } : {}),
      },
    });
    return {
      id: row.id,
      email: old.inviteeEmail,
      kind: old.kind,
      role: old.role,
      expiresAt: expiresAt.toISOString(),
      resentFrom: old.id,
      token,
      link: `${config().BETTER_AUTH_URL.replace(/\/+$/, "")}/invite#${token}`,
    };
  });
}

export type BulkInviteRow = {
  line: number;
  ok: boolean;
  email: string;
  playerName: string | null;
  who: string;
  phone: string;
  error?: string;
  link?: string;
  expiresAt?: string;
};
/**
 * Parent invitations for a whole roster at once. Each row names a player (by id, or by exact name), a parent's e-mail address
 * and a relationship. Every row goes through the ordinary createInvitation, so every rule applies per row: one open invitation
 * per parent and player, none for someone already linked, none for a player the actor cannot see. A parent of several children
 * appears on several rows and ends with ONE account and one link per child. A row that fails does not stop the others. The
 * links are returned once; the name and phone are returned only so the screen can open WhatsApp, and are not stored.
 */
export async function bulkInviteGuardians(a: Actor, input: unknown) {
  requireCapability(a, "members.manage");
  requireCapability(a, "guardians.link");
  const v = z
    .object({
      rows: z
        .array(
          z.object({
            playerId: z.string().max(200).optional(),
            playerName: z.string().trim().max(120).optional(),
            email: z.string().trim().max(254),
            relationship: z.string().trim().max(50).default("Parent"),
            who: z.string().trim().max(60).default(""),
            phone: z.string().trim().max(40).default(""),
          }),
        )
        .min(1)
        .max(200),
    })
    .parse(input);
  const players = await unit(a, async (tx) => accessiblePlayers(a, tx));
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const rows: BulkInviteRow[] = [];
  for (const [i, r] of v.rows.entries()) {
    const base = { line: i + 1, email: r.email, playerName: null as string | null, who: r.who, phone: r.phone };
    try {
      const matches = r.playerId ? players.filter((p) => p.id === r.playerId) : players.filter((p) => norm(p.name) === norm(r.playerName ?? ""));
      if (matches.length === 0) throw new DomainError("No player with that name or id.", 404);
      if (matches.length > 1) throw new DomainError("More than one player has that name. Use the player's id.", 409);
      base.playerName = matches[0].name;
      if (r.relationship.length < 2) throw new DomainError("Give the relationship (for example Mother, Father, Guardian).", 422);
      const made = await createInvitation(a, { email: r.email, kind: KIND.GUARDIAN, playerId: matches[0].id, relationship: r.relationship });
      rows.push({ ...base, ok: true, link: made.link, expiresAt: made.expiresAt });
    } catch (e) {
      if (e instanceof DomainError) rows.push({ ...base, ok: false, error: e.message });
      else if (e instanceof z.ZodError) rows.push({ ...base, ok: false, error: "That is not a valid e-mail address." });
      else throw e;
    }
  }
  return { rows, created: rows.filter((r) => r.ok).length };
}
