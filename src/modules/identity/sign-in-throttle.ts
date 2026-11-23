import { createHmac } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { database } from "../../infrastructure/database/client";
import { signInThrottle } from "../../infrastructure/database/schema";
/**
 * Per-account throttle on top of the per-address rate limit. The address limit cannot stop many
 * addresses guessing at one account; this caps consecutive failures per account instead.
 *
 * Trade-off (a policy choice, documented in the README): while an account is locked even the right
 * password is refused, so anyone who knows an email address can pause that one account's sign-in.
 * The pause is short and expires on its own; it never needs an administrator and it cannot lock an
 * owner out permanently. Operator recovery clears it immediately.
 */
export const THROTTLE_MAX_FAILURES = 10;
/**
 * RC-2 (TD-1, owner decision 2026-11-11): the shared `owner-reauth` counter, used by every owner
 * re-authentication (owner grant/revoke step-up, credential reset, MFA policy, privacy actions),
 * locks after five failures instead of ten. One counter for all of them, so guesses cannot be
 * spread across endpoints.
 */
export const OWNER_REAUTH_MAX_FAILURES = 5;
export const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
export const THROTTLE_LOCK_MS = 15 * 60 * 1000;
/** Keyed hash of a normalised identifier: unknown and known accounts look the same, nothing readable is stored. */
export const throttleKey = (
  secret: string,
  scope: string,
  identifier: string,
) =>
  createHmac("sha256", secret)
    .update(`${scope}\0${identifier.trim().toLowerCase()}`)
    .digest("hex");
export async function lockedUntil(key: string, now = new Date()) {
  const [row] = await database()
    .select()
    .from(signInThrottle)
    .where(eq(signInThrottle.key, key));
  return row?.lockedUntil && row.lockedUntil.getTime() > now.getTime()
    ? row.lockedUntil
    : null;
}
/**
 * Atomically claim one attempt BEFORE the password is checked.
 *
 * Counting only after a failure (check the lock, verify, then count) lets a burst of parallel
 * guesses all pass the lock check before any of them is counted, so the threshold would bound only
 * sequential guessing. Claiming first closes that window: the counter is advanced by a single
 * upsert, the database serialises concurrent claims on the row, and exactly the first
 * THROTTLE_MAX_FAILURES claims of a window are allowed. A claim that turns out to be a success is
 * cleared by `clearFailures`; one that never reached a password check is returned by `refundAttempt`.
 *
 * Semantics are unchanged from the failure-counting version: ten failed attempts in 15 minutes
 * lock the account for 15 minutes (counted from the tenth), the lock refuses even the right
 * password, a lock is never extended by further attempts, and it expires on its own.
 */
export async function reserveAttempt(
  key: string,
  now = new Date(),
  maxFailures = THROTTLE_MAX_FAILURES,
) {
  const db = database();
  const windowStart = new Date(now.getTime() - THROTTLE_WINDOW_MS);
  const lockUntil = new Date(now.getTime() + THROTTLE_LOCK_MS);
  // Raw SQL fragments bypass the column mapper, and node-postgres would serialise a Date in the
  // server's LOCAL time zone (then `timestamp` drops the offset). Send explicit UTC text instead.
  const utc = (d: Date) => sql`${d.toISOString()}::timestamp`;
  const t = sql.raw("sign_in_throttle");
  const locked = sql`(${t}.locked_until is not null and ${t}.locked_until > ${utc(now)})`;
  // A lock still in force keeps counting (so the claim is refused) even if the window has rolled
  // over; otherwise a stale window restarts the count.
  const next = sql`(case when ${locked} then ${t}.failures + 1 when ${t}.window_started_at < ${utc(windowStart)} then 1 else ${t}.failures + 1 end)`;
  const [row] = await db
    .insert(signInThrottle)
    .values({ key, failures: 1, windowStartedAt: now })
    .onConflictDoUpdate({
      target: signInThrottle.key,
      set: {
        failures: next,
        windowStartedAt: sql`(case when ${locked} then ${t}.window_started_at when ${t}.window_started_at < ${utc(windowStart)} then ${utc(now)} else ${t}.window_started_at end)`,
        // Set once, by the claim that reaches the threshold; never moved by later claims.
        lockedUntil: sql`(case when ${locked} then ${t}.locked_until when ${next} >= ${maxFailures} then ${utc(lockUntil)} else ${t}.locked_until end)`,
      },
    })
    .returning();
  // Housekeeping: forget stale counters so the table cannot grow without bound.
  await db
    .delete(signInThrottle)
    .where(
      lt(
        signInThrottle.windowStartedAt,
        new Date(now.getTime() - 24 * 60 * 60 * 1000),
      ),
    );
  return {
    failures: row.failures,
    allowed: row.failures <= maxFailures,
    /** This claim reached the threshold: if it fails, the account is now locked. */
    reachedLimit: row.failures === maxFailures,
    lockedUntil: row.lockedUntil,
  };
}
/** Gives back a claim that never produced a password verdict (e.g. malformed request). */
export async function refundAttempt(key: string) {
  await database()
    .update(signInThrottle)
    .set({ failures: sql`greatest(${signInThrottle.failures} - 1, 0)` })
    .where(
      and(
        eq(signInThrottle.key, key),
        // Never loosen an active lock.
        sql`(${signInThrottle.lockedUntil} is null or ${signInThrottle.lockedUntil} <= ${sql`${new Date().toISOString()}::timestamp`})`,
      ),
    );
}
/** Claims one attempt on the shared owner re-authentication counter (limit OWNER_REAUTH_MAX_FAILURES). */
export const reserveOwnerReauth = (key: string, now = new Date()) =>
  reserveAttempt(key, now, OWNER_REAUTH_MAX_FAILURES);
export async function clearFailures(key: string) {
  await database().delete(signInThrottle).where(eq(signInThrottle.key, key));
}
