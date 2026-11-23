import { z } from "zod";
import { and, desc, eq, ne } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import { unit } from "../../academy/application/access";
import { database } from "../../../infrastructure/database/client";
import { COUNTRY_CALLING_CODE, canonicalPhone } from "../share-links";

/**
 * Registers (or clears) the mobile number WhatsApp messages go to. One number per ACCOUNT (app_user.phone), never per
 * guardian link, so a guardian of three children has one number.
 *   - Your own number: any signed-in member of the academy may set or clear it.
 *   - Someone else's number: only an OWNER (capability members.manage), and only for a member of the same academy.
 * The number is stored as E.164 ("+919876543210"). It is NOT verified (no OTP), it is not a sign-in factor and it changes
 * nothing about authentication. The audit record keeps only the last four digits, never the number.
 */
const PHONE_HELP = "Enter the mobile number with its country code, for example +91 98765 43210.";
export async function savePhone(a: Actor, input: unknown) {
  const v = z.object({ userId: z.string().min(1).max(100).optional(), phone: z.string().max(40).nullable() }).parse(input);
  const targetId = v.userId ?? a.id;
  if (targetId !== a.id) requireCapability(a, "members.manage");
  const raw = (v.phone ?? "").trim();
  return unit(a, async (tx) => {
    // A number typed without its country code is read in the academy's own country (India: +91, United States: +1).
    let phone: string | null = null;
    if (raw) {
      const [settings] = await tx
        .select({ data: t.academySettings.data })
        .from(t.academySettings)
        .where(eq(t.academySettings.academyId, a.academyId));
      phone = canonicalPhone(raw, COUNTRY_CALLING_CODE[settings?.data.country ?? ""] ?? null);
      if (!phone) throw new DomainError(PHONE_HELP, 422);
    }
    // The target must belong to THIS academy (an owner cannot reach into another academy's accounts).
    const [member] = await tx
      .select({ id: t.memberships.userId })
      .from(t.memberships)
      .where(and(eq(t.memberships.academyId, a.academyId), eq(t.memberships.userId, targetId)));
    if (!member) throw new DomainError("Member not found.", 404);
    // The number belongs to the PERSON (app_user.phone) and every academy they belong to messages it. An owner may
    // change someone else's only while this is their one academy; otherwise only the person can, for themselves.
    if (targetId !== a.id) {
      const [elsewhere] = await tx
        .select({ academyId: t.memberships.academyId })
        .from(t.memberships)
        .where(and(eq(t.memberships.userId, targetId), ne(t.memberships.academyId, a.academyId)))
        .limit(1);
      if (elsewhere)
        throw new DomainError(
          "This person belongs to more than one academy, so only they can change their number.",
          409,
          "PHONE_MANAGED_BY_PERSON",
        );
    }
    await tx.update(t.user).set({ phone, updatedAt: new Date() }).where(eq(t.user.id, targetId));
    const [last] = await tx
      .select({ version: t.recordRevisions.version })
      .from(t.recordRevisions)
      .where(and(eq(t.recordRevisions.academyId, a.academyId), eq(t.recordRevisions.entityId, targetId), eq(t.recordRevisions.kind, "user-phone")))
      .orderBy(desc(t.recordRevisions.version))
      .limit(1);
    const version = (last?.version ?? 0) + 1;
    await tx.insert(t.recordRevisions).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      entityId: targetId,
      kind: "user-phone",
      version,
      data: { registered: phone !== null, last4: phone ? phone.slice(-4) : null, byOwner: targetId !== a.id },
    });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: targetId,
      action: "user-phone",
      version,
      detail: {},
    });
    return { registered: phone !== null, last4: phone ? phone.slice(-4) : null };
  });
}

/** Whether the signed-in person has a WhatsApp number saved, and its last four digits. Read on demand by the family portal. */
export async function myPhone(a: Actor) {
  const [row] = await database().select({ phone: t.user.phone }).from(t.user).where(eq(t.user.id, a.id));
  return { last4: row?.phone ? row.phone.slice(-4) : null };
}
