import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { authorityOf } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import { unit, defaultProfile, expectVersion } from "../../academy/application/access";
import { parsePlayerLinkAddress } from "../../invitations/player-link";
import { academyToday, requireUnder18 } from "./age-rules";

/**
 * A player who joined by invitation link fills in their own details here, instead of staff typing them.
 *  - Only a PLAYER account (the account type of the player login) can call this; it never takes a player id from the request:
 *    the record is found by the signed-in account, so nobody can write to another player.
 *  - FIRST SAVE creates the player in the batch the staff member chose when they made the link (read back from the accepted
 *    invitation), as an ordinary under-18 player with a date of birth (the same rule as every other way a player is created).
 *    One login, one player.
 *  - LATER SAVES change contact details and preferences only. Name and date of birth are fixed once saved (staff can still
 *    correct them in Players), so a player cannot change their own age to move in or out of a rule.
 *  - The login is stored on the profile as `loginUserId`. Parents link to the same player in the usual way and keep their own access.
 */
const requirePlayerAccount = (a: Actor) => {
  if (authorityOf(a.role)?.accountType !== "PLAYER")
    throw new DomainError("Only a player's own account can fill in these details.", 403, "NOT_A_PLAYER_ACCOUNT");
};
const own = (a: Actor) =>
  and(eq(t.profiles.academyId, a.academyId), sql`${t.profiles.data} ->> 'loginUserId' = ${a.id}`, sql`${t.profiles.data} ->> 'adult' = 'false'`);

const detailsSchema = z.object({
  version: z.number().int().optional(),
  name: z.string().trim().min(2).max(120).optional(),
  birthDate: z.string().max(10).optional(),
  email: z.union([z.email(), z.literal("")]).default(""),
  phone: z.string().trim().max(40).default(""),
  preferences: z.string().max(2000).default(""),
});

/** What the player has saved so far (or that nothing is saved yet). Never another person's record. */
export async function ownPlayerDetails(a: Actor) {
  requirePlayerAccount(a);
  const [row] = await database()
    .select({ player: t.players, profile: t.profiles })
    .from(t.profiles)
    .innerJoin(t.players, and(eq(t.players.academyId, t.profiles.academyId), eq(t.players.id, t.profiles.playerId)))
    .where(own(a));
  if (!row) return { registered: false as const };
  const d = row.profile.data;
  return {
    registered: true as const,
    version: row.profile.version,
    name: row.player.name,
    birthDate: d.birthDate,
    email: d.email,
    phone: d.phone,
    preferences: d.preferences,
  };
}

export async function selfRegisterPlayer(a: Actor, input: unknown) {
  requirePlayerAccount(a);
  const v = detailsSchema.parse(input);
  return unit(a, async (tx) => {
    const [existing] = await tx
      .select({ player: t.players, profile: t.profiles })
      .from(t.profiles)
      .innerJoin(t.players, and(eq(t.players.academyId, t.profiles.academyId), eq(t.players.id, t.profiles.playerId)))
      .where(own(a));
    if (existing) {
      expectVersion(existing.profile.version, v.version ?? 0);
      const version = existing.profile.version + 1;
      await tx
        .update(t.profiles)
        .set({ data: { ...existing.profile.data, email: v.email, phone: v.phone, preferences: v.preferences }, version })
        .where(and(eq(t.profiles.academyId, a.academyId), eq(t.profiles.playerId, existing.player.id)));
      await tx.insert(t.audit).values({
        id: crypto.randomUUID(),
        academyId: a.academyId,
        actorId: a.id,
        entityId: existing.player.id,
        action: "player-self-details",
        version,
        detail: { fields: ["email", "phone", "preferences"] },
      });
      return { id: existing.player.id, version };
    }
    // An account that already saved its details once (and whose record was later erased or removed) is not given a new record
    // without staff: the academy makes a new link if the person is to join again.
    const [before] = await tx
      .select({ id: t.audit.id })
      .from(t.audit)
      .where(and(eq(t.audit.academyId, a.academyId), eq(t.audit.actorId, a.id), eq(t.audit.action, "player-self-register")))
      .limit(1);
    if (before)
      throw new DomainError("Your details were saved before and the record is no longer active. Ask the academy for a new link.", 409, "ALREADY_REGISTERED");
    // First save: the batch comes from the invitation THIS account accepted, never from the request.
    const accepted = await tx
      .select({ address: t.academyInvitations.inviteeEmail })
      .from(t.academyInvitations)
      .where(
        and(
          eq(t.academyInvitations.academyId, a.academyId),
          eq(t.academyInvitations.kind, "ADULT_PLAYER"),
          eq(t.academyInvitations.status, "ACCEPTED"),
          eq(t.academyInvitations.acceptedByUserId, a.id),
        ),
      );
    const link = accepted.map((r) => parsePlayerLinkAddress(r.address)).find(Boolean);
    if (!link) throw new DomainError("This account was not created from a player invitation link.", 403, "NO_PLAYER_LINK");
    if (!v.name || !v.birthDate) throw new DomainError("Enter your name and date of birth.", 422, "DETAILS_REQUIRED");
    const [batch] = await tx
      .select({ id: t.batches.id })
      .from(t.batches)
      .where(and(eq(t.batches.academyId, a.academyId), eq(t.batches.id, link.batchId)));
    if (!batch) throw new DomainError("The batch this link was made for no longer exists. Ask the academy for a new link.", 409, "BATCH_GONE");
    try {
      requireUnder18({ birthDate: v.birthDate, adult: false, selfUserId: null, status: "ACTIVE" }, await academyToday(tx, a.academyId), null);
    } catch (e) {
      if (e instanceof DomainError && e.code === "PLAYER_NOT_UNDER_18")
        throw new DomainError("This academy trains players under 18. Please contact the academy about joining.", 422, "PLAYER_NOT_UNDER_18");
      throw e;
    }
    const id = crypto.randomUUID();
    await tx.insert(t.players).values({ id, academyId: a.academyId, name: v.name, batchId: link.batchId });
    await tx.insert(t.profiles).values({
      academyId: a.academyId,
      playerId: id,
      data: { ...defaultProfile, adult: false, birthDate: v.birthDate, email: v.email, phone: v.phone, preferences: v.preferences, loginUserId: a.id },
    });
    await tx.insert(t.playerHistory).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      playerId: id,
      kind: "ENROLLED",
      detail: { via: "player-link", batchId: link.batchId },
    });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: id,
      action: "player-self-register",
      version: 1,
      detail: { batchId: link.batchId },
    });
    return { id, version: 1 };
  });
}
