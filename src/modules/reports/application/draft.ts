import { and, eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Tx } from "../../academy/application/access";
import { DomainError } from "../../training/domain/rules";
import { factsSummary } from "../domain/batch-rules";
import { analyse, type ObservationCategory, type SessionFact } from "../domain/report-analysis";

/**
 * Assembles one player's draft report for a period from RECORDED data only: completed sessions the player was on the roster
 * of, the player's own attendance mark, the activities done while present, reviewed observation wording, and counts derived
 * from those. Used by the manual "Create report", by batch drafting and by the scheduler, so all three assemble identically.
 * Nothing is written here; the caller stores the result as a DRAFT. `coachOnlyId` limits the evidence to one coach's sessions
 * (a coach sees only their own).
 */
export async function assembleDraft(
  tx: Tx,
  ctx: { academyId: string; academyName: string; coachOnlyId?: string },
  player: { id: string; name: string; batchId: string },
  v: { periodStart: string; periodEnd: string; title: string },
) {
  const [batch] = await tx
    .select({ name: t.batches.name })
    .from(t.batches)
    .where(and(eq(t.batches.academyId, ctx.academyId), eq(t.batches.id, player.batchId)));
  const [sessions, reviews] = await Promise.all([
    tx.select().from(t.trainingSessions).where(eq(t.trainingSessions.academyId, ctx.academyId)),
    tx.select().from(t.observationReviews).where(eq(t.observationReviews.academyId, ctx.academyId)),
  ]);
  const mine = sessions.filter(
    (s) =>
      s.status === "COMPLETED" &&
      s.data.roster.some((p) => p.id === player.id) &&
      (!ctx.coachOnlyId || s.coachId === ctx.coachOnlyId),
  );
  const reviewed = (sessionId: string, observationId: string) =>
    reviews.find((r) => r.sessionId === sessionId && r.observationId === observationId);
  const done = (s: (typeof mine)[number]) =>
    s.data.attendance[player.id] === "PRESENT"
      ? s.data.activities.filter((act) => s.data.actuals[act.id] === "COMPLETED" || s.data.actuals[act.id] === "MODIFIED")
      : [];
  const evidence = mine
    .filter((s) => s.data.localDate >= v.periodStart && s.data.localDate <= v.periodEnd)
    // The query has no ORDER BY, so the rows come back in whatever order the database holds them. A report lists its sessions
    // in the order they happened (then by title and id, so equal dates never swap places between two drafts).
    .sort((x, y) => x.data.localDate.localeCompare(y.data.localDate) || x.data.title.localeCompare(y.data.title) || x.id.localeCompare(y.id))
    .map((s) => ({
      sessionId: s.id,
      title: s.data.title,
      date: s.data.localDate,
      // Recorded, never inferred: the player's own attendance mark, and the activities done while attending.
      attendance: s.data.attendance[player.id] ?? ("NOT_MARKED" as const),
      practised: done(s).map((act) => ({
        title: act.title,
        skill: act.snapshot?.skill ?? null,
        status: s.data.actuals[act.id] as "COMPLETED" | "MODIFIED",
      })),
      activities: done(s).map((act) => `${act.title} (${s.data.actuals[act.id].toLowerCase()})`),
      observations: s.data.observations
        .filter((n) => n.playerId === player.id)
        .flatMap((n) => {
          const review = reviewed(s.id, n.id);
          return review ? [review.approvedText] : [];
        }),
      observationDetails: s.data.observations
        .filter((n) => n.playerId === player.id)
        .flatMap((n) => {
          const review = reviewed(s.id, n.id);
          return review ? [{ text: review.approvedText, category: (review.category ?? null) as ObservationCategory | null }] : [];
        }),
    }));
  if (!evidence.length) throw new DomainError("No completed sessions were recorded for this player and period.");
  // Counts for this period and the one before it, from every completed session of the player (the same coach scope).
  const facts: SessionFact[] = mine.map((s) => ({
    date: s.data.localDate,
    attendance: s.data.attendance[player.id] ?? "NOT_MARKED",
    practised: done(s).map((act) => ({ skill: act.snapshot?.skill ?? null, minutes: act.minutes })),
    categories: s.data.observations
      .filter((n) => n.playerId === player.id)
      .flatMap((n) => {
        const review = reviewed(s.id, n.id);
        return review ? [(review.category ?? null) as ObservationCategory | null] : [];
      }),
  }));
  return {
    playerId: player.id,
    periodStart: v.periodStart,
    periodEnd: v.periodEnd,
    title: v.title,
    summary: "",
    strengths: "",
    improvements: "",
    priorities: [] as string[],
    closingNote: "",
    group: batch?.name,
    // Counts from the records only (see reports/domain). The coach may use the facts line as the summary.
    facts: factsSummary({ playerName: player.name, periodStart: v.periodStart, periodEnd: v.periodEnd, evidence }),
    analysis: analyse(facts, v.periodStart, v.periodEnd),
    evidence,
    academyName: ctx.academyName,
    playerName: player.name,
    reviewer: null,
    approvedAt: null,
  };
}
