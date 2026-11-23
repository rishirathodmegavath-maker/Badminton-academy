import { and, eq, inArray, sql } from "drizzle-orm";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import { type Actor, isManager } from "../../identity/access";
import { can, rolesWith } from "../../identity/authority";
import { lockActor } from "../../identity/lock-actor";
import { DomainError } from "../../training/domain/rules";
import { defaultSettings } from "../domain/types";
import {
  adultControlled,
  EVERY_SCOPE,
  storedScopes,
  type GuardianAccessScope,
} from "../domain/guardian-access";
export type Tx = Parameters<
  Parameters<ReturnType<typeof database>["transaction"]>[0]
>[0];
/** GUARDIAN or ADULT_PLAYER: the family account types (authority capability `family.portal`). */
export const family = (a: Actor) => can(a, "family.portal");
/** OWNER or STAFF: the staff workspace (capability `portal.staff`, RC-5). Fails closed for any unknown role. */
export const staff = (a: Actor) => can(a, "portal.staff");
export function requireRole(a: Actor, roles: string[]) {
  if (!roles.includes(a.role))
    throw new DomainError("Your role cannot perform this action.", 403);
}
/**
 * Legacy role lists, derived from the authority module (RC-1) and equal to the old literals (T-EQ). Service checks
 * now call requireCapability; these remain for the staff read model (bootstrap.ts), coach eligibility (Stage 5D,
 * Stage 5E) and the frozen Stage 5F oracle.
 */
export const opsRoles: string[] = rolesWith("academy.structure");
export const coachingRoles: string[] = rolesWith("sessions.coach");
export const financeRoles: string[] = rolesWith("finance.manage");
/** Roles whose read model is a narrow, purpose-built projection rather than the staff view. */
export const narrowRoles = ["FINANCE", "NUTRITION_PRO"];
export async function unit<T>(a: Actor, fn: (tx: Tx) => Promise<T>) {
  return database().transaction(async (tx) => {
    await tx
      .select()
      .from(t.academies)
      .where(eq(t.academies.id, a.academyId))
      .for("update");
    // RC-2: the authority this request was granted must still hold now that the lock is taken.
    await lockActor(tx, a);
    return fn(tx);
  });
}
/**
 * RC-2: the unit of work for the privacy worker (erasure processing, AUTHORIZATION_SECURITY_ARCHITECTURE 7.2), which
 * runs outside any request and acts only on requests already approved by an owner. Same academy lock as unit(); there
 * is no membership to re-validate, so no lockActor. Request-driven code must use unit(), never this.
 */
export async function systemUnit<T>(academyId: string, fn: (tx: Tx) => Promise<T>) {
  return database().transaction(async (tx) => {
    await tx
      .select()
      .from(t.academies)
      .where(eq(t.academies.id, academyId))
      .for("update");
    return fn(tx);
  });
}
type Reader = Tx | ReturnType<typeof database>;
/**
 * RC-4. Which section of a player's record a family request is about. A guardian of an ADULT player holds only the
 * sections that adult granted; "ANY" asks for at least one of them (the player's name and batch). Leaving the
 * section out asks for FULL authority over the record: a minor's guardian and the adult themself have it, a
 * guardian reading through a grant never does. Unscoped is therefore the safe default for any code that was not
 * written with grants in mind (consent, and anything added later).
 */
export type PlayerSection = GuardianAccessScope | "ANY";
/**
 * Players this actor may SEE and act on (profile, reports, media, nutrition, history).
 *
 * This is the one place player-level authority is decided, and it is deny-by-default: a role not
 * listed below, including FINANCE, receives no players at all. FINANCE has the separate, narrower
 * billing roster (billablePlayers). A request must therefore never gain access to a player just
 * because it names one.
 *
 *  OWNER / ADMIN / HEAD_COACH  every player of the academy
 *  COACH                       players in batches they coach
 *  NUTRITION_PRO               players with an ACTIVE assignment to them (nutrition_assignment)
 *  GUARDIAN                    minors with an active guardian link to them; ADULT players only through a
 *                              grant made by that adult, and only for the granted sections (RC-4)
 *  ADULT_PLAYER                the adult profile that names them as its own user
 *
 * `section` matters only for family accounts (see PlayerSection); staff authority does not depend on grants.
 */
export async function accessiblePlayers(a: Actor, tx: Reader = database(), section?: PlayerSection) {
  // Family accounts: only their own children are read (Stage 5F), never the academy's player list.
  if (family(a)) {
    const scope = await familyScope(a, tx);
    return scope.players.filter((p) => scope.holds(p.id, section));
  }
  const all = await tx
    .select()
    .from(t.players)
    .where(eq(t.players.academyId, a.academyId));
  switch (a.role) {
    case "OWNER":
    case "ADMIN":
    case "HEAD_COACH":
      return all;
    case "COACH": {
      const batches = await tx
        .select()
        .from(t.batches)
        .where(
          and(
            eq(t.batches.academyId, a.academyId),
            eq(t.batches.coachId, a.id),
          ),
        );
      return all.filter((p) => batches.some((b) => b.id === p.batchId));
    }
    case "NUTRITION_PRO": {
      const assigned = await tx
        .select({ playerId: t.nutritionAssignments.playerId })
        .from(t.nutritionAssignments)
        .where(
          and(
            eq(t.nutritionAssignments.academyId, a.academyId),
            eq(t.nutritionAssignments.professionalId, a.id),
            eq(t.nutritionAssignments.active, true),
          ),
        );
      return all.filter((p) => assigned.some((r) => r.playerId === p.id));
    }
    default:
      // FINANCE and any role this code does not know: no player-level access.
      return [];
  }
}
type PlayerRow = typeof t.players.$inferSelect;
type GuardianLinkRow = typeof t.guardianLinks.$inferSelect;
export type FamilyScope = Readonly<{
  /**
   * The children this family account may see at all: full player rows. For a guardian this includes an ADULT
   * player only when that adult granted at least one section; what may be read of each player is `scopes`.
   */
  players: readonly PlayerRow[];
  playerIds: ReadonlySet<string>;
  /** Every guardian link of this account in this academy, active or not (consent and link checks use them). */
  links: readonly GuardianLinkRow[];
  /** RC-4: the sections held per visible player. Every section for a minor's guardian and for the adult themself. */
  scopes: ReadonlyMap<string, ReadonlySet<GuardianAccessScope>>;
  /**
   * RC-4: linked players whose record is adult-controlled and whom this GUARDIAN therefore reads only through a
   * grant (whether or not one exists). Empty for an adult player account.
   */
  delegated: ReadonlySet<string>;
  /** The visible players for which this account holds `section`. Never "no filter": may be empty. */
  ids(section: GuardianAccessScope): ReadonlySet<string>;
  /** See PlayerSection: a section, "ANY", or (omitted) full authority over the record. */
  holds(playerId: string, section?: PlayerSection): boolean;
}>;
/**
 * Stage 5F. The children a GUARDIAN or ADULT_PLAYER may see, derived only from the signed-in actor (its id and
 * the academy of its one active membership): no request value is ever an input. Read on every call, never cached,
 * so a removed link, a revoked grant or a player's adulthood takes effect on the next request.
 *
 *  GUARDIAN      players with an ACTIVE guardian link to this account (one statement, which also returns the
 *                account's links, the players' profiles and this account's grants).
 *                  - minor (profile not adult-controlled): every section, as before RC-4;
 *                  - ADULT (RC-4): only through a guardian_access_grant that is not revoked, holds a well-formed,
 *                    non-empty scope list, and was granted by the very account the profile names as the adult.
 *                    Anything missing, revoked, malformed or inconsistent: the player is not visible at all.
 *  ADULT_PLAYER  players whose profile is an adult profile naming this account as its own user: every section.
 *
 * An account with no children gets an empty scope. Callers must treat an empty scope as "nothing", never as
 * "no filter".
 */
export async function familyScope(
  a: Actor,
  tx: Reader = database(),
): Promise<FamilyScope> {
  if (!family(a)) throw new Error("familyScope is only defined for family roles.");
  let players: PlayerRow[];
  let links: GuardianLinkRow[];
  const scopes = new Map<string, ReadonlySet<GuardianAccessScope>>();
  const delegated = new Set<string>();
  if (a.role === "GUARDIAN") {
    const rows = await tx
      .select({
        link: t.guardianLinks,
        player: t.players,
        profile: t.profiles.data,
        grant: t.guardianAccessGrants,
      })
      .from(t.guardianLinks)
      .leftJoin(
        t.players,
        and(
          eq(t.players.academyId, t.guardianLinks.academyId),
          eq(t.players.id, t.guardianLinks.playerId),
          eq(t.guardianLinks.active, true),
        ),
      )
      .leftJoin(
        t.profiles,
        and(
          eq(t.profiles.academyId, t.guardianLinks.academyId),
          eq(t.profiles.playerId, t.guardianLinks.playerId),
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
          eq(t.guardianLinks.userId, a.id),
        ),
      );
    links = rows.map((r) => r.link);
    players = [];
    for (const r of rows) {
      if (adultControlled(r.profile)) delegated.add(r.link.playerId);
      if (!r.player) continue;
      const held = adultControlled(r.profile)
        ? grantedScopes(r.grant, r.profile, r.link)
        : EVERY_SCOPE;
      if (!held.size) continue;
      players.push(r.player);
      scopes.set(r.player.id, held);
    }
  } else {
    const [rows, own] = await Promise.all([
      tx
        .select({ player: t.players, profile: t.profiles })
        .from(t.profiles)
        .innerJoin(
          t.players,
          and(
            eq(t.players.academyId, t.profiles.academyId),
            eq(t.players.id, t.profiles.playerId),
          ),
        )
        .where(
          and(
            eq(t.profiles.academyId, a.academyId),
            sql`(${t.profiles.data} ->> 'selfUserId' = ${a.id} OR ${t.profiles.data} ->> 'loginUserId' = ${a.id})`,
          ),
        ),
      tx
        .select()
        .from(t.guardianLinks)
        .where(
          and(
            eq(t.guardianLinks.academyId, a.academyId),
            eq(t.guardianLinks.userId, a.id),
          ),
        ),
    ]);
    // The SQL narrows by account; the rule itself is the same JavaScript check as before.
    const adults = rows.filter((r) => r.profile.data.adult && r.profile.data.selfUserId === a.id);
    // A minor's own login: the record is NOT adult-controlled (parents keep their access), and this account holds only the
    // named sections. It is marked delegated, so it never has "full authority" over the record (no section named = refused).
    const logins = rows.filter((r) => r.profile.data.adult === false && r.profile.data.loginUserId === a.id);
    players = [...adults, ...logins].map((r) => r.player);
    for (const r of adults) scopes.set(r.player.id, EVERY_SCOPE);
    for (const r of logins) {
      scopes.set(r.player.id, PLAYER_LOGIN_SCOPES);
      delegated.add(r.player.id);
    }
    links = own;
  }
  const full = new Set(players.filter((p) => !delegated.has(p.id)).map((p) => p.id));
  const bySection = new Map<GuardianAccessScope, ReadonlySet<string>>();
  return Object.freeze({
    players: Object.freeze(players),
    playerIds: new Set(players.map((p) => p.id)),
    links: Object.freeze(links),
    scopes,
    delegated,
    ids(section: GuardianAccessScope) {
      let set = bySection.get(section);
      if (!set) {
        set = new Set(players.filter((p) => scopes.get(p.id)?.has(section) === true).map((p) => p.id));
        bySection.set(section, set);
      }
      return set;
    },
    holds(playerId: string, section?: PlayerSection) {
      const held = scopes.get(playerId);
      if (!held || !held.size) return false;
      if (section === undefined) return full.has(playerId);
      return section === "ANY" ? true : held.has(section);
    },
  });
}
type GrantRow = typeof t.guardianAccessGrants.$inferSelect;
type ProfileFacts = { adult?: unknown; selfUserId?: unknown } | null | undefined;
/**
 * RC-4: what one stored grant gives one guardian over one adult-controlled record, re-derived on every request.
 * Nothing unless ALL hold: the row exists and is not revoked; its guardian link is active; the profile is an adult
 * profile naming an own account, and the grant was made by exactly that account (a grant made by anyone else, or
 * left over from a previous own-account, is void); the guardian is not that account; the stored scopes are well
 * formed.
 */
export function grantedScopes(
  grant: GrantRow | null | undefined,
  profile: ProfileFacts,
  link: Pick<GuardianLinkRow, "active" | "userId">,
): ReadonlySet<GuardianAccessScope> {
  const nothing: ReadonlySet<GuardianAccessScope> = new Set();
  if (!grant || grant.revokedAt !== null || !link.active) return nothing;
  if (!profile || profile.adult !== true) return nothing;
  if (typeof profile.selfUserId !== "string" || !profile.selfUserId) return nothing;
  if (grant.grantedBy !== profile.selfUserId || grant.guardianUserId !== link.userId) return nothing;
  if (link.userId === profile.selfUserId) return nothing;
  return storedScopes(grant.scopes);
}
/**
 * The player, if this actor may act on it. For a family account `section` says which part of the record the
 * request is about (PlayerSection): omitted means full authority, which a guardian reading an ADULT player's
 * record through a grant never has. Every refusal is the same 404.
 */
export async function requirePlayer(
  a: Actor,
  id: string,
  tx: Reader = database(),
  section?: PlayerSection,
) {
  const player = (await accessiblePlayers(a, tx, section)).find((p) => p.id === id);
  if (!player) throw new DomainError("Player not found.", 404);
  return player;
}
/**
 * RC-4, for requests made BY STAFF that would hand something about a player to a family account (a conversation,
 * an invoice addressed to it): whether that account may receive `section` of that player's record. True for a
 * minor with an active link, as before; for an adult-controlled record only the adult's own account, or a guardian
 * with a live grant holding the section.
 */
export async function guardianMayReceive(
  academyId: string,
  playerId: string,
  userId: string,
  section: GuardianAccessScope,
  tx: Reader,
) {
  const [row] = await tx
    .select({ link: t.guardianLinks, profile: t.profiles.data, grant: t.guardianAccessGrants })
    .from(t.guardianLinks)
    .leftJoin(
      t.profiles,
      and(eq(t.profiles.academyId, t.guardianLinks.academyId), eq(t.profiles.playerId, t.guardianLinks.playerId)),
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
        eq(t.guardianLinks.academyId, academyId),
        eq(t.guardianLinks.playerId, playerId),
        eq(t.guardianLinks.userId, userId),
      ),
    );
  if (!row || !row.link.active) return false;
  return recipientMay(row.link, row.profile, row.grant, section);
}
function recipientMay(
  link: GuardianLinkRow,
  profile: ProfileFacts,
  grant: GrantRow | null,
  section: GuardianAccessScope,
) {
  if (!adultControlled(profile)) return true;
  // The adult's own account (its own link row carries its consent flags).
  if (profile?.adult === true && profile.selfUserId === link.userId) return true;
  return grantedScopes(grant, profile, link).has(section);
}
/**
 * The billing roster: the players an actor may put on an invoice or credit. FINANCE gets every
 * player of its academy for this one purpose, and only through these helpers, which return the
 * bare player row (id, name, batch). Every other role is billed against the players it can
 * already see.
 */
export async function billablePlayers(a: Actor, tx: Reader = database()) {
  if (a.role !== "FINANCE") return accessiblePlayers(a, tx);
  return tx.select().from(t.players).where(eq(t.players.academyId, a.academyId));
}
export async function requireBillablePlayer(
  a: Actor,
  id: string,
  tx: Reader = database(),
) {
  const player = (await billablePlayers(a, tx)).find((p) => p.id === id);
  if (!player) throw new DomainError("Player not found.", 404);
  return player;
}
export async function requireFeature(
  a: Actor,
  key: keyof typeof defaultSettings.features,
  tx: Tx | ReturnType<typeof database> = database(),
) {
  const [setting] = await tx
    .select()
    .from(t.academySettings)
    .where(eq(t.academySettings.academyId, a.academyId));
  const [plan] = await tx
    .select()
    .from(t.entitlements)
    .where(eq(t.entitlements.academyId, a.academyId));
  if (!plan?.data[key] || !(setting?.data ?? defaultSettings).features[key])
    throw new DomainError(
      "This feature is unavailable under the academy settings or subscription.",
      403,
    );
}
export async function history(
  tx: Tx,
  a: Actor,
  kind: string,
  id: string,
  version: number,
  data: unknown,
) {
  await tx
    .insert(t.recordRevisions)
    .values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      entityId: id,
      kind,
      version,
      data,
    });
  await tx
    .insert(t.audit)
    .values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: id,
      action: kind,
      version,
      detail: {},
    });
}
export function expectVersion(actual: number, expected: number) {
  if (actual !== expected)
    throw new DomainError(
      "This record changed. Reload the saved record before continuing; your input is preserved.",
      409,
    );
}
/** What a player's own login may read of their own record: the schedule, their reports and shared media. Not fees, health or staff messages. */
export const PLAYER_LOGIN_SCOPES: ReadonlySet<GuardianAccessScope> = Object.freeze(new Set<GuardianAccessScope>(["SCHEDULE", "REPORTS", "MEDIA"]));
export const defaultProfile = {
  adult: false,
  birthDate: "",
  email: "",
  phone: "",
  notes: "",
  status: "ACTIVE" as const,
  selfUserId: null,
  preferences: "",
};
export async function scopedBatch(a: Actor, id: string, tx: Tx) {
  const [batch] = await tx
    .select()
    .from(t.batches)
    .where(and(eq(t.batches.academyId, a.academyId), eq(t.batches.id, id)));
  if (!batch || (!isManager(a) && a.role === "COACH" && batch.coachId !== a.id))
    throw new DomainError("Batch not found.", 404);
  return batch;
}
/**
 * The accounts that may be sent a message about these players: active links of active family members. RC-4: for an
 * adult-controlled record that is the adult's own account, and a guardian only while the adult's grant holds
 * MESSAGES. Recomputed at preview, approval and send, so a revocation stops delivery of anything not yet sent.
 */
export async function linkedRecipients(a: Actor, playerIds: string[], tx: Tx) {
  const links = await tx
    .select({
      link: t.guardianLinks,
      user: t.user,
      displayName: t.memberships.displayName,
      profile: t.profiles.data,
      grant: t.guardianAccessGrants,
    })
    .from(t.guardianLinks)
    .innerJoin(t.user, eq(t.user.id, t.guardianLinks.userId))
    .innerJoin(
      t.memberships,
      and(
        eq(t.memberships.academyId, t.guardianLinks.academyId),
        eq(t.memberships.userId, t.guardianLinks.userId),
      ),
    )
    .leftJoin(
      t.profiles,
      and(eq(t.profiles.academyId, t.guardianLinks.academyId), eq(t.profiles.playerId, t.guardianLinks.playerId)),
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
        eq(t.guardianLinks.active, true),
        eq(t.memberships.active, true),
        inArray(t.memberships.role, ["GUARDIAN", "ADULT_PLAYER"]),
      ),
    );
  return links
    .filter((l) => playerIds.includes(l.link.playerId) && recipientMay(l.link, l.profile, l.grant, "MESSAGES"))
    .map(({ link, user, displayName }) => ({ link, user, displayName }));
}
