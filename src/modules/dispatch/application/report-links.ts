import { and, eq, sql } from "drizzle-orm";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import { config } from "../../../shared/config";
import { guardianMayReceive } from "../../academy/application/access";
import { DomainError } from "../../training/domain/rules";
import { readLinkToken } from "../link-token";

/**
 * Opening a report link. The caller is the SIGNED-IN person (their id comes from the session, never from the request); the
 * request carries only the token. A link opens a report only when ALL of these hold, and every failure is the same plain
 * "not available" answer so the page reveals nothing about which condition failed:
 *   - the token is one this server made (unforgeable) and its link is neither revoked nor expired;
 *   - its batch is still approved and its message was not cancelled or skipped;
 *   - the report is still PUBLISHED (a withdrawn report stops opening at once);
 *   - the signed-in account is an ACTIVE parent of THAT player in THAT academy with the right to receive reports.
 * Forwarding a link therefore gives nothing to anyone who is not that child's parent, and a player (who has no login) cannot
 * open it alone.
 */
const unavailable = () => new DomainError("This report is not available to this account. Sign in with the account that was invited, or ask the academy to send it again.", 404, "REPORT_LINK_UNAVAILABLE");

export async function openReportLink(person: { id: string }, token: unknown) {
  const id = readLinkToken(config().BETTER_AUTH_SECRET, token);
  if (!id) throw unavailable();
  const db = database();
  const [row] = await db
    .select({ link: t.reportLinks, item: t.dispatchItems, batch: t.dispatchBatches, report: t.reports, academy: t.academies.name })
    .from(t.reportLinks)
    .innerJoin(t.dispatchItems, and(eq(t.dispatchItems.academyId, t.reportLinks.academyId), eq(t.dispatchItems.id, t.reportLinks.itemId)))
    .innerJoin(t.dispatchBatches, and(eq(t.dispatchBatches.academyId, t.dispatchItems.academyId), eq(t.dispatchBatches.id, t.dispatchItems.batchId)))
    .innerJoin(t.reports, and(eq(t.reports.academyId, t.reportLinks.academyId), eq(t.reports.id, t.reportLinks.reportId)))
    .innerJoin(t.academies, eq(t.academies.id, t.reportLinks.academyId))
    .where(eq(t.reportLinks.id, id));
  const now = Date.now();
  if (
    !row ||
    row.link.revokedAt ||
    row.link.expiresAt.getTime() <= now ||
    row.batch.status !== "APPROVED" ||
    ["CANCELLED", "SKIPPED"].includes(row.item.status) ||
    row.report.status !== "PUBLISHED"
  )
    throw unavailable();
  const academyId = row.link.academyId;
  const [parent] = await db
    .select({ active: t.guardianLinks.active, member: t.memberships.active })
    .from(t.guardianLinks)
    .innerJoin(t.memberships, and(eq(t.memberships.academyId, t.guardianLinks.academyId), eq(t.memberships.userId, t.guardianLinks.userId)))
    .where(and(eq(t.guardianLinks.academyId, academyId), eq(t.guardianLinks.playerId, row.report.playerId), eq(t.guardianLinks.userId, person.id)));
  if (!parent?.active || !parent.member) throw unavailable();
  if (!(await guardianMayReceive(academyId, row.report.playerId, person.id, "REPORTS", db))) throw unavailable();
  await db
    .update(t.reportLinks)
    .set({ firstOpenedAt: sql`coalesce(${t.reportLinks.firstOpenedAt}, now())`, openCount: sql`${t.reportLinks.openCount} + 1` })
    .where(eq(t.reportLinks.id, row.link.id));
  return {
    academyId,
    academyName: row.academy,
    reportId: row.report.id,
    title: row.report.data.title,
    childFirstName: row.report.data.playerName.trim().split(/\s+/)[0] ?? "",
  };
}
