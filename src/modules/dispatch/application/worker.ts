import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import { config } from "../../../shared/config";
import { suppressAddress } from "../../contacts/application/service";
import { renderMessage } from "../domain/plan";
import { makeLinkToken, reportLinkUrl } from "../link-token";
import type { Providers, SendOutcome } from "../providers/types";

/**
 * The delivery worker's core: one pass over the queue. The browser and the web server are not involved; a separate process
 * calls this on a timer (scripts/dispatch-worker.ts), and any number of workers may run at once.
 *
 *   reclaim   items a worker took but never finished (it died) go back to the queue once their lease has run out
 *   claim     due items are taken with FOR UPDATE SKIP LOCKED, so two workers never take the same item, and leased
 *   send      one provider call per item, then the outcome is recorded ONLY if this worker still holds the lease
 *   record    SENT / retry later with a delay / FAILED / SKIPPED; a bounce or a stop suppresses the address for those people
 *
 * Guarantees and limits, stated plainly:
 *   - An item is never sent twice by two live workers (lease + SKIP LOCKED).
 *   - Delivery is AT LEAST ONCE: if a worker dies after a provider accepted a message but before it recorded that, the lease
 *     expires and the message is sent again. Leases are long (default 120 s) to keep that window small; providers that accept an
 *     idempotency key (the key is the item id) can remove it.
 *   - A channel with no configured provider is not claimed at all: its items wait, unchanged, until one is configured.
 */
export const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

export type WorkerOptions = {
  providers: Providers;
  now?: Date;
  leaseSeconds?: number;
  batchSize?: number;
  concurrency?: number;
  workerId?: string;
  whatsappTemplate?: { name: string; language: string };
};
export type WorkerSummary = { reclaimed: number; claimed: number; sent: number; retrying: number; failed: number; skipped: number };

const backoff = (attempts: number, retryAfter?: number) => Math.max(BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length) - 1] ?? 21600, retryAfter ?? 0);

export async function processDispatchOnce(opts: WorkerOptions): Promise<WorkerSummary> {
  const db = database();
  const now = opts.now ?? new Date();
  const workerId = opts.workerId ?? `worker-${process.pid}`;
  const lease = (opts.leaseSeconds ?? 120) * 1000;
  const channels = (["EMAIL", "WHATSAPP"] as const).filter((c) => opts.providers[c]);
  const summary: WorkerSummary = { reclaimed: 0, claimed: 0, sent: 0, retrying: 0, failed: 0, skipped: 0 };
  summary.reclaimed = (
    await db
      .update(t.dispatchItems)
      .set({ status: "QUEUED", leaseUntil: null, leasedBy: null, updatedAt: now })
      .where(and(eq(t.dispatchItems.status, "SENDING"), lt(t.dispatchItems.leaseUntil, now)))
      .returning({ id: t.dispatchItems.id })
  ).length;
  if (!channels.length) return summary;
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: t.dispatchItems.id })
      .from(t.dispatchItems)
      .where(and(inArray(t.dispatchItems.status, ["QUEUED", "FAILED_RETRYABLE"]), lt(t.dispatchItems.nextAttemptAt, new Date(now.getTime() + 1)), inArray(t.dispatchItems.channel, channels)))
      .orderBy(t.dispatchItems.nextAttemptAt)
      .limit(opts.batchSize ?? 25)
      .for("update", { skipLocked: true });
    if (!due.length) return [];
    return tx
      .update(t.dispatchItems)
      .set({ status: "SENDING", attempts: sql`${t.dispatchItems.attempts} + 1`, leaseUntil: new Date(now.getTime() + lease), leasedBy: workerId, updatedAt: now })
      .where(inArray(t.dispatchItems.id, due.map((d) => d.id)))
      .returning();
  });
  summary.claimed = claimed.length;
  const queue = [...claimed];
  const run = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const outcome = await deliver(item, opts, workerId, now);
      summary[outcome]++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, claimed.length || 1)) }, run));
  return summary;
}

type Item = typeof t.dispatchItems.$inferSelect;
async function deliver(item: Item, opts: WorkerOptions, workerId: string, now: Date): Promise<"sent" | "retrying" | "failed" | "skipped"> {
  const db = database();
  const mine = and(eq(t.dispatchItems.id, item.id), eq(t.dispatchItems.status, "SENDING"), eq(t.dispatchItems.leasedBy, workerId));
  const skip = async (reason: string) => {
    await db.update(t.dispatchItems).set({ status: "SKIPPED", skipReason: reason, leaseUntil: null, leasedBy: null, updatedAt: new Date() }).where(mine);
    return "skipped" as const;
  };
  try {
    const secret = config().BETTER_AUTH_SECRET;
    const base = config().BETTER_AUTH_URL;
    const [reports, links, academy] = await Promise.all([
      db.select({ id: t.reports.id, status: t.reports.status, data: t.reports.data }).from(t.reports).where(and(eq(t.reports.academyId, item.academyId), inArray(t.reports.id, item.reportIds))),
      db.select().from(t.reportLinks).where(eq(t.reportLinks.itemId, item.id)),
      db.select({ name: t.academies.name }).from(t.academies).where(eq(t.academies.id, item.academyId)),
    ]);
    // Only what is still true at the moment of sending: a withdrawn report, or a link that was revoked or has expired, is left out.
    const children = reports
      .filter((r) => r.status === "PUBLISHED")
      .flatMap((r) => {
        const link = links.find((l) => l.reportId === r.id && !l.revokedAt && l.expiresAt.getTime() > now.getTime());
        return link ? [{ childFirstName: r.data.playerName.trim().split(/\s+/)[0] ?? "", title: r.data.title, url: reportLinkUrl(base, makeLinkToken(secret, link.id)) }] : [];
      });
    if (!children.length) return await skip("REPORT_WITHDRAWN: Every report in this message was withdrawn, or its link expired, before it was sent.");
    const message = renderMessage({
      academyName: academy[0]?.name ?? "Your academy",
      recipientNames: item.recipientNames,
      children,
      forPlayerOnly: item.subjectRefs.length > 0 && item.subjectRefs.every((s) => s.kind === "PLAYER"),
    });
    let result: SendOutcome;
    try {
      result =
        item.channel === "EMAIL"
          ? await opts.providers.EMAIL!.send({ to: item.address, subject: message.subject, text: message.text, idempotencyKey: item.id })
          : await opts.providers.WHATSAPP!.send({
              to: item.address,
              templateName: opts.whatsappTemplate?.name ?? "report_ready",
              language: opts.whatsappTemplate?.language ?? "en",
              params: message.templateParams,
              text: message.text,
              idempotencyKey: item.id,
            });
    } catch {
      result = { ok: false, retryable: true, errorCode: "PROVIDER_EXCEPTION" };
    }
    if (result.ok) {
      const rows = await db
        .update(t.dispatchItems)
        .set({ status: "SENT", sentAt: new Date(), providerMessageId: result.providerMessageId, lastErrorCode: null, leaseUntil: null, leasedBy: null, updatedAt: new Date() })
        .where(mine)
        .returning({ id: t.dispatchItems.id });
      if (rows.length)
        await db
          .insert(t.dispatchEvents)
          .values({ academyId: item.academyId, itemId: item.id, provider: opts.providers[item.channel as "EMAIL" | "WHATSAPP"]!.name, providerEventId: `send:${item.id}:${item.attempts}`, type: "SENT", occurredAt: new Date() })
          .onConflictDoNothing();
      return "sent";
    }
    if (result.retryable && item.attempts < MAX_ATTEMPTS) {
      await db
        .update(t.dispatchItems)
        .set({ status: "FAILED_RETRYABLE", lastErrorCode: result.errorCode, nextAttemptAt: new Date(now.getTime() + backoff(item.attempts, result.retryAfterSeconds) * 1000), leaseUntil: null, leasedBy: null, updatedAt: new Date() })
        .where(mine);
      return "retrying";
    }
    await db.transaction(async (tx) => {
      await tx
        .update(t.dispatchItems)
        .set({ status: "FAILED", lastErrorCode: result.ok ? null : result.errorCode, leaseUntil: null, leasedBy: null, updatedAt: new Date() })
        .where(mine);
      if (!result.ok && result.suppress) await suppressAddress(tx, item.academyId, item.channel as "EMAIL" | "WHATSAPP", item.address, item.subjectRefs, result.suppress);
    });
    return "failed";
  } catch {
    // Anything unexpected (a database hiccup) leaves the item leased: the lease runs out and it is picked up again.
    return "retrying";
  }
}
