import { z } from "zod";
import { and, eq, or, sql } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import { database } from "../../../infrastructure/database/client";
import type { Actor } from "../../identity/access";
import { can, requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import { accessiblePlayers, history, requireFeature, unit, type Tx } from "../../academy/application/access";
import { assembleDraft } from "./draft";
import { writeFromRecords } from "../domain/batch-rules";
import {
  DEFAULT_POLICY,
  OBSERVATION_CATEGORIES,
  computeDue,
  type DueDraft,
  type DuePlayer,
  type Policy,
} from "../domain/report-analysis";

/**
 * Report policy, the list of drafts that are DUE, and the preparation of those drafts.
 *
 *  - Policy: monthly drafts on/off, drafts after N completed sessions on/off, which observation categories the academy
 *    requires. Setting it needs `reports.approve` (owner-level). Whoever switches a trigger on is recorded; the scheduler acts
 *    on that person's behalf and stops if they can no longer author reports.
 *  - Due: pure arithmetic over recorded data (see report-analysis.computeDue). Nothing here approves or sends anything.
 *  - Preparing: only ever creates DRAFTS. An existing report (any status but withdrawn) of the same player that overlaps the
 *    period is history to preserve, so nothing is duplicated or replaced. The check and the insert run under one advisory lock
 *    per academy and player, so two workers (or a worker and a person) can never both create the same draft.
 */
const rowToPolicy = (r: typeof t.reportPolicies.$inferSelect | undefined): Policy =>
  r
    ? { monthlyEnabled: r.monthlyEnabled, sessionsEnabled: r.sessionsEnabled, sessionsN: r.sessionsN, requiredCategories: r.requiredCategories }
    : { ...DEFAULT_POLICY };

export async function loadPolicy(tx: Pick<Tx, "select">, academyId: string): Promise<Policy> {
  const [r] = await tx.select().from(t.reportPolicies).where(eq(t.reportPolicies.academyId, academyId));
  return rowToPolicy(r);
}

export async function getReportPolicy(a: Actor) {
  requireCapability(a, "reports.read");
  return unit(a, async (tx) => {
    await requireFeature(a, "reports", tx);
    const [r] = await tx.select().from(t.reportPolicies).where(eq(t.reportPolicies.academyId, a.academyId));
    return { policy: rowToPolicy(r), enabledBy: r?.enabledBy ?? null, canEdit: can(a, "reports.approve") };
  });
}

export async function saveReportPolicy(a: Actor, input: unknown) {
  requireCapability(a, "reports.approve");
  const v = z
    .object({
      monthlyEnabled: z.boolean(),
      sessionsEnabled: z.boolean(),
      sessionsN: z.number().int().min(2).max(60),
      requiredCategories: z.array(z.enum(OBSERVATION_CATEGORIES as unknown as [string, ...string[]])).max(4),
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "reports", tx);
    const values = {
      monthlyEnabled: v.monthlyEnabled,
      sessionsEnabled: v.sessionsEnabled,
      sessionsN: v.sessionsN,
      requiredCategories: [...new Set(v.requiredCategories)],
      // The scheduler works on behalf of the person who switched it on, so that person is recorded; off means nobody.
      enabledBy: v.monthlyEnabled || v.sessionsEnabled ? a.id : null,
      updatedAt: new Date(),
    };
    await tx
      .insert(t.reportPolicies)
      .values({ academyId: a.academyId, ...values })
      .onConflictDoUpdate({ target: t.reportPolicies.academyId, set: values });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: a.academyId,
      action: "report-policy",
      version: 1,
      detail: { monthly: v.monthlyEnabled, sessions: v.sessionsEnabled, n: v.sessionsN, required: values.requiredCategories },
    });
    return { policy: rowToPolicy({ ...values, academyId: a.academyId } as typeof t.reportPolicies.$inferSelect) };
  });
}

/** The inputs `computeDue` needs, for the players the actor may see (and, for a coach, only their own sessions). */
async function dueInputs(tx: Tx, a: Pick<Actor, "academyId" | "id" | "role">, scoped: Awaited<ReturnType<typeof accessiblePlayers>>) {
  const ids = new Set(scoped.map((p) => p.id));
  const [profiles, sessions, reports] = await Promise.all([
    tx.select({ playerId: t.profiles.playerId, data: t.profiles.data }).from(t.profiles).where(eq(t.profiles.academyId, a.academyId)),
    tx.select().from(t.trainingSessions).where(and(eq(t.trainingSessions.academyId, a.academyId), eq(t.trainingSessions.status, "COMPLETED"))),
    tx.select({ playerId: t.reports.playerId, status: t.reports.status, data: t.reports.data }).from(t.reports).where(eq(t.reports.academyId, a.academyId)),
  ]);
  const players: DuePlayer[] = scoped.map((p) => {
    const mine = sessions.filter((s) => s.data.roster.some((r) => r.id === p.id) && (can(a, "training.allSessions") || s.coachId === a.id));
    return {
      id: p.id,
      name: p.name,
      active: profiles.find((x) => x.playerId === p.id)?.data.status === "ACTIVE",
      rosterDates: mine.map((s) => s.data.localDate),
      presentDates: mine.filter((s) => s.data.attendance[p.id] === "PRESENT").map((s) => s.data.localDate),
    };
  });
  return {
    players,
    reports: reports
      .filter((r) => ids.has(r.playerId))
      .map((r) => ({ playerId: r.playerId, periodStart: r.data.periodStart, periodEnd: r.data.periodEnd, status: r.status })),
  };
}
const todayIn = (timezone: string, now: Date) => now.toLocaleDateString("en-CA", { timeZone: timezone });

async function dueFor(tx: Tx, a: Actor, now: Date) {
  const policy = await loadPolicy(tx, a.academyId);
  const scoped = await accessiblePlayers(a, tx);
  const inputs = await dueInputs(tx, a, scoped);
  return { policy, due: computeDue({ today: todayIn(a.timezone, now), policy, ...inputs }) };
}

/** The drafts due today under the academy's policy, for the players the person may see. Read-only. */
export async function reportsDue(a: Actor, _input?: unknown, now = new Date()) {
  requireCapability(a, "reports.read");
  return unit(a, async (tx) => {
    await requireFeature(a, "reports", tx);
    const { policy, due } = await dueFor(tx, a, now);
    return { policy, due };
  });
}

export type PrepareOutcome = DueDraft & { outcome: "CREATED" | "EXISTS" | "SKIPPED"; reportId?: string; reason?: string };
/**
 * Creates ONE draft if the player still has no report overlapping the period. The overlap check and the insert are one step
 * under an advisory lock, so concurrent callers cannot both create it. `via` is recorded in the report's history.
 */
export async function prepareDraft(a: Actor, due: DueDraft, via: "manual" | "scheduler"): Promise<PrepareOutcome> {
  try {
    return await unit(a, async (tx): Promise<PrepareOutcome> => {
      await requireFeature(a, "reports", tx);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`report-draft|${a.academyId}|${due.playerId}`}, 0))`);
      const player = (await accessiblePlayers(a, tx)).find((p) => p.id === due.playerId);
      if (!player) throw new DomainError("Player not found.", 404);
      const existing = (await tx.select().from(t.reports).where(and(eq(t.reports.academyId, a.academyId), eq(t.reports.playerId, due.playerId)))).find(
        (r) => r.status !== "WITHDRAWN" && r.data.periodStart <= due.periodEnd && due.periodStart <= r.data.periodEnd,
      );
      if (existing) return { ...due, outcome: "EXISTS", reportId: existing.id };
      const data = await assembleDraft(
        tx,
        { academyId: a.academyId, academyName: a.academyName, coachOnlyId: can(a, "training.allSessions") ? undefined : a.id },
        player,
        { periodStart: due.periodStart, periodEnd: due.periodEnd, title: due.title },
      );
      // Written from the records like the one-click batch report (counts and reviewed coach observations only), for the coach to
      // edit. Still only a DRAFT: nothing is approved or delivered here.
      Object.assign(
        data,
        writeFromRecords({ playerName: player.name, periodStart: due.periodStart, periodEnd: due.periodEnd, evidence: data.evidence, analysis: data.analysis }),
        { autoWritten: true },
      );
      const id = crypto.randomUUID();
      await tx.insert(t.reports).values({ id, academyId: a.academyId, playerId: player.id, data });
      await history(tx, a, "report", id, 1, { data, status: "DRAFT", via, trigger: due.kind });
      return { ...due, outcome: "CREATED", reportId: id };
    });
  } catch (e) {
    if (e instanceof DomainError) return { ...due, outcome: "SKIPPED", reason: e.message };
    throw e;
  }
}

/** A person presses "create the due drafts": every draft due under the policy, for the players they may see. Drafts only. */
export async function createDueDrafts(a: Actor, _input?: unknown, now = new Date()) {
  requireCapability(a, "reports.author");
  const { due } = await unit(a, async (tx) => {
    await requireFeature(a, "reports", tx);
    return dueFor(tx, a, now);
  });
  const results: PrepareOutcome[] = [];
  for (const d of due) results.push(await prepareDraft(a, d, "manual"));
  return { results };
}

export type SchedulerAcademyResult = { academyId: string; created: number; existing: number; skipped: number; note?: string };
/**
 * The scheduled run (called by the background worker, never by a request). For each academy whose policy is on, it acts on
 * behalf of the person who switched the policy on: if that person is no longer an active member who may author reports, the
 * academy is skipped with a note rather than acting under someone else's name. It creates DRAFTS only. It is safe to run as
 * often as wanted and from several workers: a second run finds the drafts it would have made and creates nothing.
 */
export async function runReportScheduler(now = new Date()): Promise<SchedulerAcademyResult[]> {
  const db = database();
  const policies = await db
    .select()
    .from(t.reportPolicies)
    .where(or(eq(t.reportPolicies.monthlyEnabled, true), eq(t.reportPolicies.sessionsEnabled, true)));
  const out: SchedulerAcademyResult[] = [];
  for (const p of policies) {
    const result: SchedulerAcademyResult = { academyId: p.academyId, created: 0, existing: 0, skipped: 0 };
    try {
      const [who] = p.enabledBy
        ? await db
            .select({ id: t.user.id, name: t.user.name, role: t.memberships.role, active: t.memberships.active, academy: t.academies.name, timezone: t.academies.timezone })
            .from(t.memberships)
            .innerJoin(t.user, eq(t.user.id, t.memberships.userId))
            .innerJoin(t.academies, eq(t.academies.id, t.memberships.academyId))
            .where(and(eq(t.memberships.academyId, p.academyId), eq(t.memberships.userId, p.enabledBy)))
        : [];
      const actor: Actor | null = who
        ? { id: who.id, name: who.name, role: who.role, academyId: p.academyId, timezone: who.timezone, academyName: who.academy }
        : null;
      if (!actor || !who?.active || !can(actor, "reports.author") || !can(actor, "reports.read")) {
        out.push({ ...result, note: "The person who switched the schedule on can no longer author reports, so nothing was prepared." });
        continue;
      }
      const { due } = await unit(actor, async (tx) => dueFor(tx, actor, now));
      for (const d of due) {
        const r = await prepareDraft(actor, d, "scheduler");
        if (r.outcome === "CREATED") result.created++;
        else if (r.outcome === "EXISTS") result.existing++;
        else result.skipped++;
      }
    } catch (e) {
      result.note = `Could not run: ${(e as Error).message}`;
    }
    out.push(result);
  }
  return out;
}
