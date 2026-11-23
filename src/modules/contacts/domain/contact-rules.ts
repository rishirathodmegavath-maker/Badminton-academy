import { createHash } from "node:crypto";
import { COUNTRY_CALLING_CODE, canonicalPhone } from "../../communications/share-links";

/**
 * Pure rules for contacts. A contact is only a PLACE a message may be sent. Nothing here ever matches, merges or links
 * people by an address: a parent and a player may share an e-mail address, a phone number, both or neither, and the four
 * combinations are all ordinary.
 */
export type Channel = "EMAIL" | "WHATSAPP";
export const WHATSAPP_OPT_IN_SOURCES = ["INVITATION_ACCEPT", "OWNER_WRITTEN", "OWNER_VERBAL", "PARENT_FORM"] as const;
export type OptInSource = (typeof WHATSAPP_OPT_IN_SOURCES)[number];
/** What a member of staff may record on a parent's behalf. INVITATION_ACCEPT is only ever written by the accept step itself. */
export const STAFF_OPT_IN_SOURCES = ["OWNER_WRITTEN", "OWNER_VERBAL", "PARENT_FORM"] as const;
export type SuppressionReason = "BOUNCED" | "COMPLAINED" | "STOP" | "OWNER";

const EMAIL = /^[^@\s]+@[^@\s]+$/;
/** Lower-cased, trimmed e-mail address, or null when it does not look like one. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  return v && v.length <= 254 && EMAIL.test(v) ? v : null;
}
/** E.164 ("+919876543210"), reading a number typed without a country code in the academy's own country. Null when unreadable. */
export function normalizeWhatsApp(raw: string | null | undefined, country: string): string | null {
  return canonicalPhone(raw ?? "", COUNTRY_CALLING_CODE[country] ?? null);
}
export function normalizeAddress(channel: Channel, raw: string | null | undefined, country: string): string | null {
  return channel === "EMAIL" ? normalizeEmail(raw) : normalizeWhatsApp(raw, country);
}
/**
 * The key two recipients share when they would receive the SAME message at the SAME place. It is a keyed digest, so the queue
 * and its logs never carry an address in the clear; equal keys inside one batch mean "send once".
 */
export function addressKey(channel: Channel, address: string, secret: string): string {
  return createHash("sha256").update(`${secret}|contact|${channel}|${address}`).digest("hex");
}
/** The last four characters, for audit lines that must not carry a full address. */
export const maskAddress = (channel: Channel, address: string) =>
  channel === "EMAIL" ? `${address.slice(0, 1)}***@${address.split("@")[1] ?? ""}` : `…${address.slice(-4)}`;

export type ContactState = {
  channel: Channel;
  optedInAt: Date | null;
  optInRevokedAt: Date | null;
  suppressedAt: Date | null;
};
/** WhatsApp may be used for a number only with a live opt-in that is not revoked and not suppressed. */
export const whatsAppAllowed = (c: ContactState | undefined) =>
  !!c && c.channel === "WHATSAPP" && !!c.optedInAt && !c.optInRevokedAt && !c.suppressedAt;
/** E-mail needs no opt-in; only a suppression (bounce, complaint, "stop") blocks it. */
export const emailAllowed = (c: ContactState | undefined) => !c || !c.suppressedAt;
