import { z } from "zod";
import { and, eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import {
  unit,
  requirePlayer,
  requireFeature,
  history,
  expectVersion,
  family,
  type Tx,
} from "../../academy/application/access";
import { publicationState } from "../../academy/domain/withdrawal";
import { REPORT_LIMITS, cleanPriorities } from "../domain/report-sheet";
import { assembleDraft } from "./draft";
import { writeFromRecords } from "../domain/batch-rules";
import {
  withdrawPublished,
  withdrawalReason,
} from "../../academy/application/withdrawal";
export async function reviewObservation(a: Actor, input: unknown) {
  requireCapability(a, "reports.author");
  const v = z
    .object({
      sessionId: z.string(),
      observationId: z.string(),
      approvedText: z.string().trim().min(1).max(2000),
      // Optional tag: which area this reviewed observation is about. Untagged observations are not counted in an area.
      category: z.enum(["TECHNICAL", "TACTICAL", "PHYSICAL", "BEHAVIOUR"]).nullish(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "reports", tx);
    const [s] = await tx
      .select()
      .from(t.trainingSessions)
      .where(
        and(
          eq(t.trainingSessions.academyId, a.academyId),
          eq(t.trainingSessions.id, v.sessionId),
        ),
      );
    if (!s || (a.role === "COACH" && s.coachId !== a.id))
      throw new DomainError("Session not found.", 404);
    const n = s.data.observations.find((n) => n.id === v.observationId);
    if (!n) throw new DomainError("Observation not found.", 404);
    const [old] = await tx
      .select()
      .from(t.observationReviews)
      .where(
        and(
          eq(t.observationReviews.academyId, a.academyId),
          eq(t.observationReviews.sessionId, s.id),
          eq(t.observationReviews.observationId, n.id),
        ),
      );
    if (old)
      throw new DomainError(
        "This observation is already reviewed. Published reports preserve the existing review.",
      );
    await tx
      .insert(t.observationReviews)
      .values({
        academyId: a.academyId,
        sessionId: s.id,
        observationId: n.id,
        approvedText: v.approvedText,
        category: v.category ?? null,
        reviewerId: a.id,
      });
    await tx
      .insert(t.audit)
      .values({
        id: crypto.randomUUID(),
        academyId: a.academyId,
        actorId: a.id,
        entityId: n.id,
        action: "observation-reviewed",
        version: 1,
        detail: { sessionId: s.id },
      });
    return { ok: true };
  });
}
export async function createReport(a: Actor, input: unknown) {
  requireCapability(a, "reports.author");
  const v = z
    .object({
      playerId: z.string(),
      periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      title: z.string().trim().min(2).max(150),
      // The one-click batch report: the wording is written from the records (batch-rules.writeFromRecords) for the coach to edit.
      autoWrite: z.boolean().optional(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "reports", tx);
    const player = await requirePlayer(a, v.playerId, tx);
    if (v.periodStart > v.periodEnd)
      throw new DomainError("Report period end must follow its start.");
    const data = await assembleDraft(
      tx,
      { academyId: a.academyId, academyName: a.academyName, coachOnlyId: ["COACH"].includes(a.role) ? a.id : undefined },
      player,
      v,
    );
    if (v.autoWrite)
      Object.assign(
        data,
        writeFromRecords({ playerName: player.name, periodStart: v.periodStart, periodEnd: v.periodEnd, evidence: data.evidence, analysis: data.analysis }),
        { autoWritten: true },
      );
    const id = crypto.randomUUID();
    const [report] = await tx
      .insert(t.reports)
      .values({ id, academyId: a.academyId, playerId: player.id, data })
      .returning();
    await history(tx, a, "report", id, 1, { data, status: "DRAFT" });
    return report;
  });
}
export async function reportAccess(a: Actor, id: string, tx: Tx) {
  await requireFeature(a, "reports", tx);
  const [r] = await tx
    .select()
    .from(t.reports)
    .where(and(eq(t.reports.academyId, a.academyId), eq(t.reports.id, id)));
  if (!r) throw new DomainError("Report not found.", 404);
  // RC-4: a guardian of an adult player needs the REPORTS section (also for the PDF, which calls this).
  await requirePlayer(a, r.playerId, tx, "REPORTS");
  if (family(a) && r.status !== "PUBLISHED") {
    const versions = await tx
      .select()
      .from(t.recordRevisions)
      .where(
        and(
          eq(t.recordRevisions.academyId, a.academyId),
          eq(t.recordRevisions.entityId, r.id),
        ),
      );
    // The newest published revision, unless a withdrawal came after it (Phase 6).
    const published = publicationState(versions, "report").live;
    if (!published) throw new DomainError("Report not found.", 404);
    return {
      ...r,
      status: "PUBLISHED",
      version: published.version,
      data: (published.data as { data: typeof r.data }).data,
    };
  }
  if (!family(a)) requireCapability(a, "reports.read");
  return r;
}
/**
 * Withdraws a report from families. Not a revision: the history stays, the published revision
 * simply stops being available to them (see academy/application/withdrawal.ts). Same authority as
 * publishing (owner, admin, head coach), for reports of players the actor can see.
 */
export async function withdrawReport(a: Actor, input: unknown) {
  requireCapability(a, "reports.approve");
  const v = z
    .object({
      id: z.string().min(1).max(200),
      version: z.number().int(),
      reason: z.string().max(2000),
    })
    .parse(input);
  const reason = withdrawalReason(v.reason);
  return unit(a, async (tx) => {
    const r = await reportAccess(a, v.id, tx);
    expectVersion(r.version, v.version);
    return withdrawPublished(tx, a, {
      kind: "report",
      row: r,
      reason,
      save: async (status, version) => {
        const [saved] = await tx
          .update(t.reports)
          .set({ status, version })
          .where(
            and(eq(t.reports.academyId, a.academyId), eq(t.reports.id, r.id)),
          )
          .returning();
        return saved;
      },
    });
  });
}
export async function updateReport(a: Actor, input: unknown) {
  requireCapability(a, "reports.author");
  const v = z
    .object({
      id: z.string(),
      version: z.number().int(),
      action: z.enum(["save", "submit", "approve", "publish", "revise"]),
      summary: z.string().max(REPORT_LIMITS.summary),
      reason: z.string().max(500),
      // Coach-entered report sections. Omitted = unchanged, so older callers keep working.
      strengths: z.string().max(REPORT_LIMITS.strengths).optional(),
      improvements: z.string().max(REPORT_LIMITS.improvements).optional(),
      priorities: z.array(z.string().max(REPORT_LIMITS.priority)).max(REPORT_LIMITS.priorities).optional(),
      closingNote: z.string().max(REPORT_LIMITS.closingNote).optional(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    const r = await reportAccess(a, v.id, tx);
    expectVersion(r.version, v.version);
    let status = r.status;
    let data = { ...r.data };
    if (v.action === "revise") {
      requireCapability(a, "reports.approve");
      if (
        !["PUBLISHED", "APPROVED", "WITHDRAWN"].includes(status) ||
        v.reason.trim().length < 3
      )
        throw new DomainError(
          "Revision requires an approved/published report and a reason.",
        );
      status = "DRAFT";
      data = { ...data, reviewer: null, reviewerId: null, approvedAt: null };
    } else if (v.action === "save") {
      if (status !== "DRAFT")
        throw new DomainError("Only report drafts can be edited.");
      data.summary = v.summary;
      if (v.strengths !== undefined) data.strengths = v.strengths.trim();
      if (v.improvements !== undefined) data.improvements = v.improvements.trim();
      if (v.priorities !== undefined) data.priorities = cleanPriorities(v.priorities);
      if (v.closingNote !== undefined) data.closingNote = v.closingNote.trim();
    } else if (v.action === "submit") {
      if (status !== "DRAFT")
        throw new DomainError("Submit a report draft for review.");
      status = "IN_REVIEW";
    } else if (v.action === "approve") {
      requireCapability(a, "reports.approve");
      if (status !== "IN_REVIEW")
        throw new DomainError("Submit the report before approval.");
      status = "APPROVED";
      data = {
        ...data,
        // Attribution comes only from the signed-in session, never from the request: the name is a
        // snapshot taken now, the id says which account approved.
        reviewer: a.name,
        reviewerId: a.id,
        approvedAt: new Date().toISOString(),
      };
    } else {
      requireCapability(a, "reports.approve");
      if (status !== "APPROVED")
        throw new DomainError("Approve before publication.");
      status = "PUBLISHED";
    }
    const version = r.version + 1;
    const [saved] = await tx
      .update(t.reports)
      .set({ data, status, version })
      .where(and(eq(t.reports.academyId, a.academyId), eq(t.reports.id, r.id)))
      .returning();
    await history(tx, a, "report", r.id, version, {
      data,
      status,
      reason: v.reason,
    });
    return saved;
  });
}
