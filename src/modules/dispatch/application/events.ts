import { and, eq, sql } from "drizzle-orm";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import { suppressAddress } from "../../contacts/application/service";
import type { ProviderEvent } from "../providers/types";

/**
 * What a provider tells us later about a message it accepted (delivered, read, failed, bounced, a complaint) and what a person
 * tells us by replying STOP. Called by the signature-verified webhook, never by a screen.
 *
 *   - Idempotent: a provider event is recorded once (provider + event id); a repeat changes nothing.
 *   - Monotonic: a message only moves forward (sent → delivered → read). A late "sent" never undoes a "delivered".
 *   - "Delivered" appears in the owner's screen ONLY because a provider said so here.
 *   - A bounce, a complaint or a STOP suppresses the address for the people that message was for.
 */
const RANK: Record<string, number> = { QUEUED: 0, SENDING: 1, SENT: 2, DELIVERED: 3, READ: 4 };
export type EventResult = "APPLIED" | "DUPLICATE" | "UNKNOWN_MESSAGE" | "STOP_APPLIED";

export async function applyProviderEvent(ev: ProviderEvent): Promise<EventResult> {
  const db = database();
  if (ev.kind === "stop") {
    // By value, across academies: a number that said STOP must not be messaged by any academy through this channel.
    const rows = await db.update(t.contactPoints).set({ suppressedAt: ev.occurredAt, suppressionReason: "STOP", optInRevokedAt: ev.occurredAt, updatedAt: new Date() }).where(and(eq(t.contactPoints.channel, "WHATSAPP"), eq(t.contactPoints.address, ev.address))).returning({ id: t.contactPoints.id });
    return rows.length ? "STOP_APPLIED" : "UNKNOWN_MESSAGE";
  }
  return db.transaction(async (tx): Promise<EventResult> => {
    const [item] = await tx.select().from(t.dispatchItems).where(eq(t.dispatchItems.providerMessageId, ev.providerMessageId)).for("update");
    if (!item) return "UNKNOWN_MESSAGE";
    const inserted = await tx
      .insert(t.dispatchEvents)
      .values({ academyId: item.academyId, itemId: item.id, provider: ev.provider, providerEventId: ev.eventId, type: ev.type, occurredAt: ev.occurredAt, detail: ev.detail })
      .onConflictDoNothing()
      .returning({ id: t.dispatchEvents.id });
    if (!inserted.length) return "DUPLICATE";
    if (ev.type === "DELIVERED" || ev.type === "READ") {
      if ((RANK[item.status] ?? -1) < RANK[ev.type])
        await tx
          .update(t.dispatchItems)
          .set({ status: ev.type, deliveredAt: item.deliveredAt ?? ev.occurredAt, lastErrorCode: null, updatedAt: new Date() })
          .where(eq(t.dispatchItems.id, item.id));
    } else if (ev.type === "FAILED" || ev.type === "BOUNCED" || ev.type === "COMPLAINED") {
      // A failure after the message was already delivered does not take the delivery back.
      if ((RANK[item.status] ?? -1) < RANK.DELIVERED && item.status !== "FAILED") {
        await tx.update(t.dispatchItems).set({ status: "FAILED", lastErrorCode: `PROVIDER_${ev.type}`, updatedAt: new Date() }).where(eq(t.dispatchItems.id, item.id));
      }
      if (ev.type !== "FAILED") await suppressAddress(tx, item.academyId, item.channel as "EMAIL" | "WHATSAPP", item.address, item.subjectRefs, ev.type);
    }
    void sql;
    return "APPLIED";
  });
}
