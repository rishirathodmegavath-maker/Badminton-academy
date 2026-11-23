import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { database } from "../../infrastructure/database/client";
import * as t from "../../infrastructure/database/schema";
import { config } from "../../shared/config";
import { authorityOf, can } from "./authority";
import { installTemporaryCredential, type Tx } from "./credentials";
import { RecoveryError } from "./operator-recovery";
import { recordSecurityEvent, type SecurityEventName } from "./security-events";
import { generateTemporaryPassword } from "./temporary-password";
/**
 * RC-2: operator restoration of an academy OWNER when the academy has none (TD-5), with the
 * independent second approval the owner chose for PD-5 (2026-11-11).
 *
 * Two people, two commands, no HTTP endpoint:
 *   1. `--restore-owner <email> --reason "..." --yes`  (operator A) checks the TD-5 rules and records a
 *      request. It prints a request ID and a one-time approval code; only a hash of the code is kept.
 *   2. `--approve-owner-restore <request-id> --approval-code <code> --yes`  (operator B, a different
 *      operator identity) re-checks every rule under the academy lock and only then restores ownership.
 *
 * TD-5 rules, checked at both steps:
 *  - the academy has NO active owner (otherwise the normal application is the way);
 *  - the account has exactly one membership (one academy per login, as everywhere else);
 *  - GUARDIAN and ADULT_PLAYER accounts are never eligible;
 *  - FORMER_OWNER first: a deactivated OWNER membership, or an active member whose most recent
 *    MEMBER_ROLE_CHANGED shows fromRole = OWNER;
 *  - ADMINISTRATOR fallback: an active ADMIN, only when the academy has no former-owner candidate;
 *  - a reason of 10 to 500 characters.
 * A request expires after 24 hours, is used at most once, and becomes void after three refused
 * approvals. Every step (request, refused approval, restoration) is a security event in the same
 * transaction as its effect, and those events form a per-academy hash chain (`detail.seq`,
 * `detail.prev`, `detail.hash`) that `verifyRecoveryChain` checks, so editing or removing an earlier
 * recovery event is detectable. The application never updates or deletes security events.
 *
 * Restoration: role OWNER and active, a 72-hour one-use temporary password, every session revoked;
 * an enrolled authenticator is left in place.
 */
export const RESTORE_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_REFUSED_APPROVALS = 3;
const CHAIN_EVENTS = [
  "OPERATOR_OWNER_RESTORE_REQUESTED",
  "OPERATOR_OWNER_RESTORE_DENIED",
  "OPERATOR_OWNER_RESTORED",
] as const satisfies readonly SecurityEventName[];
type ChainEvent = (typeof CHAIN_EVENTS)[number];
export type CandidateType = "FORMER_OWNER" | "ADMINISTRATOR";
/** GUARDIAN and ADULT_PLAYER (the family account types) are never eligible. */
const isFamily = (m: { role: string }) => can(m, "family.portal");
/** STAFF · Administrator (stored ADMIN), decided by the authority module. */
const isAdministrator = (m: { role: string }) => authorityOf(m.role)?.designation === "ADMINISTRATOR";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const normaliseOperator = (operator: string) => operator.trim().toLowerCase().slice(0, 80);
function checkReason(reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length < 10 || trimmed.length > 500)
    throw new RecoveryError("Give a reason of 10 to 500 characters.");
  return trimmed;
}
async function personByEmail(db: Tx | ReturnType<typeof database>, email: string) {
  const [person] = await db
    .select({ id: t.user.id, name: t.user.name, email: t.user.email })
    .from(t.user)
    .where(eq(t.user.email, email.trim().toLowerCase()));
  return person ?? null;
}
/** Latest MEMBER_ROLE_CHANGED per member of the academy (by time, then id). */
async function latestRoleChanges(db: Tx, academyId: string) {
  const rows = await db
    .select({ target: t.securityEvent.targetUserId, detail: t.securityEvent.detail })
    .from(t.securityEvent)
    .where(and(eq(t.securityEvent.academyId, academyId), eq(t.securityEvent.event, "MEMBER_ROLE_CHANGED")))
    .orderBy(desc(t.securityEvent.createdAt), desc(t.securityEvent.id));
  const latest = new Map<string, string | null>();
  for (const row of rows) {
    if (!row.target || latest.has(row.target)) continue;
    const from = (row.detail as { fromRole?: unknown } | null)?.fromRole;
    latest.set(row.target, typeof from === "string" ? from : null);
  }
  return latest;
}
type Membership = typeof t.memberships.$inferSelect;
function isFormerOwner(m: Membership, latest: Map<string, string | null>) {
  if (isFamily(m)) return false;
  if (m.role === "OWNER" && !m.active) return true;
  return m.active && latest.get(m.userId) === "OWNER";
}
/**
 * The TD-5 decision for one account, read in the caller's transaction (which holds the academy lock
 * when it matters). Throws RecoveryError with the operator-facing reason when not eligible.
 */
async function decide(db: Tx, userId: string, academyId?: string) {
  const own = await db.select().from(t.memberships).where(eq(t.memberships.userId, userId));
  if (own.length === 0) throw new RecoveryError("This account has no academy membership.");
  // A person may belong to several academies. The restoration is about ONE of them, so the operator names it; without
  // a name a multi-academy account is ambiguous and nothing is restored.
  if (own.length > 1 && !academyId)
    throw new RecoveryError(
      "This account has memberships in more than one academy: name the academy to restore with --academy <academy id>.",
    );
  const chosen = academyId ? own.filter((m) => m.academyId === academyId) : own;
  if (chosen.length === 0) throw new RecoveryError("This account has no membership in that academy.");
  const target = chosen[0];
  // The person's login is shared by every academy they work in. Restoring ownership of ONE must not replace their
  // password or end their sessions elsewhere, so credentials are left alone while they have another ACTIVE membership.
  const credentialsShared = own.some((m) => m.academyId !== target.academyId && m.active);
  if (isFamily(target))
    throw new RecoveryError("Ineligible account type: guardian and player accounts can never be made owners.");
  const members = await db.select().from(t.memberships).where(eq(t.memberships.academyId, target.academyId));
  const owners = members.filter((m) => m.role === "OWNER" && m.active).length;
  if (owners > 0)
    throw new RecoveryError(
      `Cannot restore owner. Academy already has ${owners} active owner(s). Use the standard application interface to manage memberships.`,
    );
  const latest = await latestRoleChanges(db, target.academyId);
  let candidateType: CandidateType;
  if (isFormerOwner(target, latest)) candidateType = "FORMER_OWNER";
  else if (isAdministrator(target) && target.active) {
    if (members.some((m) => isFormerOwner(m, latest)))
      throw new RecoveryError(
        "Ineligible account: this academy has a former owner, who must be restored instead of an Administrator.",
      );
    candidateType = "ADMINISTRATOR";
  } else
    throw new RecoveryError(
      "Ineligible account: only a former owner, or an active Administrator when the academy has no former owner, can be restored.",
    );
  return { membership: target, candidateType, credentialsShared };
}
const lockAcademy = (tx: Tx, academyId: string) =>
  tx.select().from(t.academies).where(eq(t.academies.id, academyId)).for("update");
/** Canonical JSON (sorted keys) so the chain hash does not depend on key order after a jsonb round trip. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const chainHash = (body: { event: string; academyId: string; targetUserId: string | null; detail: Record<string, unknown> }) =>
  sha256(canonical(body));
async function appendChained(
  tx: Tx,
  event: ChainEvent,
  academyId: string,
  targetUserId: string | null,
  detail: Record<string, unknown>,
) {
  const [last] = await tx
    .select({ detail: t.securityEvent.detail })
    .from(t.securityEvent)
    .where(and(eq(t.securityEvent.academyId, academyId), inArray(t.securityEvent.event, [...CHAIN_EVENTS])))
    .orderBy(desc(sql`(${t.securityEvent.detail}->>'seq')::int`))
    .limit(1);
  const prior = last?.detail as { seq?: number; hash?: string } | undefined;
  const body = { ...detail, seq: (prior?.seq ?? 0) + 1, prev: prior?.hash ?? "GENESIS" };
  const hash = chainHash({ event, academyId, targetUserId, detail: body });
  await recordSecurityEvent(tx, { event, academyId, actorId: null, targetUserId, detail: { ...body, hash } });
}
/** What step 1 would do, without changing anything (the dry run). */
export async function describeOwnerRestore(email: string, academyId?: string) {
  const db = database();
  const person = await personByEmail(db, email);
  if (!person) throw new RecoveryError("No account matches that email address.");
  return db.transaction(async (tx) => {
    const decision = await decide(tx, person.id, academyId);
    const [academy] = await tx.select().from(t.academies).where(eq(t.academies.id, decision.membership.academyId));
    return {
      credentialsShared: decision.credentialsShared,
      name: person.name,
      academy: academy?.name ?? decision.membership.academyId,
      currentRole: decision.membership.role,
      active: decision.membership.active,
      candidateType: decision.candidateType,
    };
  });
}
export async function requestOwnerRestore(input: { email: string; reason: string; operator: string; academyId?: string; now?: Date }) {
  const reason = checkReason(input.reason);
  const operator = normaliseOperator(input.operator);
  if (!operator) throw new RecoveryError("The operator identity is missing.");
  const now = input.now ?? new Date();
  const db = database();
  const person = await personByEmail(db, input.email);
  if (!person) throw new RecoveryError("No account matches that email address.");
  const requestId = crypto.randomUUID();
  // 120 bits; shown once to operator A, who hands it to operator B. Only its hash is stored.
  const approvalCode = randomBytes(15).toString("base64url");
  const expiresAt = new Date(now.getTime() + RESTORE_REQUEST_TTL_MS);
  const candidateType = await db.transaction(async (tx) => {
    const first = await decide(tx, person.id, input.academyId);
    await lockAcademy(tx, first.membership.academyId);
    const decision = await decide(tx, person.id, input.academyId);
    await appendChained(tx, "OPERATOR_OWNER_RESTORE_REQUESTED", decision.membership.academyId, person.id, {
      requestId,
      requestedBy: operator,
      reason,
      candidateType: decision.candidateType,
      approvalCodeSha256: sha256(approvalCode),
      expiresAt: expiresAt.toISOString(),
    });
    return decision.candidateType;
  });
  return { requestId, approvalCode, expiresAt, candidateType };
}
export async function approveOwnerRestore(input: {
  requestId: string;
  approvalCode: string;
  operator: string;
  now?: Date;
}) {
  const operator = normaliseOperator(input.operator);
  if (!operator) throw new RecoveryError("The operator identity is missing.");
  const now = input.now ?? new Date();
  const db = database();
  const findRequest = async (reader: Tx | ReturnType<typeof database>) =>
    (
      await reader
        .select()
        .from(t.securityEvent)
        .where(
          and(
            eq(t.securityEvent.event, "OPERATOR_OWNER_RESTORE_REQUESTED"),
            sql`${t.securityEvent.detail}->>'requestId' = ${input.requestId}`,
          ),
        )
    )[0];
  const located = await findRequest(db);
  if (!located?.academyId || !located.targetUserId)
    throw new RecoveryError("No owner recovery request has that ID.");
  const academyId = located.academyId;
  const targetUserId = located.targetUserId;
  // Temporary password hashed before the lock (slow), used only if the approval succeeds.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const outcome = await db.transaction(async (tx) => {
    await lockAcademy(tx, academyId);
    const request = await findRequest(tx);
    const detail = request.detail as {
      requestedBy: string;
      reason: string;
      approvalCodeSha256: string;
      expiresAt: string;
    };
    const related = await tx
      .select({ event: t.securityEvent.event })
      .from(t.securityEvent)
      .where(
        and(
          eq(t.securityEvent.academyId, academyId),
          inArray(t.securityEvent.event, ["OPERATOR_OWNER_RESTORE_DENIED", "OPERATOR_OWNER_RESTORED"]),
          sql`${t.securityEvent.detail}->>'requestId' = ${input.requestId}`,
        ),
      );
    const deny = async (reason: string, message: string) => {
      await appendChained(tx, "OPERATOR_OWNER_RESTORE_DENIED", academyId, targetUserId, {
        requestId: input.requestId,
        attemptedBy: operator,
        reason,
      });
      return { ok: false as const, message };
    };
    if (related.some((r) => r.event === "OPERATOR_OWNER_RESTORED"))
      return deny("ALREADY_USED", "This recovery request has already been used.");
    if (related.filter((r) => r.event === "OPERATOR_OWNER_RESTORE_DENIED").length >= MAX_REFUSED_APPROVALS)
      return deny("VOID", "This recovery request is void after repeated refused approvals. Create a new request.");
    const expires = Date.parse(detail.expiresAt);
    // Fail closed: an unreadable expiry is treated as expired.
    if (!Number.isFinite(expires) || now.getTime() >= expires)
      return deny("EXPIRED", "This recovery request has expired. Create a new request.");
    if (operator === normaliseOperator(detail.requestedBy))
      return deny("SAME_OPERATOR", "The approval must come from a different operator than the one who made the request.");
    const presented = Buffer.from(sha256(input.approvalCode.trim()), "hex");
    const expected = Buffer.from(detail.approvalCodeSha256, "hex");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected))
      return deny("BAD_APPROVAL_CODE", "The approval code does not match this request.");
    let decision: Awaited<ReturnType<typeof decide>>;
    try {
      decision = await decide(tx, targetUserId, academyId);
    } catch (error) {
      if (error instanceof RecoveryError) return deny("NO_LONGER_ELIGIBLE", error.message);
      throw error;
    }
    const before = decision.membership;
    await tx
      .update(t.memberships)
      .set({ role: "OWNER", active: true })
      .where(and(eq(t.memberships.academyId, academyId), eq(t.memberships.userId, targetUserId)));
    // A person who also works in another academy keeps their password and sessions: only the role in THIS academy is
    // restored. (If they have lost their credentials too, the operator runs the separate account recovery, whose
    // dry run lists everything it would end.) Everyone else gets the usual one-time temporary password.
    const issued = decision.credentialsShared
      ? null
      : await installTemporaryCredential(tx, {
          userId: targetUserId,
          passwordHash,
          source: "OPERATOR_RECOVERY",
          issuedBy: null,
          secret: config().BETTER_AUTH_SECRET,
          now,
        });
    if (before.role !== "OWNER")
      await recordSecurityEvent(tx, {
        event: "MEMBER_ROLE_CHANGED",
        academyId,
        actorId: null,
        targetUserId,
        detail: { fromRole: before.role, toRole: "OWNER", via: "OPERATOR_OWNER_RESTORED" },
      });
    await appendChained(tx, "OPERATOR_OWNER_RESTORED", academyId, targetUserId, {
      requestId: input.requestId,
      targetUserId,
      requestedBy: normaliseOperator(detail.requestedBy),
      approvedBy: operator,
      reason: detail.reason,
      candidateType: decision.candidateType,
      fromRole: before.role,
      fromActive: before.active,
      credentialsChanged: issued !== null,
      temporaryPasswordExpiresAt: issued ? issued.expiresAt.toISOString() : null,
      revokedSessions: issued ? issued.revokedSessions : 0,
    });
    return { ok: true as const, issued, candidateType: decision.candidateType };
  });
  if (!outcome.ok) throw new RecoveryError(outcome.message);
  return {
    userId: targetUserId,
    candidateType: outcome.candidateType,
    // Null when the person's credentials were deliberately left alone (they work in another academy too).
    credentialsChanged: outcome.issued !== null,
    temporaryPassword: outcome.issued ? temporaryPassword : null,
    expiresAt: outcome.issued ? outcome.issued.expiresAt : null,
    revokedSessions: outcome.issued ? outcome.issued.revokedSessions : 0,
  };
}
/** Checks the per-academy recovery event chain: contiguous sequence, links and hashes. */
export async function verifyRecoveryChain(academyId?: string) {
  const rows = await database()
    .select()
    .from(t.securityEvent)
    .where(
      academyId
        ? and(eq(t.securityEvent.academyId, academyId), inArray(t.securityEvent.event, [...CHAIN_EVENTS]))
        : inArray(t.securityEvent.event, [...CHAIN_EVENTS]),
    )
    .orderBy(asc(t.securityEvent.academyId), asc(sql`(${t.securityEvent.detail}->>'seq')::int`));
  const byAcademy = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.academyId ?? "";
    byAcademy.set(key, [...(byAcademy.get(key) ?? []), row]);
  }
  const problems: string[] = [];
  for (const [academy, events] of byAcademy) {
    let prev = "GENESIS";
    events.forEach((row, index) => {
      const { hash, ...body } = row.detail as Record<string, unknown> & { hash?: string; seq?: number; prev?: string };
      if (body.seq !== index + 1) problems.push(`${academy}: event ${row.id} has seq ${String(body.seq)}, expected ${index + 1}`);
      if (body.prev !== prev) problems.push(`${academy}: event ${row.id} does not link to the previous event`);
      const recomputed = chainHash({ event: row.event, academyId: academy, targetUserId: row.targetUserId, detail: body });
      if (hash !== recomputed) problems.push(`${academy}: event ${row.id} was altered (hash mismatch)`);
      prev = typeof hash === "string" ? hash : "";
    });
  }
  return { academies: byAcademy.size, events: rows.length, ok: problems.length === 0, problems };
}
