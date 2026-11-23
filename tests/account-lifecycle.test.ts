import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { recoverAccount, RecoveryError } from "../src/modules/identity/operator-recovery";
import { throttleKey } from "../src/modules/identity/sign-in-throttle";
import { FIXTURE_PASSWORD, USERS } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import {
  CHANGE,
  NEW_PASSWORD,
  STATE,
  code,
  events,
  hashOf,
  hoursFromNow,
  newMember as makeMember,
  reset,
  secretBearingRows,
  sessionsOf,
  setExpiry,
  signedIn as signIn,
  temporaryRow,
  type ResetResult,
} from "./helpers/accounts";
/**
 * Time-dependent and failure-dependent account behaviour: expired temporary credentials, the
 * per-account sign-in throttle, and recovery that never leaves the only owner locked out.
 * Time is moved by editing the stored expiry, so no test sleeps.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("account-lifecycle");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const newMember = (role: Parameters<typeof makeMember>[0] = "COACH", academy: "green" | "blue" | "quiet" = "green") =>
  makeMember(role, academy, "lc");
const signedIn = (email: string, password = FIXTURE_PASSWORD) => signIn(app, email, password);
async function issue(role: Parameters<typeof makeMember>[0] = "COACH") {
  const target = await newMember(role);
  const owner = await signedIn(USERS.owner.email);
  const r = await reset(owner, target.id);
  assert.equal(r.status, 200, r.text);
  return { ...target, temporary: (r.json as ResetResult).temporaryPassword };
}
test("a temporary password still inside its 72 hours signs in; one past it does not", async () => {
  const { id, email, temporary } = await issue();
  // 71 h 59 m in: still valid.
  await setExpiry(id, hoursFromNow(0.02), hoursFromNow(-71.98));
  const ok = app.anonymous();
  assert.equal((await ok.signIn(email, temporary)).status, 200);
  assert.equal(code(await ok.get("/api/academy")), "PASSWORD_CHANGE_REQUIRED");
  // One second past expiry: the right password is refused and no session is created.
  await setExpiry(id, new Date(Date.now() - 1000), hoursFromNow(-72.01));
  const late = app.anonymous();
  const before = await sessionsOf(id);
  const r = await late.signIn(email, temporary);
  assert.equal(r.status, 403);
  assert.equal(code(r), "TEMPORARY_PASSWORD_EXPIRED");
  assert.equal(late.hasSession(), false);
  assert.equal(await sessionsOf(id), before, "no session row was left behind");
  assert.equal((await late.get("/api/academy")).status, 401);
  assert.equal((await events(id, "TEMPORARY_PASSWORD_EXPIRED_SIGNIN")).length, 1);
});
test("expiry is revealed only to someone who knows the temporary password", async () => {
  const { id, email } = await issue();
  await setExpiry(id, new Date(Date.now() - 1000), hoursFromNow(-73));
  const wrong = await app.anonymous().signIn(email, "Wrong-Guess-Entirely-1");
  const unknown = await app.anonymous().signIn("no.such.person@example.test", "Wrong-Guess-Entirely-1");
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, unknown.json, "same answer as an account that does not exist");
});
test("a session that outlives its temporary password is cut off, and cannot rotate it", async () => {
  const { id, email, temporary } = await issue();
  const client = app.anonymous();
  assert.equal((await client.signIn(email, temporary)).status, 200);
  await setExpiry(id, new Date(Date.now() - 1000), hoursFromNow(-73));
  const api = await client.get("/api/academy");
  assert.equal(api.status, 403);
  assert.equal(code(api), "TEMPORARY_PASSWORD_EXPIRED");
  const change = await client.post(CHANGE, { currentPassword: temporary, newPassword: NEW_PASSWORD() });
  assert.equal(change.status, 403);
  assert.equal(code(change), "TEMPORARY_PASSWORD_EXPIRED");
  assert.ok(await temporaryRow(id), "an expired credential cannot be turned into a normal one");
  assert.equal((await client.post("/api/auth/update-user", { name: "Anyone" })).status, 403);
  // It can still find out why and sign out.
  const state = await client.get(STATE);
  assert.equal((state.json as { gate: string }).gate, "TEMPORARY_PASSWORD_EXPIRED");
  assert.equal((await client.signOut()).status, 200);
});
test("recovery from an expired temporary password: the owner issues a new one", async () => {
  const { id, email, temporary } = await issue("FINANCE");
  await setExpiry(id, new Date(Date.now() - 1000), hoursFromNow(-73));
  assert.equal((await app.anonymous().signIn(email, temporary)).status, 403);
  const again = await reset(await signedIn(USERS.owner.email), id);
  assert.equal(again.status, 200);
  const fresh = (again.json as ResetResult).temporaryPassword;
  assert.notEqual(fresh, temporary);
  assert.equal((await app.anonymous().signIn(email, temporary)).status, 401, "the expired one stays dead");
  const client = app.anonymous();
  assert.equal((await client.signIn(email, fresh)).status, 200);
  assert.equal((await client.post(CHANGE, { currentPassword: fresh, newPassword: NEW_PASSWORD() })).status, 200);
  assert.equal((await client.get("/api/academy/identity")).status, 200);
});
test("the sign-in throttle locks one account after ten failures from any number of addresses", async () => {
  const victim = await newMember();
  const bystander = await newMember();
  // Ten different machines, one wrong guess each: no single address ever hits its own limit.
  for (let i = 0; i < 10; i++)
    assert.equal((await app.anonymous().signIn(victim.email, `Wrong-Guess-${i}-Entirely`)).status, 401, `guess ${i}`);
  const locked = await app.anonymous().signIn(victim.email, FIXTURE_PASSWORD);
  assert.equal(locked.status, 429, "even the correct password is refused while locked");
  assert.equal(code(locked), "TOO_MANY_ATTEMPTS");
  assert.equal((await events(victim.id, "SIGN_IN_LOCKED")).length, 1);
  // Other accounts are untouched, from the same kind of address.
  assert.equal((await app.anonymous().signIn(bystander.email, FIXTURE_PASSWORD)).status, 200);
  // The stored counter is a keyed hash: no email address appears in it.
  const rows = await database().select().from(t.signInThrottle);
  assert.ok(rows.length >= 1);
  assert.ok(!JSON.stringify(rows).includes(victim.email) && !JSON.stringify(rows).includes("example.test"));
  // The lock expires by itself.
  const key = throttleKey(process.env.BETTER_AUTH_SECRET!, "sign-in", victim.email);
  await database().update(t.signInThrottle).set({ lockedUntil: new Date(Date.now() - 1000), windowStartedAt: new Date(Date.now() - 20 * 60 * 1000) }).where(eq(t.signInThrottle.key, key));
  assert.equal((await app.anonymous().signIn(victim.email, FIXTURE_PASSWORD)).status, 200);
  assert.equal((await database().select().from(t.signInThrottle).where(eq(t.signInThrottle.key, key))).length, 0, "success clears the counter");
});
test("the throttle treats unknown addresses exactly like known ones", async () => {
  const email = `nobody-${Date.now()}@example.test`;
  const outcomes: number[] = [];
  for (let i = 0; i < 11; i++) outcomes.push((await app.anonymous().signIn(email, `Wrong-Guess-${i}-Entirely`)).status);
  assert.deepEqual(outcomes, [...Array(10).fill(401), 429]);
});
test("nine failures then a success do not accumulate", async () => {
  const member = await newMember();
  for (let i = 0; i < 9; i++) await app.anonymous().signIn(member.email, `Wrong-Guess-${i}-Entirely`);
  assert.equal((await app.anonymous().signIn(member.email, FIXTURE_PASSWORD)).status, 200);
  for (let i = 0; i < 9; i++)
    assert.equal((await app.anonymous().signIn(member.email, `Wrong-Again-${i}-Entirely`)).status, 401);
  assert.equal((await app.anonymous().signIn(member.email, FIXTURE_PASSWORD)).status, 200);
});
test("concurrent guesses are counted atomically and still lock the account", async () => {
  const member = await newMember();
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, i) => app.anonymous().signIn(member.email, `Wrong-Parallel-${i}-Entirely`)),
  );
  const rejected = results.filter((r) => r.status === 401).length;
  const refused = results.filter((r) => r.status === 429).length;
  assert.equal(rejected + refused, 16);
  assert.ok(rejected >= 10, `at least ten guesses were counted (${rejected})`);
  assert.equal((await app.anonymous().signIn(member.email, FIXTURE_PASSWORD)).status, 429);
});
test("an owner reset clears a locked account so the person can use the new password at once", async () => {
  const member = await newMember();
  for (let i = 0; i < 10; i++) await app.anonymous().signIn(member.email, `Wrong-Guess-${i}-Entirely`);
  assert.equal((await app.anonymous().signIn(member.email, FIXTURE_PASSWORD)).status, 429);
  const r = await reset(await signedIn(USERS.owner.email), member.id);
  assert.equal(r.status, 200);
  assert.equal((await app.anonymous().signIn(member.email, (r.json as ResetResult).temporaryPassword)).status, 200);
});
test("the per-address limit still applies on top of the per-account throttle", async () => {
  const client = app.anonymous();
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await client.signIn(`other-${i}@example.test`, "Wrong-Guess-Entirely-1")).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429, 429]);
});
test("operator recovery restores the only owner of an academy whose reset path is exhausted", async () => {
  // quiet has one owner and nobody else: no one in the application can reset them.
  const quiet = USERS.quietOwner;
  const someone = await signedIn(USERS.owner.email);
  const attempt = await reset(someone, quiet.id);
  assert.equal(attempt.status, 404, "another academy's owner cannot do it");
  // The owner is locked out two ways at once: throttled and holding an expired temporary password.
  for (let i = 0; i < 10; i++) await app.anonymous().signIn(quiet.email, `Wrong-Guess-${i}-Entirely`);
  await database().insert(t.temporaryCredential).values({ userId: quiet.id, issuedBy: null, source: "OPERATOR_RECOVERY", issuedAt: hoursFromNow(-100), expiresAt: hoursFromNow(-28) }).onConflictDoNothing();
  assert.equal((await app.anonymous().signIn(quiet.email, FIXTURE_PASSWORD)).status, 429);
  const recovered = await recoverAccount({ email: quiet.email.toUpperCase(), reason: "Owner locked out; identity verified by phone call.", resetAuthenticator: false, operator: "test-operator" });
  assert.equal(recovered.userId, quiet.id);
  assert.match(recovered.temporaryPassword, /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
  assert.ok(Math.abs(recovered.expiresAt.getTime() - Date.now() - 72 * 3600 * 1000) < 60_000);
  const client = app.anonymous();
  assert.equal((await client.signIn(quiet.email, recovered.temporaryPassword)).status, 200, "throttle was cleared too");
  // Recovery is never weaker than a normal login: the person must still replace the password first.
  assert.equal(code(await client.get("/api/academy")), "PASSWORD_CHANGE_REQUIRED");
  const chosen = NEW_PASSWORD();
  assert.equal((await client.post(CHANGE, { currentPassword: recovered.temporaryPassword, newPassword: chosen })).status, 200);
  assert.equal((await client.get("/api/academy/identity")).status, 200);
  const [event] = await events(quiet.id, "OPERATOR_RECOVERY");
  assert.equal(event.actorId, null);
  assert.equal(event.academyId, "quiet");
  assert.equal((event.detail as { operator: string }).operator, "test-operator");
  assert.ok(!(await secretBearingRows()).includes(recovered.temporaryPassword));
});
test("operator recovery validates its input and changes nothing on a miss", async () => {
  const member = await newMember();
  const before = await hashOf(member.id);
  await assert.rejects(recoverAccount({ email: "ghost@example.test", reason: "A perfectly good reason.", resetAuthenticator: false, operator: "op" }), RecoveryError);
  await assert.rejects(recoverAccount({ email: member.email, reason: "short", resetAuthenticator: false, operator: "op" }), /reason/i);
  assert.equal(await hashOf(member.id), before);
  assert.equal(await temporaryRow(member.id), undefined);
});
