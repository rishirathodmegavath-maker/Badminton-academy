import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import { config } from "../../../shared/config";
import type { Actor } from "../../identity/access";
import { can, requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import { accessiblePlayers, linkedRecipients, requireFeature, unit, type Tx } from "../../academy/application/access";
import { reportAccess } from "../../reports/application/service";
import { addressKey, maskAddress, normalizeEmail, normalizeWhatsApp } from "../../contacts/domain/contact-rules";
import { countryOf } from "../../contacts/application/service";
import {
  SKIP_TEXT,
  planDispatch,
  renderMessage,
  type Channel,
  type Consolidation,
  type Mode,
  type Plan,
  type PlanPlayer,
  type PlanReport,
  type PlannedItem,
  type SkippedRecipient,
} from "../domain/plan";
import { LINK_VALID_DAYS } from "../link-token";
import { channelStates } from "../providers/registry";

/**
 * Bulk delivery of PUBLISHED reports to parents and/or players, by e-mail and the official WhatsApp channel.
 *
 *  - PREVIEW (read-only): who would receive what, who would be left out and why, and a sample of the words. Needs `comms.author`.
 *  - APPROVE AND QUEUE: the owner-level step (`comms.approve`) that turns the plan into a batch of queued messages. Nothing is
 *    sent here: the background worker sends, retries and records. Re-pressing it cannot send twice (see "already sent").
 *  - STATUS / RETRY / CANCEL: monitoring and control of a batch.
 *
 * Reports are only ever delivered as links to a private, signed-in page. The audit trail and logs carry batch ids, counts and
 * masked addresses, never a full address or any report content.
 */
const MAX_REPORTS = 300;
const input = z.object({
  reportIds: z.array(z.string().min(1).max(200)).min(1).max(MAX_REPORTS),
  mode: z.enum(["PARENTS", "PLAYERS", "BOTH"]),
  channels: z.array(z.enum(["EMAIL", "WHATSAPP"])).min(1).max(2),
  consolidation: z.enum(["PER_PARENT", "PER_CHILD"]).default("PER_PARENT"),
});
const first = (name: string) => name.trim().split(/\s+/)[0] ?? "";
/** Statuses that mean "this address already has, or is about to have, these reports". */
const COVERED = ["QUEUED", "SENDING", "SENT", "DELIVERED", "READ", "FAILED_RETRYABLE"];

type Loaded = {
  plan: Plan;
  reports: PlanReport[];
  notPublished: string[];
  hashOf: (item: PlannedItem) => string;
  academyName: string;
};

/** The shared first half of preview and queue: validate, read the contacts, plan, then remove what was already sent. */
async function loadPlan(a: Actor, tx: Tx, v: z.infer<typeof input>): Promise<Loaded> {
  await requireFeature(a, "communications", tx);
  const secret = config().BETTER_AUTH_SECRET;
  const reports: PlanReport[] = [];
  const notPublished: string[] = [];
  const names = new Map<string, string>();
  for (const id of [...new Set(v.reportIds)]) {
    const r = await reportAccess(a, id, tx);
    if (r.status !== "PUBLISHED") {
      notPublished.push(r.id);
      continue;
    }
    names.set(r.playerId, r.data.playerName);
    reports.push({ id: r.id, playerId: r.playerId, title: r.data.title, childFirstName: first(r.data.playerName) });
  }
  const playerIds = [...new Set(reports.map((r) => r.playerId))];
  const country = await countryOf(tx, a.academyId);
  const visible = (await accessiblePlayers(a, tx)).filter((p) => playerIds.includes(p.id));
  const profiles = playerIds.length
    ? await tx.select({ playerId: t.profiles.playerId, data: t.profiles.data }).from(t.profiles).where(and(eq(t.profiles.academyId, a.academyId), inArray(t.profiles.playerId, playerIds)))
    : [];
  const parents = await linkedRecipients(a, playerIds, tx);
  const points = await tx.select().from(t.contactPoints).where(eq(t.contactPoints.academyId, a.academyId));
  const state = new Map<string, { optedIn: boolean; suppressed: boolean }>();
  for (const p of points) {
    const kind = p.playerId ? `PLAYER:${p.playerId}` : `ACCOUNT:${p.userId}`;
    state.set(`${kind}|${p.channel}|${p.address}`, { optedIn: !!p.optedInAt && !p.optInRevokedAt && !p.suppressedAt, suppressed: !!p.suppressedAt });
  }
  const players: PlanPlayer[] = visible.map((p) => {
    const profile = profiles.find((x) => x.playerId === p.id)?.data;
    const phoneRaw = (profile?.phone ?? "").trim();
    const phone = phoneRaw ? normalizeWhatsApp(phoneRaw, country) : null;
    return {
      id: p.id,
      name: p.name,
      email: normalizeEmail(profile?.email),
      phone,
      phoneUnreadable: !!phoneRaw && !phone,
      guardians: parents
        .filter((g) => g.link.playerId === p.id)
        .map((g) => ({ userId: g.user.id, name: g.displayName ?? g.user.name, email: normalizeEmail(g.user.email), phone: g.user.phone ?? null })),
    };
  });
  const plan = planDispatch({
    reports,
    players,
    mode: v.mode as Mode,
    channels: v.channels as Channel[],
    consolidation: v.consolidation as Consolidation,
    flags: (subject, channel, address) => state.get(`${subject.kind}:${subject.id}|${channel}|${address}`) ?? { optedIn: false, suppressed: false },
  });
  const hashOf = (item: PlannedItem) => addressKey(item.channel, item.dedupeKey, secret);
  // Duplicate-send prevention across batches: an address that already has (or is about to have) a report is not sent it again.
  const prior = plan.items.length
    ? await tx
        .select({ hash: t.dispatchItems.addressHash, reportIds: t.dispatchItems.reportIds })
        .from(t.dispatchItems)
        .where(and(eq(t.dispatchItems.academyId, a.academyId), inArray(t.dispatchItems.status, COVERED), inArray(t.dispatchItems.addressHash, plan.items.map(hashOf))))
    : [];
  const kept: PlannedItem[] = [];
  const skipped = [...plan.skipped];
  for (const item of plan.items) {
    const covered = new Set(prior.filter((p) => p.hash === hashOf(item)).flatMap((p) => p.reportIds));
    const remaining = item.reportIds.filter((id) => !covered.has(id));
    if (remaining.length) kept.push({ ...item, reportIds: remaining });
    else
      skipped.push({
        channel: item.channel,
        recipientName: item.recipientNames[0],
        recipientKind: item.subjects.some((s) => s.kind === "ACCOUNT") ? "PARENT" : "PLAYER",
        childNames: [...new Set(reports.filter((r) => item.reportIds.includes(r.id)).map((r) => r.childFirstName))],
        reportIds: item.reportIds,
        reason: "ALREADY_SENT",
        detail: SKIP_TEXT.ALREADY_SENT,
        subject: item.subjects[0] ?? null,
        address: item.address,
      });
  }
  return { plan: { ...plan, items: kept, skipped, sharedAddress: kept.filter((i) => i.subjects.length > 1).length }, reports, notPublished, hashOf, academyName: a.academyName };
}

const summarise = (l: Loaded) => ({
  messages: l.plan.items.length,
  byChannel: { EMAIL: l.plan.items.filter((i) => i.channel === "EMAIL").length, WHATSAPP: l.plan.items.filter((i) => i.channel === "WHATSAPP").length },
  sharedAddress: l.plan.sharedAddress,
  reports: l.reports.length,
  notPublished: l.notPublished.length,
  skipped: l.plan.skipped.map((s) => ({
    recipient: s.recipientName,
    kind: s.recipientKind,
    children: s.childNames,
    channel: s.channel,
    reason: s.reason,
    detail: s.detail,
    // What the screen needs to offer "record the WhatsApp opt-in" for a person left out for lack of one.
    subject: s.subject,
    playerId: l.reports.find((r) => s.reportIds.includes(r.id))?.playerId ?? null,
  })),
});

/** Read-only: exactly what approving would queue, who would be left out and why, and a sample of the words. */
export async function previewDispatch(a: Actor, raw: unknown) {
  requireCapability(a, "comms.author");
  const v = input.parse(raw);
  return unit(a, async (tx) => {
    const l = await loadPlan(a, tx, v);
    const states = channelStates();
    const sample = l.plan.items.slice(0, 3).map((item) => {
      const children = l.reports.filter((r) => item.reportIds.includes(r.id)).map((r) => ({ childFirstName: r.childFirstName, title: r.title, url: "https://…/report-link#(a private link for this report)" }));
      const r = renderMessage({ academyName: a.academyName, recipientNames: item.recipientNames, children, forPlayerOnly: item.subjects.every((s) => s.kind === "PLAYER") });
      return { channel: item.channel, to: maskAddress(item.channel, item.address), recipients: item.recipientNames, subject: item.channel === "EMAIL" ? r.subject : null, text: r.text };
    });
    return { ...summarise(l), sample, channels: { EMAIL: states.EMAIL.mode, WHATSAPP: states.WHATSAPP.mode } };
  });
}

/**
 * The owner-level approval: records the batch as approved and queues every message in it, in one step. Nothing is sent here.
 * A message already sent or queued to the same address for the same report is NOT queued again, so pressing it twice cannot
 * double-send. A selection with nothing left to send is refused with the reasons.
 */
export async function queueDispatch(a: Actor, raw: unknown) {
  requireCapability(a, "comms.approve");
  const v = input.extend({ title: z.string().trim().max(150).optional() }).parse(raw);
  const secret = config().BETTER_AUTH_SECRET;
  void secret;
  return unit(a, async (tx) => {
    const l = await loadPlan(a, tx, v);
    if (!l.plan.items.length) {
      const reasons = [...new Set(l.plan.skipped.map((s) => SKIP_TEXT[s.reason]))];
      throw new DomainError(
        `Nothing to send. ${l.notPublished.length ? `${l.notPublished.length} report(s) are not published. ` : ""}${reasons.join(" ")}`.trim(),
        409,
        "NOTHING_TO_SEND",
      );
    }
    const now = new Date();
    const title = v.title || `Reports: ${[...new Set(l.reports.map((r) => r.title))].slice(0, 2).join(", ")}`;
    const [batch] = await tx
      .insert(t.dispatchBatches)
      .values({
        academyId: a.academyId,
        title,
        recipientMode: v.mode,
        consolidation: v.consolidation,
        channels: v.channels,
        reportIds: l.reports.map((r) => r.id),
        status: "APPROVED",
        createdBy: a.id,
        approvedBy: a.id,
        approvedAt: now,
      })
      .returning({ id: t.dispatchBatches.id });
    const expires = new Date(now.getTime() + LINK_VALID_DAYS * 86_400_000);
    for (const item of l.plan.items) {
      const [row] = await tx
        .insert(t.dispatchItems)
        .values({
          academyId: a.academyId,
          batchId: batch.id,
          channel: item.channel,
          address: item.address,
          addressHash: l.hashOf(item),
          recipientNames: item.recipientNames,
          subjectRefs: item.subjects,
          reportIds: item.reportIds,
        })
        .returning({ id: t.dispatchItems.id });
      await tx.insert(t.reportLinks).values(item.reportIds.map((reportId) => ({ academyId: a.academyId, itemId: row.id, reportId, expiresAt: expires })));
    }
    // The people left out are recorded too, so the history says who did not receive it and why.
    let n = 0;
    for (const s of l.plan.skipped as SkippedRecipient[]) {
      await tx.insert(t.dispatchItems).values({
        academyId: a.academyId,
        batchId: batch.id,
        channel: s.channel ?? v.channels[0],
        address: "",
        addressHash: addressKey(s.channel ?? v.channels[0], `skip|${n++}|${s.reason}`, config().BETTER_AUTH_SECRET),
        recipientNames: [s.recipientName],
        subjectRefs: s.subject ? [s.subject] : [],
        reportIds: s.reportIds,
        status: "SKIPPED",
        skipReason: `${s.reason}: ${s.detail}`,
      });
    }
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: batch.id,
      action: "dispatch-approve",
      version: 1,
      detail: { reports: l.reports.length, queued: l.plan.items.length, skipped: l.plan.skipped.length, channels: v.channels, mode: v.mode, consolidation: v.consolidation },
    });
    return { batchId: batch.id, queued: l.plan.items.length, skipped: l.plan.skipped.length };
  });
}

const STATUSES = ["QUEUED", "SENDING", "SENT", "DELIVERED", "READ", "FAILED_RETRYABLE", "FAILED", "SKIPPED", "CANCELLED"] as const;
const count = (rows: { status: string }[]) => Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length])) as Record<(typeof STATUSES)[number], number>;

/** Recent batches with their counts by status. */
export async function listDispatchBatches(a: Actor) {
  requireCapability(a, "comms.author");
  return unit(a, async (tx) => {
    // Delivery history names every family a batch reached, across the whole academy: it is for the people who approve sending
    // (owner, administrator, head coach). A coach may prepare and preview for their own players but sees no history.
    const batches = !can(a, "comms.approve")
      ? []
      : await tx.select().from(t.dispatchBatches).where(eq(t.dispatchBatches.academyId, a.academyId)).orderBy(desc(t.dispatchBatches.createdAt)).limit(30);
    const items = batches.length
      ? await tx.select({ batchId: t.dispatchItems.batchId, status: t.dispatchItems.status }).from(t.dispatchItems).where(and(eq(t.dispatchItems.academyId, a.academyId), inArray(t.dispatchItems.batchId, batches.map((b) => b.id))))
      : [];
    return {
      channels: (({ EMAIL, WHATSAPP }) => ({ EMAIL, WHATSAPP }))(channelStates()),
      batches: batches.map((b) => ({
        id: b.id,
        title: b.title,
        mode: b.recipientMode,
        consolidation: b.consolidation,
        channels: b.channels,
        status: b.status,
        createdAt: b.createdAt.toISOString(),
        counts: count(items.filter((i) => i.batchId === b.id)),
      })),
    };
  });
}

/** One batch: counts and every item (who, how, what state, how many tries, why it failed) with the address masked. */
export async function dispatchBatchStatus(a: Actor, raw: unknown) {
  // One batch lists the parents and (masked) addresses of everyone it reached, academy-wide: approvers only, like the history.
  requireCapability(a, "comms.approve");
  const v = z.object({ batchId: z.uuid() }).parse(raw);
  return unit(a, async (tx) => {
    const [b] = await tx.select().from(t.dispatchBatches).where(and(eq(t.dispatchBatches.academyId, a.academyId), eq(t.dispatchBatches.id, v.batchId)));
    if (!b) throw new DomainError("Batch not found.", 404);
    const items = await tx.select().from(t.dispatchItems).where(and(eq(t.dispatchItems.academyId, a.academyId), eq(t.dispatchItems.batchId, b.id)));
    return {
      batch: { id: b.id, title: b.title, status: b.status, mode: b.recipientMode, channels: b.channels, createdAt: b.createdAt.toISOString() },
      counts: count(items),
      items: items
        .map((i) => ({
          id: i.id,
          recipients: i.recipientNames,
          channel: i.channel,
          to: i.address ? maskAddress(i.channel as Channel, i.address) : "",
          reports: i.reportIds.length,
          status: i.status,
          attempts: i.attempts,
          error: i.lastErrorCode,
          skipReason: i.skipReason,
          sentAt: i.sentAt?.toISOString() ?? null,
          deliveredAt: i.deliveredAt?.toISOString() ?? null,
        }))
        .sort((x, y) => x.recipients[0].localeCompare(y.recipients[0]) || x.channel.localeCompare(y.channel)),
    };
  });
}

/**
 * Retry what failed: every FAILED item of the batch whose address is not suppressed goes back to the queue with a fresh set of
 * attempts. Items that were delivered, read, queued or sent are never touched, so a retry cannot double-send a delivered message.
 */
export async function retryFailedItems(a: Actor, raw: unknown) {
  requireCapability(a, "comms.approve");
  const v = z.object({ batchId: z.uuid() }).parse(raw);
  return unit(a, async (tx) => {
    const [b] = await tx.select().from(t.dispatchBatches).where(and(eq(t.dispatchBatches.academyId, a.academyId), eq(t.dispatchBatches.id, v.batchId)));
    if (!b) throw new DomainError("Batch not found.", 404);
    if (b.status !== "APPROVED") throw new DomainError("Only an approved batch can be retried.", 409);
    const failed = await tx.select().from(t.dispatchItems).where(and(eq(t.dispatchItems.academyId, a.academyId), eq(t.dispatchItems.batchId, b.id), eq(t.dispatchItems.status, "FAILED")));
    const points = failed.length ? await tx.select().from(t.contactPoints).where(eq(t.contactPoints.academyId, a.academyId)) : [];
    let requeued = 0;
    let stillBlocked = 0;
    for (const item of failed) {
      const blocked = points.some((p) => p.address === item.address && p.channel === item.channel && !!p.suppressedAt && item.subjectRefs.some((s) => (s.kind === "PLAYER" ? p.playerId === s.id : p.userId === s.id)));
      if (blocked) {
        stillBlocked++;
        continue;
      }
      await tx
        .update(t.dispatchItems)
        .set({ status: "QUEUED", attempts: 0, nextAttemptAt: new Date(), lastErrorCode: null, leaseUntil: null, leasedBy: null, updatedAt: new Date() })
        .where(and(eq(t.dispatchItems.id, item.id), eq(t.dispatchItems.status, "FAILED")));
      requeued++;
    }
    await tx.insert(t.audit).values({ id: crypto.randomUUID(), academyId: a.academyId, actorId: a.id, entityId: b.id, action: "dispatch-retry", version: 1, detail: { requeued, stillBlocked } });
    return { requeued, stillBlocked };
  });
}

/** Cancel what has not been sent: queued and waiting-to-retry items stop. Anything already handed to a provider is not recalled. */
export async function cancelDispatchBatch(a: Actor, raw: unknown) {
  requireCapability(a, "comms.approve");
  const v = z.object({ batchId: z.uuid() }).parse(raw);
  return unit(a, async (tx) => {
    const [b] = await tx.select().from(t.dispatchBatches).where(and(eq(t.dispatchBatches.academyId, a.academyId), eq(t.dispatchBatches.id, v.batchId)));
    if (!b) throw new DomainError("Batch not found.", 404);
    const stopped = await tx
      .update(t.dispatchItems)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(eq(t.dispatchItems.academyId, a.academyId), eq(t.dispatchItems.batchId, b.id), inArray(t.dispatchItems.status, ["QUEUED", "FAILED_RETRYABLE"])))
      .returning({ id: t.dispatchItems.id });
    await tx.update(t.dispatchBatches).set({ status: "CANCELLED", cancelledAt: new Date() }).where(eq(t.dispatchBatches.id, b.id));
    // Links of a cancelled batch stop working too.
    await tx.execute(sql`update report_link set revoked_at = now() where item_id in (select id from dispatch_item where batch_id = ${b.id} and status = 'CANCELLED') and revoked_at is null`);
    await tx.insert(t.audit).values({ id: crypto.randomUUID(), academyId: a.academyId, actorId: a.id, entityId: b.id, action: "dispatch-cancel", version: 1, detail: { stopped: stopped.length } });
    return { stopped: stopped.length };
  });
}
