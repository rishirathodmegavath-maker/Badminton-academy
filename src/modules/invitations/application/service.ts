import { z } from "zod";
import { and, desc, eq, lt } from "drizzle-orm";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import { config } from "../../../shared/config";
import { requirePlayer, scopedBatch, unit } from "../../academy/application/access";
import type { Actor } from "../../identity/access";
import { can, requireCapability } from "../../identity/authority";
import { shownName } from "../../identity/membership";
import { verifyOwnerMfaStepUp } from "../../identity/owner-step-up";
import { recordSecurityEvent } from "../../identity/security-events";
import { DomainError } from "../../training/domain/rules";
import { COUNTRY_CALLING_CODE, canonicalPhone } from "../../communications/share-links";
import { upsertOptIn } from "../../contacts/application/service";
import {
  INVITATION_DEFAULT_DAYS,
  INVITATION_MAX_DAYS,
  INVITATION_KIND as KIND,
  INVITATION_MESSAGES,
  PLAYER_LINK_LABEL,
  STAFF_INVITATION_ROLES,
  grantsOwnership,
  needsAttestation,
  type InvitationCode,
  type InvitationStatus,
} from "../messages";
import { hashInvitationToken, looksLikeInvitationToken, maskEmail, newInvitationToken } from "../token";
import { PLAYER_LINK_DEFAULT_DAYS, PLAYER_LINK_MAX_BATCH_ID, PLAYER_LINK_MAX_DAYS, isPlayerLinkAddress, parsePlayerLinkAddress, playerLinkAddress } from "../player-link";

/**
 * Academy invitations (migration 0018). An invitation is how a person joins an academy: it is never implied by an
 * email address. The rules, in one place:
 *
 *  - CREATING, LISTING and REVOKING are academy actions: an actor of the academy (resolveActor) holding `members.manage`
 *    (an OWNER, today), inside the academy's unit of work, always scoped to the actor's own academy. Inviting an OWNER
 *    needs the same password + second-factor step-up as granting OWNER anywhere else (verifyOwnerMfaStepUp). A
 *    GUARDIAN invitation also needs `guardians.link` and names a player the actor may see.
 *  - The token is shown once to the creator and stored only as a keyed hash (token.ts). It travels in a URL fragment and
 *    in request bodies, never in a path or query, so it reaches no access log and no Referer.
 *  - ACCEPTING is done by the signed-in invitee, who is not a member yet, so it is not an academy request. It runs in one
 *    transaction that takes the academy lock first (the same order as unit()), then the invitation row FOR UPDATE, and
 *    re-validates everything at that moment: pending and unexpired, addressed to THIS account's email, the inviter still
 *    holds the authority the invitation needed, the person has no membership yet (a guardian may gain another child).
 *    Only then the membership (and, for a guardian, the link with NO consent granted) is created. A second acceptance by
 *    the same person is idempotent; by anyone else it is refused.
 *  - Nothing here sends email. The creator hands the link over; email delivery is not a dependency of joining.
 */
const roleOf = z.enum(STAFF_INVITATION_ROLES as unknown as [string, ...string[]]);
const createInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  kind: z.enum([KIND.STAFF, KIND.GUARDIAN, KIND.ADULT_PLAYER]),
  role: roleOf.optional(),
  playerId: z.string().min(1).max(200).optional(),
  relationship: z.string().trim().min(2).max(50).optional(),
  expiresInDays: z.number().int().min(1).max(INVITATION_MAX_DAYS).optional(),
  // Required for NUTRITION_PRO, as when an owner creates that login directly.
  professionalAttestation: z.string().max(500).optional(),
  // Required only when the invitation grants OWNER (verified, never stored or logged).
  ownerPassword: z.unknown().optional(),
  mfaCode: z.unknown().optional(),
});
const DAY = 86_400_000;
const fail = (code: InvitationCode, status: number) => new DomainError(INVITATION_MESSAGES[code], status, code);
const displayStatus = (row: { status: string; expiresAt: Date }, now: Date): InvitationStatus =>
  row.status === "PENDING" && row.expiresAt.getTime() <= now.getTime() ? "EXPIRED" : (row.status as InvitationStatus);

export async function createInvitation(a: Actor, input: unknown) {
  requireCapability(a, "members.manage");
  const v = createInput.parse(input);
  if (v.kind === KIND.ADULT_PLAYER)
    throw new DomainError("Players do not have their own login: they are under 18, so invite a parent or guardian instead.", 422, "ADULT_PLAYERS_NOT_SUPPORTED");
  const role = v.kind === "STAFF" ? v.role : v.kind === "GUARDIAN" ? "GUARDIAN" : "ADULT_PLAYER";
  if (!role) throw new DomainError("Choose the role this person will have.", 422, "ROLE_REQUIRED");
  if (v.kind !== "STAFF" && v.role) throw new DomainError("This kind of invitation fixes the role.", 422);
  if (v.kind === "GUARDIAN") {
    requireCapability(a, "guardians.link");
    if (!v.playerId || !v.relationship)
      throw new DomainError("A guardian invitation needs the player and the relationship.", 422, "PLAYER_REQUIRED");
  } else if (v.playerId || v.relationship) throw new DomainError("Only a guardian invitation names a player.", 422);
  if (needsAttestation(role) && (v.professionalAttestation ?? "").trim().length < 10)
    throw new DomainError("Record professional authorisation before inviting a nutrition professional.");
  const secret = config().BETTER_AUTH_SECRET;
  // Granting OWNER needs the acting owner's password and second factor, checked before any lock is taken.
  const stepUp =
    grantsOwnership(role)
      ? await verifyOwnerMfaStepUp({
          actorId: a.id,
          academyId: a.academyId,
          ownerPassword: v.ownerPassword,
          mfaCode: v.mfaCode,
          change: "GRANT",
          targetUserId: null,
        })
      : null;
  const token = newInvitationToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (v.expiresInDays ?? INVITATION_DEFAULT_DAYS) * DAY);
  return unit(a, async (tx) => {
    if (v.kind === "GUARDIAN") await requirePlayer(a, v.playerId!, tx);
    // Somebody who already has a place in THIS academy is not invited again (a guardian may be invited for another child).
    const [existing] = await tx
      .select({ id: t.user.id, role: t.memberships.role, active: t.memberships.active })
      .from(t.user)
      .innerJoin(t.memberships, and(eq(t.memberships.userId, t.user.id), eq(t.memberships.academyId, a.academyId)))
      .where(eq(t.user.email, v.email));
    if (existing && !(v.kind === "GUARDIAN" && existing.role === "GUARDIAN" && existing.active))
      throw new DomainError(
        "That person already has an account in this academy. Change their access under Staff & family access instead.",
        409,
        "ALREADY_MEMBER",
      );
    if (existing && v.kind === "GUARDIAN") {
      const [link] = await tx
        .select({ active: t.guardianLinks.active })
        .from(t.guardianLinks)
        .where(and(eq(t.guardianLinks.academyId, a.academyId), eq(t.guardianLinks.playerId, v.playerId!), eq(t.guardianLinks.userId, existing.id)));
      if (link?.active) throw new DomainError("That guardian is already linked to this player.", 409, "ALREADY_MEMBER");
    }
    // An invitation that ran out is settled first, so the address can be invited again.
    await tx
      .update(t.academyInvitations)
      .set({ status: "EXPIRED" })
      .where(
        and(
          eq(t.academyInvitations.academyId, a.academyId),
          eq(t.academyInvitations.inviteeEmail, v.email),
          eq(t.academyInvitations.status, "PENDING"),
          // an invitation is live until its expiry; only past ones are settled
          lessThanNow(now),
        ),
      );
    const [row] = await tx
      .insert(t.academyInvitations)
      .values({
        academyId: a.academyId,
        inviteeEmail: v.email,
        kind: v.kind,
        role,
        playerId: v.kind === "GUARDIAN" ? v.playerId : null,
        relationship: v.kind === "GUARDIAN" ? v.relationship : null,
        tokenHash: hashInvitationToken(token, secret),
        invitedByUserId: a.id,
        createdAt: now,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: t.academyInvitations.id });
    if (!row)
      throw new DomainError(
        "There is already an open invitation for this address. Use Resend on it to send a fresh link, or withdraw it first.",
        409,
        "DUPLICATE_INVITATION",
      );
    await recordSecurityEvent(tx, {
      event: "INVITATION_CREATED",
      academyId: a.academyId,
      actorId: a.id,
      detail: { ref: row.id, kind: v.kind, toRole: role, expiresAt: expiresAt.toISOString(), ...(stepUp ? { method: stepUp.method } : {}) },
    });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: row.id,
      action: "invitation-create",
      version: 1,
      detail: { role, kind: v.kind, ...(needsAttestation(role) ? { professionalAttestation: v.professionalAttestation } : {}) },
    });
    return {
      id: row.id,
      email: v.email,
      kind: v.kind,
      role,
      expiresAt: expiresAt.toISOString(),
      // The only time the token exists in plaintext: the creator hands this link to the person (nothing is emailed).
      token,
      link: `${config().BETTER_AUTH_URL.replace(/\/+$/, "")}/invite#${token}`,
    };
  });
}
const lessThanNow = (now: Date) => lt(t.academyInvitations.expiresAt, now);

/**
 * "Add player" by invitation link. The person who may add players (`players.manage`) chooses the batch and, if they like, how
 * long the link lasts. Nobody is named: whoever opens the link first signs in with any email and becomes THE PLAYER'S OWN login
 * (role ADULT_PLAYER, which sees only the schedule, reports and media of their own record), then fills in their own details.
 * The link works once, expires (3 days unless chosen otherwise), is shown only now, can be withdrawn like any invitation, and
 * is recorded in the audit and security history. See player-link.ts for how it is stored.
 */
const playerLinkInput = z.object({
  batchId: z.string().min(1).max(PLAYER_LINK_MAX_BATCH_ID),
  expiresInDays: z.number().int().min(1).max(PLAYER_LINK_MAX_DAYS).optional(),
});
export async function createPlayerLink(a: Actor, input: unknown) {
  requireCapability(a, "players.manage");
  const v = playerLinkInput.parse(input);
  const token = newInvitationToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (v.expiresInDays ?? PLAYER_LINK_DEFAULT_DAYS) * DAY);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  return unit(a, async (tx) => {
    // The batch is one of this academy's that this person may use; the same check as adding a player to it.
    await scopedBatch(a, v.batchId, tx);
    const [row] = await tx
      .insert(t.academyInvitations)
      .values({
        academyId: a.academyId,
        inviteeEmail: playerLinkAddress(v.batchId, nonce),
        kind: "ADULT_PLAYER",
        role: "ADULT_PLAYER",
        playerId: null,
        relationship: null,
        tokenHash: hashInvitationToken(token, config().BETTER_AUTH_SECRET),
        invitedByUserId: a.id,
        createdAt: now,
        expiresAt,
      })
      .returning({ id: t.academyInvitations.id });
    await recordSecurityEvent(tx, {
      event: "INVITATION_CREATED",
      academyId: a.academyId,
      actorId: a.id,
      detail: { ref: row.id, kind: "PLAYER_LINK", toRole: "ADULT_PLAYER", expiresAt: expiresAt.toISOString() },
    });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: row.id,
      action: "invitation-create",
      version: 1,
      detail: { role: "ADULT_PLAYER", kind: "PLAYER_LINK", batchId: v.batchId },
    });
    return {
      id: row.id,
      kind: "PLAYER_LINK" as const,
      expiresAt: expiresAt.toISOString(),
      // The only time the token exists in plaintext: the creator hands this link on (nothing is emailed).
      link: `${config().BETTER_AUTH_URL.replace(/\/+$/, "")}/invite#${token}`,
    };
  });
}

/** This academy's invitations, newest first, with the state as of now. No token, no hash. */
export async function listInvitations(a: Actor) {
  requireCapability(a, "members.manage");
  const now = new Date();
  const rows = await database()
    .select({
      invitation: t.academyInvitations,
      inviter: shownName,
      player: t.players.name,
    })
    .from(t.academyInvitations)
    .innerJoin(
      t.memberships,
      and(eq(t.memberships.academyId, t.academyInvitations.academyId), eq(t.memberships.userId, t.academyInvitations.invitedByUserId)),
    )
    .innerJoin(t.user, eq(t.user.id, t.memberships.userId))
    .leftJoin(t.players, and(eq(t.players.academyId, t.academyInvitations.academyId), eq(t.players.id, t.academyInvitations.playerId)))
    .where(eq(t.academyInvitations.academyId, a.academyId))
    .orderBy(desc(t.academyInvitations.createdAt))
    .limit(200);
  return {
    invitations: rows.map(({ invitation: i, inviter, player }) => ({
      id: i.id,
      email: isPlayerLinkAddress(i.inviteeEmail) ? PLAYER_LINK_LABEL : i.inviteeEmail,
      kind: i.kind,
      role: i.role,
      relationship: i.relationship,
      playerName: player ?? null,
      status: displayStatus(i, now),
      invitedBy: inviter,
      createdAt: i.createdAt.toISOString(),
      expiresAt: i.expiresAt.toISOString(),
      acceptedAt: i.acceptedAt?.toISOString() ?? null,
      revokedAt: i.revokedAt?.toISOString() ?? null,
    })),
  };
}

/** Withdraws a pending invitation of THIS academy. Withdrawing grants nothing, so it needs no second factor. */
export async function revokeInvitation(a: Actor, input: unknown) {
  requireCapability(a, "members.manage");
  const v = z.object({ id: z.uuid() }).parse(input);
  return unit(a, async (tx) => {
    const [row] = await tx
      .select()
      .from(t.academyInvitations)
      .where(and(eq(t.academyInvitations.academyId, a.academyId), eq(t.academyInvitations.id, v.id)))
      .for("update");
    if (!row) throw new DomainError("Invitation not found.", 404, "NOT_FOUND");
    const now = new Date();
    const status = displayStatus(row, now);
    if (status !== "PENDING")
      throw new DomainError(
        status === "ACCEPTED" ? "This invitation was already accepted." : status === "REVOKED" ? "This invitation was already withdrawn." : "This invitation has already expired.",
        409,
        "NOT_PENDING",
      );
    await tx
      .update(t.academyInvitations)
      .set({ status: "REVOKED", revokedAt: now, revokedByUserId: a.id })
      .where(and(eq(t.academyInvitations.academyId, a.academyId), eq(t.academyInvitations.id, row.id)));
    await recordSecurityEvent(tx, {
      event: "INVITATION_REVOKED",
      academyId: a.academyId,
      actorId: a.id,
      detail: { ref: row.id, kind: row.kind, toRole: row.role },
    });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: row.id,
      action: "invitation-revoke",
      version: 1,
      detail: { role: row.role },
    });
    return { id: row.id, status: "REVOKED" as const };
  });
}

/**
 * What the holder of a token is being offered, for the review screen. Needs no account (the person may not have one yet),
 * so it answers only for a valid token and tells an unknown token from nothing else. It names the academy, the role and,
 * masked, the address; never a person or a player.
 */
export async function previewInvitation(token: unknown) {
  if (!looksLikeInvitationToken(token)) throw fail("INVALID_INVITATION", 404);
  const [row] = await database()
    .select({ invitation: t.academyInvitations, academy: t.academies.name, inviter: shownName })
    .from(t.academyInvitations)
    .innerJoin(t.academies, eq(t.academies.id, t.academyInvitations.academyId))
    .innerJoin(
      t.memberships,
      and(eq(t.memberships.academyId, t.academyInvitations.academyId), eq(t.memberships.userId, t.academyInvitations.invitedByUserId)),
    )
    .innerJoin(t.user, eq(t.user.id, t.memberships.userId))
    .where(eq(t.academyInvitations.tokenHash, hashInvitationToken(token, config().BETTER_AUTH_SECRET)));
  if (!row) throw fail("INVALID_INVITATION", 404);
  const i = row.invitation;
  return {
    status: displayStatus(i, new Date()),
    academyName: row.academy,
    kind: i.kind,
    role: i.role,
    relationship: i.relationship,
    emailHint: isPlayerLinkAddress(i.inviteeEmail) ? "Any email address" : maskEmail(i.inviteeEmail),
    invitedBy: row.inviter,
    expiresAt: i.expiresAt.toISOString(),
  };
}

type Accepted = { academyId: string; academyName: string; role: string; kind: string; alreadyAccepted: boolean };
type Outcome = { ok: true; accepted: Accepted } | { ok: false; error: DomainError; refusal?: { academyId: string; ref: string; reason: string } };

/**
 * The signed-in person accepts the invitation their token opens. Everything is decided inside one transaction under the
 * academy lock (see the header). `person` comes from the session, never from the request.
 *
 * `phone` is the number the person typed on the accept page, so the academy can reach them on WhatsApp without asking again.
 * It is optional and is read in the academy's own country when typed without a country code. It is saved to the person's
 * account (app_user.phone) in the same transaction as the membership, so an invitation that is refused saves nothing.
 */
export async function acceptInvitation(
  person: { id: string; email: string },
  token: unknown,
  phone?: string | null,
  whatsappOptIn?: boolean,
): Promise<Accepted> {
  if (!looksLikeInvitationToken(token)) throw fail("INVALID_INVITATION", 404);
  const typedPhone = (phone ?? "").trim();
  const hash = hashInvitationToken(token, config().BETTER_AUTH_SECRET);
  const [peek] = await database()
    .select({ id: t.academyInvitations.id, academyId: t.academyInvitations.academyId })
    .from(t.academyInvitations)
    .where(eq(t.academyInvitations.tokenHash, hash));
  if (!peek) throw fail("INVALID_INVITATION", 404);
  const outcome = await database().transaction(async (tx): Promise<Outcome> => {
    // Same order as unit(): the academy first, so this cannot deadlock with a member change in the same academy.
    await tx.select().from(t.academies).where(eq(t.academies.id, peek.academyId)).for("update");
    const [inv] = await tx.select().from(t.academyInvitations).where(eq(t.academyInvitations.id, peek.id)).for("update");
    if (!inv) return { ok: false, error: fail("INVALID_INVITATION", 404) };
    const [academy] = await tx.select().from(t.academies).where(eq(t.academies.id, inv.academyId));
    const now = new Date();
    const refused = (code: InvitationCode, status: number, reason: string): Outcome => ({
      ok: false,
      error: fail(code, status),
      refusal: { academyId: inv.academyId, ref: inv.id, reason },
    });
    const done = (alreadyAccepted: boolean): Outcome => ({
      ok: true,
      accepted: { academyId: inv.academyId, academyName: academy.name, role: inv.role, kind: inv.kind, alreadyAccepted },
    });

    if (inv.status === "ACCEPTED")
      return inv.acceptedByUserId === person.id ? done(true) : { ok: false, error: fail("INVITATION_ALREADY_USED", 409) };
    if (inv.status === "REVOKED") return { ok: false, error: fail("INVITATION_REVOKED", 410) };
    if (inv.status === "EXPIRED" || inv.expiresAt.getTime() <= now.getTime()) {
      if (inv.status === "PENDING") await tx.update(t.academyInvitations).set({ status: "EXPIRED" }).where(eq(t.academyInvitations.id, inv.id));
      return { ok: false, error: fail("INVITATION_EXPIRED", 410) };
    }
    // A player link is not addressed to a person: holding it (once) is the condition, and the batch it carries must still exist.
    // Every other invitation is addressed to ONE email; that is a condition on top of holding the token, never a way in by itself.
    const link = inv.kind === "ADULT_PLAYER" ? parsePlayerLinkAddress(inv.inviteeEmail) : null;
    if (!link && person.email.trim().toLowerCase() !== inv.inviteeEmail) return refused("WRONG_ACCOUNT", 403, "WRONG_ACCOUNT");
    // The authority the invitation needed must still exist: an inviter who has since been demoted or switched off
    // cannot have their invitations used.
    const [inviter] = await tx
      .select({ role: t.memberships.role, active: t.memberships.active })
      .from(t.memberships)
      .where(and(eq(t.memberships.academyId, inv.academyId), eq(t.memberships.userId, inv.invitedByUserId)))
      .for("share");
    if (!inviter || !inviter.active || !can(inviter, link ? "players.manage" : "members.manage") || (inv.kind === "GUARDIAN" && !can(inviter, "guardians.link")))
      return refused("INVITATION_NO_LONGER_VALID", 410, "INVITER_NOT_AUTHORIZED");

    const [held] = await tx
      .select({ role: t.memberships.role, active: t.memberships.active })
      .from(t.memberships)
      .where(and(eq(t.memberships.academyId, inv.academyId), eq(t.memberships.userId, person.id)))
      .for("update");
    if (held && !(inv.kind === "GUARDIAN" && held.role === "GUARDIAN" && held.active)) return refused("ALREADY_MEMBER", 409, "ALREADY_MEMBER");

    if (link) {
      const [batch] = await tx
        .select({ id: t.batches.id })
        .from(t.batches)
        .where(and(eq(t.batches.academyId, inv.academyId), eq(t.batches.id, link.batchId)));
      if (!batch) return refused("INVITATION_NO_LONGER_VALID", 410, "BATCH_GONE");
    }
    let savedPhone: string | null = null;
    if (typedPhone) {
      const [settings] = await tx.select({ data: t.academySettings.data }).from(t.academySettings).where(eq(t.academySettings.academyId, inv.academyId));
      savedPhone = canonicalPhone(typedPhone, COUNTRY_CALLING_CODE[settings?.data.country ?? ""] ?? null);
      if (!savedPhone)
        throw new DomainError("Enter the mobile number with its country code, for example +91 98765 43210, or leave it empty.", 422, "INVALID_PHONE");
    }
    if (!held) await tx.insert(t.memberships).values({ academyId: inv.academyId, userId: person.id, role: inv.role, active: true });
    if (savedPhone) await tx.update(t.user).set({ phone: savedPhone, updatedAt: now }).where(eq(t.user.id, person.id));
    // The person ticked "WhatsApp me" on the accept page: a minimal, channel-specific record on THAT number (never a general consent).
    let optedNumber: string | null = null;
    if (whatsappOptIn) {
      optedNumber = savedPhone;
      if (!optedNumber) {
        const [u] = await tx.select({ phone: t.user.phone }).from(t.user).where(eq(t.user.id, person.id));
        optedNumber = u?.phone ?? null;
      }
      if (!optedNumber)
        throw new DomainError("Enter your WhatsApp number to agree to WhatsApp messages, or untick the box.", 422, "INVALID_PHONE");
    }
    if (optedNumber) await upsertOptIn(tx, inv.academyId, { userId: person.id }, optedNumber, "INVITATION_ACCEPT", person.id);
    if (inv.kind === "GUARDIAN") {
      // The player must still be here. The link starts with NOTHING granted: consent is a separate decision of the
      // guardian (or recorded for them by staff), and a guardian of an adult reads nothing until the adult grants it.
      const [player] = await tx
        .select({ id: t.players.id })
        .from(t.players)
        .where(and(eq(t.players.academyId, inv.academyId), eq(t.players.id, inv.playerId!)));
      if (!player) return refused("INVITATION_NO_LONGER_VALID", 410, "PLAYER_GONE");
      await tx
        .insert(t.guardianLinks)
        .values({
          academyId: inv.academyId,
          playerId: inv.playerId!,
          userId: person.id,
          relationship: inv.relationship!,
          active: true,
          consent: { portal: false, email: false, whatsapp: false },
        })
        .onConflictDoUpdate({
          target: [t.guardianLinks.academyId, t.guardianLinks.playerId, t.guardianLinks.userId],
          set: { relationship: inv.relationship!, active: true },
        });
      await tx.insert(t.audit).values({
        id: crypto.randomUUID(),
        academyId: inv.academyId,
        actorId: person.id,
        entityId: inv.playerId!,
        action: "guardian-link",
        version: 1,
        detail: { guardianId: person.id, active: true, via: "invitation" },
      });
    }
    await tx
      .update(t.academyInvitations)
      .set({ status: "ACCEPTED", acceptedAt: now, acceptedByUserId: person.id })
      .where(and(eq(t.academyInvitations.id, inv.id), eq(t.academyInvitations.status, "PENDING")));
    await recordSecurityEvent(tx, {
      event: "INVITATION_ACCEPTED",
      academyId: inv.academyId,
      actorId: person.id,
      targetUserId: person.id,
      detail: { ref: inv.id, kind: inv.kind, toRole: inv.role },
    });
    if (grantsOwnership(inv.role))
      // The grant was authorised by the inviting owner's password and second factor when the invitation was made.
      await recordSecurityEvent(tx, {
        event: "OWNER_GRANTED",
        academyId: inv.academyId,
        actorId: inv.invitedByUserId,
        targetUserId: person.id,
        detail: { targetUserId: person.id, method: "invitation", fromRole: null, toRole: "OWNER", fromActive: null, toActive: true },
      });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: inv.academyId,
      actorId: person.id,
      entityId: person.id,
      action: "member-invitation-accepted",
      version: 1,
      detail: { role: inv.role, kind: inv.kind, invitation: inv.id, ...(savedPhone ? { phoneLast4: savedPhone.slice(-4) } : {}) },
    });
    return done(false);
  });
  if (!outcome.ok) {
    // Recorded after the transaction so that a refusal survives it. Identifiers and a reason code only.
    if (outcome.refusal)
      await recordSecurityEvent(database(), {
        event: "INVITATION_REFUSED",
        academyId: outcome.refusal.academyId,
        actorId: person.id,
        detail: { ref: outcome.refusal.ref, reason: outcome.refusal.reason },
      });
    throw outcome.error;
  }
  return outcome.accepted;
}
