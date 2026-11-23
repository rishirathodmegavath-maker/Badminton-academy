import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import { accessiblePlayers, requireFeature, unit } from "../../academy/application/access";
import { reportIssues, type ReportIssue } from "../domain/batch-rules";
import { reportWarnings, type Warning } from "../domain/report-analysis";
import { loadPolicy } from "./policy";
import { createReport, reportAccess, updateReport } from "./service";

/**
 * Batch reports: assemble drafts for many players at once, see which are ready, and let the owner approve the ready ones.
 *
 *  - Nothing new is stored. A draft is the ordinary report (createReport), so every existing rule still applies: the player
 *    must be one the actor may see, the evidence is the recorded sessions only, observations need their reviewed wording.
 *  - A report for the same player and period is never made twice. A withdrawn one does not count.
 *  - Batch approval walks each report through the ordinary steps (submit, approve, publish) one report at a time, so a
 *    problem with one report never undoes or blocks the others. Every report is judged by `reportIssues`: a report with any
 *    issue is excluded and the reason is returned. Approving by hand stays possible for a flagged report once it is fixed.
 *  - Results are per report. There is no all-or-nothing step, so nothing is lost when one report is refused.
 */
const MAX_PLAYERS = 300;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const period = z.object({ periodStart: day, periodEnd: day });

export type BatchRow = {
  playerId: string;
  playerName: string;
  batchId: string;
  report: { id: string; status: string; version: number; title: string } | null;
  issues: ReportIssue[];
  /** What the records do not contain (never blocks): no earlier period to compare with, no reviewed observation in an area. */
  warnings: Warning[];
  /** Ready for batch approval: a draft, in review or approved report with no issues. */
  ready: boolean;
};

const ACTIVE = ["DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHED"];

/** The players the actor may see, optionally narrowed to one batch or a chosen few, with their report for this period. */
export async function batchReportView(a: Actor, input: unknown) {
  requireCapability(a, "reports.read");
  const v = period
    .extend({ batchId: z.string().max(200).optional(), playerIds: z.array(z.string().max(200)).max(MAX_PLAYERS).optional() })
    .parse(input);
  if (v.periodStart > v.periodEnd) throw new DomainError("The period end must follow its start.");
  return unit(a, async (tx) => {
    await requireFeature(a, "reports", tx);
    const { requiredCategories } = await loadPolicy(tx, a.academyId);
    let players = (await accessiblePlayers(a, tx)).filter((p) => !v.batchId || p.batchId === v.batchId);
    if (v.playerIds) players = players.filter((p) => v.playerIds!.includes(p.id));
    players = players.slice(0, MAX_PLAYERS);
    const reports = players.length
      ? await tx
          .select()
          .from(t.reports)
          .where(and(eq(t.reports.academyId, a.academyId), inArray(t.reports.playerId, players.map((p) => p.id))))
      : [];
    const rows: BatchRow[] = players
      .map((p) => {
        const r = reports.find(
          (x) => x.playerId === p.id && x.data.periodStart === v.periodStart && x.data.periodEnd === v.periodEnd && ACTIVE.includes(x.status),
        );
        const open = !!r && r.status !== "PUBLISHED";
        const issues = open ? reportIssues(r.data, { requiredCategories }) : [];
        return {
          playerId: p.id,
          playerName: p.name,
          batchId: p.batchId,
          report: r ? { id: r.id, status: r.status, version: r.version, title: r.data.title } : null,
          issues,
          warnings: open ? reportWarnings(r.data.analysis, requiredCategories) : [],
          ready: open && issues.length === 0,
        };
      })
      .sort((x, y) => x.playerName.localeCompare(y.playerName));
    return { rows };
  });
}

export type DraftOutcome = { playerId: string; outcome: "CREATED" | "EXISTS" | "SKIPPED"; reason?: string; reportId?: string };

/** Makes a draft for each chosen player who has none for this period. A player with nothing to report is skipped, with the reason. */
export async function batchCreateDrafts(a: Actor, input: unknown) {
  requireCapability(a, "reports.author");
  const v = period
    .extend({
      playerIds: z.array(z.string().min(1).max(200)).min(1).max(MAX_PLAYERS),
      title: z.string().trim().min(2).max(150),
      autoWrite: z.boolean().optional(),
    })
    .parse(input);
  if (v.periodStart > v.periodEnd) throw new DomainError("The period end must follow its start.");
  const have = await unit(a, async (tx) => {
    await requireFeature(a, "reports", tx);
    return tx
      .select({ playerId: t.reports.playerId, id: t.reports.id, status: t.reports.status, data: t.reports.data })
      .from(t.reports)
      .where(and(eq(t.reports.academyId, a.academyId), inArray(t.reports.playerId, v.playerIds)));
  });
  const results: DraftOutcome[] = [];
  for (const playerId of [...new Set(v.playerIds)]) {
    const existing = have.find(
      (r) => r.playerId === playerId && r.data.periodStart === v.periodStart && r.data.periodEnd === v.periodEnd && ACTIVE.includes(r.status),
    );
    if (existing) {
      results.push({ playerId, outcome: "EXISTS", reportId: existing.id });
      continue;
    }
    try {
      const made = await createReport(a, { playerId, periodStart: v.periodStart, periodEnd: v.periodEnd, title: v.title, autoWrite: v.autoWrite });
      results.push({ playerId, outcome: "CREATED", reportId: made.id });
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      results.push({ playerId, outcome: "SKIPPED", reason: e.message });
    }
  }
  return { results };
}

export type ApproveOutcome = {
  reportId: string;
  outcome: "PUBLISHED" | "BLOCKED" | "ALREADY_PUBLISHED" | "FAILED";
  issues?: ReportIssue[];
  reason?: string;
};

/**
 * The owner approves and publishes the ready reports. A report with any issue is BLOCKED and left exactly as it was.
 * Publishing is part of this step because families only ever see a published report.
 */
export async function batchApprove(a: Actor, input: unknown) {
  requireCapability(a, "reports.approve");
  const v = z.object({ reportIds: z.array(z.string().min(1).max(200)).min(1).max(MAX_PLAYERS) }).parse(input);
  const { requiredCategories } = await unit(a, async (tx) => ({ requiredCategories: (await loadPolicy(tx, a.academyId)).requiredCategories }));
  const results: ApproveOutcome[] = [];
  for (const reportId of [...new Set(v.reportIds)]) {
    try {
      let r = await unit(a, (tx) => reportAccess(a, reportId, tx));
      if (r.status === "PUBLISHED") {
        results.push({ reportId, outcome: "ALREADY_PUBLISHED" });
        continue;
      }
      if (!["DRAFT", "IN_REVIEW", "APPROVED"].includes(r.status)) {
        results.push({ reportId, outcome: "BLOCKED", issues: [], reason: "This report is not waiting for approval." });
        continue;
      }
      const issues = reportIssues(r.data, { requiredCategories });
      if (issues.length) {
        results.push({ reportId, outcome: "BLOCKED", issues });
        continue;
      }
      const step = async (action: "submit" | "approve" | "publish") => {
        r = await updateReport(a, { id: r.id, version: r.version, action, summary: r.data.summary ?? "", reason: "Batch approval" });
      };
      if (r.status === "DRAFT") await step("submit");
      if (r.status === "IN_REVIEW") await step("approve");
      if (r.status === "APPROVED") await step("publish");
      results.push({ reportId, outcome: "PUBLISHED" });
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      results.push({ reportId, outcome: "FAILED", reason: e.message });
    }
  }
  return { results };
}
