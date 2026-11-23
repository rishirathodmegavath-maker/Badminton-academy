import { and, eq } from "drizzle-orm";
import { database } from "../../infrastructure/database/client";
import { academies, memberships, sessionAcademy } from "../../infrastructure/database/schema";
import { toActive, type ActiveMembership } from "./membership";
type Db = ReturnType<typeof database>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/**
 * Which academy a signed-in session is working in (migration 0017; MULTI_ACADEMY_IDENTITY_DESIGN.md).
 *
 * Signing in identifies the PERSON. Authority comes from one membership in one academy, and this module is the single
 * place that decides which one, for every application request and every Better Auth endpoint that acts as an academy
 * member. The rules, in order:
 *
 *   1. Only ACTIVE memberships count; they are read from the database on every call, never from the request.
 *   2. A stored selection for this session wins, but only while it still names an active membership of this person.
 *      A selection that no longer does (the membership was switched off) is ignored and removed.
 *   3. Otherwise exactly one active membership is used automatically (nothing needs choosing).
 *   4. Otherwise none (NO_MEMBERSHIP, or MEMBERSHIP_INACTIVE when memberships exist but are all switched off).
 *   5. Otherwise several and none chosen: the caller must choose (ACADEMY_SELECTION_REQUIRED).
 *
 * The selection is only a CHOICE among memberships the person already holds. A client never supplies an academy id
 * for authorization: it may ask to switch (selectAcademy), and the server checks that the person is an active member.
 */
export type Resolution =
  | { status: "resolved"; chosen: ActiveMembership; active: ActiveMembership[]; viaSelection: boolean }
  | { status: "none"; code: "NO_MEMBERSHIP" | "MEMBERSHIP_INACTIVE" }
  | { status: "selection_required"; active: ActiveMembership[] };
export async function resolveMembership(userId: string, sessionId: string, db: Db | Tx = database()): Promise<Resolution> {
  const rows = await db
    .select({ membership: memberships, academy: academies })
    .from(memberships)
    .innerJoin(academies, eq(academies.id, memberships.academyId))
    .where(eq(memberships.userId, userId));
  const active = rows.filter((r) => r.membership.active).map((r) => toActive(r.membership, r.academy));
  if (active.length === 0)
    return { status: "none", code: rows.length ? "MEMBERSHIP_INACTIVE" : "NO_MEMBERSHIP" };
  const [selection] = await db
    .select()
    .from(sessionAcademy)
    .where(and(eq(sessionAcademy.sessionId, sessionId), eq(sessionAcademy.userId, userId)));
  if (selection) {
    const chosen = active.find((m) => m.academyId === selection.academyId);
    if (chosen) return { status: "resolved", chosen, active, viaSelection: true };
    // Stale: the person no longer holds an active membership there. Forget it, so it cannot come back to life
    // if the membership is switched on again later without the person choosing.
    await db.delete(sessionAcademy).where(eq(sessionAcademy.sessionId, sessionId));
  }
  if (active.length === 1) return { status: "resolved", chosen: active[0], active, viaSelection: false };
  return { status: "selection_required", active };
}
/** The membership a request acts under, or null when there is none to act under (none, or a choice is still needed). */
export async function activeMembershipOf(userId: string, sessionId: string, db: Db | Tx = database()) {
  const r = await resolveMembership(userId, sessionId, db);
  return r.status === "resolved" ? r.chosen : null;
}
/**
 * Switch this session to another academy the person is an ACTIVE member of. Returns the membership, or null when they
 * are not (an unknown academy and somebody else's academy are indistinguishable). The membership row is read FOR SHARE
 * in the same transaction as the write: it conflicts with the FOR UPDATE a member change takes, so a deactivation
 * either commits first (and nothing is stored) or waits for this. Every later request re-reads it anyway.
 */
export async function selectAcademy(userId: string, sessionId: string, academyId: string) {
  return database().transaction(async (tx) => {
    const [row] = await tx
      .select({ membership: memberships, academy: academies })
      .from(memberships)
      .innerJoin(academies, eq(academies.id, memberships.academyId))
      .where(and(eq(memberships.userId, userId), eq(memberships.academyId, academyId), eq(memberships.active, true)))
      .for("share", { of: memberships });
    if (!row) return null;
    const [previous] = await tx.select().from(sessionAcademy).where(eq(sessionAcademy.sessionId, sessionId));
    await tx
      .insert(sessionAcademy)
      .values({ sessionId, userId, academyId })
      .onConflictDoUpdate({ target: sessionAcademy.sessionId, set: { academyId, selectedAt: new Date() } });
    return { chosen: toActive(row.membership, row.academy), previousAcademyId: previous?.academyId ?? null };
  });
}
/** Forget every session's choice of one academy for one person (their membership there was switched off). */
export async function clearSelections(db: Db | Tx, academyId: string, userId: string) {
  await db.delete(sessionAcademy).where(and(eq(sessionAcademy.academyId, academyId), eq(sessionAcademy.userId, userId)));
}
