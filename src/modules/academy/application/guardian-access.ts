import { z } from "zod";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { shownName } from "../../identity/membership";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { authorityOf } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import { familyScope, grantedScopes, unit, type Tx } from "./access";
import {
  GUARDIAN_ACCESS_SCOPES,
  orderedScopes,
  type GuardianAccessEvent,
  type GuardianAccessScope,
} from "../domain/guardian-access";
/**
 * RC-4: adult-controlled guardian access (decision D5, TD-3, TD-4).
 *
 * An ADULT player decides, guardian by guardian, which of the seven sections of their own record that guardian may
 * read (academy/domain/guardian-access.ts). This module is the ONLY writer of grants, and the only way to create or
 * widen one is `saveGuardianAccess`, which accepts exactly one kind of caller: the signed-in PLAYER account that the
 * player's own profile names. There is deliberately no staff, guardian or system path that grants (owner decision
 * PD-2), and consent is not a section.
 *
 * `endGuardianAccess` can only END access (adulthood recorded, adult flag cleared, link deactivated); it never
 * creates or widens anything.
 *
 * Enforcement of what a grant gives is not here: it is `familyScope` / `requirePlayer` in access.ts, re-read from
 * the database on every request, so a change made here applies to the guardian's very next request.
 */
const notFound = () => new DomainError("Player not found.", 404);
/** The account type that may manage grants. Derived from the stored role by the authority module, never from input. */
const isPlayerAccount = (a: Actor) => authorityOf(a.role)?.accountType === "PLAYER";
const isGuardianAccount = (a: Actor) => authorityOf(a.role)?.accountType === "GUARDIAN";

/**
 * The state of one guardian's grant, as the adult (and the UI) sees it. There is NO time-based state: a grant never
 * expires (owner decision; the table has no expiry column).
 *   none     no grant has ever been stored for this guardian
 *   active   the grant gives at least one section right now
 *   revoked  the grant was closed: by the adult (REVOKED), or automatically when the link was deactivated or the
 *            adult flag was cleared (see lastEvent)
 *   void     a stored grant that is not revoked but gives nothing, because it fails a validity rule (made by another
 *            account than the player's current own account, guardian link inactive, or malformed scopes). The
 *            application never writes such a row; it is treated exactly like no grant, and the adult can replace it.
 */
export type GuardianAccessState = "none" | "active" | "revoked" | "void";
type StoredGrant = typeof t.guardianAccessGrants.$inferSelect;
function stateOf(grant: StoredGrant | null | undefined, held: readonly GuardianAccessScope[]): GuardianAccessState {
  if (!grant) return "none";
  if (grant.revokedAt !== null) return "revoked";
  return held.length ? "active" : "void";
}

const saveSchema = z.object({
  playerId: z.string().min(1).max(200),
  guardianUserId: z.string().min(1).max(200),
  // An empty list revokes. Unknown names are refused, never ignored.
  scopes: z
    .array(z.enum(GUARDIAN_ACCESS_SCOPES))
    .max(GUARDIAN_ACCESS_SCOPES.length)
    .refine((list) => new Set(list).size === list.length, "Each section may be listed once."),
  // The grant version the adult was looking at (0 when there is no grant yet): a concurrent change is a 409.
  version: z.number().int().min(0),
});

async function record(
  tx: Tx,
  a: Pick<Actor, "id" | "role" | "academyId">,
  playerId: string,
  guardianUserId: string,
  event: GuardianAccessEvent,
  scopes: GuardianAccessScope[] | null,
) {
  await tx.insert(t.guardianAccessEvents).values({
    academyId: a.academyId,
    playerId,
    guardianUserId,
    event,
    scopes,
    actorId: a.id,
    actorRole: a.role,
  });
}

/**
 * Grant, change or revoke what ONE guardian may read of the caller's own record.
 *
 * Every check runs inside the writing transaction, under the academy lock and after `lockActor` re-validated the
 * caller's membership (RC-2), so two requests are serialised and neither can act on stale authority:
 *   1. the caller is a PLAYER account                                  else 403
 *   2. the player is the caller's OWN adult record (profile.selfUserId) else 404 (same answer as a foreign id)
 *   3. the guardian holds an ACTIVE link to that player and an ACTIVE GUARDIAN membership here, and is not the
 *      caller                                                           else 404
 *   4. `version` is the stored grant version                            else 409
 */
export async function saveGuardianAccess(a: Actor, input: unknown) {
  if (!isPlayerAccount(a)) throw new DomainError("Only the adult player can decide who sees their record.", 403);
  const v = saveSchema.parse(input);
  const wanted = orderedScopes(v.scopes);
  return unit(a, async (tx) => {
    // (2) Derived from the signed-in account only; `holds` without a section means full authority (the adult).
    const scope = await familyScope(a, tx);
    if (!scope.holds(v.playerId)) throw notFound();
    const [profile] = await tx
      .select({ data: t.profiles.data })
      .from(t.profiles)
      .where(and(eq(t.profiles.academyId, a.academyId), eq(t.profiles.playerId, v.playerId)));
    if (!profile || profile.data.adult !== true || profile.data.selfUserId !== a.id) throw notFound();
    // (3) The guardian: a real, current guardian of THIS player in THIS academy.
    if (v.guardianUserId === a.id) throw new DomainError("Guardian not found.", 404);
    const [link] = await tx
      .select()
      .from(t.guardianLinks)
      .where(
        and(
          eq(t.guardianLinks.academyId, a.academyId),
          eq(t.guardianLinks.playerId, v.playerId),
          eq(t.guardianLinks.userId, v.guardianUserId),
        ),
      )
      .for("update");
    const [member] = await tx
      .select({ role: t.memberships.role, active: t.memberships.active })
      .from(t.memberships)
      .where(and(eq(t.memberships.academyId, a.academyId), eq(t.memberships.userId, v.guardianUserId)));
    const [current] = await tx
      .select()
      .from(t.guardianAccessGrants)
      .where(
        and(
          eq(t.guardianAccessGrants.academyId, a.academyId),
          eq(t.guardianAccessGrants.playerId, v.playerId),
          eq(t.guardianAccessGrants.guardianUserId, v.guardianUserId),
        ),
      )
      .for("update");
    const eligible = !!link && link.active && !!member && member.active && authorityOf(member.role)?.accountType === "GUARDIAN";
    // Revoking stays possible for a guardian who is no longer eligible, as long as the link row exists.
    if (!link || (!eligible && wanted.length)) throw new DomainError("Guardian not found.", 404);
    // (4)
    if ((current?.version ?? 0) !== v.version)
      throw new DomainError(
        "This access changed. Reload it before continuing; nothing was saved.",
        409,
        "GUARDIAN_ACCESS_CONFLICT",
      );
    // What the stored row gives right now (nothing if revoked, malformed, or made by a previous own-account).
    const held = orderedScopes(grantedScopes(current, profile.data, link));
    const same = held.length === wanted.length && held.every((s, i) => s === wanted[i]);
    // After a successful request the grant is active (sections held), revoked (closed) or absent; never void.
    const state = (version: number, scopes: GuardianAccessScope[]) => ({
      playerId: v.playerId,
      guardianUserId: v.guardianUserId,
      state: (scopes.length ? "active" : version ? "revoked" : "none") as GuardianAccessState,
      scopes,
      version,
    });
    if (!wanted.length) {
      // Revoke everything. A row that is still live in storage is closed even if it currently gives nothing.
      if (!current || current.revokedAt !== null) return state(current?.version ?? 0, []);
      const version = current.version + 1;
      await tx
        .update(t.guardianAccessGrants)
        .set({ revokedAt: new Date(), version })
        .where(
          and(
            eq(t.guardianAccessGrants.academyId, a.academyId),
            eq(t.guardianAccessGrants.playerId, v.playerId),
            eq(t.guardianAccessGrants.guardianUserId, v.guardianUserId),
          ),
        );
      await record(tx, a, v.playerId, v.guardianUserId, "REVOKED", []);
      return state(version, []);
    }
    if (same) return state(current!.version, held);
    const version = (current?.version ?? 0) + 1;
    const fresh = !held.length;
    await tx
      .insert(t.guardianAccessGrants)
      .values({
        academyId: a.academyId,
        playerId: v.playerId,
        guardianUserId: v.guardianUserId,
        scopes: wanted,
        grantedBy: a.id,
        version,
      })
      .onConflictDoUpdate({
        target: [
          t.guardianAccessGrants.academyId,
          t.guardianAccessGrants.playerId,
          t.guardianAccessGrants.guardianUserId,
        ],
        set: {
          scopes: wanted,
          grantedBy: a.id,
          revokedAt: null,
          version,
          ...(fresh ? { grantedAt: new Date() } : {}),
        },
      });
    await record(tx, a, v.playerId, v.guardianUserId, fresh ? "GRANTED" : "SCOPES_CHANGED", wanted);
    return state(version, wanted);
  });
}

/**
 * What the signed-in family account may know about grants.
 *   PLAYER    their own record(s): every linked guardian with what they currently hold, and the full history.
 *   GUARDIAN  only the sections they themselves currently hold, per adult player; no history, no other guardian.
 * Everyone else: 403. Nothing is taken from the request.
 */
export async function guardianAccessView(a: Actor) {
  const db = database();
  if (isGuardianAccount(a)) {
    const scope = await familyScope(a, db);
    return {
      scopes: GUARDIAN_ACCESS_SCOPES,
      manage: false as const,
      held: scope.players
        .filter((p) => scope.delegated.has(p.id))
        .map((p) => ({ playerId: p.id, name: p.name, scopes: orderedScopes(scope.scopes.get(p.id) ?? []) })),
    };
  }
  if (!isPlayerAccount(a)) throw new DomainError("Your role cannot perform this action.", 403);
  const scope = await familyScope(a, db);
  const players = [];
  for (const player of scope.players) {
    if (!scope.holds(player.id)) continue;
    const [profile] = await db
      .select({ data: t.profiles.data })
      .from(t.profiles)
      .where(and(eq(t.profiles.academyId, a.academyId), eq(t.profiles.playerId, player.id)));
    const rows = await db
      .select({
        link: t.guardianLinks,
        name: shownName,
        role: t.memberships.role,
        memberActive: t.memberships.active,
        grant: t.guardianAccessGrants,
      })
      .from(t.guardianLinks)
      .innerJoin(t.user, eq(t.user.id, t.guardianLinks.userId))
      .leftJoin(
        t.memberships,
        and(
          eq(t.memberships.academyId, t.guardianLinks.academyId),
          eq(t.memberships.userId, t.guardianLinks.userId),
        ),
      )
      .leftJoin(
        t.guardianAccessGrants,
        and(
          eq(t.guardianAccessGrants.academyId, t.guardianLinks.academyId),
          eq(t.guardianAccessGrants.playerId, t.guardianLinks.playerId),
          eq(t.guardianAccessGrants.guardianUserId, t.guardianLinks.userId),
        ),
      )
      .where(
        and(
          eq(t.guardianLinks.academyId, a.academyId),
          eq(t.guardianLinks.playerId, player.id),
          ne(t.guardianLinks.userId, a.id),
        ),
      );
    const events = await db
      .select()
      .from(t.guardianAccessEvents)
      .where(
        and(eq(t.guardianAccessEvents.academyId, a.academyId), eq(t.guardianAccessEvents.playerId, player.id)),
      )
      .orderBy(desc(t.guardianAccessEvents.at))
      .limit(200);
    // The newest history entry per guardian (also for guardians beyond the 200 newest entries listed below).
    const latest = await db
      .selectDistinctOn([t.guardianAccessEvents.guardianUserId])
      .from(t.guardianAccessEvents)
      .where(
        and(eq(t.guardianAccessEvents.academyId, a.academyId), eq(t.guardianAccessEvents.playerId, player.id)),
      )
      .orderBy(t.guardianAccessEvents.guardianUserId, desc(t.guardianAccessEvents.at));
    const lastOf = new Map(latest.map((e) => [e.guardianUserId, e]));
    const entry = (e: (typeof events)[number]) => ({
      id: e.id,
      guardianUserId: e.guardianUserId,
      event: e.event,
      scopes: e.scopes,
      byPlayer: e.actorId === a.id,
      actorRole: e.actorRole,
      at: e.at.toISOString(),
    });
    players.push({
      playerId: player.id,
      name: player.name,
      guardians: rows
        .filter((r) => authorityOf(r.role)?.accountType === "GUARDIAN")
        .map((r) => {
          const scopes = orderedScopes(grantedScopes(r.grant, profile?.data, r.link));
          const last = lastOf.get(r.link.userId);
          return {
            userId: r.link.userId,
            name: r.name,
            relationship: r.link.relationship,
            // Whether access can be granted now: an active link and an active guardian account.
            eligible: r.link.active && r.memberActive === true,
            state: stateOf(r.grant, scopes),
            scopes,
            version: r.grant?.version ?? 0,
            grantedAt: r.grant?.grantedAt.toISOString() ?? null,
            revokedAt: r.grant?.revokedAt?.toISOString() ?? null,
            lastEvent: last ? entry(last) : null,
          };
        })
        .sort((x, y) => x.userId.localeCompare(y.userId)),
      history: events.map(entry),
    });
  }
  return { scopes: GUARDIAN_ACCESS_SCOPES, manage: true as const, players };
}

/**
 * Ends access; never grants. Called inside the caller's transaction by the players service:
 *   ACCESS_ENDED_ADULTHOOD    a player was recorded as an adult: one event per ACTIVE guardian link (the adult's own
 *                             link excluded). Access itself ends because no grant exists; any grant row left from an
 *                             earlier period as an adult is closed as well.
 *   ENDED_ADULT_FLAG_CLEARED  the adult flag was cleared: every live grant is closed (the guardians of a minor have
 *                             their ordinary access again, and a later adulthood must start from nothing).
 *   ENDED_LINK_INACTIVE       one guardian's link was deactivated: that guardian's live grant is closed.
 * guardian_link rows and consent are never touched here.
 */
export async function endGuardianAccess(
  tx: Tx,
  a: Pick<Actor, "id" | "role" | "academyId">,
  playerId: string,
  event: "ACCESS_ENDED_ADULTHOOD" | "ENDED_ADULT_FLAG_CLEARED" | "ENDED_LINK_INACTIVE",
  only?: { guardianUserId?: string; exceptUserId?: string | null },
) {
  const live = await tx
    .select({ guardianUserId: t.guardianAccessGrants.guardianUserId, version: t.guardianAccessGrants.version })
    .from(t.guardianAccessGrants)
    .where(
      and(
        eq(t.guardianAccessGrants.academyId, a.academyId),
        eq(t.guardianAccessGrants.playerId, playerId),
        isNull(t.guardianAccessGrants.revokedAt),
        only?.guardianUserId ? eq(t.guardianAccessGrants.guardianUserId, only.guardianUserId) : undefined,
      ),
    )
    .for("update");
  for (const grant of live)
    await tx
      .update(t.guardianAccessGrants)
      .set({ revokedAt: new Date(), version: grant.version + 1 })
      .where(
        and(
          eq(t.guardianAccessGrants.academyId, a.academyId),
          eq(t.guardianAccessGrants.playerId, playerId),
          eq(t.guardianAccessGrants.guardianUserId, grant.guardianUserId),
        ),
      );
  if (event === "ACCESS_ENDED_ADULTHOOD") {
    const links = await tx
      .select({ userId: t.guardianLinks.userId })
      .from(t.guardianLinks)
      .where(
        and(
          eq(t.guardianLinks.academyId, a.academyId),
          eq(t.guardianLinks.playerId, playerId),
          eq(t.guardianLinks.active, true),
        ),
      );
    for (const link of links)
      if (link.userId !== only?.exceptUserId) await record(tx, a, playerId, link.userId, event, null);
    return;
  }
  for (const grant of live) await record(tx, a, playerId, grant.guardianUserId, event, null);
}
