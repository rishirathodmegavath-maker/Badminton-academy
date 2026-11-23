import { and, eq } from "drizzle-orm";
import { shownName } from "./membership";
import { database } from "../../infrastructure/database/client";
import * as t from "../../infrastructure/database/schema";
import { activeMemberships } from "./membership";
import { can, rolesWith } from "./authority";
import {
  DEFAULT_REQUIRED_ROLES,
  ROLE_NAMES,
  effectiveLevel,
  levelFor,
  mfaPolicy,
  normaliseRoles,
  stricterMode,
  type Env,
  type MfaLevel,
  type MfaMode,
} from "./mfa-policy";
import { academyMfaPolicyOf } from "./mfa-policy-store";
import { recordSecurityEvent } from "./security-events";
type Db = ReturnType<typeof database>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/**
 * Administration of the two-factor policy: what an academy's owner and admins may see (policy,
 * readiness for enforcement, recovery readiness) and the one guarded way to change it.
 *
 * Safety model (each rule is covered by tests/mfa-policy.test.ts):
 *  - OWNER and ADMIN may read; only an OWNER may change, after re-entering their password, with a
 *    written reason, inside a transaction that re-checks their authority under the academy lock.
 *  - The academy policy can only RAISE what the deployment sets; the stricter wins.
 *  - A role becomes REQUIRED only after it was at WARN (people have notice), and only with the
 *    changing owner already enrolled and the lock-out risk acknowledged. Lowering is always allowed.
 *  - Those people must also have had MFA_GRACE_DAYS full days of warning in this academy. This is
 *    enforced here (GRACE_PERIOD_ACTIVE); acknowledging the risk does not skip it. Only an owner may
 *    skip it, explicitly (`emergencyOverride`), with a written reason, recorded as its own security event.
 *  - Required never means locked out: unenrolled people can still sign in and enrol.
 *  - Output names members and counts; it never contains authenticator material, e-mail addresses
 *    or recovery codes (this module never reads them).
 */
/** Derived from the authority module (RC-1); kept under its old name. */
export const MFA_POLICY_VIEWERS = rolesWith("security.mfa.view");
export const MFA_POLICY_EDITORS = rolesWith("security.mfa.edit");
/**
 * The least notice (complete days at the warning stage, in this academy) people must have had
 * before a role may become required. Enforced by changeMfaPolicy, not merely advised.
 */
export const MFA_GRACE_DAYS = 14;
const GRACE_MS = MFA_GRACE_DAYS * 86_400_000;
/** An emergency override must say why, in words: this is the audit trail for skipping the notice. */
export function meaningfulReason(text: string, ordinary?: string) {
  const trimmed = text.trim();
  const words = trimmed.toLowerCase().match(/\p{L}{2,}/gu) ?? [];
  return (
    trimmed.length >= 20 &&
    words.length >= 4 &&
    new Set(words).size >= 4 &&
    trimmed.toLowerCase() !== (ordinary ?? "").trim().toLowerCase()
  );
}
type Stored = { mode: MfaMode; roles: string[]; warnSince: Date | null } | null;
/**
 * Has this academy's own warning stage covered `roles` for the full grace period? The clock is the
 * academy's `warnSince`, which only ever moves later while a role is at warn (see warnSinceFor), so
 * it is never later than any role's real notice. A warning that comes only from the server-wide
 * setting has no start time here and does not count: the academy has to start its own.
 */
export function graceStatus(before: Stored, roles: string[], now: Date) {
  const clock =
    before?.mode === "warn" &&
    before.warnSince &&
    roles.every((r) => before.roles.includes(r))
      ? before.warnSince
      : null;
  if (!clock) return { started: null, eligibleAt: null, met: false, elapsedDays: null };
  const eligibleAt = new Date(clock.getTime() + GRACE_MS);
  return {
    started: clock,
    eligibleAt,
    met: now.getTime() >= eligibleAt.getTime(),
    elapsedDays: Math.max(0, Math.floor((now.getTime() - clock.getTime()) / 86_400_000)),
  };
}
/**
 * When the warning stage began for what is stored after a change. Entering warn (from off or from
 * required) starts the clock; staying at warn keeps it only if no role was added (a role added later
 * has had less notice, so the clock restarts); required keeps the last start; off clears it. It can
 * move later but never earlier, so no ordinary change shortens a grace period.
 */
function warnSinceFor(
  mode: MfaMode,
  roles: string[],
  before: Stored,
  now: Date,
): Date | null {
  if (mode === "off") return null;
  if (mode === "enforce") return before?.warnSince ?? null;
  return before?.mode === "warn" &&
    before.warnSince &&
    roles.every((r) => before.roles.includes(r))
    ? before.warnSince
    : now;
}
export class MfaAdminError extends Error {
  constructor(
    readonly status: "FORBIDDEN" | "BAD_REQUEST" | "CONFLICT",
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
type Finding = { code: string; message: string };
export async function mfaOverview(
  db: Pick<Db, "select">,
  viewer: { id: string; academyId: string; role: string },
  env: Env = process.env,
  now = new Date(),
) {
  const system = mfaPolicy(env);
  const academy = await academyMfaPolicyOf(viewer.academyId, db);
  const members = await db
    .select({
      id: t.user.id,
      name: shownName,
      role: t.memberships.role,
      enrolled: t.user.twoFactorEnabled,
      temporary: t.temporaryCredential.userId,
    })
    .from(t.memberships)
    .innerJoin(t.user, eq(t.user.id, t.memberships.userId))
    .leftJoin(
      t.temporaryCredential,
      eq(t.temporaryCredential.userId, t.user.id),
    )
    .where(
      and(
        eq(t.memberships.academyId, viewer.academyId),
        eq(t.memberships.active, true),
      ),
    );
  const levelOf = (role: string): MfaLevel =>
    effectiveLevel(system, academy, role);
  const roles = ROLE_NAMES.map((role) => {
    const level = levelOf(role);
    const here = members.filter((m) => m.role === role);
    const fromSystem = levelFor(system, role);
    const fromAcademy = levelFor(academy, role);
    return {
      role,
      level,
      // Who is responsible for the level: the deployment, this academy's owner, or neither.
      source:
        level === "optional"
          ? ("none" as const)
          : fromSystem === level
            ? ("deployment" as const)
            : ("academy" as const),
      members: here.length,
      enrolled: here.filter((m) => m.enrolled).length,
    };
  });
  const affected = members.filter((m) => levelOf(m.role) !== "optional");
  const needsAction = affected
    .filter((m) => !m.enrolled)
    .map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      level: levelOf(m.role),
      hasTemporaryPassword: !!m.temporary,
    }));
  const owners = members.filter((m) => m.role === "OWNER");
  const candidates: string[] = roles.filter((r) => r.level === "warn").map((r) => r.role);
  const viewerEnrolled =
    members.find((m) => m.id === viewer.id)?.enrolled ?? false;
  const blockers: Finding[] = [];
  const warnings: Finding[] = [];
  if (!candidates.length)
    blockers.push({
      code: "NOTHING_AT_WARN",
      message:
        "No role is in the warning stage yet. Roles become required only after a warning period.",
    });
  if (!viewerEnrolled)
    blockers.push({
      code: "ACTOR_NOT_ENROLLED",
      message:
        "You have not set up two-factor authentication yourself. Do that first so you can verify the rollout.",
    });
  const pending = needsAction.filter((m) => candidates.includes(m.role));
  if (pending.length)
    warnings.push({
      code: "UNENROLLED_ACCOUNTS",
      message: `${pending.length} account(s) in the warning stage have not enrolled. They could still sign in, but only to set it up.`,
    });
  if (pending.some((m) => m.hasTemporaryPassword))
    warnings.push({
      code: "TEMPORARY_PASSWORDS",
      message:
        "Some of them still hold a temporary password and must replace it before they can enrol.",
    });
  if (owners.length < 2)
    warnings.push({
      code: "SINGLE_OWNER",
      message:
        "This academy has one active owner. If that owner loses their authenticator and recovery codes, only the server operator can recover the account (npm run auth:recover).",
    });
  else if (owners.filter((o) => o.enrolled).length < 2)
    warnings.push({
      code: "OWNER_ENROLMENT",
      message:
        "Fewer than two owners are enrolled. Enrol a second owner so one can always help the other.",
    });
  const grace = graceStatus(academy, academy?.roles ?? [], now);
  if (candidates.length && !grace.met)
    blockers.push({
      code: "GRACE_PERIOD_ACTIVE",
      message: grace.eligibleAt
        ? `People must have ${MFA_GRACE_DAYS} full days of warning first. This academy can make it required from ${grace.eligibleAt.toISOString()}. Only an owner can skip this, as a recorded emergency.`
        : `This academy has not started its own warning stage for these roles, so the ${MFA_GRACE_DAYS}-day notice has not begun. Start it under Warning first.`,
    });
  return {
    stage: stricterMode(system.mode, academy?.mode ?? "off"),
    deployment: { mode: system.mode, roles: system.roles },
    academy: {
      mode: academy?.mode ?? ("off" as MfaMode),
      roles: academy?.roles ?? [...DEFAULT_REQUIRED_ROLES],
      warnSince: academy?.warnSince?.toISOString() ?? null,
      updatedAt: academy?.updatedAt.toISOString() ?? null,
    },
    grace: {
      days: MFA_GRACE_DAYS,
      eligibleAt: grace.eligibleAt?.toISOString() ?? null,
      met: grace.met,
    },
    canEdit: can(viewer, "security.mfa.edit"),
    roles,
    totals: {
      accounts: affected.length,
      enrolled: affected.length - needsAction.length,
      needingAction: needsAction.length,
    },
    needsAction,
    recovery: {
      activeOwners: owners.length,
      enrolledOwners: owners.filter((o) => o.enrolled).length,
      singleOwner: owners.length < 2,
    },
    enforcement: { ready: !blockers.length, blockers, warnings },
  };
}
export type MfaOverview = Awaited<ReturnType<typeof mfaOverview>>;
export type MfaPolicyChange = {
  mode: MfaMode;
  roles: string[];
  reason: string;
  acknowledgeRisk?: boolean;
  /** Skip the grace period. Only meaningful, and only honoured, with `emergencyReason`. */
  emergencyOverride?: boolean;
  emergencyReason?: string;
};
/**
 * Applies a policy change for the academy. Must run inside the caller's transaction, after the
 * owner has re-authenticated. Returns what changed so the caller can report it.
 */
export async function changeMfaPolicy(
  tx: Tx,
  actor: { id: string; academyId: string },
  input: MfaPolicyChange,
  env: Env = process.env,
  now = new Date(),
) {
  // Same lock as member changes and resets: authority is decided against the state this write sees.
  await tx
    .select()
    .from(t.academies)
    .where(eq(t.academies.id, actor.academyId))
    .for("update");
  const asDb = tx as unknown as Db;
  // The person may hold several memberships: it is the one in the academy being changed that counts.
  const current = (await activeMemberships(actor.id, asDb)).find((m) => m.academyId === actor.academyId);
  if (!current || !can(current, "security.mfa.edit"))
    throw new MfaAdminError(
      "FORBIDDEN",
      "Only an academy owner can change the two-factor policy.",
      "NOT_OWNER",
    );
  const system = mfaPolicy(env);
  const before = await academyMfaPolicyOf(actor.academyId, tx);
  let roles: string[];
  try {
    roles = normaliseRoles(input.roles);
  } catch (error) {
    throw new MfaAdminError("BAD_REQUEST", (error as Error).message, "BAD_ROLES");
  }
  if (input.mode !== "off" && !roles.length)
    throw new MfaAdminError(
      "BAD_REQUEST",
      "Choose at least one role for this stage.",
      "ROLES_REQUIRED",
    );
  const beforeMode: MfaMode = before?.mode ?? "off";
  const unchanged =
    beforeMode === input.mode &&
    (input.mode === "off" ||
      (before !== null &&
        before.roles.length === roles.length &&
        before.roles.every((r) => roles.includes(r))));
  if (unchanged) return { changed: false as const };
  let emergency: { reason: string; daysElapsed: number | null } | null = null;
  const newlyRequired = ROLE_NAMES.filter(
    (role) =>
      effectiveLevel(system, { mode: input.mode, roles }, role) ===
        "required" && effectiveLevel(system, before, role) !== "required",
  );
  if (newlyRequired.length) {
    const skipped = newlyRequired.filter(
      (role) => effectiveLevel(system, before, role) !== "warn",
    );
    if (skipped.length)
      throw new MfaAdminError(
        "CONFLICT",
        `Put ${skipped.join(", ")} in the warning stage first, so people have notice before it becomes required.`,
        "WARN_FIRST",
      );
    const [self] = await tx
      .select({ enrolled: t.user.twoFactorEnabled })
      .from(t.user)
      .where(eq(t.user.id, actor.id));
    if (!self?.enrolled)
      throw new MfaAdminError(
        "CONFLICT",
        "Set up two-factor authentication on your own account before making it required for others.",
        "ACTOR_NOT_ENROLLED",
      );
    // The grace period is a rule, not advice: ordinary acknowledgement never skips it. Only an
    // explicit owner emergency override, with a real reason, may (the caller has already proven the
    // actor is this academy's owner and re-entered their password).
    const grace = graceStatus(before, newlyRequired, now);
    if (!grace.met) {
      if (input.emergencyOverride !== true)
        throw new MfaAdminError(
          "CONFLICT",
          grace.eligibleAt
            ? `People must have ${MFA_GRACE_DAYS} full days of warning before a role becomes required. This can be done from ${grace.eligibleAt.toISOString()}.`
            : `This academy's own warning stage has not covered ${newlyRequired.join(", ")} yet, so the ${MFA_GRACE_DAYS}-day notice has not begun.`,
          "GRACE_PERIOD_ACTIVE",
        );
      if (!meaningfulReason(input.emergencyReason ?? "", input.reason))
        throw new MfaAdminError(
          "BAD_REQUEST",
          "An emergency override needs its own written reason (at least 20 characters, in words) explaining why people cannot have the full warning period.",
          "EMERGENCY_REASON_REQUIRED",
        );
      emergency = {
        reason: (input.emergencyReason ?? "").trim(),
        daysElapsed: grace.elapsedDays,
      };
    }
    if (input.acknowledgeRisk !== true)
      throw new MfaAdminError(
        "CONFLICT",
        "Confirm that you have reviewed the enrolment readiness and understand that people who have not enrolled will be limited to setting it up.",
        "ACKNOWLEDGEMENT_REQUIRED",
      );
  }
  const warnSince = warnSinceFor(input.mode, roles, before, now);
  const values = {
    academyId: actor.academyId,
    mode: input.mode,
    roles,
    warnSince,
    updatedBy: actor.id,
    updatedAt: now,
  };
  await tx
    .insert(t.academyMfaPolicy)
    .values(values)
    .onConflictDoUpdate({
      target: t.academyMfaPolicy.academyId,
      set: {
        mode: values.mode,
        roles: values.roles,
        warnSince: values.warnSince,
        updatedBy: values.updatedBy,
        updatedAt: values.updatedAt,
      },
    });
  await recordSecurityEvent(tx, {
    event: "MFA_POLICY_CHANGED",
    academyId: actor.academyId,
    actorId: actor.id,
    detail: {
      fromMode: beforeMode,
      toMode: input.mode,
      fromRoles: before?.roles ?? [],
      roles,
      reason: input.reason,
      ...(emergency ? { emergency: true } : {}),
    },
  });
  if (emergency)
    await recordSecurityEvent(tx, {
      event: "MFA_EMERGENCY_OVERRIDE",
      academyId: actor.academyId,
      actorId: actor.id,
      detail: {
        reason: emergency.reason,
        roles: newlyRequired,
        requiredDays: MFA_GRACE_DAYS,
        ...(emergency.daysElapsed === null
          ? {}
          : { daysElapsed: emergency.daysElapsed }),
      },
    });
  return { changed: true as const, newlyRequired };
}
