import { z } from "zod";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { reauthenticate } from "../../identity/reauth";
import { recordSecurityEvent, type SecurityEventName } from "../../identity/security-events";
import { DomainError } from "../../training/domain/rules";
import { denialAudited, recordAccess } from "../../audit/application/record";
import { expectVersion, unit, type Tx } from "../../academy/application/access";
import {
  CATEGORIES,
  OPEN_STATUSES,
  POLICY_PENDING,
  RETENTION_ACTIONS,
  SOURCES,
  canTransition,
  categoryInfo,
  evaluateEligibility,
  graceDays,
  validPrivacyReason,
  type CategoryKey,
  type Preview,
  type PreviewCategory,
  type RetentionAction,
  type Step,
} from "../domain";
import { inspect } from "./categories";
import { ledgerPath } from "./ledger";
/**
 * Phase 8: retention rules, erasure requests (the lifecycle), legal holds, and the reads behind the
 * Settings screen. Execution lives in process.ts.
 *
 * Rules enforced here, server-side, in one transaction under the academy lock (so approvals, holds,
 * cancellations and execution can never interleave):
 *  - only OWNER/ADMIN act; only the OWNER approves retention rules and releases holds;
 *  - a request is approved by someone other than whoever raised it, with password re-authentication;
 *  - every move must be in TRANSITIONS; nothing erases anything directly - approval only starts a grace
 *    period, and the processor re-checks policy, holds and subject before each step.
 */
export type Row = typeof t.erasureRequests.$inferSelect;
type Who = { id: string; role: string; academyId: string };
export const systemActor = (academyId: string): Actor => ({ id: "system", name: "System", role: "SYSTEM", academyId, timezone: "UTC", academyName: "" });
const E = (message: string, status: number, code: string) => new DomainError(message, status, code);
export async function logEvent(
  tx: Tx,
  who: Who | null,
  requestId: string,
  academyId: string,
  e: { event: string; from?: string | null; to?: string | null; reason?: string; detail?: Record<string, unknown> },
) {
  await tx.insert(t.erasureEvents).values({
    id: crypto.randomUUID(),
    academyId,
    requestId,
    at: new Date(),
    event: e.event,
    fromStatus: e.from ?? null,
    toStatus: e.to ?? null,
    actorId: who?.id ?? null,
    actorRole: who?.role ?? "SYSTEM",
    reason: e.reason ?? null,
    detail: e.detail ?? {},
  });
}
/** Security-log entry: identifiers and kinds only (no names, no reasons, no record contents). */
export const security = (tx: Tx, who: Who | null, academyId: string, event: SecurityEventName, detail: Record<string, unknown>) =>
  recordSecurityEvent(tx, { event, academyId, actorId: who && who.id !== "system" ? who.id : null, detail });
/** Validated move: the only way a request changes status. */
export async function move(
  tx: Tx,
  row: Row,
  to: string,
  patch: Partial<typeof t.erasureRequests.$inferInsert>,
  who: Who | null,
  e: { event: string; reason?: string; detail?: Record<string, unknown> },
) {
  if (!canTransition(row.status, to))
    throw E(`This request is ${row.status.toLowerCase().replaceAll("_", " ")} and cannot become ${to.toLowerCase().replaceAll("_", " ")}.`, 409, "INVALID_STATE");
  const [saved] = await tx
    .update(t.erasureRequests)
    .set({ ...patch, status: to, version: row.version + 1, updatedAt: new Date() })
    .where(and(eq(t.erasureRequests.academyId, row.academyId), eq(t.erasureRequests.id, row.id), eq(t.erasureRequests.version, row.version)))
    .returning();
  if (!saved) throw E("This request changed. Reload it and try again.", 409, "CONFLICT");
  await logEvent(tx, who, row.id, row.academyId, { ...e, from: row.status, to });
  return saved;
}
export async function loadRequest(tx: Tx, academyId: string, id: string) {
  const [row] = await tx.select().from(t.erasureRequests).where(and(eq(t.erasureRequests.academyId, academyId), eq(t.erasureRequests.id, id)));
  if (!row) throw E("Erasure request not found.", 404, "NOT_FOUND");
  return row;
}
export async function activeHolds(tx: Tx, academyId: string, playerId: string) {
  return tx
    .select()
    .from(t.legalHolds)
    .where(
      and(
        eq(t.legalHolds.academyId, academyId),
        isNull(t.legalHolds.releasedAt),
        or(eq(t.legalHolds.scope, "ACADEMY"), eq(t.legalHolds.playerId, playerId)),
      ),
    );
}
export async function policyMap(tx: Tx, academyId: string) {
  const rows = await tx.select().from(t.retentionPolicies).where(eq(t.retentionPolicies.academyId, academyId));
  return new Map(rows.map((r) => [r.category, r]));
}
/** When the player stopped being active: the newest profile revision, if the profile is not ACTIVE now. */
export async function subjectState(tx: Tx, academyId: string, playerId: string) {
  const [profile] = await tx.select().from(t.profiles).where(and(eq(t.profiles.academyId, academyId), eq(t.profiles.playerId, playerId)));
  if (!profile || profile.data.status === "ACTIVE") return { leftAt: null as Date | null };
  const [rev] = await tx
    .select({ at: t.recordRevisions.createdAt })
    .from(t.recordRevisions)
    .where(and(eq(t.recordRevisions.academyId, academyId), eq(t.recordRevisions.kind, "player-profile"), eq(t.recordRevisions.entityId, playerId)))
    .orderBy(desc(t.recordRevisions.version))
    .limit(1);
  return { leftAt: rev?.at ?? null };
}
/** NON-DESTRUCTIVE. Counts only; every query is scoped to the academy; nothing is written. */
export async function buildPreview(tx: Tx, academyId: string, playerId: string, now = new Date()): Promise<Preview> {
  const [policies, holds, subject] = await Promise.all([policyMap(tx, academyId), activeHolds(tx, academyId, playerId), subjectState(tx, academyId, playerId)]);
  const held = holds.length > 0;
  const categories: PreviewCategory[] = [];
  for (const c of CATEGORIES) {
    const counts = await inspect(c.key, tx, academyId, playerId);
    const base = { key: c.key, label: c.label, records: counts.records, detail: counts.detail };
    if (!c.actions.length) {
      categories.push({ ...base, outcome: "RETAINED_FIXED", note: c.fixedReason });
      continue;
    }
    const policy = policies.get(c.key) ?? null;
    const eligibility = evaluateEligibility(policy, subject, now);
    if (!eligibility.eligible) {
      categories.push({
        ...base,
        outcome: eligibility.reason === "REQUIRES_POLICY_APPROVAL" ? "REQUIRES_POLICY_APPROVAL" : "NOT_ELIGIBLE",
        note: eligibility.reason === "REQUIRES_POLICY_APPROVAL" ? POLICY_PENDING : eligibility.reason,
      });
    } else if (held) categories.push({ ...base, outcome: "HELD", note: "Legal hold" });
    else if (counts.records === 0) categories.push({ ...base, outcome: "NOTHING_TO_DO" });
    else if (!c.actions.includes(eligibility.action)) categories.push({ ...base, outcome: "REQUIRES_POLICY_APPROVAL", note: "The approved action is not supported for this category" });
    else categories.push({ ...base, outcome: eligibility.action === "ERASE" ? "WILL_ERASE" : "WILL_ANONYMIZE" });
  }
  return {
    generatedAt: now.toISOString(),
    held,
    categories,
    willAct: categories.filter((c) => c.outcome === "WILL_ERASE" || c.outcome === "WILL_ANONYMIZE").map((c) => ({ category: c.key, action: (c.outcome === "WILL_ERASE" ? "ERASE" : "ANONYMIZE") as RetentionAction })),
  };
}
const reasonOf = (text: string) => {
  if (!validPrivacyReason(text)) throw E("Say why, in words (at least 10 characters).", 422, "REASON_REQUIRED");
  return text.trim();
};
// ------------------------------------------------------------------------------------------------
// Retention rules
// ------------------------------------------------------------------------------------------------
export async function setRetentionPolicy(a: Actor, input: unknown) {
  requireCapability(a, "privacy.retention");
  const v = z
    .object({
      category: z.string().min(1).max(60),
      decision: z.enum(["APPROVE", "SUSPEND"]),
      action: z.enum(RETENTION_ACTIONS).optional(),
      retentionDays: z.number().int().min(0).max(36_500).nullable().optional(),
      basis: z.string().max(2000),
      ownerPassword: z.string().max(512),
    })
    .parse(input);
  const info = categoryInfo(v.category);
  if (!info) throw E("Unknown category.", 404, "NOT_FOUND");
  if (!info.actions.length) throw E("This category is fixed evidence; this application never erases or rewrites it.", 422, "FIXED_RETENTION");
  const basis = reasonOf(v.basis);
  if (v.decision === "APPROVE" && (!v.action || !info.actions.includes(v.action)))
    throw E(`Choose ${info.actions.join(" or ").toLowerCase()} for this category.`, 422, "ACTION_NOT_SUPPORTED");
  await reauthenticate(a.id, v.ownerPassword);
  return unit(a, async (tx) => {
    const [old] = await tx.select().from(t.retentionPolicies).where(and(eq(t.retentionPolicies.academyId, a.academyId), eq(t.retentionPolicies.category, v.category)));
    if (v.decision === "SUSPEND") {
      if (!old) throw E("There is no approved rule to suspend.", 404, "NOT_FOUND");
      await tx.update(t.retentionPolicies).set({ status: "SUSPENDED", basis, approvedBy: a.id, approvedAt: new Date() }).where(and(eq(t.retentionPolicies.academyId, a.academyId), eq(t.retentionPolicies.category, v.category)));
    } else {
      const values = { academyId: a.academyId, category: v.category, status: "APPROVED", action: v.action!, retentionDays: v.retentionDays ?? null, basis, approvedBy: a.id, approvedAt: new Date() };
      await tx.insert(t.retentionPolicies).values(values).onConflictDoUpdate({ target: [t.retentionPolicies.academyId, t.retentionPolicies.category], set: values });
    }
    await security(tx, a, a.academyId, "RETENTION_POLICY_CHANGED", { category: v.category, action: v.decision === "SUSPEND" ? "SUSPEND" : v.action, ...(v.retentionDays != null ? { days: v.retentionDays } : {}) });
    return { ok: true };
  });
}
// ------------------------------------------------------------------------------------------------
// Erasure requests
// ------------------------------------------------------------------------------------------------
export async function requestErasure(a: Actor, input: unknown) {
  requireCapability(a, "privacy.manage");
  const v = z.object({ playerId: z.string().min(1).max(200), reason: z.string().max(2000), source: z.enum(SOURCES).default("STAFF") }).parse(input);
  const reason = reasonOf(v.reason);
  return unit(a, async (tx) => {
    const [player] = await tx.select({ id: t.players.id }).from(t.players).where(and(eq(t.players.academyId, a.academyId), eq(t.players.id, v.playerId)));
    if (!player) throw E("Player not found.", 404, "NOT_FOUND");
    const [open] = await tx
      .select({ id: t.erasureRequests.id })
      .from(t.erasureRequests)
      .where(and(eq(t.erasureRequests.academyId, a.academyId), eq(t.erasureRequests.playerId, v.playerId), inArray(t.erasureRequests.status, OPEN_STATUSES)));
    if (open) throw E("There is already an open erasure request for this player.", 409, "DUPLICATE_OPEN_REQUEST");
    const now = new Date();
    const preview = await buildPreview(tx, a.academyId, v.playerId, now);
    const [row] = await tx
      .insert(t.erasureRequests)
      .values({ id: crypto.randomUUID(), academyId: a.academyId, playerId: v.playerId, source: v.source, reason, requestedBy: a.id, requestedAt: now, status: "PREVIEW_READY", preview, previewAt: now, updatedAt: now })
      .returning();
    await logEvent(tx, a, row.id, a.academyId, { event: "REQUESTED", to: "PREVIEW_READY", reason, detail: { source: v.source } });
    await logEvent(tx, a, row.id, a.academyId, { event: "PREVIEW_GENERATED", detail: { acts: preview.willAct.length, held: preview.held } });
    await security(tx, a, a.academyId, "ERASURE_REQUESTED", { ref: row.id });
    return summarise(row);
  });
}
export async function refreshErasurePreview(a: Actor, input: unknown) {
  requireCapability(a, "privacy.manage");
  const v = z.object({ id: z.string().min(1).max(200) }).parse(input);
  return unit(a, async (tx) => {
    const row = await loadRequest(tx, a.academyId, v.id);
    if (row.status !== "PREVIEW_READY") throw E("Only a request waiting for review can be re-previewed.", 409, "INVALID_STATE");
    const preview = await buildPreview(tx, a.academyId, row.playerId);
    const [saved] = await tx.update(t.erasureRequests).set({ preview, previewAt: new Date(), version: row.version + 1, updatedAt: new Date() }).where(eq(t.erasureRequests.id, row.id)).returning();
    await logEvent(tx, a, row.id, a.academyId, { event: "PREVIEW_GENERATED", detail: { acts: preview.willAct.length, held: preview.held } });
    return summarise(saved);
  });
}
export async function reviewErasure(a: Actor, input: unknown) {
  requireCapability(a, "privacy.manage");
  const v = z
    .object({ id: z.string().min(1).max(200), version: z.number().int(), decision: z.enum(["APPROVE", "REJECT"]), reason: z.string().max(2000), ownerPassword: z.string().max(512) })
    .parse(input);
  const reason = reasonOf(v.reason);
  await reauthenticate(a.id, v.ownerPassword);
  return unit(a, async (tx) => {
    const row = await loadRequest(tx, a.academyId, v.id);
    expectVersion(row.version, v.version);
    if (row.status !== "PREVIEW_READY") throw E("Only a request waiting for review can be decided.", 409, "INVALID_STATE");
    if (row.requestedBy === a.id) throw E("Whoever raised a request cannot decide it. Another owner or administrator must.", 403, "SELF_APPROVAL_FORBIDDEN");
    const now = new Date();
    if (v.decision === "REJECT") {
      const saved = await move(tx, row, "REJECTED", { reviewedBy: a.id, reviewedAt: now, reviewReason: reason }, a, { event: "REJECTED", reason });
      await security(tx, a, a.academyId, "ERASURE_REJECTED", { ref: row.id });
      return summarise(saved);
    }
    // Approval looks at the data as it is NOW, not as it was when the request was made.
    const preview = await buildPreview(tx, a.academyId, row.playerId, now);
    if (preview.held) throw E("A legal hold applies to this player. Nothing can be approved until it is released.", 409, "LEGAL_HOLD");
    if (!preview.willAct.length) throw E(`Nothing can be erased for this player yet: no category has an approved retention rule with something to act on (${POLICY_PENDING}).`, 409, "NOTHING_TO_ERASE");
    const executeAfter = new Date(now.getTime() + graceDays() * 86_400_000);
    const steps: Step[] = preview.willAct.map((s) => ({ ...s, status: "PENDING" }));
    const saved = await move(tx, row, "GRACE_PERIOD", { reviewedBy: a.id, reviewedAt: now, reviewReason: reason, executeAfter, plan: preview.willAct, steps, preview, previewAt: now, nextAttemptAt: null }, a, { event: "APPROVED", reason, detail: { executeAfter: executeAfter.toISOString(), categories: preview.willAct.length } });
    await security(tx, a, a.academyId, "ERASURE_APPROVED", { ref: row.id, days: graceDays() });
    return summarise(saved);
  });
}
export async function cancelErasure(a: Actor, input: unknown) {
  requireCapability(a, "privacy.manage");
  const v = z.object({ id: z.string().min(1).max(200), reason: z.string().max(2000) }).parse(input);
  const reason = reasonOf(v.reason);
  return unit(a, async (tx) => {
    const row = await loadRequest(tx, a.academyId, v.id);
    if (row.status === "PROCESSING") throw E("Erasure has started and can no longer be cancelled.", 409, "TOO_LATE");
    const saved = await move(tx, row, "CANCELLED", { blockedReason: null, lockedUntil: null, lockedBy: null }, a, { event: "CANCELLED", reason });
    await security(tx, a, a.academyId, "ERASURE_CANCELLED", { ref: row.id });
    return summarise(saved);
  });
}
// ------------------------------------------------------------------------------------------------
// Legal holds
// ------------------------------------------------------------------------------------------------
export async function placeLegalHold(a: Actor, input: unknown) {
  requireCapability(a, "privacy.manage");
  const v = z.object({ playerId: z.string().min(1).max(200).nullable().optional(), reason: z.string().max(2000), ownerPassword: z.string().max(512) }).parse(input);
  const reason = reasonOf(v.reason);
  await reauthenticate(a.id, v.ownerPassword);
  return unit(a, async (tx) => {
    if (v.playerId) {
      const [p] = await tx.select({ id: t.players.id }).from(t.players).where(and(eq(t.players.academyId, a.academyId), eq(t.players.id, v.playerId)));
      if (!p) throw E("Player not found.", 404, "NOT_FOUND");
    }
    const id = crypto.randomUUID();
    await tx.insert(t.legalHolds).values({ id, academyId: a.academyId, scope: v.playerId ? "PLAYER" : "ACADEMY", playerId: v.playerId ?? null, reason, createdBy: a.id, createdAt: new Date() });
    // Anything waiting out its grace period for the held data stops now.
    const waiting = await tx
      .select()
      .from(t.erasureRequests)
      .where(and(eq(t.erasureRequests.academyId, a.academyId), eq(t.erasureRequests.status, "GRACE_PERIOD"), v.playerId ? eq(t.erasureRequests.playerId, v.playerId) : undefined));
    for (const r of waiting) await move(tx, r, "BLOCKED", { blockedReason: "LEGAL_HOLD" }, a, { event: "BLOCKED_BY_HOLD", detail: { hold: id } });
    await security(tx, a, a.academyId, "LEGAL_HOLD_PLACED", { ref: id, scope: v.playerId ? "PLAYER" : "ACADEMY" });
    return { id, blocked: waiting.length };
  });
}
export async function releaseLegalHold(a: Actor, input: unknown) {
  requireCapability(a, "privacy.releaseHold");
  const v = z.object({ id: z.string().min(1).max(200), reason: z.string().max(2000), ownerPassword: z.string().max(512) }).parse(input);
  const reason = reasonOf(v.reason);
  await reauthenticate(a.id, v.ownerPassword);
  return unit(a, async (tx) => {
    const [hold] = await tx.select().from(t.legalHolds).where(and(eq(t.legalHolds.academyId, a.academyId), eq(t.legalHolds.id, v.id)));
    if (!hold) throw E("Legal hold not found.", 404, "NOT_FOUND");
    if (hold.releasedAt) throw E("This hold has already been released.", 409, "ALREADY_RELEASED");
    await tx.update(t.legalHolds).set({ releasedBy: a.id, releasedAt: new Date(), releaseReason: reason }).where(eq(t.legalHolds.id, hold.id));
    // Re-evaluate what the hold was blocking: a fresh preview, and a fresh approval is needed.
    const blocked = await tx.select().from(t.erasureRequests).where(and(eq(t.erasureRequests.academyId, a.academyId), eq(t.erasureRequests.status, "BLOCKED"), eq(t.erasureRequests.blockedReason, "LEGAL_HOLD")));
    let reevaluated = 0;
    for (const r of blocked) {
      if ((await activeHolds(tx, a.academyId, r.playerId)).length) continue;
      const preview = await buildPreview(tx, a.academyId, r.playerId);
      await move(tx, r, "PREVIEW_READY", { blockedReason: null, reviewedBy: null, reviewedAt: null, reviewReason: null, executeAfter: null, plan: [], steps: [], preview, previewAt: new Date() }, a, { event: "HOLD_RELEASED_REEVALUATED", detail: { hold: hold.id } });
      reevaluated++;
    }
    await security(tx, a, a.academyId, "LEGAL_HOLD_RELEASED", { ref: hold.id, scope: hold.scope });
    return { ok: true, reevaluated };
  });
}
// ------------------------------------------------------------------------------------------------
// Reads (recorded in the access history as PRIVACY; refusals recorded as DENIED)
// ------------------------------------------------------------------------------------------------
const summarise = (r: Row) => ({
  id: r.id,
  playerId: r.playerId,
  source: r.source,
  status: r.status,
  version: r.version,
  requestedBy: r.requestedBy,
  requestedAt: r.requestedAt.toISOString(),
  reason: r.reason,
  reviewedBy: r.reviewedBy,
  reviewedAt: r.reviewedAt?.toISOString() ?? null,
  reviewReason: r.reviewReason,
  executeAfter: r.executeAfter?.toISOString() ?? null,
  blockedReason: r.blockedReason,
  failureCode: r.failureCode,
  attempts: r.attempts,
  completedAt: r.completedAt?.toISOString() ?? null,
  steps: r.steps as Step[],
  preview: r.preview as Preview,
});
export async function privacyOverview(a: Actor) {
  return denialAudited(a, { category: "PRIVACY", operation: "LIST" }, async () => {
    requireCapability(a, "privacy.manage");
    const db = database();
    const result = await db.transaction(async (tx) => {
      const policies = await policyMap(tx, a.academyId);
      const requests = await tx.select().from(t.erasureRequests).where(eq(t.erasureRequests.academyId, a.academyId)).orderBy(desc(t.erasureRequests.requestedAt), desc(t.erasureRequests.id)).limit(50);
      const holds = await tx.select().from(t.legalHolds).where(eq(t.legalHolds.academyId, a.academyId)).orderBy(desc(t.legalHolds.createdAt)).limit(50);
      const people = new Map((await tx.select({ id: t.players.id, name: t.players.name }).from(t.players).where(eq(t.players.academyId, a.academyId))).map((p) => [p.id, p.name]));
      const [pending] = await tx.select({ n: sql<number>`count(*)::int` }).from(t.storageDeletions).where(and(eq(t.storageDeletions.academyId, a.academyId), eq(t.storageDeletions.status, "PENDING")));
      const [failed] = await tx.select({ n: sql<number>`count(*)::int` }).from(t.storageDeletions).where(and(eq(t.storageDeletions.academyId, a.academyId), eq(t.storageDeletions.status, "FAILED")));
      return {
        categories: CATEGORIES.map((c) => {
          const p = policies.get(c.key);
          return { ...c, policy: p ? { status: p.status, action: p.action, retentionDays: p.retentionDays, basis: p.basis, approvedAt: p.approvedAt.toISOString() } : null, policyStatus: c.actions.length ? (p ? p.status : POLICY_PENDING) : "FIXED" };
        }),
        graceDays: graceDays(),
        ledgerConfigured: !!ledgerPath(),
        requests: requests.map((r) => ({ ...summarise(r), playerName: people.get(r.playerId) ?? null, preview: undefined })),
        holds: holds.map((h) => ({ id: h.id, scope: h.scope, playerId: h.playerId, playerName: h.playerId ? (people.get(h.playerId) ?? null) : null, reason: h.reason, createdAt: h.createdAt.toISOString(), releasedAt: h.releasedAt?.toISOString() ?? null, releaseReason: h.releaseReason })),
        storage: { pending: pending.n, failed: failed.n },
        eligible: await eligiblePlayers(tx, a.academyId, policies, people),
      };
    });
    await recordAccess(db, a, { category: "PRIVACY", operation: "LIST", context: { count: result.requests.length } });
    return result;
  });
}
/** Players whose approved, time-based retention rule has elapsed. A list to act on; nothing is created or erased. */
async function eligiblePlayers(tx: Tx, academyId: string, policies: Map<string, typeof t.retentionPolicies.$inferSelect>, people: Map<string, string>) {
  const timed = [...policies.values()].filter((p) => p.status === "APPROVED" && p.retentionDays !== null);
  if (!timed.length) return [];
  const profiles = await tx.select().from(t.profiles).where(eq(t.profiles.academyId, academyId));
  const out: { playerId: string; name: string | null; categories: string[] }[] = [];
  const now = new Date();
  for (const pr of profiles.filter((p) => p.data.status !== "ACTIVE").slice(0, 200)) {
    const subject = await subjectState(tx, academyId, pr.playerId);
    const categories: string[] = [];
    for (const p of timed)
      if (evaluateEligibility(p, subject, now).eligible && (await inspect(p.category as CategoryKey, tx, academyId, pr.playerId)).records > 0) categories.push(p.category);
    if (categories.length) out.push({ playerId: pr.playerId, name: people.get(pr.playerId) ?? null, categories });
    if (out.length >= 50) break;
  }
  return out;
}
export async function erasureDetail(a: Actor, id: string) {
  return denialAudited(a, { category: "PRIVACY", operation: "VIEW", resourceId: id }, async () => {
    requireCapability(a, "privacy.manage");
    const db = database();
    const row = await db.transaction(async (tx) => loadRequest(tx, a.academyId, id));
    const events = await db.select().from(t.erasureEvents).where(and(eq(t.erasureEvents.academyId, a.academyId), eq(t.erasureEvents.requestId, id))).orderBy(t.erasureEvents.at, t.erasureEvents.id);
    const deletions = await db.select({ status: t.storageDeletions.status }).from(t.storageDeletions).where(and(eq(t.storageDeletions.academyId, a.academyId), eq(t.storageDeletions.requestId, id)));
    await recordAccess(db, a, { category: "PRIVACY", operation: "VIEW", resourceId: id, playerId: row.playerId });
    return {
      ...summarise(row),
      files: { pending: deletions.filter((d) => d.status === "PENDING").length, done: deletions.filter((d) => d.status === "DONE").length, failed: deletions.filter((d) => d.status === "FAILED").length },
      events: events.map((e) => ({ id: e.id, at: e.at.toISOString(), event: e.event, from: e.fromStatus, to: e.toStatus, actorId: e.actorId, actorRole: e.actorRole, reason: e.reason, detail: e.detail })),
    };
  });
}
