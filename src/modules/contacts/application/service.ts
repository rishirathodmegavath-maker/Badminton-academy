import { z } from "zod";
import { and, eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import { linkedRecipients, requirePlayer, unit, type Tx } from "../../academy/application/access";
import {
  STAFF_OPT_IN_SOURCES,
  maskAddress,
  normalizeAddress,
  normalizeEmail,
  normalizeWhatsApp,
  type Channel,
  type OptInSource,
} from "../domain/contact-rules";

/**
 * Contacts: where a message may be sent, and the channel-specific facts about each place.
 *
 *  - Independent of identity. A player's and a parent's e-mail and phone are separate values that may be equal or different;
 *    no code here looks an address up to find or join a person.
 *  - WhatsApp opt-in is a small record on the number itself: when, where it came from, and whether it was revoked. It gates
 *    only the OFFICIAL WhatsApp channel; it does not gate ordinary academy functions, the free manual links, e-mail or the
 *    portal.
 *  - Suppression (a bounce, a complaint, a "stop") stops automated sending to that address until an owner clears it.
 *  - Audit lines carry the channel and a masked address, never a full address.
 */
type Reader = Pick<Tx, "select">;
export const countryOf = async (tx: Reader, academyId: string) => {
  const [s] = await tx.select({ data: t.academySettings.data }).from(t.academySettings).where(eq(t.academySettings.academyId, academyId));
  return s?.data.country ?? "IN";
};

export type ContactView = {
  id: string | null;
  channel: Channel;
  address: string | null;
  /** Where the value comes from: the player's profile, the parent's account, or an extra contact added here. */
  origin: "PROFILE" | "ACCOUNT" | "EXTRA";
  label: string | null;
  optedIn: boolean | null;
  optInSource: string | null;
  optedInAt: string | null;
  optInRevokedAt: string | null;
  suppressed: boolean;
  suppressionReason: string | null;
  /** True when the stored text could not be read as a usable address (for example a number with no country code). */
  unreadable: boolean;
};
type Row = typeof t.contactPoints.$inferSelect;
const view = (
  channel: Channel,
  address: string | null,
  origin: ContactView["origin"],
  row: Row | undefined,
  unreadable = false,
): ContactView => ({
  id: row?.id ?? null,
  channel,
  address,
  origin,
  label: row?.label ?? null,
  optedIn: channel === "WHATSAPP" ? !!row?.optedInAt && !row?.optInRevokedAt : null,
  optInSource: row?.optInSource ?? null,
  optedInAt: row?.optedInAt?.toISOString() ?? null,
  optInRevokedAt: row?.optInRevokedAt?.toISOString() ?? null,
  suppressed: !!row?.suppressedAt,
  suppressionReason: row?.suppressionReason ?? null,
  unreadable,
});

const audit = (tx: Tx, a: Actor, entityId: string, action: string, detail: Record<string, unknown>) =>
  tx.insert(t.audit).values({ id: crypto.randomUUID(), academyId: a.academyId, actorId: a.id, entityId, action, version: 1, detail });

/** Every contact row of one subject (a player or an account) in this academy. */
export async function contactRows(tx: Reader, academyId: string, subject: { playerId?: string; userId?: string }) {
  return tx
    .select()
    .from(t.contactPoints)
    .where(
      and(
        eq(t.contactPoints.academyId, academyId),
        subject.playerId ? eq(t.contactPoints.playerId, subject.playerId) : eq(t.contactPoints.userId, subject.userId!),
      ),
    );
}
const rowFor = (rows: Row[], channel: Channel, address: string | null) =>
  address ? rows.find((r) => r.channel === channel && r.address === address) : undefined;

/**
 * Who would be reached for one player, and how: the player's own contacts and each linked parent's. Every value is shown as
 * stored; none is used to find or join anyone. Needs `comms.author` and a player the actor may see.
 */
export async function contactsOverview(a: Actor, input: unknown) {
  requireCapability(a, "comms.author");
  const v = z.object({ playerId: z.string().min(1).max(200) }).parse(input);
  return unit(a, async (tx) => {
    const player = await requirePlayer(a, v.playerId, tx);
    const country = await countryOf(tx, a.academyId);
    const [profile] = await tx
      .select({ data: t.profiles.data })
      .from(t.profiles)
      .where(and(eq(t.profiles.academyId, a.academyId), eq(t.profiles.playerId, v.playerId)));
    const own = await contactRows(tx, a.academyId, { playerId: v.playerId });
    const email = normalizeEmail(profile?.data.email);
    const phoneRaw = (profile?.data.phone ?? "").trim();
    const phone = phoneRaw ? normalizeWhatsApp(phoneRaw, country) : null;
    const playerContacts: ContactView[] = [];
    if (profile?.data.email) playerContacts.push(view("EMAIL", email, "PROFILE", rowFor(own, "EMAIL", email), !email));
    if (phoneRaw) playerContacts.push(view("WHATSAPP", phone, "PROFILE", rowFor(own, "WHATSAPP", phone), !phone));
    for (const r of own)
      if (!playerContacts.some((c) => c.id === r.id) && !(r.address === email || r.address === phone))
        playerContacts.push(view(r.channel as Channel, r.address, "EXTRA", r));
    const parents = [];
    for (const { link, user, displayName } of await linkedRecipients(a, [v.playerId], tx)) {
      const rows = await contactRows(tx, a.academyId, { userId: user.id });
      const mail = normalizeEmail(user.email);
      const contacts: ContactView[] = [];
      if (mail) contacts.push(view("EMAIL", mail, "ACCOUNT", rowFor(rows, "EMAIL", mail)));
      if (user.phone) contacts.push(view("WHATSAPP", user.phone, "ACCOUNT", rowFor(rows, "WHATSAPP", user.phone)));
      for (const r of rows)
        if (!(r.address === mail || r.address === user.phone)) contacts.push(view(r.channel as Channel, r.address, "EXTRA", r));
      parents.push({ userId: user.id, name: displayName ?? user.name, relationship: link.relationship, contacts });
    }
    return { player: { id: player.id, name: player.name, contacts: playerContacts }, parents };
  });
}

const subjectInput = z.object({
  playerId: z.string().min(1).max(200),
  /** Omitted: the contact belongs to the player. Given: it belongs to that linked parent's account. */
  userId: z.string().min(1).max(200).optional(),
});
async function resolveSubject(a: Actor, tx: Tx, v: z.infer<typeof subjectInput>) {
  await requirePlayer(a, v.playerId, tx);
  if (!v.userId) return { playerId: v.playerId } as const;
  const [link] = await tx
    .select({ active: t.guardianLinks.active })
    .from(t.guardianLinks)
    .where(and(eq(t.guardianLinks.academyId, a.academyId), eq(t.guardianLinks.playerId, v.playerId), eq(t.guardianLinks.userId, v.userId)));
  if (!link?.active) throw new DomainError("That person is not a linked parent of this player.", 404);
  return { userId: v.userId } as const;
}

/** Adds an extra e-mail address or WhatsApp number for a player or a linked parent. The same value may exist for several people. */
export async function saveContact(a: Actor, input: unknown) {
  const v = subjectInput
    .extend({ channel: z.enum(["EMAIL", "WHATSAPP"]), address: z.string().trim().min(3).max(254), label: z.string().trim().max(60).optional() })
    .parse(input);
  requireCapability(a, v.userId ? "guardians.link" : "players.manage");
  return unit(a, async (tx) => {
    const subject = await resolveSubject(a, tx, v);
    const country = await countryOf(tx, a.academyId);
    const address = normalizeAddress(v.channel, v.address, country);
    if (!address)
      throw new DomainError(
        v.channel === "EMAIL" ? "Enter a valid e-mail address." : "Enter the number with its country code, for example +91 98765 43210.",
        422,
      );
    const existing = (await contactRows(tx, a.academyId, subject)).find((r) => r.channel === v.channel && r.address === address);
    if (existing) return { id: existing.id, created: false };
    const [row] = await tx
      .insert(t.contactPoints)
      .values({ academyId: a.academyId, ...subject, channel: v.channel, address, label: v.label || null })
      .returning({ id: t.contactPoints.id });
    await audit(tx, a, row.id, "contact-save", { channel: v.channel, masked: maskAddress(v.channel, address), subject: subject.playerId ? "PLAYER" : "ACCOUNT" });
    return { id: row.id, created: true };
  });
}

/** The number to record an opt-in for: the one given, else the number the player's profile or the parent's account already holds. */
async function numberFor(tx: Tx, a: Actor, subject: { playerId?: string; userId?: string }, given: string | undefined, country: string) {
  if (given) {
    const n = normalizeWhatsApp(given, country);
    if (!n) throw new DomainError("Enter the number with its country code, for example +91 98765 43210.", 422);
    return n;
  }
  if (subject.userId) {
    const [u] = await tx.select({ phone: t.user.phone }).from(t.user).where(eq(t.user.id, subject.userId));
    if (u?.phone) return u.phone;
  } else {
    const [p] = await tx
      .select({ data: t.profiles.data })
      .from(t.profiles)
      .where(and(eq(t.profiles.academyId, a.academyId), eq(t.profiles.playerId, subject.playerId!)));
    const n = normalizeWhatsApp(p?.data.phone, country);
    if (n) return n;
  }
  throw new DomainError("No WhatsApp number is saved for this person yet. Add the number first.", 422, "NO_NUMBER");
}

export async function upsertOptIn(
  tx: Tx,
  academyId: string,
  subject: { playerId?: string; userId?: string },
  address: string,
  source: OptInSource,
  recordedBy: string,
) {
  const now = new Date();
  const existing = (await contactRows(tx, academyId, subject)).find((r) => r.channel === "WHATSAPP" && r.address === address);
  if (existing) {
    await tx
      .update(t.contactPoints)
      .set({ optedInAt: now, optInSource: source, optInRecordedBy: recordedBy, optInRevokedAt: null, updatedAt: now })
      .where(eq(t.contactPoints.id, existing.id));
    return existing.id;
  }
  const [row] = await tx
    .insert(t.contactPoints)
    .values({ academyId, ...subject, channel: "WHATSAPP", address, optedInAt: now, optInSource: source, optInRecordedBy: recordedBy })
    .returning({ id: t.contactPoints.id });
  return row.id;
}

/**
 * Records that this WhatsApp number may be used for the official WhatsApp channel, with where the agreement came from.
 * Staff record it on a parent's or player's behalf (owner, administrator, head coach). It is channel-specific and gates nothing else.
 */
export async function recordWhatsAppOptIn(a: Actor, input: unknown) {
  requireCapability(a, "comms.approve");
  const v = subjectInput.extend({ address: z.string().trim().max(40).optional(), source: z.enum(STAFF_OPT_IN_SOURCES) }).parse(input);
  return unit(a, async (tx) => {
    const subject = await resolveSubject(a, tx, v);
    const country = await countryOf(tx, a.academyId);
    const address = await numberFor(tx, a, subject, v.address, country);
    const id = await upsertOptIn(tx, a.academyId, subject, address, v.source, a.id);
    await audit(tx, a, id, "contact-optin", { channel: "WHATSAPP", masked: maskAddress("WHATSAPP", address), source: v.source });
    return { id, optedIn: true };
  });
}

/** Withdraws a WhatsApp opt-in. The record stays (with when it was revoked); automated WhatsApp stops for that number at once. */
export async function revokeWhatsAppOptIn(a: Actor, input: unknown) {
  requireCapability(a, "comms.approve");
  const v = subjectInput.extend({ address: z.string().trim().max(40).optional() }).parse(input);
  return unit(a, async (tx) => {
    const subject = await resolveSubject(a, tx, v);
    const country = await countryOf(tx, a.academyId);
    const address = await numberFor(tx, a, subject, v.address, country);
    const row = (await contactRows(tx, a.academyId, subject)).find((r) => r.channel === "WHATSAPP" && r.address === address);
    if (!row?.optedInAt) throw new DomainError("There is no opt-in recorded for that number.", 404);
    await tx.update(t.contactPoints).set({ optInRevokedAt: new Date(), updatedAt: new Date() }).where(eq(t.contactPoints.id, row.id));
    await audit(tx, a, row.id, "contact-optout", { channel: "WHATSAPP", masked: maskAddress("WHATSAPP", address) });
    return { id: row.id, optedIn: false };
  });
}

/** The signed-in parent's own choice about WhatsApp messages to the number on their account. */
export async function saveMyWhatsAppOptIn(a: Actor, input: unknown) {
  const v = z.object({ optIn: z.boolean() }).parse(input);
  return unit(a, async (tx) => {
    const [u] = await tx.select({ phone: t.user.phone }).from(t.user).where(eq(t.user.id, a.id));
    if (!u?.phone) throw new DomainError("Save your WhatsApp number first.", 422, "NO_NUMBER");
    if (v.optIn) {
      const id = await upsertOptIn(tx, a.academyId, { userId: a.id }, u.phone, "PARENT_FORM", a.id);
      await audit(tx, a, id, "contact-optin", { channel: "WHATSAPP", masked: maskAddress("WHATSAPP", u.phone), source: "PARENT_FORM" });
    } else {
      const row = (await contactRows(tx, a.academyId, { userId: a.id })).find((r) => r.channel === "WHATSAPP" && r.address === u.phone);
      if (row?.optedInAt && !row.optInRevokedAt) {
        await tx.update(t.contactPoints).set({ optInRevokedAt: new Date(), updatedAt: new Date() }).where(eq(t.contactPoints.id, row.id));
        await audit(tx, a, row.id, "contact-optout", { channel: "WHATSAPP", masked: maskAddress("WHATSAPP", u.phone) });
      }
    }
    return { optedIn: v.optIn };
  });
}

/** Whether the signed-in person has WhatsApp opt-in on their saved number (for their own portal card). */
export async function myWhatsAppOptIn(a: Actor) {
  return unit(a, async (tx) => {
    const [u] = await tx.select({ phone: t.user.phone }).from(t.user).where(eq(t.user.id, a.id));
    if (!u?.phone) return { hasNumber: false, optedIn: false };
    const row = (await contactRows(tx, a.academyId, { userId: a.id })).find((r) => r.channel === "WHATSAPP" && r.address === u.phone);
    return { hasNumber: true, optedIn: !!row?.optedInAt && !row.optInRevokedAt };
  });
}

/** An owner clears a suppression after the cause is fixed (a corrected address, a person who asked to hear from the academy again). */
export async function clearSuppression(a: Actor, input: unknown) {
  requireCapability(a, "comms.approve");
  const v = z.object({ id: z.uuid() }).parse(input);
  return unit(a, async (tx) => {
    const [row] = await tx
      .select()
      .from(t.contactPoints)
      .where(and(eq(t.contactPoints.academyId, a.academyId), eq(t.contactPoints.id, v.id)));
    if (!row?.suppressedAt) throw new DomainError("That contact is not suppressed.", 404);
    await tx
      .update(t.contactPoints)
      .set({ suppressedAt: null, suppressionReason: null, updatedAt: new Date() })
      .where(eq(t.contactPoints.id, row.id));
    await audit(tx, a, row.id, "contact-unsuppress", { channel: row.channel, masked: maskAddress(row.channel as Channel, row.address) });
    return { id: row.id };
  });
}

/**
 * Called by the delivery pipeline (never by a screen): marks an address as not to be sent to again for the people a message
 * was for. A contact row is created for a subject whose value lived only on the profile or the account. People who merely
 * share the same address elsewhere are NOT touched: this is by subject, never by matching addresses.
 */
export async function suppressAddress(
  tx: Tx,
  academyId: string,
  channel: Channel,
  address: string,
  subjects: { kind: "ACCOUNT" | "PLAYER"; id: string }[],
  reason: "BOUNCED" | "COMPLAINED" | "STOP",
) {
  const now = new Date();
  let changed = 0;
  for (const s of subjects) {
    const subject = s.kind === "PLAYER" ? { playerId: s.id } : { userId: s.id };
    const existing = (await contactRows(tx, academyId, subject)).find((r) => r.channel === channel && r.address === address);
    const patch = { suppressedAt: now, suppressionReason: reason, updatedAt: now, ...(reason === "STOP" && channel === "WHATSAPP" ? { optInRevokedAt: now } : {}) };
    if (existing) await tx.update(t.contactPoints).set(patch).where(eq(t.contactPoints.id, existing.id));
    else await tx.insert(t.contactPoints).values({ academyId, ...subject, channel, address, ...patch });
    changed++;
  }
  return changed;
}
