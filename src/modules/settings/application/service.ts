import { z } from "zod";
import { and, eq, ne, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { config } from "../../../shared/config";
import { database } from "../../../infrastructure/database/client";
import { installTemporaryCredential } from "../../identity/credentials";
import { passwordProblem } from "../../identity/password-policy";
import { clearSelections } from "../../identity/active-academy";
import { recordSecurityEvent } from "../../identity/security-events";
import { generateTemporaryPassword } from "../../identity/temporary-password";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { PLAYER_LOGIN_ROLE, STORED_ROLES, requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import {
  unit,
  history,
  expectVersion,
  type Tx,
} from "../../academy/application/access";
import { type OwnerChange, verifyOwnerMfaStepUp } from "../../identity/owner-step-up";
import { defaultSettings } from "../../academy/domain/types";
import { LOGO_MAX_DATA_URL, checkLogo } from "../domain/logo";
import { CURRENCY_CODES } from "../../fees/domain/money";
import { assertCurrencyChangeAllowed } from "../../fees/application/currency";
import {
  canCoach,
  coachConstraintError,
  handOverCoaching,
  lockedMembership,
} from "./coach-assignments";
/**
 * Runs a settings unit and reports the database's own refusals as domain errors: the coach-assignment triggers
 * (migration 0011) and the last-active-owner triggers (migration 0013).
 */
async function guarded<T>(work: Promise<T>) {
  try {
    return await work;
  } catch (error) {
    throw coachConstraintError(error) ?? ownerConstraintError(error) ?? error;
  }
}
const LAST_OWNER_MESSAGE = "Cannot remove the last active owner of the academy.";
/**
 * RC-3 (F-03): the database backstop of S-2. Migration 0013's triggers raise SQLSTATE 23514 with a message starting
 * "OWNER_REQUIRED:" when a commit would leave an academy without an active owner; this is the same refusal as
 * assertAnotherActiveOwner, so it is reported the same way (409 LAST_OWNER). Only that exact pair is translated:
 * any other check_violation (role CHECK, coach triggers, payment limits) and any other error is left as it is.
 * The driver's error may arrive directly (a deferred trigger fails at COMMIT) or wrapped as a query error's cause.
 */
export function ownerConstraintError(error: unknown) {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (code === "23514" && typeof message === "string" && message.startsWith("OWNER_REQUIRED:"))
      return new DomainError(LAST_OWNER_MESSAGE, 409, "LAST_OWNER");
  }
  return null;
}
export async function saveSettings(a: Actor, input: unknown) {
  requireCapability(a, "academy.settings");
  const v = z
    .object({
      version: z.number().int(),
      name: z.string().trim().min(2).max(120),
      timezone: z.string().max(80),
      country: z.enum(["IN", "US"]),
      currency: z.enum(CURRENCY_CODES),
      colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      policy: z.string().max(4000),
      retentionDays: z.number().int().min(30).max(3650),
      features: z.object({
        reports: z.boolean(),
        nutrition: z.boolean(),
        communications: z.boolean(),
        manualVideo: z.boolean(),
      }),
      // The academy profile. Left out = unchanged; an empty string clears it.
      city: z.string().trim().max(80).optional(),
      contactEmail: z.union([z.literal(""), z.string().trim().email().max(254)]).optional(),
      about: z.string().trim().max(250).optional(),
      // A PNG data URL replaces the logo, null removes it, left out keeps it. The bytes are checked below.
      logoData: z.union([z.string().max(LOGO_MAX_DATA_URL), z.null()]).optional(),
    })
    .parse(input);
  try {
    new Intl.DateTimeFormat("en", { timeZone: v.timezone });
  } catch {
    throw new DomainError("Choose a valid IANA timezone.");
  }
  if (typeof v.logoData === "string") {
    const checked = checkLogo(v.logoData);
    if (!checked.ok) throw new DomainError(checked.message, 400, "LOGO_INVALID");
  }
  return unit(a, async (tx) => {
    const [old] = await tx
      .select()
      .from(t.academySettings)
      .where(eq(t.academySettings.academyId, a.academyId));
    expectVersion(old?.version ?? 1, v.version);
    // Switching the billing currency must not leave existing money records in a currency the
    // academy no longer uses. Saving any other setting is unaffected.
    if (v.currency !== (old?.data ?? defaultSettings).currency)
      await assertCurrencyChangeAllowed(tx, a.academyId, v.currency);
    const [plan] = await tx
      .select()
      .from(t.entitlements)
      .where(eq(t.entitlements.academyId, a.academyId));
    for (const [key, on] of Object.entries(v.features))
      if (on && !plan?.data[key])
        throw new DomainError(
          "This capability is locked by the subscription. Academy roles cannot grant it.",
          403,
        );
    const version = (old?.version ?? 1) + 1;
    // Profile fields this request leaves out keep what is stored; an empty value clears one.
    const keep = <K extends "city" | "contactEmail" | "about">(key: K, given: string | undefined) => {
      const value = given === undefined ? old?.data[key] : given;
      return value ? { [key]: value } : {};
    };
    const logo = v.logoData === undefined ? old?.data.logoData : (v.logoData ?? undefined);
    const data = {
      ...defaultSettings,
      ...keep("city", v.city),
      ...keep("contactEmail", v.contactEmail),
      ...keep("about", v.about),
      ...(logo ? { logoData: logo } : {}),
      country: v.country,
      currency: v.currency,
      colour: v.colour,
      policy: v.policy,
      retentionDays: v.retentionDays,
      features: v.features,
    };
    const logoChange = v.logoData === undefined ? "kept" : v.logoData === null ? (old?.data.logoData ? "removed" : "none") : "changed";
    await tx
      .insert(t.academySettings)
      .values({ academyId: a.academyId, version, data })
      .onConflictDoUpdate({
        target: t.academySettings.academyId,
        set: { version, data },
      });
    await tx
      .update(t.academies)
      .set({ name: v.name, timezone: v.timezone })
      .where(eq(t.academies.id, a.academyId));
    // The history keeps what changed, not the picture itself (a logo is up to 200 KB and would be copied on every save).
    const { logoData: _stored, ...historic } = data as typeof data & { logoData?: string };
    void _stored;
    await history(tx, a, "academy-settings", a.academyId, version, {
      name: v.name,
      timezone: v.timezone,
      ...historic,
      logo: logoChange,
    });
    return { version };
  });
}
export async function saveBranch(a: Actor, input: unknown) {
  requireCapability(a, "academy.structure");
  const v = z
    .object({
      id: z.string().optional(),
      name: z.string().trim().min(2).max(120),
    })
    .parse(input);
  return unit(a, async (tx) => {
    const id = v.id ?? crypto.randomUUID();
    if (v.id) {
      const [old] = await tx
        .update(t.branches)
        .set({ name: v.name })
        .where(
          and(eq(t.branches.academyId, a.academyId), eq(t.branches.id, id)),
        )
        .returning();
      if (!old) throw new DomainError("Branch not found.", 404);
    } else
      await tx
        .insert(t.branches)
        .values({ id, academyId: a.academyId, name: v.name });
    await tx
      .insert(t.audit)
      .values({
        id: crypto.randomUUID(),
        academyId: a.academyId,
        actorId: a.id,
        entityId: id,
        version: 1,
        action: "branch-save",
        detail: {},
      });
    return { id };
  });
}
export async function saveBatch(a: Actor, input: unknown) {
  requireCapability(a, "academy.structure");
  const v = z
    .object({
      id: z.string().optional(),
      name: z.string().trim().min(2).max(120),
      branchId: z.string(),
      coachId: z.string(),
    })
    .parse(input);
  return guarded(unit(a, async (tx) => {
    const [branch] = await tx
      .select()
      .from(t.branches)
      .where(
        and(
          eq(t.branches.academyId, a.academyId),
          eq(t.branches.id, v.branchId),
        ),
      );
    // Locked: the coach's access cannot be switched off before this assignment commits.
    const coach = await lockedMembership(tx, a.academyId, v.coachId);
    if (!branch || !canCoach(coach))
      throw new DomainError(
        "Choose an academy branch and active coaching staff member.",
      );
    const id = v.id ?? crypto.randomUUID();
    if (v.id) {
      const [saved] = await tx
        .update(t.batches)
        .set({ name: v.name, branchId: v.branchId, coachId: v.coachId })
        .where(and(eq(t.batches.academyId, a.academyId), eq(t.batches.id, id)))
        .returning();
      if (!saved) throw new DomainError("Batch not found.", 404);
    } else
      await tx
        .insert(t.batches)
        .values({
          id,
          academyId: a.academyId,
          name: v.name,
          branchId: v.branchId,
          coachId: v.coachId,
        });
    await tx
      .insert(t.audit)
      .values({
        id: crypto.randomUUID(),
        academyId: a.academyId,
        actorId: a.id,
        entityId: id,
        action: "batch-save",
        version: 1,
        detail: {},
      });
    return { id };
  }));
}
/**
 * Whether a member change grants or removes OWNER (TD-1), and which. Any change to the role or the
 * active flag of a membership that is or becomes OWNER counts, including reactivating or
 * deactivating an owner and creating an owner account; a rename alone does not.
 */
export function ownerChangeKind(
  old: { role: string; active: boolean } | null,
  next: { role: string; active: boolean },
  creating: boolean,
): OwnerChange | null {
  if (creating) return next.role === "OWNER" ? "GRANT" : null;
  if (!old) return null;
  if (old.role !== "OWNER" && next.role !== "OWNER") return null;
  if (old.role === next.role && old.active === next.active) return null;
  // Becoming OWNER, or an owner membership being switched (back) on, grants; anything else that
  // touches an owner membership (demotion, deactivation) removes.
  return next.role === "OWNER" && (next.active || old.role !== "OWNER") ? "GRANT" : "REVOKE";
}
/** S-2: refuses a change that would leave the academy with no active owner (409 LAST_OWNER). */
export async function assertAnotherActiveOwner(tx: Tx, academyId: string, excludingUserId: string) {
  const [remaining] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(t.memberships)
    .where(
      and(
        eq(t.memberships.academyId, academyId),
        eq(t.memberships.role, "OWNER"),
        eq(t.memberships.active, true),
        ne(t.memberships.userId, excludingUserId),
      ),
    );
  if (!remaining || remaining.n === 0)
    throw new DomainError(LAST_OWNER_MESSAGE, 409, "LAST_OWNER");
}
export async function saveMember(a: Actor, input: unknown) {
  requireCapability(a, "members.manage");
  const v = z
    .object({
      id: z.string().optional(),
      name: z.string().trim().min(2).max(120),
      email: z.email(),
      // Exactly one of the eight stored roles (one designation per membership, D3).
      role: z.enum(STORED_ROLES),
      active: z.boolean(),
      // Optional: when blank the server generates a random temporary password.
      initialPassword: z.string().max(128).optional().default(""),
      professionalAttestation: z.string().max(500),
      // Stage 5D: who takes over batches, upcoming sessions and upcoming events when this change
      // removes a coach's coaching access (deactivation, or a role that cannot coach).
      replacementCoachId: z.string().max(200).nullish(),
      // RC-2 (TD-1): required only when the change grants or removes OWNER; checked by
      // verifyOwnerMfaStepUp, never stored or logged.
      ownerPassword: z.unknown().optional(),
      mfaCode: z.unknown().optional(),
    })
    .parse(input);
  // Players are under 18 and do not sign in: only staff and parents/guardians have accounts.
  if (v.role === PLAYER_LOGIN_ROLE)
    throw new DomainError("Players do not have their own login: they are under 18, so a parent or guardian signs in for them.", 422, "ADULT_PLAYERS_NOT_SUPPORTED");
  if (
    v.role === "NUTRITION_PRO" &&
    v.professionalAttestation.trim().length < 10
  )
    throw new DomainError(
      "Record professional authorisation before assigning nutrition review access.",
    );
  if (v.id === a.id && (v.role !== "OWNER" || !v.active))
    throw new DomainError(
      "Use another owner account to change your own owner membership.",
    );
  // RC-2 (TD-1/TD-2): a change that grants or removes OWNER needs the acting owner's password and a
  // second factor, verified before any lock is taken. The decision is made again under the lock
  // below; if the member changed in between so that the step-up is now needed, the save is refused.
  const before = v.id
    ? (
        await database()
          .select({ role: t.memberships.role, active: t.memberships.active })
          .from(t.memberships)
          .where(and(eq(t.memberships.academyId, a.academyId), eq(t.memberships.userId, v.id)))
      )[0]
    : undefined;
  const touchesOwner = (old: { role: string; active: boolean } | undefined) =>
    ownerChangeKind(old ?? null, { role: v.role, active: v.active }, !v.id);
  const plannedChange = touchesOwner(before);
  const stepUp = plannedChange
    ? await verifyOwnerMfaStepUp({
        actorId: a.id,
        academyId: a.academyId,
        ownerPassword: v.ownerPassword,
        mfaCode: v.mfaCode,
        change: plannedChange,
        targetUserId: before ? v.id! : null,
      })
    : null;
  // A new login always starts with a temporary password (72 hours, replaced at first sign-in).
  // The owner may type one for a hand-over; otherwise a random one is generated and returned once.
  const provisioning = v.id
    ? null
    : (() => {
        const typed = v.initialPassword.length > 0;
        const password = typed ? v.initialPassword : generateTemporaryPassword();
        const problem = typed
          ? passwordProblem(password, { email: v.email, name: v.name })
          : null;
        if (problem)
          throw new DomainError(
            `Temporary password not accepted. ${problem} Leave it blank to generate a secure one.`,
          );
        return { password, generated: !typed };
      })();
  const passwordHash = provisioning
    ? await hashPassword(provisioning.password)
    : null;
  let temporary: Date | null = null;
  return guarded(unit(a, async (tx) => {
    let renamed = false;
    let handover: Awaited<ReturnType<typeof handOverCoaching>> | null = null;
    const id = v.id ?? crypto.randomUUID();
    let ownerEvent: { change: OwnerChange; fromRole: string | null; fromActive: boolean | null } | null =
      null;
    if (v.id) {
      const old = await lockedMembership(tx, a.academyId, id);
      if (!old) throw new DomainError("Member not found.", 404);
      const change = touchesOwner(old);
      if (change && !stepUp)
        throw new DomainError(
          "Membership changed while this was being processed. Review the member and try again.",
          409,
          "MEMBERSHIP_CHANGED",
        );
      // S-2: an academy is never left without an active owner (the database adds a deferred
      // backstop in migration 0013). Under the academy lock, after lockActor confirmed the acting
      // owner, this is defence in depth: the actor is itself an active owner other than the target.
      if (old.role === "OWNER" && old.active && !(v.role === "OWNER" && v.active))
        await assertAnotherActiveOwner(tx, a.academyId, id);
      if (change) ownerEvent = { change, fromRole: old.role, fromActive: old.active };
      // Losing coaching access (deactivation or a non-coaching role) hands the person's open
      // coaching work to a replacement first, in this transaction; history stays as it is.
      if (canCoach(old) && !canCoach({ active: v.active, role: v.role }))
        handover = await handOverCoaching(tx, a, {
          coachId: id,
          replacementId: v.replacementCoachId ?? null,
          reason: v.active ? "ROLE_CHANGE" : "DEACTIVATION",
        });
      await tx
        .update(t.memberships)
        .set({ role: v.role, active: v.active })
        .where(
          and(
            eq(t.memberships.academyId, a.academyId),
            eq(t.memberships.userId, id),
          ),
        );
      // Account-security consequences of the change. The person's login is theirs, shared by every academy they
      // belong to, so switching them off HERE must not cut them off THERE:
      //   - every session's choice of this academy is forgotten (so none can keep working in it), and
      //   - their sessions end only when this was their LAST active membership (nothing is left to work in; with a
      //     single academy this is exactly the former behaviour).
      // The application already refuses a switched-off member on every request, whatever sessions survive.
      // Reactivation changes no credential and brings no choice back.
      if (old.active && !v.active) {
        await clearSelections(tx, a.academyId, id);
        const [remaining] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(t.memberships)
          .where(and(eq(t.memberships.userId, id), eq(t.memberships.active, true)));
        const endedAll = (remaining?.n ?? 0) === 0;
        const ended = endedAll
          ? await tx.delete(t.session).where(eq(t.session.userId, id)).returning({ id: t.session.id })
          : [];
        await recordSecurityEvent(tx, {
          event: "MEMBER_DEACTIVATED",
          academyId: a.academyId,
          actorId: a.id,
          targetUserId: id,
          // Counts and a flag only: nothing about any other academy the person belongs to.
          detail: { revokedSessions: ended.length, endedAllSessions: endedAll },
        });
      } else if (!old.active && v.active)
        await recordSecurityEvent(tx, {
          event: "MEMBER_REACTIVATED",
          academyId: a.academyId,
          actorId: a.id,
          targetUserId: id,
        });
      if (old.role !== v.role)
        await recordSecurityEvent(tx, {
          event: "MEMBER_ROLE_CHANGED",
          academyId: a.academyId,
          actorId: a.id,
          targetUserId: id,
          detail: { fromRole: old.role, toRole: v.role },
        });
      // How THIS academy shows the person is academy data (it is copied onto approvals as the approver's name), so an
      // owner's rename writes only the membership's display name, and it is recorded. The person's own name
      // (app_user.name) belongs to their global identity and is never rewritten by an academy: it may be shared with
      // other academies that show something different. A name equal to the person's own is stored as "no override".
      // Names are not written to the log (identifiers only); records already approved keep the name they were
      // approved under.
      const [shown] = await tx
        .select({ own: t.user.name, display: t.memberships.displayName })
        .from(t.memberships)
        .innerJoin(t.user, eq(t.user.id, t.memberships.userId))
        .where(and(eq(t.memberships.academyId, a.academyId), eq(t.memberships.userId, id)));
      renamed = !!shown && (shown.display ?? shown.own) !== v.name;
      if (shown)
        await tx
          .update(t.memberships)
          .set({ displayName: v.name === shown.own ? null : v.name })
          .where(and(eq(t.memberships.academyId, a.academyId), eq(t.memberships.userId, id)));
      if (renamed)
        await recordSecurityEvent(tx, {
          event: "MEMBER_RENAMED",
          academyId: a.academyId,
          actorId: a.id,
          targetUserId: id,
        });
    } else {
      const [existing] = await tx
        .select()
        .from(t.user)
        .where(eq(t.user.email, v.email.toLowerCase()));
      if (existing)
        throw new DomainError(
          "Email already has an account. To bring an existing account into this academy, invite it (Settings > Invitations): the person accepts the invitation themselves.",
          409,
        );
      await tx
        .insert(t.user)
        .values({
          id,
          name: v.name,
          email: v.email.toLowerCase(),
          emailVerified: false,
        });
      const issued = await installTemporaryCredential(tx, {
        userId: id,
        passwordHash: passwordHash!,
        source: "MEMBER_CREATED",
        issuedBy: a.id,
        secret: config().BETTER_AUTH_SECRET,
        createAccount: true,
      });
      temporary = issued.expiresAt;
      await recordSecurityEvent(tx, {
        event: "MEMBER_CREDENTIAL_ISSUED",
        academyId: a.academyId,
        actorId: a.id,
        targetUserId: id,
        detail: { generated: provisioning!.generated, expiresAt: issued.expiresAt.toISOString() },
      });
      await tx
        .insert(t.memberships)
        .values({
          academyId: a.academyId,
          userId: id,
          role: v.role,
          active: v.active,
        });
      const change = touchesOwner(undefined);
      if (change && !stepUp)
        throw new DomainError("Owner confirmation is missing.", 409, "MEMBERSHIP_CHANGED");
      if (change) ownerEvent = { change, fromRole: null, fromActive: null };
    }
    if (ownerEvent)
      await recordSecurityEvent(tx, {
        event: ownerEvent.change === "GRANT" ? "OWNER_GRANTED" : "OWNER_REVOKED",
        academyId: a.academyId,
        actorId: a.id,
        targetUserId: id,
        detail: {
          targetUserId: id,
          method: stepUp!.method,
          fromRole: ownerEvent.fromRole,
          toRole: v.role,
          fromActive: ownerEvent.fromActive,
          toActive: v.active,
        },
      });
    await tx
      .insert(t.audit)
      .values({
        id: crypto.randomUUID(),
        academyId: a.academyId,
        actorId: a.id,
        entityId: id,
        action: "member-save",
        version: 1,
        detail: {
          role: v.role,
          active: v.active,
          ...(renamed ? { nameChanged: true } : {}),
          ...(handover?.replacementCoachId
            ? {
                coachHandover: {
                  replacementCoachId: handover.replacementCoachId,
                  batches: handover.batches.length,
                  sessions: handover.sessions.length,
                  events: handover.events.length,
                },
              }
            : {}),
          professionalAttestation:
            v.role === "NUTRITION_PRO" ? v.professionalAttestation : undefined,
        },
      });
    return {
      id,
      ...(handover?.replacementCoachId
        ? {
            reassigned: {
              replacementCoachId: handover.replacementCoachId,
              batches: handover.batches.length,
              sessions: handover.sessions.length,
              events: handover.events.length,
            },
          }
        : {}),
      ...(temporary
        ? {
            temporaryPasswordExpiresAt: temporary.toISOString(),
            // Shown once, only when the server generated it; the owner delivers it privately.
            ...(provisioning?.generated
              ? { temporaryPassword: provisioning.password }
              : {}),
          }
        : {}),
    };
  }));
}

/**
 * Who is signed in and which academy they are in, for the application shell (name, role, academy name and the
 * academy's own accent colour). Read-only, scoped to the actor's academy, and free of any other record.
 */
export async function identityView(a: Actor) {
  const [row] = await database()
    .select()
    .from(t.academySettings)
    .where(eq(t.academySettings.academyId, a.academyId));
  const colour = row?.data?.colour;
  return {
    role: a.role,
    name: a.name,
    userId: a.id,
    academy: {
      name: a.academyName,
      accent: typeof colour === "string" && /^#[0-9a-fA-F]{6}$/.test(colour) ? colour.toLowerCase() : null,
      // Where the sidebar finds the logo (the version changes the address, so a new logo shows at once). Null: none.
      logo: row?.data?.logoData ? `/api/academy/logo?v=${row.version}` : null,
    },
  };
}
/** The academy's own logo (the signed-in person's academy, never one named by the request), or null when it has none. */
export async function academyLogo(a: Actor) {
  const [row] = await database().select().from(t.academySettings).where(eq(t.academySettings.academyId, a.academyId));
  if (!row?.data?.logoData) return null;
  const checked = checkLogo(row.data.logoData);
  return checked.ok ? { bytes: checked.bytes, etag: `"${a.academyId}-${row.version}"` } : null;
}
