import { z } from "zod";
import { and, eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import {
  adultAuthority,
  decideFlagTargets,
  recordConsentChanges,
} from "../../consent/application/service";
import { CONSENT_CATEGORIES, FLAG_KEY, STAFF_METHODS } from "../../consent/domain";
import {
  unit,
  requirePlayer,
  expectVersion,
  history,
  scopedBatch,
  family,
} from "../../academy/application/access";
import { endGuardianAccess } from "../../academy/application/guardian-access";
import { adultControlled } from "../../academy/domain/guardian-access";
import { academyToday, requireUnder18 } from "./age-rules";
const profileSchema = z.object({
  adult: z.boolean(),
  birthDate: z.string().max(10),
  email: z.union([z.email(), z.literal("")]),
  phone: z.string().max(40),
  notes: z.string().max(2000),
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]),
  selfUserId: z.string().nullable(),
  preferences: z.string().max(2000),
});
export async function savePlayer(a: Actor, input: unknown) {
  requireCapability(a, "players.manage");
  const v = z
    .object({
      id: z.string().optional(),
      version: z.number().int().optional(),
      name: z.string().trim().min(2).max(120),
      batchId: z.string(),
      profile: profileSchema,
    })
    .parse(input);
  return unit(a, async (tx) => {
    await scopedBatch(a, v.batchId, tx);
    // Players are under 18 and always have a date of birth (see age-rules.ts). The owner's age-review decision about a
    // player is not editable here: it is carried over from the stored profile and only the review changes it.
    if (v.id) await requirePlayer(a, v.id, tx);
    const [stored] = v.id
      ? await tx
          .select({ data: t.profiles.data })
          .from(t.profiles)
          .where(and(eq(t.profiles.academyId, a.academyId), eq(t.profiles.playerId, v.id)))
      : [];
    // A LEGACY adult-controlled record (the application no longer creates one, but an older database may hold one) is never changed
    // by the ordinary player form. Saving it used to rewrite the stored flag to "minor", which revoked the grants the adult had made,
    // removed the adult's own-account link and opened the whole record to every linked guardian, silently. Who may see an adult's
    // record must only ever change by a deliberate, separate action (none exists yet), so every such save is refused and nothing is
    // written. The test is the access layer's own (fail-closed): a profile whose flag is not the boolean false, or that names an
    // own account, is adult-controlled.
    if (stored && adultControlled(stored.data))
      throw new DomainError(
        "This record belongs to an adult player. Players are under 18, so it cannot be edited or converted here, and nothing about who can see it has been changed.",
        409,
        "ADULT_RECORD_PROTECTED",
      );
    requireUnder18(v.profile, await academyToday(tx, a.academyId), stored?.data.ageDecision);
    // A player's own login (joined by invitation link) is kept when staff correct the record: it is never set from the form.
    const profileData = {
      ...v.profile,
      adult: false,
      selfUserId: null,
      ageDecision: stored?.data.ageDecision ?? null,
      ...(stored?.data.loginUserId ? { loginUserId: stored.data.loginUserId } : {}),
    };
    const id = v.id ?? crypto.randomUUID();
    let version = 1;
    if (v.id) {
      const player = await requirePlayer(a, id, tx);
      const [old] = await tx
        .select()
        .from(t.profiles)
        .where(
          and(
            eq(t.profiles.academyId, a.academyId),
            eq(t.profiles.playerId, id),
          ),
        );
      expectVersion(old?.version ?? 1, v.version ?? 0);
      version = (old?.version ?? 1) + 1;
      // RC-4 (TD-3). Recording adulthood ends every guardian's access to this record at once: from the next
      // request a guardian reads it only through a grant made by the adult, and none exists. One
      // ACCESS_ENDED_ADULTHOOD event per active guardian link says so. Links and consent are kept as they are.
      // Clearing the flag closes any grant, so a later adulthood starts from nothing again.
      const wasAdult = old?.data.adult === true;
      if (!wasAdult && v.profile.adult)
        await endGuardianAccess(tx, a, id, "ACCESS_ENDED_ADULTHOOD", { exceptUserId: v.profile.selfUserId });
      else if (wasAdult && !v.profile.adult)
        await endGuardianAccess(tx, a, id, "ENDED_ADULT_FLAG_CLEARED");
      await tx
        .update(t.players)
        .set({ name: v.name, batchId: v.batchId })
        .where(and(eq(t.players.academyId, a.academyId), eq(t.players.id, id)));
      await tx.insert(t.playerHistory).values({
        id: crypto.randomUUID(),
        academyId: a.academyId,
        playerId: id,
        kind: player.batchId !== v.batchId ? "TRANSFER" : "PROFILE_UPDATED",
        detail: {
          fromBatch: player.batchId,
          toBatch: v.batchId,
          status: v.profile.status,
          actor: a.id,
        },
      });
    } else {
      await tx.insert(t.players).values({
        id,
        academyId: a.academyId,
        name: v.name,
        batchId: v.batchId,
      });
      await tx.insert(t.playerHistory).values({
        id: crypto.randomUUID(),
        academyId: a.academyId,
        playerId: id,
        kind: "ENROLLED",
        detail: { batchId: v.batchId, actor: a.id },
      });
    }
    await tx
      .insert(t.profiles)
      .values({
        academyId: a.academyId,
        playerId: id,
        version,
        data: profileData,
      })
      .onConflictDoUpdate({
        target: [t.profiles.academyId, t.profiles.playerId],
        set: { version, data: profileData },
      });
    await history(tx, a, "player-profile", id, version, {
      name: v.name,
      batchId: v.batchId,
      ...profileData,
    });
    return { id, version };
  });
}
export async function linkGuardian(a: Actor, input: unknown) {
  requireCapability(a, "guardians.link");
  const v = z
    .object({
      playerId: z.string(),
      userId: z.string(),
      relationship: z.string().trim().min(2).max(50),
      active: z.boolean(),
      // Optional: omitted means "leave consent as it is". Any CHANGE is a recorded decision made on the
      // person's behalf (owner/admin only, with method, evidence and the document version shown).
      consent: z
        .object({
          portal: z.boolean(),
          email: z.boolean(),
          whatsapp: z.boolean(),
        })
        .optional(),
      consentMethod: z.enum(STAFF_METHODS).optional(),
      evidenceRef: z.string().trim().max(500).optional(),
      consentVersions: z
        .object({
          portal: z.string().nullable().optional(),
          email: z.string().nullable().optional(),
          whatsapp: z.string().nullable().optional(),
        })
        .optional(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    await requirePlayer(a, v.playerId, tx);
    const [member] = await tx
      .select()
      .from(t.memberships)
      .where(
        and(
          eq(t.memberships.academyId, a.academyId),
          eq(t.memberships.userId, v.userId),
          eq(t.memberships.active, true),
          eq(t.memberships.role, "GUARDIAN"),
        ),
      );
    if (!member)
      throw new DomainError(
        "Choose an active guardian account in this academy.",
      );
    // The link itself. Consent is never written here: a new link starts with nothing granted, an
    // existing one keeps what it has, and any change goes through recordConsentChanges below.
    await tx
      .insert(t.guardianLinks)
      .values({
        academyId: a.academyId,
        playerId: v.playerId,
        userId: v.userId,
        relationship: v.relationship,
        active: v.active,
        consent: { portal: false, email: false, whatsapp: false },
      })
      .onConflictDoUpdate({
        target: [
          t.guardianLinks.academyId,
          t.guardianLinks.playerId,
          t.guardianLinks.userId,
        ],
        set: { relationship: v.relationship, active: v.active },
      });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: v.playerId,
      action: "guardian-link",
      version: 1,
      detail: { guardianId: v.userId, active: v.active },
    });
    // RC-4: a deactivated link closes whatever an adult player had granted this guardian. Re-activating the
    // link later restores nothing; only the adult can grant again.
    if (!v.active)
      await endGuardianAccess(tx, a, v.playerId, "ENDED_LINK_INACTIVE", { guardianUserId: v.userId });
    if (v.consent) {
      const [link] = await tx
        .select()
        .from(t.guardianLinks)
        .where(
          and(
            eq(t.guardianLinks.academyId, a.academyId),
            eq(t.guardianLinks.playerId, v.playerId),
            eq(t.guardianLinks.userId, v.userId),
          ),
        )
        .for("update");
      const changes = CONSENT_CATEGORIES.flatMap((category) => {
        const key = FLAG_KEY[category];
        if (v.consent![key] === link.consent[key]) return [];
        return [
          v.consent![key]
            ? {
                category,
                action: "GRANT" as const,
                versionId: v.consentVersions?.[key] ?? null,
              }
            : { category, action: "WITHDRAW" as const },
        ];
      });
      if (changes.length) {
        requireCapability(a, "consent.admin");
        const authority = await adultAuthority(a.academyId, v.playerId, tx);
        if (authority && authority !== v.userId)
          throw new DomainError("This player manages their own consent.", 403);
        if (!v.consentMethod)
          throw new DomainError(
            "Say how the consent was received (written or verbal) when changing it.",
            422,
            "METHOD_REQUIRED",
          );
        if (changes.some((c) => c.action === "GRANT") && !v.evidenceRef)
          throw new DomainError(
            "Recording consent on someone's behalf needs a reference to the evidence (for example a form number).",
            422,
            "EVIDENCE_REQUIRED",
          );
        await recordConsentChanges(tx, a, link, {
          changes,
          method: v.consentMethod,
          evidenceRef: v.evidenceRef,
        });
      }
    }
    return { ok: true };
  });
}
export async function saveConsent(a: Actor, input: unknown) {
  if (!family(a))
    throw new DomainError(
      "Use guardian-link management for staff changes.",
      403,
    );
  const v = z
    .object({
      playerId: z.string(),
      consent: z.object({
        portal: z.boolean(),
        email: z.boolean(),
        whatsapp: z.boolean(),
      }),
    })
    .parse(input);
  void v;
  // Recorded as individual, versioned decisions by the consent module (the single writer).
  return decideFlagTargets(a, input);
}
