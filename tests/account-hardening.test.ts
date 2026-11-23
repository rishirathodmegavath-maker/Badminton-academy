import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import {
  RecoveryError,
  describeRecoveryTarget,
  recoverAccount,
} from "../src/modules/identity/operator-recovery";
import {
  THROTTLE_LOCK_MS,
  OWNER_REAUTH_MAX_FAILURES,
  THROTTLE_MAX_FAILURES,
  clearFailures,
  refundAttempt,
  reserveAttempt,
  throttleKey,
} from "../src/modules/identity/sign-in-throttle";
import { FIXTURE_PASSWORD, USERS } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { nextTestAddress, type TestClient } from "./helpers/client";
import {
  CHANGE,
  NEW_PASSWORD,
  RESET,
  code,
  events,
  newMember as makeMember,
  reset,
  signedIn as signIn,
  type ResetResult,
} from "./helpers/accounts";
/**
 * Phase 3 account-lockout and recovery hardening:
 *  - the per-account limits hold under concurrency (attempts are claimed atomically before the
 *    password is checked), for sign-in, change-password and the owner's re-authentication;
 *  - lock timing, expiry and consistency;
 *  - recovery (owner reset or operator) clears every per-account pause that could keep the person
 *    from replacing the temporary password, and never weakens the replacement requirement.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("account-hardening");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const SECRET = () => process.env.BETTER_AUTH_SECRET!;
const newMember = (role: Parameters<typeof makeMember>[0] = "COACH") =>
  makeMember(role, "green", "hd");
const signedIn = (email: string, password = FIXTURE_PASSWORD) =>
  signIn(app, email, password);
const row = async (key: string) =>
  (await database().select().from(t.signInThrottle).where(eq(t.signInThrottle.key, key)))[0];
const tally = (results: { status: number }[]) => {
  const by: Record<number, number> = {};
  for (const r of results) by[r.status] = (by[r.status] ?? 0) + 1;
  return by;
};
/** A copy of a signed-in client that presents its own address (a different machine, same session). */
const elsewhere = (client: TestClient) => client.clone(nextTestAddress());
test("40 simultaneous wrong guesses at one account: exactly ten are judged, the rest are refused unjudged", async () => {
  const victim = await newMember();
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      app.anonymous().signIn(victim.email, `Wrong-Parallel-${i}-Entirely`),
    ),
  );
  assert.deepEqual(tally(results), { 401: THROTTLE_MAX_FAILURES, 429: 40 - THROTTLE_MAX_FAILURES });
  assert.ok(results.filter((r) => r.status === 429).every((r) => code(r) === "TOO_MANY_ATTEMPTS"));
  assert.equal((await events(victim.id, "SIGN_IN_LOCKED")).length, 1, "one lock, one event");
  assert.equal((await app.anonymous().signIn(victim.email, FIXTURE_PASSWORD)).status, 429);
  const stored = await row(throttleKey(SECRET(), "sign-in", victim.email));
  assert.equal(stored.failures >= THROTTLE_MAX_FAILURES, true);
});
test("a burst that includes the right password cannot get more than ten tries in total", async () => {
  const victim = await newMember();
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      app.anonymous().signIn(victim.email, i === 29 ? FIXTURE_PASSWORD : `Wrong-Burst-${i}-Entirely`),
    ),
  );
  const judged = results.filter((r) => r.status !== 429).length;
  assert.ok(judged <= THROTTLE_MAX_FAILURES, `${judged} attempts were judged`);
});
test("the lock lasts fifteen minutes from the tenth failure, is not extended by further attempts, and holds when the counting window has rolled over", async () => {
  const victim = await newMember();
  const key = throttleKey(SECRET(), "sign-in", victim.email);
  const started = Date.now();
  for (let i = 0; i < THROTTLE_MAX_FAILURES; i++)
    assert.equal((await app.anonymous().signIn(victim.email, `Wrong-Seq-${i}-Entirely`)).status, 401);
  const locked = await row(key);
  const until = locked.lockedUntil!.getTime();
  assert.ok(until >= started + THROTTLE_LOCK_MS - 1000 && until <= Date.now() + THROTTLE_LOCK_MS + 1000, "fifteen minutes from the tenth failure");
  for (let i = 0; i < 4; i++) assert.equal((await app.anonymous().signIn(victim.email, `Wrong-More-${i}-Entirely`)).status, 429);
  assert.equal((await row(key)).lockedUntil!.getTime(), until, "refused attempts do not extend the lock");
  // Failures spread over a long time: the 15-minute window ended but the lock is still running.
  await database().update(t.signInThrottle).set({ windowStartedAt: new Date(Date.now() - 20 * 60 * 1000) }).where(eq(t.signInThrottle.key, key));
  assert.equal((await app.anonymous().signIn(victim.email, FIXTURE_PASSWORD)).status, 429, "still locked");
  assert.equal((await row(key)).lockedUntil!.getTime(), until);
  // The lock ends by itself, and a success starts from zero.
  await database().update(t.signInThrottle).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(t.signInThrottle.key, key));
  assert.equal((await app.anonymous().signIn(victim.email, FIXTURE_PASSWORD)).status, 200);
  assert.equal(await row(key), undefined, "success clears the counter");
  // After the lock the next failure counts as the first of a new window.
  assert.equal((await app.anonymous().signIn(victim.email, "Wrong-After-Lock-Entirely")).status, 401);
  assert.equal((await row(key)).failures, 1);
});
test("answers do not reveal whether an account exists, before or during a lock", async () => {
  const known = await newMember();
  const unknown = `nobody-${Date.now()}@example.test`;
  const a = await app.anonymous().signIn(known.email, "Wrong-Enumeration-Entirely");
  const b = await app.anonymous().signIn(unknown, "Wrong-Enumeration-Entirely");
  assert.equal(a.status, b.status);
  assert.deepEqual(a.json, b.json);
  for (let i = 0; i < THROTTLE_MAX_FAILURES; i++) {
    await app.anonymous().signIn(known.email, `Wrong-Fill-${i}-Entirely`);
    await app.anonymous().signIn(unknown, `Wrong-Fill-${i}-Entirely`);
  }
  const lockedKnown = await app.anonymous().signIn(known.email, "Wrong-Enumeration-Entirely");
  const lockedUnknown = await app.anonymous().signIn(unknown, "Wrong-Enumeration-Entirely");
  assert.equal(lockedKnown.status, 429);
  assert.deepEqual([lockedKnown.status, lockedKnown.json], [lockedUnknown.status, lockedUnknown.json]);
  // No event ties a lock to an address that is not an account.
  const stray = (await database().select().from(t.securityEvent)).filter((e) => e.event === "SIGN_IN_LOCKED" && e.targetUserId === null);
  assert.ok(stray.every((e) => e.academyId === null), "an unknown address never reaches any academy's log");
});
test("reserveAttempt / refundAttempt: ten claims per window, refunds only outside a lock", async () => {
  const key = throttleKey(SECRET(), "unit", `unit-${Date.now()}`);
  const now = new Date();
  const claims = [];
  for (let i = 0; i < 12; i++) claims.push(await reserveAttempt(key, now));
  assert.deepEqual(claims.map((c) => c.allowed), [...Array(10).fill(true), false, false]);
  assert.deepEqual(claims.map((c) => c.reachedLimit), [...Array(9).fill(false), true, false, false]);
  const first = claims[9].lockedUntil!.getTime();
  assert.equal(first, now.getTime() + THROTTLE_LOCK_MS);
  assert.equal(claims[11].lockedUntil!.getTime(), first);
  await refundAttempt(key);
  assert.ok((await row(key)).failures >= 12, "a lock is never loosened by a refund");
  await clearFailures(key);
  assert.equal(await row(key), undefined);
  const other = throttleKey(SECRET(), "unit", `unit-refund-${Date.now()}`);
  await reserveAttempt(other);
  await reserveAttempt(other);
  await reserveAttempt(other);
  await refundAttempt(other);
  assert.equal((await row(other)).failures, 2);
  await refundAttempt(other);
  await refundAttempt(other);
  await refundAttempt(other);
  assert.equal((await row(other)).failures, 0, "never below zero");
  // Many simultaneous claims are serialised by the database.
  const burst = throttleKey(SECRET(), "unit", `unit-burst-${Date.now()}`);
  const all = await Promise.all(Array.from({ length: 25 }, () => reserveAttempt(burst)));
  assert.equal(all.filter((c) => c.allowed).length, THROTTLE_MAX_FAILURES);
  assert.equal(all.filter((c) => c.reachedLimit).length, 1);
});
test("change-password: parallel wrong current passwords are capped at ten, and a correct one clears the count", async () => {
  const member = await newMember();
  const session = await signedIn(member.email);
  const attempts = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      elsewhere(session).post(CHANGE, { currentPassword: `Wrong-Current-${i}-Entirely`, newPassword: NEW_PASSWORD() }),
    ),
  );
  assert.deepEqual(tally(attempts), { 400: THROTTLE_MAX_FAILURES, 429: 6 });
  assert.equal(code(attempts.find((r) => r.status === 429)!), "TOO_MANY_ATTEMPTS");
  assert.equal((await events(member.id, "PASSWORD_CHANGE_FAILED")).length, THROTTLE_MAX_FAILURES);
  // Even the right password is refused while paused.
  assert.equal((await session.post(CHANGE, { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD() })).status, 429);
  // A fresh member: nine wrong, then the right one, then the count starts over.
  const other = await newMember();
  const s2 = await signedIn(other.email);
  for (let i = 0; i < 9; i++) assert.equal((await elsewhere(s2).post(CHANGE, { currentPassword: `Wrong-Again-${i}-Entirely`, newPassword: NEW_PASSWORD() })).status, 400);
  const replacement = NEW_PASSWORD();
  assert.equal((await s2.post(CHANGE, { currentPassword: FIXTURE_PASSWORD, newPassword: replacement })).status, 200);
  const key = throttleKey(SECRET(), "change-password", other.id);
  assert.equal(await row(key), undefined);
});
// RC-2 (owner decision 2026-11-11): the shared owner re-authentication counter locks after five failures, not ten.
test("owner re-authentication for resets: parallel wrong passwords are capped at five", async () => {
  const boss = await newMember("OWNER");
  const target = await newMember();
  const session = await signedIn(boss.email);
  const attempts = await Promise.all(
    Array.from({ length: 16 }, (_, i) => elsewhere(session).post(RESET, { userId: target.id, reason: "Member forgot their password; identity confirmed.", ownerPassword: `Wrong-Owner-${i}-Entirely` })),
  );
  assert.deepEqual(tally(attempts), { 403: OWNER_REAUTH_MAX_FAILURES, 429: 16 - OWNER_REAUTH_MAX_FAILURES });
  const codes = attempts.map(code);
  assert.equal(codes.filter((c) => c === "REAUTHENTICATION_FAILED").length, OWNER_REAUTH_MAX_FAILURES, "five were judged");
  assert.equal(codes.filter((c) => c === "TOO_MANY_ATTEMPTS").length, 16 - OWNER_REAUTH_MAX_FAILURES, "the rest were refused unjudged");
  // Nothing was changed for the target.
  assert.equal((await events(target.id, "ADMIN_PASSWORD_RESET")).length, 0);
});
test("an owner reset clears the pause on change-password, so the temporary password can be replaced at once", async () => {
  const member = await newMember();
  const session = await signedIn(member.email);
  await Promise.all(Array.from({ length: 12 }, (_, i) => elsewhere(session).post(CHANGE, { currentPassword: `Wrong-Lock-${i}-Entirely`, newPassword: NEW_PASSWORD() })));
  assert.equal((await session.post(CHANGE, { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD() })).status, 429, "paused");
  const owner = await signedIn(USERS.owner.email);
  const issued = await reset(owner, member.id);
  assert.equal(issued.status, 200, issued.text);
  const temporary = (issued.json as ResetResult).temporaryPassword;
  const fresh = await signedIn(member.email, temporary);
  const replacement = NEW_PASSWORD();
  const changed = await fresh.post(CHANGE, { currentPassword: temporary, newPassword: replacement });
  assert.equal(changed.status, 200, `${changed.status} ${changed.text}`);
  assert.equal((await fresh.get("/api/academy/identity")).status, 200);
});
test("an owner reset also clears a paused owner re-authentication of the target", async () => {
  const boss = await newMember("OWNER");
  const target = await newMember("ADMIN");
  // The target (an admin) is paused on the re-authentication key.
  const key = throttleKey(SECRET(), "owner-reauth", target.id);
  for (let i = 0; i < THROTTLE_MAX_FAILURES; i++) await reserveAttempt(key);
  assert.equal((await row(key)).failures, THROTTLE_MAX_FAILURES);
  const issued = await reset(await signedIn(boss.email), target.id);
  assert.equal(issued.status, 200, issued.text);
  assert.equal(await row(key), undefined);
});
test("operator recovery of the only owner: the target is described first, every pause is cleared, and the temporary password must still be replaced", async () => {
  assert.equal(await describeRecoveryTarget("nobody-at-all@example.test"), null);
  await assert.rejects(() => recoverAccount({ email: "nobody-at-all@example.test", reason: "Owner locked out; verified by phone.", resetAuthenticator: false, operator: "tester" }), RecoveryError);
  const described = await describeRecoveryTarget(USERS.quietOwner.email.toUpperCase());
  assert.deepEqual(described, { name: USERS.quietOwner.name, roles: ["OWNER @ Fixture Quiet Academy"], authenticatorEnrolled: false });
  // Lock the only owner out on every per-account counter.
  const owner = USERS.quietOwner;
  for (let i = 0; i < THROTTLE_MAX_FAILURES; i++) await app.anonymous().signIn(owner.email, `Wrong-Quiet-${i}-Entirely`);
  assert.equal((await app.anonymous().signIn(owner.email, FIXTURE_PASSWORD)).status, 429);
  for (const scope of ["change-password", "owner-reauth"])
    for (let i = 0; i < THROTTLE_MAX_FAILURES; i++) await reserveAttempt(throttleKey(SECRET(), scope, owner.id));
  const recovered = await recoverAccount({ email: owner.email, reason: "Only owner locked out; identity verified by phone.", resetAuthenticator: false, operator: "tester" });
  const keys = ["sign-in", "change-password", "owner-reauth"].map((s) => throttleKey(SECRET(), s, s === "sign-in" ? owner.email : owner.id));
  for (const key of keys) assert.equal(await row(key), undefined);
  // Not weaker than a normal sign-in: it works, but only to replace the password.
  const client = app.anonymous();
  assert.equal((await client.signIn(owner.email, recovered.temporaryPassword)).status, 200);
  const gated = await client.get("/api/academy/identity");
  assert.equal(gated.status, 403);
  assert.equal(code(gated), "PASSWORD_CHANGE_REQUIRED");
  const replacement = NEW_PASSWORD();
  assert.equal((await client.post(CHANGE, { currentPassword: recovered.temporaryPassword, newPassword: replacement })).status, 200);
  assert.equal((await client.get("/api/academy/identity")).status, 200);
  assert.equal((await app.anonymous().signIn(owner.email, recovered.temporaryPassword)).status, 401, "the temporary password is dead once replaced");
  // The event names the academy and the operator, and never the password.
  const logged = (await events(owner.id, "OPERATOR_RECOVERY"))[0];
  assert.equal(logged.academyId, "quiet");
  assert.ok(!JSON.stringify(logged).includes(recovered.temporaryPassword));
});
