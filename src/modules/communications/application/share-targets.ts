import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { can, requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import {
  accessiblePlayers,
  linkedRecipients,
  requireFeature,
  unit,
  type Tx,
} from "../../academy/application/access";
import { reportAccess } from "../../reports/application/service";

/**
 * "Tell everyone", free. The server only works out WHO should be told and HOW they may be reached; the person sending
 * presses a button per row and their own WhatsApp or mail app opens with the message ready. Nothing is sent from here and
 * nothing here ever claims a message was delivered.
 *
 * Every parent linked to a player on the session is listed with the e-mail address on their account and the WhatsApp
 * number saved for them (if any); no separate consent record is needed. A missing number is added from the list.
 */
export type ShareTarget = {
  userId: string;
  /** True for the coach running the session; false for a parent. (A flag, so no screen has to name a stored role.) */
  staff: boolean;
  name: string;
  email: string | null;
  phone: string | null;
  children: string[];
};
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";
/** Those who see every session (capability `training.allSessions`); a coach sees only their own. */
const seesAll = (a: Actor) => can(a, "training.allSessions");

async function parentsOf(a: Actor, playerIds: string[], tx: Tx): Promise<ShareTarget[]> {
  const allowed = new Set((await accessiblePlayers(a, tx)).map((p) => p.id));
  const ids = [...new Set(playerIds)].filter((id) => allowed.has(id));
  if (!ids.length) return [];
  const names = new Map(
    (await tx.select().from(t.players).where(and(eq(t.players.academyId, a.academyId), inArray(t.players.id, ids)))).map(
      (p) => [p.id, p.name] as const,
    ),
  );
  const out = new Map<string, ShareTarget>();
  for (const { link, user, displayName } of await linkedRecipients(a, ids, tx)) {
    const entry = out.get(user.id) ?? {
      userId: user.id,
      staff: false,
      name: displayName ?? user.name,
      email: user.email || null,
      phone: user.phone ?? null,
      children: [],
    };
    const child = firstName(names.get(link.playerId) ?? "");
    if (child && !entry.children.includes(child)) entry.children.push(child);
    out.set(user.id, entry);
  }
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/** Who to tell about one training session or calendar event: its coach and the parents of the players on it. */
export async function sessionShare(a: Actor, input: unknown) {
  requireCapability(a, "comms.author");
  const v = z.object({ kind: z.enum(["SESSION", "EVENT"]), id: z.string().min(1).max(200) }).parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "communications", tx);
    let title: string, startsAt: string | null, duration: number, timezone: string, status: string;
    let coachId: string, batchId: string | null, playerIds: string[], drills: { name: string; minutes: number }[];
    if (v.kind === "SESSION") {
      const [s] = await tx
        .select()
        .from(t.trainingSessions)
        .where(and(eq(t.trainingSessions.academyId, a.academyId), eq(t.trainingSessions.id, v.id)));
      if (!s || (!seesAll(a) && s.coachId !== a.id)) throw new DomainError("Session not found.", 404);
      if (s.status === "DRAFT") throw new DomainError("This session is still a draft. Publish it before telling anyone.", 409);
      ({ title, startsAt, duration, timezone } = s.data);
      status = s.status === "CANCELLED" ? "CANCELLED" : "SCHEDULED";
      coachId = s.coachId;
      batchId = s.batchId;
      playerIds = s.data.roster.map((r) => r.id);
      drills = s.data.activities.map((x) => ({ name: x.title, minutes: x.minutes }));
    } else {
      const [e] = await tx
        .select()
        .from(t.calendarEvents)
        .where(and(eq(t.calendarEvents.academyId, a.academyId), eq(t.calendarEvents.id, v.id)));
      if (!e || e.kind === "CLOSURE" || (!seesAll(a) && e.data.coachId !== a.id))
        throw new DomainError("Event not found.", 404);
      ({ title, startsAt, duration, timezone } = e.data);
      status = e.status === "CANCELLED" ? "CANCELLED" : "SCHEDULED";
      coachId = e.data.coachId;
      batchId = e.data.batchId || null;
      playerIds = e.data.playerIds;
      drills = [];
    }
    if (!startsAt) throw new DomainError("This has no date and time yet.", 409);
    if (batchId) {
      const inBatch = await tx
        .select({ id: t.players.id })
        .from(t.players)
        .where(and(eq(t.players.academyId, a.academyId), eq(t.players.batchId, batchId)));
      playerIds = [...playerIds, ...inBatch.map((p) => p.id)];
    }
    const people: ShareTarget[] = [];
    if (coachId) {
      const [coach] = await tx
        .select({ id: t.user.id, name: t.user.name, email: t.user.email, phone: t.user.phone, display: t.memberships.displayName })
        .from(t.memberships)
        .innerJoin(t.user, eq(t.user.id, t.memberships.userId))
        .where(and(eq(t.memberships.academyId, a.academyId), eq(t.memberships.userId, coachId), eq(t.memberships.active, true)));
      if (coach)
        people.push({
          userId: coach.id,
          staff: true,
          name: coach.display ?? coach.name,
          email: coach.email,
          phone: coach.phone,
          children: [],
        });
    }
    people.push(...(await parentsOf(a, playerIds, tx)));
    return {
      academyName: a.academyName,
      country: await countryOf(a, tx),
      session: {
        status,
        title,
        startAt: startsAt,
        endAt: new Date(Date.parse(startsAt) + (duration || 60) * 60_000).toISOString(),
        timezone,
        location: "",
        drills,
      },
      people,
    };
  });
}

async function countryOf(a: Actor, tx: Tx) {
  const [s] = await tx.select({ data: t.academySettings.data }).from(t.academySettings).where(eq(t.academySettings.academyId, a.academyId));
  return s?.data.country ?? "IN";
}

/** Who to tell about one PUBLISHED report: the parents of its player. A draft, a revised draft or a withdrawn report is refused. */
export async function reportShare(a: Actor, input: unknown) {
  requireCapability(a, "comms.author");
  const v = z.object({ id: z.string().min(1).max(200) }).parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "communications", tx);
    const report = await reportAccess(a, v.id, tx);
    if (report.status !== "PUBLISHED")
      throw new DomainError("Only a published report can be shared with a parent.", 409);
    const [player] = await tx
      .select()
      .from(t.players)
      .where(and(eq(t.players.academyId, a.academyId), eq(t.players.id, report.playerId)));
    return {
      academyName: a.academyName,
      country: await countryOf(a, tx),
      report: { id: report.id, title: report.data.title, childFirstName: firstName(player?.name ?? "") },
      people: await parentsOf(a, [report.playerId], tx),
    };
  });
}

/**
 * Who to tell about a BATCH of published reports, parent by parent: a parent with two children in the batch appears once,
 * with both names, so one message covers both. Reports that are not published are listed in `notPublished` and left out.
 * Nothing is sent from here.
 */
export async function reportBatchShare(a: Actor, input: unknown) {
  requireCapability(a, "comms.author");
  const v = z.object({ reportIds: z.array(z.string().min(1).max(200)).min(1).max(300) }).parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "communications", tx);
    const published: { id: string; title: string; playerId: string }[] = [];
    const notPublished: string[] = [];
    for (const id of [...new Set(v.reportIds)]) {
      const report = await reportAccess(a, id, tx);
      if (report.status === "PUBLISHED") published.push({ id: report.id, title: report.data.title, playerId: report.playerId });
      else notPublished.push(report.id);
    }
    return {
      academyName: a.academyName,
      country: await countryOf(a, tx),
      titles: [...new Set(published.map((r) => r.title))],
      reportCount: published.length,
      notPublished,
      people: await parentsOf(a, published.map((r) => r.playerId), tx),
    };
  });
}
