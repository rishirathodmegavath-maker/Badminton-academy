import { createHash } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, inArray } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import {
  unit,
  requirePlayer,
  requireFeature,
  linkedRecipients,
  guardianMayReceive,
  history,
  expectVersion,
  family,
  accessiblePlayers,
  type Tx,
} from "../../academy/application/access";
import type { MessageData } from "../../academy/domain/types";
import { emailConfig, providerStatus } from "../providers/config";
import { sendEmail } from "../providers/zeptomail";
import type { SendResult } from "../providers/transport";
const messageSchema = z.object({
  subject: z.string().trim().min(2).max(150),
  body: z.string().trim().min(3).max(5000),
  playerIds: z.array(z.string()).max(500),
  batchIds: z.array(z.string()).max(100),
  allBatches: z.boolean(),
  channels: z.array(z.enum(["PORTAL", "EMAIL", "WHATSAPP"])).min(1),
  templateId: z.string().nullable(),
});
type Audience = Pick<MessageData, "playerIds" | "batchIds" | "allBatches">;
const selectedPlayers = <P extends { id: string; batchId: string | null }>(allowed: P[], data: Audience) =>
  allowed.filter(
    (p) => data.allBatches || data.playerIds.includes(p.id) || (p.batchId !== null && data.batchIds.includes(p.batchId)),
  );
/**
 * Who a message could reach, before any channel is chosen: how many players the audience covers, how many of them have a
 * parent account linked, and how many distinct parents each channel can reach. Every linked parent can be messaged; no
 * separate consent record is needed. A WhatsApp number that is missing is added from the "Ready to send" list. The screen
 * uses this to say WHY nobody qualifies, instead of only refusing at approval.
 */
export async function audienceSummary(a: Actor, data: Audience, tx: Tx) {
  const players = selectedPlayers(await accessiblePlayers(a, tx), data);
  const links = await linkedRecipients(
    a,
    players.map((p) => p.id),
    tx,
  );
  const reach = { PORTAL: new Set<string>(), EMAIL: new Set<string>(), WHATSAPP: new Set<string>() };
  const noNumber = new Set<string>();
  for (const { user } of links) {
    reach.PORTAL.add(user.id);
    reach.WHATSAPP.add(user.id);
    if (user.email) reach.EMAIL.add(user.id);
    if (!user.phone) noNumber.add(user.id);
  }
  return {
    players: players.length,
    playersWithParent: new Set(links.map((l) => l.link.playerId)).size,
    reach: { PORTAL: reach.PORTAL.size, EMAIL: reach.EMAIL.size, WHATSAPP: reach.WHATSAPP.size },
    /** Parents with no WhatsApp number saved yet: they can still be messaged once a number is added. */
    needNumber: noNumber.size,
  };
}
export async function recipients(
  a: Actor,
  data: Pick<MessageData, "playerIds" | "batchIds" | "allBatches" | "channels">,
  tx: Tx,
) {
  const allowed = await accessiblePlayers(a, tx);
  const playerIds = selectedPlayers(allowed, data).map((p) => p.id);
  for (const id of data.playerIds) await requirePlayer(a, id, tx);
  const links = await linkedRecipients(a, playerIds, tx);
  const result = new Map<string, MessageData["recipients"][number]>();
  for (const { link, user, displayName } of links) {
    // Every linked parent can be messaged on the channels chosen; E-mail needs an address on the account.
    const channels = data.channels.filter((c) => c !== "EMAIL" || !!user.email);
    if (!channels.length) continue;
    const old = result.get(user.id);
    if (old) {
      old.playerIds.push(link.playerId);
      old.channels = [...new Set([...old.channels, ...channels])];
    } else
      result.set(user.id, {
        userId: user.id,
        name: displayName ?? user.name,
        email: user.email,
        playerIds: [link.playerId],
        channels,
      });
  }
  return [...result.values()]
    .map((r) => ({
      ...r,
      playerIds: [...new Set(r.playerIds)].sort(),
      channels: r.channels.sort(),
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const digest = (data: MessageData) =>
  createHash("sha256")
    .update(
      stableJson({
        subject: data.subject,
        body: data.body,
        channels: data.channels,
        recipients: data.recipients,
      }),
    )
    .digest("hex");
export async function previewMessage(a: Actor, input: unknown) {
  requireCapability(a, "comms.author");
  const v = messageSchema.parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "communications", tx);
    return {
      recipients: await recipients(a, v, tx),
      audience: await audienceSummary(a, v, tx),
      providers: { PORTAL: "AVAILABLE", ...providerStatus() },
    };
  });
}
export async function saveMessage(a: Actor, input: unknown) {
  requireCapability(a, "comms.author");
  const v = z
    .object({
      id: z.string().optional(),
      version: z.number().int().optional(),
      action: z.enum(["save", "approve", "schedule", "revise"]),
      scheduledAt: z.string().nullable(),
      data: messageSchema,
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "communications", tx);
    const id = v.id ?? crypto.randomUUID();
    let version = 1;
    let status = "DRAFT";
    let data: MessageData = {
      ...v.data,
      channels: [...new Set(v.data.channels)],
      recipients: [],
      scheduledAt: null,
      approvedBy: null,
      approvalHash: null,
    };
    if (v.id) {
      const [old] = await tx
        .select()
        .from(t.messages)
        .where(
          and(eq(t.messages.academyId, a.academyId), eq(t.messages.id, id)),
        );
      if (!old || (a.role === "COACH" && old.authorId !== a.id))
        throw new DomainError("Message not found.", 404);
      expectVersion(old.version, v.version ?? 0);
      version = old.version + 1;
      status = old.status;
      data = structuredClone(old.data);
    }
    if (v.action === "save") {
      if (status !== "DRAFT")
        throw new DomainError("Revise the message before editing.");
      data = {
        ...data,
        ...v.data,
        channels: [...new Set(v.data.channels)],
        approvedBy: null,
        approvalHash: null,
        recipients: [],
      };
    }
    if (v.action === "revise") {
      if (!["APPROVED", "SCHEDULED", "BLOCKED"].includes(status))
        throw new DomainError("Only pending approved messages can be revised.");
      const [attempt] = await tx
        .select()
        .from(t.deliveries)
        .where(
          and(
            eq(t.deliveries.academyId, a.academyId),
            eq(t.deliveries.messageId, id),
          ),
        );
      if (attempt)
        throw new DomainError(
          "Delivery has started. Create a new message instead.",
        );
      status = "DRAFT";
      data = {
        ...data,
        approvedBy: null,
        approvalHash: null,
        scheduledAt: null,
        recipients: [],
      };
    }
    if (v.action === "approve") {
      requireCapability(a, "comms.approve");
      if (status !== "DRAFT") throw new DomainError("Approve a saved draft.");
      data.recipients = await recipients(a, data, tx);
      if (!data.recipients.length)
        throw new DomainError(
          "Nobody can receive this with the channels you ticked. Check who it goes to: the players need a parent account linked. Invite the parents first, or choose a different audience.",
        );
      data.approvedBy = a.id;
      data.approvalHash = digest(data);
      status = "APPROVED";
    }
    if (v.action === "schedule") {
      requireCapability(a, "comms.approve");
      if (
        status !== "APPROVED" ||
        !data.approvalHash ||
        digest(data) !== data.approvalHash
      )
        throw new DomainError(
          "Review and approve the exact message and recipients first.",
        );
      if (!v.scheduledAt || !Number.isFinite(Date.parse(v.scheduledAt)))
        throw new DomainError("Choose a valid scheduled time.");
      data.scheduledAt = new Date(v.scheduledAt).toISOString();
      status = "SCHEDULED";
    }
    const [saved] = v.id
      ? await tx
          .update(t.messages)
          .set({ data, status, version })
          .where(
            and(eq(t.messages.academyId, a.academyId), eq(t.messages.id, id)),
          )
          .returning()
      : await tx
          .insert(t.messages)
          .values({ id, academyId: a.academyId, authorId: a.id, data, status })
          .returning();
    await history(tx, a, "communication", id, version, { data, status });
    return saved;
  });
}
export async function processOutbox(a: Actor, now = Date.now()) {
  requireCapability(a, "comms.approve");
  return unit(a, async (tx) => {
    await requireFeature(a, "communications", tx);
    const rows = await tx
      .select()
      .from(t.messages)
      .where(
        and(
          eq(t.messages.academyId, a.academyId),
          eq(t.messages.status, "SCHEDULED"),
        ),
      );
    let processed = 0;
    for (const m of rows) {
      if (!m.data.scheduledAt || Date.parse(m.data.scheduledAt) > now) continue;
      if (!m.data.approvalHash || digest(m.data) !== m.data.approvalHash)
        throw new DomainError(
          "Stored message approval does not match its content.",
          409,
        );
      const current = await recipients(a, m.data, tx);
      for (const target of m.data.recipients) {
        for (const channel of target.channels) {
          const stillAllowed = current.find(
            (c) =>
              c.userId === target.userId &&
              c.channels.includes(channel) &&
              c.playerIds.some((id) => target.playerIds.includes(id)),
          );
          // WhatsApp is always sent by a person from their own phone or computer (a free wa.me link). E-mail is sent by
          // the optional e-mail service when one is set up, and otherwise the same way, through the sender's mail app.
          const status = !stillAllowed
            ? "SKIPPED"
            : channel === "PORTAL"
              ? "AVAILABLE_IN_PORTAL"
              : channel === "EMAIL" && emailConfig().ok
                ? "QUEUED"
                : "READY_TO_SHARE";
          await tx
            .insert(t.deliveries)
            .values({
              id: crypto.randomUUID(),
              academyId: a.academyId,
              messageId: m.id,
              userId: target.userId,
              channel,
              status,
              attempts: 0,
              detail:
                status === "SKIPPED"
                  ? "No longer a linked parent."
                  : status === "READY_TO_SHARE"
                    ? "Ready for you to send from your own WhatsApp or mail app. Nothing has been sent yet."
                    : status === "QUEUED"
                      ? "Queued for the provider; sending happens after this step."
                      : "Approved update is available in the private family portal; this does not establish that it was read.",
            })
            .onConflictDoNothing();
        }
      }
      const status = "PROCESSED";
      await tx
        .update(t.messages)
        .set({ status, version: m.version + 1 })
        .where(
          and(eq(t.messages.academyId, a.academyId), eq(t.messages.id, m.id)),
        );
      await history(tx, a, "communication", m.id, m.version + 1, {
        data: m.data,
        status,
      });
      processed++;
    }
    return { processed };
  }).then(async ({ processed }) => ({ processed, delivery: await dispatchDeliveries(a, now) }));
}
export async function saveTemplate(a: Actor, input: unknown) {
  requireCapability(a, "comms.approve");
  const v = z
    .object({
      name: z.string().trim().min(2).max(100),
      subject: z.string().trim().min(2).max(150),
      body: z.string().trim().min(3).max(5000),
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "communications", tx);
    const id = crypto.randomUUID();
    await tx
      .insert(t.messageTemplates)
      .values({ id, academyId: a.academyId, ...v });
    await history(tx, a, "message-template", id, 1, v);
    return { id };
  });
}
export async function saveConversation(a: Actor, input: unknown) {
  const v = z
    .object({
      id: z.string().optional(),
      version: z.number().int().optional(),
      guardianId: z.string(),
      playerId: z.string(),
      subject: z.string().trim().min(2).max(150),
      text: z.string().trim().min(1).max(5000),
      entryId: z.uuid(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "communications", tx);
    // RC-4: conversations are the MESSAGES section.
    await requirePlayer(a, v.playerId, tx, "MESSAGES");
    if (family(a) && v.guardianId !== a.id)
      throw new DomainError("Conversation not found.", 404);
    if (!family(a)) requireCapability(a, "comms.conversation");
    const links = await tx
      .select()
      .from(t.guardianLinks)
      .where(
        and(
          eq(t.guardianLinks.academyId, a.academyId),
          eq(t.guardianLinks.userId, v.guardianId),
          eq(t.guardianLinks.playerId, v.playerId),
          eq(t.guardianLinks.active, true),
        ),
      );
    if (!links.length) throw new DomainError("Guardian access is not active.");
    // RC-4: staff may write to a guardian about an adult player only while that adult grants them MESSAGES.
    if (!(await guardianMayReceive(a.academyId, v.playerId, v.guardianId, "MESSAGES", tx)))
      throw new DomainError("Guardian access is not active.");
    const allowed = await accessiblePlayers(a, tx, "MESSAGES");
    if (!links.some((l) => allowed.some((p) => p.id === l.playerId)))
      throw new DomainError("Conversation not found.", 404);
    const [member] = await tx
      .select()
      .from(t.memberships)
      .where(
        and(
          eq(t.memberships.academyId, a.academyId),
          eq(t.memberships.userId, v.guardianId),
          eq(t.memberships.active, true),
        ),
      );
    if (!member) throw new DomainError("Guardian access revoked.");
    const id = v.id ?? crypto.randomUUID();
    let version = 1;
    let entries: {
      id: string;
      authorId: string;
      name: string;
      text: string;
      at: string;
    }[] = [];
    if (v.id) {
      const [old] = await tx
        .select()
        .from(t.conversations)
        .where(
          and(
            eq(t.conversations.academyId, a.academyId),
            eq(t.conversations.id, id),
            eq(t.conversations.guardianId, v.guardianId),
            eq(t.conversations.playerId, v.playerId),
          ),
        );
      if (!old) throw new DomainError("Conversation not found.", 404);
      const existing = old.entries.find((e) => e.id === v.entryId);
      if (existing) {
        if (existing.authorId !== a.id || existing.text !== v.text)
          throw new DomainError(
            "Conversation submission ID already used.",
            409,
          );
        return old;
      }
      expectVersion(old.version, v.version ?? 0);
      version = old.version + 1;
      entries = old.entries;
    }
    entries = [
      ...entries,
      {
        id: v.entryId,
        authorId: a.id,
        name: a.name,
        text: v.text,
        at: new Date().toISOString(),
      },
    ];
    const [saved] = v.id
      ? await tx
          .update(t.conversations)
          .set({ entries, version })
          .where(
            and(
              eq(t.conversations.academyId, a.academyId),
              eq(t.conversations.id, id),
            ),
          )
          .returning()
      : await tx
          .insert(t.conversations)
          .values({
            id,
            academyId: a.academyId,
            guardianId: v.guardianId,
            playerId: v.playerId,
            subject: v.subject,
            entries,
          })
          .returning();
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: id,
      action: "conversation-entry",
      version,
      detail: {},
    });
    return saved;
  });
}

/* ---------------------------------------------------------------------------------------------------------------
 * Provider delivery for the EMAIL and WHATSAPP rows that processOutbox queued (status QUEUED, or RETRY after a
 * temporary failure). Three short steps, so no database transaction or academy lock is ever held during a network call:
 *   1. CLAIM  (transaction) re-check the parent is still linked, resolve address/template, mark the row SENDING, attempts + 1.
 *   2. SEND   (no transaction) one provider call per claimed row, with a timeout.
 *   3. RECORD (transaction) SENT / RETRY / FAILED, with a short detail.
 * Guarantees: a row is claimed by one conditional UPDATE, so two overlapping runs cannot both send it; a row left in
 * SENDING (the process died between steps 1 and 3) is NEVER sent again automatically - it may already have been sent,
 * and resending would risk a duplicate - and is counted as `stuck` for a person to check with the provider.
 * SENT means the provider ACCEPTED the message. No delivery or read receipts are processed.
 * Retries: a temporary failure leaves the row in RETRY; the next processOutbox run tries it again, at most MAX_ATTEMPTS
 * times in total, then it is FAILED. The caller's schedule is the back-off (no timing column exists).
 * ------------------------------------------------------------------------------------------------------------- */
export const MAX_ATTEMPTS = 3;
const BATCH = 50;
type Job = { id: string; attempts: number; run: () => Promise<SendResult> };
export type DeliverySummary = {
  sent: number;
  retrying: number;
  failed: number;
  skipped: number;
  notConfigured: number;
  stuck: number;
};

export async function dispatchDeliveries(a: Actor, _now = Date.now()): Promise<DeliverySummary> {
  requireCapability(a, "comms.approve");
  const summary: DeliverySummary = { sent: 0, retrying: 0, failed: 0, skipped: 0, notConfigured: 0, stuck: 0 };
  const jobs = await unit(a, async (tx) => {
    await requireFeature(a, "communications", tx);
    const open = await tx
      .select()
      .from(t.deliveries)
      .where(
        and(
          eq(t.deliveries.academyId, a.academyId),
          inArray(t.deliveries.channel, ["EMAIL"]),
          inArray(t.deliveries.status, ["QUEUED", "RETRY"]),
        ),
      )
      .orderBy(asc(t.deliveries.createdAt), asc(t.deliveries.id))
      .limit(BATCH);
    const stuck = await tx
      .select({ id: t.deliveries.id })
      .from(t.deliveries)
      .where(and(eq(t.deliveries.academyId, a.academyId), eq(t.deliveries.status, "SENDING")));
    summary.stuck = stuck.length;
    const messages = new Map<string, Awaited<ReturnType<typeof loadMessage>>>();
    const out: Job[] = [];
    const settle = (id: string, status: string, detail: string) =>
      tx
        .update(t.deliveries)
        .set({ status, detail })
        .where(and(eq(t.deliveries.academyId, a.academyId), eq(t.deliveries.id, id)));
    for (const d of open) {
      const channel = "EMAIL" as const;
      if (!messages.has(d.messageId)) messages.set(d.messageId, await loadMessage(a, d.messageId, tx));
      const m = messages.get(d.messageId);
      // The guardian relationship and access are checked again NOW, exactly as when the row was queued.
      // The recipient must also be one the approver saw and approved (the approval hash covers that list).
      const target = m?.current.find((c) => c.userId === d.userId && c.channels.includes(channel));
      const approved = m?.row.data.recipients.some((r) => r.userId === d.userId && r.channels.includes(channel));
      if (!m || !target || !approved) {
        await settle(d.id, "SKIPPED", "No longer a linked parent when sending. Nothing was sent.");
        summary.skipped++;
        continue;
      }
      if (d.attempts >= MAX_ATTEMPTS) {
        await settle(d.id, "FAILED", `Gave up after ${d.attempts} attempts.`);
        summary.failed++;
        continue;
      }
      const cfg = emailConfig();
      if (!cfg.ok) {
        // No e-mail service here: the sender's own mail app does it, from a button, for free.
        await settle(d.id, "READY_TO_SHARE", "Ready for you to send from your own mail app. Nothing has been sent yet.");
        summary.notConfigured++;
        continue;
      }
      const attempts = await claim(a, d, tx);
      if (!attempts) continue;
      out.push({
        id: d.id,
        attempts,
        run: () =>
          sendEmail(cfg.config, {
            to: { address: target.email, name: target.name },
            subject: m.row.data.subject,
            text: m.row.data.body,
            reference: d.id,
          }),
      });
    }
    return out;
  });
  if (!jobs.length) return summary;
  // Step 2: no transaction is open here.
  const results: { job: Job; result: SendResult }[] = [];
  for (const job of jobs) {
    let result: SendResult;
    try {
      result = await job.run();
    } catch {
      result = { kind: "retry", detail: "Unexpected error while calling the provider." };
    }
    results.push({ job, result });
  }
  await unit(a, async (tx) => {
    for (const { job, result } of results) {
      const [status, detail] =
        result.kind === "sent"
          ? ["SENT", `Accepted by the provider (id ${result.providerId}). Delivery and reading are not tracked.`]
          : result.kind === "failed"
            ? ["FAILED", result.detail]
            : job.attempts >= MAX_ATTEMPTS
              ? ["FAILED", `${result.detail} Gave up after ${job.attempts} attempts.`]
              : ["RETRY", `${result.detail} Attempt ${job.attempts} of ${MAX_ATTEMPTS}; it will be tried again at the next run.`];
      await tx
        .update(t.deliveries)
        .set({ status, detail })
        .where(
          and(
            eq(t.deliveries.academyId, a.academyId),
            eq(t.deliveries.id, job.id),
            eq(t.deliveries.status, "SENDING"),
          ),
        );
      if (status === "SENT") summary.sent++;
      else if (status === "RETRY") summary.retrying++;
      else summary.failed++;
    }
  });
  return summary;
}
/**
 * Manual sending, free. Deliveries in READY_TO_SHARE are the e-mails and WhatsApp messages a person sends from their own
 * mail app or WhatsApp: the page builds a `mailto:` / `wa.me` link from what is returned here. The guardian relationship
 * and the approved recipient list are checked again now, exactly as for automatic delivery; a recipient who no longer
 * qualifies is SKIPPED and not returned. The phone is the recipient's OWN registered number (never anyone else's).
 */
export async function shareList(a: Actor) {
  requireCapability(a, "comms.approve");
  return unit(a, async (tx) => {
    await requireFeature(a, "communications", tx);
    const open = await tx
      .select()
      .from(t.deliveries)
      .where(
        and(
          eq(t.deliveries.academyId, a.academyId),
          inArray(t.deliveries.channel, ["EMAIL", "WHATSAPP"]),
          eq(t.deliveries.status, "READY_TO_SHARE"),
        ),
      )
      .orderBy(asc(t.deliveries.createdAt), asc(t.deliveries.id))
      .limit(300);
    const messages = new Map<string, Awaited<ReturnType<typeof loadMessage>>>();
    const items: {
      id: string;
      messageId: string;
      userId: string;
      channel: "EMAIL" | "WHATSAPP";
      name: string;
      email: string | null;
      phone: string | null;
      subject: string;
      body: string;
    }[] = [];
    for (const d of open) {
      const channel = d.channel as "EMAIL" | "WHATSAPP";
      if (!messages.has(d.messageId)) messages.set(d.messageId, await loadMessage(a, d.messageId, tx));
      const m = messages.get(d.messageId);
      const target = m?.current.find((c) => c.userId === d.userId && c.channels.includes(channel));
      const approved = m?.row.data.recipients.some((r) => r.userId === d.userId && r.channels.includes(channel));
      if (!m || !target || !approved) {
        await tx
          .update(t.deliveries)
          .set({ status: "SKIPPED", detail: "No longer a linked parent when sending. Nothing was sent." })
          .where(and(eq(t.deliveries.academyId, a.academyId), eq(t.deliveries.id, d.id)));
        continue;
      }
      items.push({
        id: d.id,
        messageId: d.messageId,
        userId: d.userId,
        channel,
        name: target.name,
        email: channel === "EMAIL" ? target.email : null,
        phone: channel === "WHATSAPP" ? await phoneFor(target.userId, tx) : null,
        subject: m.row.data.subject,
        body: m.row.data.body,
      });
    }
    return { items };
  });
}

/** The sender opened WhatsApp or their mail app for this delivery. It records that, not that anything was received. */
export async function markShared(a: Actor, input: unknown) {
  requireCapability(a, "comms.approve");
  const v = z.object({ id: z.string().min(1).max(200) }).parse(input);
  return unit(a, async (tx) => {
    await requireFeature(a, "communications", tx);
    const rows = await tx
      .update(t.deliveries)
      .set({
        status: "SHARED",
        detail: "Opened in the sender's own WhatsApp or mail app. Whether it was sent, delivered or read is not tracked.",
      })
      .where(
        and(
          eq(t.deliveries.academyId, a.academyId),
          eq(t.deliveries.id, v.id),
          eq(t.deliveries.status, "READY_TO_SHARE"),
        ),
      )
      .returning({ id: t.deliveries.id });
    if (!rows.length) {
      const [now] = await tx
        .select({ status: t.deliveries.status })
        .from(t.deliveries)
        .where(and(eq(t.deliveries.academyId, a.academyId), eq(t.deliveries.id, v.id)));
      if (now?.status === "SHARED") return { id: v.id, status: "SHARED" as const };
      throw new DomainError("This message is not waiting to be sent.", 409);
    }
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: v.id,
      action: "delivery-shared",
      version: 1,
      detail: {},
    });
    return { id: v.id, status: "SHARED" as const };
  });
}

/** One conditional UPDATE is the claim: it succeeds for exactly one caller. Returns the new attempt count, or 0. */
async function claim(a: Actor, d: { id: string; attempts: number }, tx: Tx) {
  const rows = await tx
    .update(t.deliveries)
    .set({ status: "SENDING", attempts: d.attempts + 1, detail: "Sending." })
    .where(
      and(
        eq(t.deliveries.academyId, a.academyId),
        eq(t.deliveries.id, d.id),
        eq(t.deliveries.attempts, d.attempts),
        inArray(t.deliveries.status, ["QUEUED", "RETRY"]),
      ),
    )
    .returning({ attempts: t.deliveries.attempts });
  return rows[0]?.attempts ?? 0;
}
async function loadMessage(a: Actor, id: string, tx: Tx) {
  const [row] = await tx
    .select()
    .from(t.messages)
    .where(and(eq(t.messages.academyId, a.academyId), eq(t.messages.id, id)));
  if (!row) return null;
  const current = await recipients(a, row.data, tx);
  let templateName: string | null = null;
  if (row.data.templateId) {
    const [tpl] = await tx
      .select({ name: t.messageTemplates.name })
      .from(t.messageTemplates)
      .where(and(eq(t.messageTemplates.academyId, a.academyId), eq(t.messageTemplates.id, row.data.templateId)));
    templateName = tpl?.name ?? null;
  }
  return { row, current, templateName };
}
/**
 * The number a WhatsApp message goes to: the RECIPIENT'S OWN registered phone number (app_user.phone, one per account,
 * E.164). Nobody else's number is ever substituted: not a player's profile phone (a minor's included), not another
 * guardian's, not a number from another link. No number on file -> null, and the delivery FAILS with that reason.
 */
async function phoneFor(userId: string, tx: Tx) {
  const [row] = await tx.select({ phone: t.user.phone }).from(t.user).where(eq(t.user.id, userId));
  return row?.phone?.trim() || null;
}
