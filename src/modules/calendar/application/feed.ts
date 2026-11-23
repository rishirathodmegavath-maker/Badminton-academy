import { createHash, randomBytes } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import { database } from "../../../infrastructure/database/client";
import type { Actor } from "../../identity/access";
import { DomainError } from "../../training/domain/rules";
import { accessiblePlayers, family, unit } from "../../academy/application/access";
import { can } from "../../identity/authority";
import { buildIcs, type IcsEvent } from "../ics";

/**
 * A private calendar link for each person, free: add it once to Google, Apple or Outlook calendar and every session
 * follows by itself, with the drills in the description. Coaches see the sessions they run, owners, admins and head
 * coaches every session, and a parent only the sessions and events their own child is on.
 *
 * Safety:
 *  - The secret is 32 random bytes. Only its SHA-256 is stored (in the existing token table, `auth_verification`, under
 *    the identifier `calendar-feed:<hash>`), so a database copy cannot read anyone's calendar. A new link replaces the
 *    old one, which stops working.
 *  - Every request rebuilds the feed from the same authority the app uses (`accessiblePlayers`, the person's CURRENT
 *    membership), so it ends with the membership.
 *  - Staff events carry the number of players, never names (a calendar lives in a third-party service); a parent's events
 *    carry only their own child's first name. No private note, objective or observation is ever included.
 *  - A wrong link answers 404 and writes nothing.
 */
const PREFIX = "calendar-feed:";
const FOREVER_MS = 5 * 365 * 86_400_000;
const PAST_DAYS = 14;
const CANCELLED_STAFF_DAYS = 7;
/** Who has a calendar: those who see every session, those who coach, and the family accounts (by capability, not by role name). */
const hasFeed = (a: Actor) => can(a, "training.allSessions") || can(a, "sessions.coach") || family(a);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const ref = (academyId: string, userId: string) => JSON.stringify([academyId, userId]);

export async function issueFeedToken(a: Actor) {
  if (!hasFeed(a)) throw new DomainError("A calendar link is not available for your role.", 403);
  const token = randomBytes(32).toString("base64url");
  // unit() takes the academy lock and re-validates the actor's membership before anything is written.
  await unit(a, async (tx) => {
    await tx
      .delete(t.verification)
      .where(and(like(t.verification.identifier, `${PREFIX}%`), eq(t.verification.value, ref(a.academyId, a.id))));
    await tx.insert(t.verification).values({
      id: crypto.randomUUID(),
      identifier: `${PREFIX}${hash(token)}`,
      value: ref(a.academyId, a.id),
      expiresAt: new Date(Date.now() + FOREVER_MS),
    });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: a.id,
      action: "calendar-link-created",
      version: 1,
      detail: {},
    });
  });
  return { token };
}

const drillsText = (activities: { title: string; minutes: number }[]) =>
  activities.length
    ? "Drills:\n" + activities.map((x, i) => `${i + 1}. ${x.title}${x.minutes ? ` (${x.minutes} min)` : ""}`).join("\n")
    : "";
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";
const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

export async function feedEvents(a: Actor): Promise<IcsEvent[]> {
  const db = database(),
    now = Date.now(),
    since = now - PAST_DAYS * 86_400_000,
    staff = can(a, "training.allSessions"),
    guardian = family(a);
  // The children a parent may see in full; staff and coaches are scoped below by what they coach.
  const children = guardian ? await accessiblePlayers(a, db) : [];
  const childIds = new Set(children.map((c) => c.id)),
    childBatches = new Set(children.map((c) => c.batchId));
  if (guardian && !children.length) return [];
  const batches = new Map(
    (await db.select().from(t.batches).where(eq(t.batches.academyId, a.academyId))).map((b) => [b.id, b]),
  );
  const events: IcsEvent[] = [];
  const sessions = await db.select().from(t.trainingSessions).where(eq(t.trainingSessions.academyId, a.academyId));
  for (const s of sessions) {
    const d = s.data;
    if (!d.startsAt || s.status === "DRAFT") continue;
    const end = plus(d.startsAt, d.duration || 60);
    const cancelled = s.status === "CANCELLED";
    if (!cancelled && Date.parse(end) < since) continue;
    if (cancelled && Date.parse(end) < now - CANCELLED_STAFF_DAYS * 86_400_000) continue;
    const mine = d.roster.filter((r) => childIds.has(r.id));
    if (guardian) {
      if (!mine.length && !(s.batchId && childBatches.has(s.batchId))) continue;
      if (cancelled) {
        // A cancelled draft was never visible to a family: only a session that had been published is shown as cancelled.
        const seen = (
          await db
            .select({ status: t.revisions.status })
            .from(t.revisions)
            .where(and(eq(t.revisions.academyId, a.academyId), eq(t.revisions.sessionId, s.id)))
        ).some((r) => r.status === "PUBLISHED" || r.status === "IN_PROGRESS");
        if (!seen) continue;
      }
    } else if (!staff && s.coachId !== a.id) continue;
    const batch = batches.get(s.batchId ?? "")?.name ?? "";
    const kids = guardian
      ? [
          ...new Set(
            (mine.length ? mine.map((m) => m.id) : children.filter((c) => c.batchId === s.batchId).map((c) => c.id)).map(
              (id) => firstName(children.find((c) => c.id === id)?.name ?? ""),
            ),
          ),
        ].filter(Boolean)
      : [];
    const title = d.title?.trim() || `${batch || "Badminton"} training`;
    events.push({
      uid: `${s.id}@sportozen`,
      title: `${cancelled ? "Cancelled: " : ""}${kids.length ? `${kids.join(" & ")} – ` : ""}${title}`,
      startAt: d.startsAt,
      endAt: end,
      description: [
        guardian ? batch : `${batch}${batch ? " · " : ""}${d.roster.length} player${d.roster.length === 1 ? "" : "s"}`,
        cancelled ? "This session was cancelled." : drillsText(d.activities.map((x) => ({ title: x.title, minutes: x.minutes }))),
        a.academyName,
      ]
        .filter(Boolean)
        .join("\n\n"),
      status: cancelled ? "CANCELLED" : "CONFIRMED",
      sequence: s.version,
      updatedAt: s.updatedAt.toISOString(),
    });
  }
  const rows = await db.select().from(t.calendarEvents).where(eq(t.calendarEvents.academyId, a.academyId));
  for (const e of rows) {
    const d = e.data;
    if (e.kind === "CLOSURE" || !d.startsAt) continue;
    const cancelled = e.status === "CANCELLED",
      end = d.endsAt || plus(d.startsAt, d.duration || 60);
    if (Date.parse(end) < (cancelled ? now - CANCELLED_STAFF_DAYS * 86_400_000 : since)) continue;
    if (guardian) {
      if (!d.playerIds.some((id) => childIds.has(id)) && !(d.batchId && childBatches.has(d.batchId))) continue;
    } else if (!staff && d.coachId !== a.id) continue;
    events.push({
      uid: `${e.id}@sportozen`,
      title: `${cancelled ? "Cancelled: " : ""}${d.title}`,
      startAt: d.startsAt,
      endAt: end,
      description: [cancelled ? "This was cancelled." : "", a.academyName].filter(Boolean).join("\n\n"),
      status: cancelled ? "CANCELLED" : "CONFIRMED",
      sequence: e.version,
    });
  }
  return events.sort((x, y) => x.startAt.localeCompare(y.startAt));
}

/** The calendar text for a link secret, or null when the link is not valid (or no longer is). */
export async function feedFor(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
  const db = database();
  const [row] = await db
    .select()
    .from(t.verification)
    .where(eq(t.verification.identifier, `${PREFIX}${hash(token)}`));
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  let academyId: string, userId: string;
  try {
    [academyId, userId] = JSON.parse(row.value) as [string, string];
  } catch {
    return null;
  }
  const [member] = await db
    .select({ role: t.memberships.role, active: t.memberships.active, displayName: t.memberships.displayName })
    .from(t.memberships)
    .where(and(eq(t.memberships.academyId, academyId), eq(t.memberships.userId, userId)));
  if (!member?.active) return null;
  const [academy] = await db.select().from(t.academies).where(eq(t.academies.id, academyId));
  const [person] = await db.select({ name: t.user.name }).from(t.user).where(eq(t.user.id, userId));
  if (!academy || !person) return null;
  const actor: Actor = {
    id: userId,
    name: member.displayName ?? person.name,
    academyId,
    role: member.role,
    timezone: academy.timezone,
    academyName: academy.name,
  };
  if (!hasFeed(actor)) return null;
  return buildIcs(`${academy.name} – training`, await feedEvents(actor));
}
