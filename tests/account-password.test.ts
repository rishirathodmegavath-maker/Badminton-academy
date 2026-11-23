import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import {
  FIXTURE_PASSWORD,
  ROLES,
  ROLE_USER,
  USERS,
} from "./helpers/fixtures";
import {
  CHANGE,
  NEW_PASSWORD,
  code,
  events,
  hashOf,
  newMember as makeMember,
  sessionsOf,
  signedIn as signIn,
} from "./helpers/accounts";
import { startHarness, type Harness } from "./helpers/harness";
import type { TestClient } from "./helpers/client";
import { HOOK_TIMEOUT } from "./helpers/paths";
/**
 * Authenticated password change, at the HTTP boundary with real Better Auth sessions.
 * Each scenario that changes a password uses its own account so scenarios stay independent.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("account-password");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const newMember = (role: (typeof ROLES)[number] = "COACH") =>
  makeMember(role, "green", "pw");
const signedIn = (email: string, password = FIXTURE_PASSWORD) =>
  signIn(app, email, password);
test("unauthenticated requests cannot change a password or read account state", async () => {
  const anon = app.anonymous();
  const post = await anon.post(CHANGE, {
    currentPassword: FIXTURE_PASSWORD,
    newPassword: NEW_PASSWORD(),
  });
  assert.equal(post.status, 401);
  assert.equal((await anon.get("/api/auth/account/security-state")).status, 401);
  // A forged or unknown session cookie is no better than none.
  const forged = app.anonymous();
  const r = await forged.post(
    CHANGE,
    { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD() },
    { headers: { cookie: "better-auth.session_token=forged.value" } },
  );
  assert.equal(r.status, 401);
});
for (const role of ROLES) {
  test(`${role}: change password succeeds, revokes other sessions and rotates this one`, async () => {
    const key = ROLE_USER[role];
    const user = USERS[key];
    const here = await signedIn(user.email);
    const other = await signedIn(user.email);
    const stolen = here.clone();
    assert.equal(await sessionsOf(user.id), 2);
    const before = await hashOf(user.id);
    const next = NEW_PASSWORD();
    const r = await here.post(CHANGE, {
      currentPassword: FIXTURE_PASSWORD,
      newPassword: next,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((r.json as { status: boolean }).status, true);
    assert.equal(r.headers.get("cache-control"), "no-store");
    // The response carries no hash, token or user record.
    assert.deepEqual(Object.keys(r.json as object).sort(), ["revokedSessions", "status"]);
    assert.notEqual(await hashOf(user.id), before);
    // Policy: every old session is dead (the other device AND the cookie that made the request);
    // exactly one fresh session remains and it works.
    assert.equal(await sessionsOf(user.id), 1);
    assert.equal((await other.get("/api/academy/identity")).status, 401);
    assert.equal((await stolen.get("/api/academy/identity")).status, 401);
    assert.equal((await here.get("/api/academy/identity")).status, 200);
    // Old password is dead, new one works.
    assert.equal((await app.anonymous().signIn(user.email, FIXTURE_PASSWORD)).status, 401);
    assert.equal((await app.anonymous().signIn(user.email, next)).status, 200);
    const [event] = await events(user.id, "PASSWORD_CHANGED");
    assert.ok(event);
    assert.equal(event.actorId, user.id);
    assert.equal((event.detail as { wasTemporary: boolean }).wasTemporary, false);
    assert.ok(!JSON.stringify(event).includes(next) && !JSON.stringify(event).includes(FIXTURE_PASSWORD));
  });
}
test("wrong current password changes nothing and is recorded", async () => {
  const member = await newMember();
  const client = await signedIn(member.email);
  const before = await hashOf(member.id);
  const r = await client.post(CHANGE, {
    currentPassword: "definitely-not-my-password",
    newPassword: NEW_PASSWORD(),
  });
  assert.equal(r.status, 400);
  assert.equal(code(r), "INVALID_PASSWORD");
  assert.equal(await hashOf(member.id), before);
  assert.equal(await sessionsOf(member.id), 1);
  assert.equal((await client.get("/api/academy/identity")).status, 200);
  assert.equal((await events(member.id, "PASSWORD_CHANGE_FAILED")).length, 1);
  // A success after the failure still works (no accidental lock-out from one typo).
  const ok = await client.post(CHANGE, {
    currentPassword: FIXTURE_PASSWORD,
    newPassword: NEW_PASSWORD(),
  });
  assert.equal(ok.status, 200);
});
test("weak, reused and malformed new passwords are rejected without side effects", async () => {
  const member = await newMember();
  const before = await hashOf(member.id);
  const local = member.email.split("@")[0];
  // Each client has its own address, and the endpoint allows 5 requests a minute per address, so
  // the many cases below are spread over several clients.
  let client = await signedIn(member.email);
  let used = 0;
  const post = async (body: unknown, init: Parameters<TestClient["post"]>[2] = {}) => {
    if (used++ % 4 === 3) client = await signedIn(member.email);
    return client.post(CHANGE, body, init);
  };
  const cases: [unknown, string][] = [
    [{ currentPassword: FIXTURE_PASSWORD, newPassword: "Short-1aB" }, "WEAK_PASSWORD"],
    [{ currentPassword: FIXTURE_PASSWORD, newPassword: "Password12345" }, "WEAK_PASSWORD"],
    [{ currentPassword: FIXTURE_PASSWORD, newPassword: "aaaaaaaaaaaaaaaa" }, "WEAK_PASSWORD"],
    [{ currentPassword: FIXTURE_PASSWORD, newPassword: `xx-${local}-xx-123` }, "WEAK_PASSWORD"],
    [{ currentPassword: FIXTURE_PASSWORD, newPassword: FIXTURE_PASSWORD }, "PASSWORD_UNCHANGED"],
  ];
  for (const [body, expected] of cases) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(code(r), expected, JSON.stringify(body));
    assert.ok(!r.text.includes((body as { newPassword: string }).newPassword));
  }
  for (const body of [
    {},
    { currentPassword: FIXTURE_PASSWORD },
    { newPassword: NEW_PASSWORD() },
    { currentPassword: 1, newPassword: NEW_PASSWORD() },
    { currentPassword: FIXTURE_PASSWORD, newPassword: ["x"] },
    { currentPassword: FIXTURE_PASSWORD, newPassword: "x".repeat(129) },
    { currentPassword: "x".repeat(129), newPassword: NEW_PASSWORD() },
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
  }
  const raw = await post({}, { raw: "not json" });
  assert.ok(raw.status === 400 || raw.status === 415, `raw ${raw.status}`);
  assert.equal(await hashOf(member.id), before);
  assert.equal((await client.get("/api/academy/identity")).status, 200);
});
test("a cross-site request cannot change a password even with a valid session cookie", async () => {
  const member = await newMember();
  const client = await signedIn(member.email);
  const before = await hashOf(member.id);
  const body = { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD() };
  for (const origin of ["https://evil.example", "http://127.0.0.1:1", "null"]) {
    const r = await client.post(CHANGE, body, { origin });
    assert.ok(r.status === 403, `${origin}: ${r.status}`);
  }
  assert.equal(await hashOf(member.id), before);
  // The same request from the real origin is the positive control.
  assert.equal((await client.post(CHANGE, body)).status, 200);
});
test("the stock password and account routes are not reachable", async () => {
  const member = await newMember();
  const client = await signedIn(member.email);
  const before = await hashOf(member.id);
  const next = NEW_PASSWORD();
  const attempts: [string, unknown][] = [
    ["/api/auth/change-password", { currentPassword: FIXTURE_PASSWORD, newPassword: next, revokeOtherSessions: false }],
    ["/api/auth/set-password", { newPassword: next }],
    ["/api/auth/request-password-reset", { email: member.email }],
    ["/api/auth/reset-password", { newPassword: next, token: "x" }],
    ["/api/auth/send-verification-email", { email: member.email }],
    ["/api/auth/change-email", { newEmail: "other@example.test" }],
    ["/api/auth/delete-user", { password: FIXTURE_PASSWORD }],
    ["/api/auth/two-factor/get-totp-uri", { password: FIXTURE_PASSWORD }],
    ["/api/auth/two-factor/view-backup-codes", { userId: member.id }],
    ["/api/auth/two-factor/generate-totp", { secret: "x" }],
    // A password oracle for a stolen session (overnight audit S-1): the application never calls it.
    ["/api/auth/verify-password", { password: FIXTURE_PASSWORD }],
  ];
  for (const [path, body] of attempts) {
    const r = await client.post(path, body);
    assert.ok(r.status >= 400 && r.status < 500, `${path}: ${r.status}`);
  }
  assert.equal((await client.get("/api/auth/reset-password/sometoken?callbackURL=/")).status >= 300, true);
  assert.equal(await hashOf(member.id), before);
  assert.equal((await app.anonymous().signIn(member.email, FIXTURE_PASSWORD)).status, 200);
  const stillThere = await database().select().from(t.user).where(eq(t.user.id, member.id));
  assert.equal(stillThere.length, 1);
});
test("no response or log row exposes a password hash or any password", async () => {
  const member = await newMember("FINANCE");
  const client = await signedIn(member.email);
  const hash = await hashOf(member.id);
  const fragments = [hash, ...hash.split(":"), hash.slice(0, 40)];
  const next = NEW_PASSWORD();
  const responses = [
    await client.get("/api/auth/get-session"),
    await client.get("/api/auth/list-sessions"),
    await client.get("/api/auth/account/security-state"),
    await client.get("/api/academy"),
    await client.get("/api/academy/identity"),
    await client.post(CHANGE, { currentPassword: FIXTURE_PASSWORD, newPassword: next }),
  ];
  for (const r of responses)
    for (const fragment of fragments)
      assert.ok(!r.text.includes(fragment), `response leaks stored hash material (${r.status})`);
  const stored = JSON.stringify(await database().select().from(t.securityEvent));
  assert.ok(!stored.includes(next) && !stored.includes(FIXTURE_PASSWORD));
  const newHash = await hashOf(member.id);
  for (const r of responses) assert.ok(!r.text.includes(newHash));
});
test("two simultaneous changes: exactly one wins and the account stays consistent", async () => {
  const member = await newMember();
  const a = await signedIn(member.email);
  const b = await signedIn(member.email);
  const first = NEW_PASSWORD();
  const second = NEW_PASSWORD();
  const [ra, rb] = await Promise.all([
    a.post(CHANGE, { currentPassword: FIXTURE_PASSWORD, newPassword: first }),
    b.post(CHANGE, { currentPassword: FIXTURE_PASSWORD, newPassword: second }),
  ]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, [200, 409], `${ra.status}/${rb.status}`);
  const winner = ra.status === 200 ? first : second;
  const loser = ra.status === 200 ? second : first;
  assert.equal((await app.anonymous().signIn(member.email, winner)).status, 200);
  assert.equal((await app.anonymous().signIn(member.email, loser)).status, 401);
  assert.equal((await app.anonymous().signIn(member.email, FIXTURE_PASSWORD)).status, 401);
  // The winner's replacement session is the only live one (plus the two sign-ins just made).
  const live = await sessionsOf(member.id);
  assert.ok(live >= 1 && live <= 3, `sessions: ${live}`);
});
test("repeated sequential changes work and only the latest password is valid", async () => {
  const member = await newMember();
  const client = await signedIn(member.email);
  const second = NEW_PASSWORD();
  const third = NEW_PASSWORD();
  assert.equal((await client.post(CHANGE, { currentPassword: FIXTURE_PASSWORD, newPassword: second })).status, 200);
  assert.equal((await client.post(CHANGE, { currentPassword: second, newPassword: third })).status, 200);
  // The first password is no longer the "current" one.
  const stale = await client.post(CHANGE, { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD() });
  assert.equal(stale.status, 400);
  assert.equal(code(stale), "INVALID_PASSWORD");
  assert.equal((await app.anonymous().signIn(member.email, third)).status, 200);
  assert.equal((await events(member.id, "PASSWORD_CHANGED")).length, 2);
});
test("change-password is rate limited per client address", async () => {
  const member = await newMember();
  const client = await signedIn(member.email);
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++)
    statuses.push(
      (await client.post(CHANGE, { currentPassword: "wrong-wrong-wrong", newPassword: NEW_PASSWORD() })).status,
    );
  assert.deepEqual(statuses.slice(0, 5), [400, 400, 400, 400, 400]);
  assert.ok(statuses.slice(5).every((s) => s === 429), statuses.join(","));
  // The limit is per address: someone else is unaffected.
  const bystander = await newMember();
  const other = await signedIn(bystander.email);
  assert.equal(
    (await other.post(CHANGE, { currentPassword: FIXTURE_PASSWORD, newPassword: NEW_PASSWORD() })).status,
    200,
  );
});
test("a new password cannot contain the owner's own details", async () => {
  const member = await newMember();
  const client = await signedIn(member.email);
  const r = await client.post(CHANGE, {
    currentPassword: FIXTURE_PASSWORD,
    newPassword: `Fixture-${member.id}-Orchid`,
  });
  assert.equal(r.status, 400);
  assert.equal(code(r), "WEAK_PASSWORD");
});
export type { TestClient };
