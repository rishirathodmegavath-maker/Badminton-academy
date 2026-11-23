import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { FIXTURE_PASSWORD, ROLES, ROLE_USER, USERS } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import {
  AUTH,
  CHANGE,
  STATE,
  code,
  events,
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
import { TF, enroll as enrollUser, stableWindow, startChallenge, twoFactorRedirect, type Enrolled } from "./helpers/mfa";
import { base32Decode, parseProvisioningUri, totpAt } from "./helpers/totp";
/**
 * Two-factor authentication through Better Auth's own plugin, exercised end to end over HTTP.
 * Authenticator codes come from an independent RFC 6238 implementation (tests/helpers/totp.ts).
 */
let app: Harness;
const captured: string[] = [];
const restore: (() => void)[] = [];
before(
  async () => {
    // Everything the process prints is collected so the last test can prove no secret was logged.
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      const original = console[method];
      console[method] = (...args: unknown[]) => {
        captured.push(args.map(String).join(" "));
        original.apply(console, args as []);
      };
      restore.push(() => (console[method] = original));
    }
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        captured.push(String(chunk));
        return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      restore.push(() => (stream.write = original as typeof stream.write));
    }
    app = await startHarness("mfa");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
    restore.forEach((r) => r());
  },
  { timeout: HOOK_TIMEOUT },
);
const secretsSeen = new Set<string>();
const newMember = (role: Parameters<typeof makeMember>[0] = "COACH") => makeMember(role, "green", "mf");
const signedIn = (email: string, password = FIXTURE_PASSWORD) => signIn(app, email, password);
async function enroll(user: { id: string; email: string }) {
  const e = await enrollUser(app, user);
  secretsSeen.add(e.uri.raw);
  secretsSeen.add(new URL(e.uri.raw).searchParams.get("secret")!);
  secretsSeen.add(e.uri.secret.toString());
  e.backupCodes.forEach((c) => secretsSeen.add(c));
  return e;
}
const rowOf = async (userId: string) =>
  (await database().select().from(t.twoFactor).where(eq(t.twoFactor.userId, userId)))[0];
const enabled = async (userId: string) =>
  (await database().select().from(t.user).where(eq(t.user.id, userId)))[0].twoFactorEnabled;
/** Complete the second step of a pending challenge. */
const answer = (client: Awaited<ReturnType<typeof startChallenge>>["client"], codeValue: string) =>
  client.post(`${TF}/verify-totp`, { code: codeValue });
const protectedAreas = ["/api/academy", "/api/academy/identity", "/api/training", "/api/auth/list-sessions", STATE];
async function assertNoAccess(client: { get: (p: string) => Promise<{ status: number }> }, label: string) {
  for (const path of protectedAreas) assert.equal((await client.get(path)).status, 401, `${label}: ${path}`);
}
for (const role of ROLES) {
  test(`${role}: enrol an authenticator, then sign in with a second factor`, async () => {
    const key = ROLE_USER[role];
    const user = USERS[key];
    const e = await enroll(user);
    assert.equal(await enabled(user.id), true);
    const { client, step1 } = await startChallenge(app, user.email);
    assert.equal(step1.status, 200);
    assert.ok(twoFactorRedirect(step1), "password alone no longer signs this account in");
    assert.equal(client.hasSession(), false);
    await assertNoAccess(client, `${role} after password`);
    const done = await answer(client, e.code());
    assert.equal(done.status, 200, done.text);
    assert.ok(client.hasSession());
    assert.equal((await client.get("/api/academy/identity")).status, 200);
  });
}
test("enrolment: the secret is shown once, over no-store, and is stored only encrypted", async () => {
  const member = await newMember();
  await stableWindow();
  const client = await signedIn(member.email);
  const anon = await app.anonymous().post(`${TF}/enable`, { password: FIXTURE_PASSWORD });
  assert.equal(anon.status, 401);
  assert.equal((await client.post(`${TF}/enable`, {})).status, 400, "password is required");
  const wrong = await client.post(`${TF}/enable`, { password: "not-my-password-at-all" });
  assert.equal(wrong.status, 400);
  assert.equal(await rowOf(member.id), undefined, "no secret is issued without the password");
  const r = await client.post(`${TF}/enable`, { password: FIXTURE_PASSWORD });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = r.json as { method: string; totpURI: string; backupCodes: string[] };
  const uri = new URL(body.totpURI);
  assert.equal(uri.protocol, "otpauth:");
  assert.equal(uri.hostname, "totp");
  assert.equal(uri.searchParams.get("issuer"), "Sportozen");
  assert.equal(uri.searchParams.get("digits"), "6");
  assert.equal(uri.searchParams.get("period"), "30");
  assert.ok(decodeURIComponent(uri.pathname).includes(member.email));
  const base32 = uri.searchParams.get("secret")!;
  assert.ok(base32.length >= 32, "at least 160 bits of secret");
  body.backupCodes.forEach((c) => secretsSeen.add(c));
  secretsSeen.add(base32);
  secretsSeen.add(body.totpURI);
  // Stored: encrypted secret and encrypted recovery codes, nothing readable.
  const row = await rowOf(member.id);
  const raw = base32Decode(base32).toString();
  const stored = JSON.stringify(row);
  assert.ok(!stored.includes(base32) && !stored.includes(raw));
  for (const c of body.backupCodes) assert.ok(!stored.includes(c), "recovery codes are not stored in readable form");
  assert.equal(row.verified, false, "pending until the first code is confirmed");
  // The URI cannot be read back later.
  assert.ok((await client.post(`${TF}/get-totp-uri`, { password: FIXTURE_PASSWORD })).status >= 400);
  assert.equal(body.backupCodes.length, 10);
  for (const c of body.backupCodes) assert.match(c, /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);
  assert.equal(new Set(body.backupCodes).size, 10);
});
test("enrolment is not active until a valid code is confirmed", async () => {
  const member = await newMember();
  await stableWindow();
  const other = await signedIn(member.email);
  const client = await signedIn(member.email);
  const r = await client.post(`${TF}/enable`, { password: FIXTURE_PASSWORD });
  const body = r.json as { totpURI: string; backupCodes: string[] };
  secretsSeen.add(body.totpURI);
  body.backupCodes.forEach((c) => secretsSeen.add(c));
  assert.equal(await enabled(member.id), false);
  // A password-only sign-in still works while enrolment is pending (nothing is enforced yet).
  assert.equal((await app.anonymous().signIn(member.email, FIXTURE_PASSWORD)).status, 200);
  // A wrong code does not activate it.
  const wrong = await client.post(`${TF}/verify-totp`, { code: "000000" });
  assert.equal(wrong.status, 401);
  assert.equal(await enabled(member.id), false);
  assert.equal((await rowOf(member.id)).verified, false);
  const key = parseProvisioningUri(body.totpURI).secret;
  // Confirming the real code activates it and ends every other session.
  const sessionsBefore = await sessionsOf(member.id);
  assert.ok(sessionsBefore >= 3);
  const ok = await client.post(`${TF}/verify-totp`, { code: totpAt(key, 0) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(await enabled(member.id), true);
  assert.equal((await rowOf(member.id)).verified, true);
  assert.equal(await sessionsOf(member.id), 1, "only the activating session survives");
  assert.equal((await other.get("/api/academy/identity")).status, 401);
  assert.equal((await client.get("/api/academy/identity")).status, 200);
  const [event] = await events(member.id, "MFA_ENABLED");
  assert.ok(event);
  assert.ok((await events(member.id, "MFA_ENROLLMENT_STARTED")).length >= 1);
  // Enrolling again while active is refused and leaves the first authenticator intact.
  const again = await client.post(`${TF}/enable`, { password: FIXTURE_PASSWORD });
  assert.equal(again.status, 400);
});
test("re-running enrolment before confirming replaces the pending secret", async () => {
  const member = await newMember();
  await stableWindow();
  const client = await signedIn(member.email);
  const first = (await client.post(`${TF}/enable`, { password: FIXTURE_PASSWORD })).json as { totpURI: string };
  const second = (await client.post(`${TF}/enable`, { password: FIXTURE_PASSWORD })).json as { totpURI: string };
  secretsSeen.add(first.totpURI);
  secretsSeen.add(second.totpURI);
  assert.notEqual(first.totpURI, second.totpURI);
  const stale = totpAt(parseProvisioningUri(first.totpURI).secret, 0);
  assert.equal((await client.post(`${TF}/verify-totp`, { code: stale })).status, 401, "the discarded secret confirms nothing");
  assert.equal(await enabled(member.id), false);
  assert.equal((await client.post(`${TF}/verify-totp`, { code: totpAt(parseProvisioningUri(second.totpURI).secret, 0) })).status, 200);
  assert.equal(await enabled(member.id), true);
});
test("sign-in challenge: no session, no access, and every protected route stays closed", async () => {
  const member = await newMember("FINANCE");
  const e = await enroll(member);
  const { client, step1 } = await startChallenge(app, member.email);
  assert.ok(twoFactorRedirect(step1));
  assert.deepEqual((step1.json as { twoFactorMethods: string[] }).twoFactorMethods, ["totp"]);
  const cookies = step1.setCookies.join(" ");
  assert.ok(!/session_token=[^;\s]/.test(cookies.replace(/session_token=;/g, "")), "no session cookie");
  assert.equal((await database().select().from(t.session).where(eq(t.session.userId, member.id))).length, 1, "only the activation session exists");
  await assertNoAccess(client, "pending challenge");
  // The challenge cookie unlocks nothing except the verification endpoints.
  for (const [path, body] of [
    [`${AUTH}/two-factor/disable`, { password: FIXTURE_PASSWORD }],
    [`${AUTH}/two-factor/generate-backup-codes`, { password: FIXTURE_PASSWORD }],
    [`${AUTH}/two-factor/enable`, { password: FIXTURE_PASSWORD }],
    [CHANGE, { currentPassword: FIXTURE_PASSWORD, newPassword: "Orchid-Lantern-Meadow-0-Quartz" }],
    ["/api/academy/players/save", {}],
  ] as const)
    assert.equal((await client.post(path, body)).status, 401, path);
  // Only the genuine code finishes it.
  assert.equal((await answer(client, "123456")).status, 401);
  assert.equal(client.hasSession(), false);
  const done = await answer(client, e.code());
  assert.equal(done.status, 200);
  assert.equal((await client.get("/api/academy/identity")).status, 200);
});
test("a wrong password never reaches the second step and looks like any other failure", async () => {
  const member = await newMember();
  await enroll(member);
  const wrong = await app.anonymous().signIn(member.email, "Wrong-Guess-Entirely-1");
  const unknown = await app.anonymous().signIn("ghost@example.test", "Wrong-Guess-Entirely-1");
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.json, unknown.json);
});
test("the second step cannot be started without the first, or with someone else's challenge", async () => {
  const a = await newMember();
  const b = await newMember();
  const ea = await enroll(a);
  const eb = await enroll(b);
  const bare = app.anonymous();
  assert.equal((await answer(bare, ea.code())).status, 401);
  assert.equal((await bare.post(`${TF}/verify-backup-code`, { code: ea.backupCodes[0] })).status, 401);
  // A forged challenge cookie is worthless.
  const forged = await bare.post(`${TF}/verify-totp`, { code: eb.code() }, { headers: { cookie: "better-auth.two_factor=forged.value" } });
  assert.equal(forged.status, 401);
  // A's challenge answered with B's authenticator fails; A's own code then still works.
  const { client } = await startChallenge(app, a.email);
  assert.equal((await answer(client, eb.code())).status, 401);
  assert.equal((await answer(client, ea.code())).status, 200);
});
test("trusted devices are refused, so the second factor cannot be skipped later", async () => {
  const member = await newMember();
  const e = await enroll(member);
  const { client } = await startChallenge(app, member.email);
  const r = await client.post(`${TF}/verify-totp`, { code: e.code(), trustDevice: true });
  assert.equal(r.status, 400);
  assert.equal(code(r), "TRUST_DEVICE_DISABLED");
  assert.equal(client.hasSession(), false);
  const ok = await answer(client, e.code());
  assert.equal(ok.status, 200);
  assert.ok(!ok.setCookies.some((c) => c.includes("trust_device")), "no device-trust cookie is ever set");
  const backup = await startChallenge(app, member.email);
  const refused = await backup.client.post(`${TF}/verify-backup-code`, { code: e.backupCodes[0], trustDevice: true });
  assert.equal(refused.status, 400);
  // And a later password sign-in still demands the factor.
  assert.ok(twoFactorRedirect((await startChallenge(app, member.email)).step1));
});
test("replay: an authenticator code works once, even on a different challenge", async () => {
  const member = await newMember();
  const e = await enroll(member);
  const used = e.code();
  const first = await startChallenge(app, member.email);
  assert.equal((await answer(first.client, used)).status, 200);
  const second = await startChallenge(app, member.email);
  const replay = await answer(second.client, used);
  assert.equal(replay.status, 401, "the same code is refused the second time");
  assert.equal(second.client.hasSession(), false);
  // A different valid code still gets in (positive control for the same challenge).
  assert.equal((await answer(second.client, e.code())).status, 200);
});
test("replay: the code that activated the authenticator cannot be reused to sign in", async () => {
  const member = await newMember();
  await stableWindow();
  const client = await signedIn(member.email);
  const uri = parseProvisioningUri(((await client.post(`${TF}/enable`, { password: FIXTURE_PASSWORD })).json as { totpURI: string }).totpURI);
  const activation = totpAt(uri.secret, 0);
  assert.equal((await client.post(`${TF}/verify-totp`, { code: activation })).status, 200);
  const { client: next } = await startChallenge(app, member.email);
  assert.equal((await answer(next, activation)).status, 401);
  assert.equal((await answer(next, totpAt(uri.secret, 1))).status, 200);
});
test("replay: two simultaneous sign-ins presenting the same code cannot both succeed", async () => {
  const member = await newMember();
  const e = await enroll(member);
  const a = await startChallenge(app, member.email);
  const b = await startChallenge(app, member.email);
  const shared = e.code();
  const [ra, rb] = await Promise.all([answer(a.client, shared), answer(b.client, shared)]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 401]);
});
test("an unanswered challenge expires and an answered one cannot be answered again", async () => {
  const member = await newMember();
  const e = await enroll(member);
  const { client } = await startChallenge(app, member.email);
  await database().update(t.verification).set({ expiresAt: new Date(Date.now() - 1000) });
  assert.equal((await answer(client, e.code())).status, 401, "expired challenge");
  const fresh = await startChallenge(app, member.email);
  const copy = fresh.client.clone();
  assert.equal((await answer(fresh.client, e.code())).status, 200);
  // Even a genuine recovery code is refused on the answered challenge: it was consumed.
  assert.equal((await copy.post(`${TF}/verify-backup-code`, { code: e.backupCodes[0] })).status, 401, "a consumed challenge is gone");
  assert.equal((await answer(copy, "123456")).status, 401);
});
test("brute force: five wrong codes burn the challenge", async () => {
  const member = await newMember();
  const e = await enroll(member);
  const { client } = await startChallenge(app, member.email);
  for (let i = 0; i < 5; i++) assert.equal((await answer(client, String(100000 + i))).status, 401);
  // Even the correct code is useless now: the person must start again with their password.
  const dead = await answer(client, e.code());
  assert.ok(dead.status === 400 || dead.status === 401, `status ${dead.status}`);
  assert.equal(client.hasSession(), false);
  const restart = await startChallenge(app, member.email);
  assert.equal((await answer(restart.client, e.code())).status, 200);
});
test("brute force: ten consecutive failures lock the second factor for the account", async () => {
  const member = await newMember();
  const e = await enroll(member);
  for (let round = 0; round < 2; round++) {
    const { client } = await startChallenge(app, member.email);
    for (let i = 0; i < 5; i++) await answer(client, String(200000 + round * 10 + i));
  }
  const locked = await startChallenge(app, member.email);
  const attempt = await answer(locked.client, e.code());
  assert.equal(attempt.status, 429, attempt.text);
  assert.equal(locked.client.hasSession(), false);
  const viaBackup = await locked.client.post(`${TF}/verify-backup-code`, { code: e.backupCodes[0] });
  assert.equal(viaBackup.status, 429, "a recovery code does not get around the lock");
  // Other people are unaffected, and the lock ends by itself.
  const other = await newMember();
  const oe = await enroll(other);
  const oc = await startChallenge(app, other.email);
  assert.equal((await answer(oc.client, oe.code())).status, 200);
  await database().update(t.twoFactor).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(t.twoFactor.userId, member.id));
  const after = await startChallenge(app, member.email);
  assert.equal((await answer(after.client, e.code())).status, 200);
  assert.equal((await rowOf(member.id)).failedVerificationCount, 0, "success clears the failure count");
});
test("recovery codes: each works exactly once and never again", async () => {
  const member = await newMember();
  const e = await enroll(member);
  const [first, second, ...rest] = e.backupCodes;
  const a = await startChallenge(app, member.email);
  const ok = await a.client.post(`${TF}/verify-backup-code`, { code: first });
  assert.equal(ok.status, 200, ok.text);
  assert.ok(a.client.hasSession());
  assert.equal((await a.client.get("/api/academy/identity")).status, 200);
  assert.equal((await events(member.id, "MFA_RECOVERY_CODE_USED")).length, 1);
  const again = await startChallenge(app, member.email);
  assert.equal((await again.client.post(`${TF}/verify-backup-code`, { code: first })).status, 401, "a used code is dead");
  // Another code from the same set still works on the same (still pending) challenge.
  assert.equal((await again.client.post(`${TF}/verify-backup-code`, { code: second })).status, 200);
  // Codes are exact: wrong case and near-misses fail.
  const miss = await startChallenge(app, member.email);
  assert.equal((await miss.client.post(`${TF}/verify-backup-code`, { code: rest[0].toUpperCase() === rest[0] ? rest[0].toLowerCase() : rest[0].toUpperCase() })).status, 401);
  assert.equal((await miss.client.post(`${TF}/verify-backup-code`, { code: rest[0].replace("-", "") })).status, 401);
  assert.equal((await miss.client.post(`${TF}/verify-backup-code`, { code: rest[0] })).status, 200);
  assert.ok(!(await secretBearingRows()).includes(rest[1]));
});
test("recovery codes: one code cannot sign in two people at once", async () => {
  const member = await newMember();
  const e = await enroll(member);
  const a = await startChallenge(app, member.email);
  const b = await startChallenge(app, member.email);
  const [ra, rb] = await Promise.all([
    a.client.post(`${TF}/verify-backup-code`, { code: e.backupCodes[3] }),
    b.client.post(`${TF}/verify-backup-code`, { code: e.backupCodes[3] }),
  ]);
  assert.equal([ra.status, rb.status].filter((s) => s === 200).length, 1, `${ra.status}/${rb.status}`);
});
test("recovery codes can be regenerated with the password; the old set dies", async () => {
  const member = await newMember();
  const e = await enroll(member);
  const client = e.client;
  const gen = `${TF}/generate-backup-codes`;
  assert.equal((await app.anonymous().post(gen, { password: FIXTURE_PASSWORD })).status, 401);
  assert.equal((await client.post(gen, {})).status, 400, "password required");
  assert.equal((await client.post(gen, { password: "not-my-password-at-all" })).status, 400);
  const r = await client.post(gen, { password: FIXTURE_PASSWORD });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const fresh = (r.json as { backupCodes: string[] }).backupCodes;
  fresh.forEach((c) => secretsSeen.add(c));
  assert.equal(fresh.length, 10);
  assert.equal(fresh.filter((c) => e.backupCodes.includes(c)).length, 0);
  const old = await startChallenge(app, member.email);
  assert.equal((await old.client.post(`${TF}/verify-backup-code`, { code: e.backupCodes[0] })).status, 401, "old set is dead");
  assert.equal((await old.client.post(`${TF}/verify-backup-code`, { code: fresh[0] })).status, 200, "new set works");
  assert.equal((await events(member.id, "MFA_RECOVERY_CODES_REGENERATED")).length, 1);
  // A person without MFA has nothing to regenerate.
  const plain = await newMember();
  const pc = await signedIn(plain.email);
  assert.equal((await pc.post(gen, { password: FIXTURE_PASSWORD })).status, 400);
});
test("using every recovery code leaves TOTP working and the account recoverable by an owner", async () => {
  const member = await newMember();
  const e = await enroll(member);
  for (const backup of e.backupCodes) {
    const c = await startChallenge(app, member.email);
    assert.equal((await c.client.post(`${TF}/verify-backup-code`, { code: backup })).status, 200);
  }
  const none = await startChallenge(app, member.email);
  assert.equal((await none.client.post(`${TF}/verify-backup-code`, { code: e.backupCodes[0] })).status, 401);
  // The authenticator itself still works...
  assert.equal((await answer(none.client, e.code())).status, 200);
  // ...and if the device were lost too, the owner can remove the authenticator and re-issue access.
  const owner = await signedIn((await newMember("OWNER")).email);
  const r = await reset(owner, member.id, { resetAuthenticator: true });
  assert.equal(r.status, 200, r.text);
  assert.equal((r.json as ResetResult).authenticatorRemoved, true);
  assert.equal(await rowOf(member.id), undefined);
  assert.equal(await enabled(member.id), false);
});
test("disabling needs a session and the password, ends other sessions, and is recorded", async () => {
  const member = await newMember();
  const e = await enroll(member);
  const client = e.client;
  const other = (async () => {
    const c = await startChallenge(app, member.email);
    assert.equal((await answer(c.client, e.code())).status, 200);
    return c.client;
  })();
  const second = await other;
  assert.equal((await app.anonymous().post(`${TF}/disable`, { password: FIXTURE_PASSWORD })).status, 401);
  assert.equal((await client.post(`${TF}/disable`, {})).status, 400);
  const wrong = await client.post(`${TF}/disable`, { password: "not-my-password-at-all" });
  assert.equal(wrong.status, 400);
  assert.equal(await enabled(member.id), true, "a wrong password disables nothing");
  const r = await client.post(`${TF}/disable`, { password: FIXTURE_PASSWORD });
  assert.equal(r.status, 200, r.text);
  assert.equal(await enabled(member.id), false);
  assert.equal(await rowOf(member.id), undefined, "secret and recovery codes are deleted");
  assert.equal((await second.get("/api/academy/identity")).status, 401, "other sessions end");
  assert.equal((await client.get("/api/academy/identity")).status, 200, "the acting session continues");
  assert.equal((await events(member.id, "MFA_DISABLED")).length, 1);
  // Sign-in is password-only again, and a fresh enrolment works.
  assert.equal(twoFactorRedirect(await app.anonymous().signIn(member.email, FIXTURE_PASSWORD)), false);
  const again = await enroll(member);
  assert.ok(await enabled(member.id));
  assert.notEqual(again.uri.raw, e.uri.raw, "a new secret, not the old one");
});
test("an account that changes its password keeps its second factor", async () => {
  const member = await newMember();
  const e = await enroll(member);
  const next = "Orchid-Lantern-Meadow-901-Quartz";
  assert.equal((await e.client.post(CHANGE, { currentPassword: FIXTURE_PASSWORD, newPassword: next })).status, 200);
  assert.equal(await enabled(member.id), true);
  const { step1 } = await startChallenge(app, member.email, next);
  assert.ok(twoFactorRedirect(step1));
});
test("an expired temporary password is refused before any second factor is offered", async () => {
  const member = await newMember();
  await enroll(member);
  const owner = await signedIn((await newMember("OWNER")).email);
  const r = await reset(owner, member.id);
  assert.equal(r.status, 200);
  const temporary = (r.json as ResetResult).temporaryPassword;
  // Reset without resetAuthenticator keeps MFA: recovery is not a weaker path than normal login.
  const live = await startChallenge(app, member.email, temporary);
  assert.ok(twoFactorRedirect(live.step1), "a temporary password still needs the second factor");
  await setExpiry(member.id, new Date(Date.now() - 1000), hoursFromNow(-73));
  const expired = await startChallenge(app, member.email, temporary);
  assert.equal(expired.step1.status, 403);
  assert.equal(code(expired.step1), "TEMPORARY_PASSWORD_EXPIRED");
  assert.ok(await temporaryRow(member.id));
});
test("sessions record where they came from, never list bearer tokens, and can be ended one by one", async () => {
  const member = await newMember();
  const e = await enroll(member);
  const { client } = await startChallenge(app, member.email);
  const done = await answer(client, e.code());
  assert.equal(done.status, 200);
  const rows = await database().select().from(t.session).where(eq(t.session.userId, member.id));
  assert.ok(rows.length >= 2);
  for (const row of rows) assert.ok(row.ipAddress && row.userAgent !== null, "address and user agent are recorded");
  const list = await client.get("/api/auth/list-sessions");
  assert.equal(list.status, 200);
  const listed = list.json as { id: string; current: boolean; token?: string }[];
  assert.equal(listed.length, rows.length);
  for (const row of rows) assert.ok(!list.text.includes(row.token), "session tokens are not listed");
  assert.ok(listed.every((s) => s.token === undefined));
  assert.equal(listed.filter((s) => s.current).length, 1);
  const other = listed.find((s) => !s.current)!;
  // The stock token-addressed route is closed; the id-addressed one only touches your own sessions.
  assert.ok((await client.post("/api/auth/revoke-session", { token: rows[0].token })).status >= 400);
  const stranger = await newMember();
  const sc = await signedIn(stranger.email);
  const strangerSession = (await database().select().from(t.session).where(eq(t.session.userId, stranger.id)))[0];
  const REVOKE = "/api/auth/account/revoke-session";
  assert.equal((await client.post(REVOKE, { id: strangerSession.id })).status, 404);
  assert.equal((await sc.get("/api/academy/identity")).status, 200, "someone else's session survives");
  assert.equal((await client.post(REVOKE, { id: listed.find((s) => s.current)!.id })).status, 400);
  assert.equal((await app.anonymous().post(REVOKE, { id: other.id })).status, 401);
  assert.equal((await client.post(REVOKE, { id: other.id })).status, 200);
  assert.equal(await sessionsOf(member.id), rows.length - 1);
  assert.equal((await client.post(REVOKE, { id: other.id })).status, 404);
  assert.equal((await client.post("/api/auth/revoke-other-sessions", {})).status, 200);
  assert.equal(await sessionsOf(member.id), 1);
  assert.equal((await client.get("/api/academy/identity")).status, 200);
  assert.ok(!done.setCookies.some((c) => c.includes("trust_device")));
});
test("authenticator secrets and recovery codes never appear in logs, events or other tables", async () => {
  const tables = await secretBearingRows();
  assert.ok(secretsSeen.size > 40, `collected ${secretsSeen.size} secret values to look for`);
  for (const value of secretsSeen) {
    if (value.length < 6) continue;
    assert.ok(!tables.includes(value), `a secret value is stored readable in a security table`);
    assert.ok(!captured.some((line) => line.includes(value)), `a secret value was written to the process output`);
  }
  assert.ok(!captured.some((line) => /otpauth:\/\//.test(line)));
  // Nor does any stored two_factor row hold one in the clear.
  const stored = JSON.stringify(await database().select().from(t.twoFactor));
  for (const value of secretsSeen) if (value.length >= 6) assert.ok(!stored.includes(value));
});
export type { Enrolled };
