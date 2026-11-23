import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import {
  FIXTURE_PASSWORD,
  ROLES,
  ROLE_USER,
  USERS,
  addFixtureUser,
} from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { corrupt } from "./helpers/client";
import { HOOK_TIMEOUT } from "./helpers/paths";
/**
 * Authentication, session-based role resolution and authorization at the HTTP boundary.
 * Everything goes over a real HTTP socket with real Better Auth sessions (no synthetic actors).
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("http-auth");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const error = (r: { json: unknown }) =>
  (r.json as { error?: string } | null)?.error;
test("unauthenticated requests are rejected on every API area", async () => {
  const anon = app.anonymous();
  for (const path of [
    "/api/academy",
    "/api/academy/identity",
    "/api/training",
  ]) {
    const r = await anon.get(path);
    assert.equal(r.status, 401, path);
    assert.match(error(r) ?? "", /sign in/i);
  }
  const post = await anon.post("/api/academy/players/save", {});
  assert.equal(post.status, 401);
});
test("sign-in rejects a wrong password and an unknown account without issuing a session", async () => {
  for (const [email, password] of [
    [USERS.owner.email, "definitely-the-wrong-password"],
    ["nobody.canary@example.test", FIXTURE_PASSWORD],
  ]) {
    const client = app.anonymous();
    const r = await client.signIn(email, password);
    assert.equal(r.status, 401, email);
    assert.equal(client.hasSession(), false);
    assert.equal((await client.get("/api/academy")).status, 401);
  }
});
test("each of the eight roles signs in and the session resolves to its membership role", async () => {
  for (const role of ROLES) {
    const client = await app.as(ROLE_USER[role]);
    assert.ok(client.hasSession(), role);
    const identity = await client.get("/api/academy/identity");
    assert.equal(identity.status, 200, role);
    // Phase 9 added the user id and the academy's own name and accent colour for the app shell.
    assert.deepEqual(identity.json, {
      role,
      name: USERS[ROLE_USER[role]].name,
      userId: USERS[ROLE_USER[role]].id,
      academy: { name: "Fixture Green Academy", accent: "#17644e", logo: null },
    });
    const bootstrap = await client.get("/api/academy");
    assert.equal(bootstrap.status, 200, role);
    const actor = (
      bootstrap.json as { actor: { role: string; academyId: string } }
    ).actor;
    assert.equal(actor.role, role);
    assert.equal(actor.academyId, "green");
  }
});
test("a missing, tampered or foreign session cookie grants nothing", async () => {
  const owner = await app.as("owner");
  const tampered = app.anonymous();
  const [name, value] = owner.sessionCookie!;
  // Alter the signed token itself, and (separately) its signature part; both must be rejected.
  const response = await tampered.request("/api/academy", {
    headers: { cookie: `${name}=${corrupt(value)}` },
  });
  assert.equal(response.status, 401, "tampered token accepted");
  const badSignature = await tampered.request("/api/academy", {
    headers: { cookie: `${name}=${corrupt(value, value.length - 1)}` },
  });
  assert.equal(badSignature.status, 401, "tampered signature accepted");
  assert.equal(
    (await owner.get("/api/academy/identity")).status,
    200,
    "the genuine cookie must still work (control)",
  );
  const forged = await tampered.request("/api/academy", {
    headers: { cookie: "better-auth.session_token=forged.value" },
  });
  assert.equal(forged.status, 401);
});
test("signing out revokes the session server-side (the old cookie stops working)", async () => {
  const client = app.anonymous();
  assert.equal(
    (await client.signIn(USERS.admin.email, FIXTURE_PASSWORD)).status,
    200,
  );
  const stolen = client.clone();
  assert.equal((await stolen.get("/api/academy/identity")).status, 200);
  assert.equal((await client.signOut()).status, 200);
  assert.equal(client.hasSession(), false);
  assert.equal((await stolen.get("/api/academy/identity")).status, 401);
});
test("an expired session row is rejected", async () => {
  const client = app.anonymous();
  const { id } = await addFixtureUser("fx-expiring", [
    { academyId: "green", role: "COACH" },
  ]);
  assert.equal(
    (await client.signIn(`${id}.canary@example.test`, FIXTURE_PASSWORD)).status,
    200,
  );
  assert.equal((await client.get("/api/academy/identity")).status, 200);
  await database()
    .update(t.session)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(t.session.userId, id));
  assert.equal((await client.get("/api/academy/identity")).status, 401);
});
test("membership rules are enforced from the live database on every request", async () => {
  const db = database();
  // No membership at all.
  const none = await addFixtureUser("fx-none", []);
  const noneClient = app.anonymous();
  await noneClient.signIn(none.email, FIXTURE_PASSWORD);
  const noMembership = await noneClient.get("/api/academy/identity");
  assert.equal(noMembership.status, 403);
  assert.match(error(noMembership) ?? "", /not assigned to an academy/i);
  assert.equal((noMembership.json as { code?: string }).code, "NO_MEMBERSHIP");
  // Two active memberships (Phase 2, migration 0017): one person may belong to several academies. Until they choose
  // which one this session works in, nothing is readable and the answer says so (409, a stable code that names no academy);
  // it is no longer the old "exactly one membership" refusal. Choosing, and everything after, is multi-academy-selection.test.ts.
  const two = await addFixtureUser("fx-two", [
    { academyId: "green", role: "COACH" },
    { academyId: "blue", role: "COACH" },
  ]);
  const twoClient = app.anonymous();
  await twoClient.signIn(two.email, FIXTURE_PASSWORD);
  for (const path of ["/api/academy/identity", "/api/academy", "/api/training"]) {
    const unchosen = await twoClient.get(path);
    assert.equal(unchosen.status, 409, path);
    assert.equal((unchosen.json as { code?: string }).code, "ACADEMY_SELECTION_REQUIRED", path);
  }
  // Deactivation applies immediately to an already signed-in session; reactivation restores it.
  const mover = await addFixtureUser("fx-mover", [
    { academyId: "green", role: "COACH" },
  ]);
  const client = app.anonymous();
  await client.signIn(mover.email, FIXTURE_PASSWORD);
  const where = and(
    eq(t.memberships.userId, mover.id),
    eq(t.memberships.academyId, "green"),
  );
  assert.equal(
    ((await client.get("/api/academy/identity")).json as { role: string }).role,
    "COACH",
  );
  await db.update(t.memberships).set({ active: false }).where(where);
  assert.equal((await client.get("/api/academy/identity")).status, 403);
  await db
    .update(t.memberships)
    .set({ active: true, role: "GUARDIAN" })
    .where(where);
  assert.equal(
    ((await client.get("/api/academy/identity")).json as { role: string }).role,
    "GUARDIAN",
  );
});
test("Training Studio is limited to coaching staff; the academy API serves every role", async () => {
  const allowed = new Set(["OWNER", "ADMIN", "HEAD_COACH", "COACH"]);
  for (const role of ROLES) {
    const client = await app.as(ROLE_USER[role]);
    const r = await client.get("/api/training");
    assert.equal(r.status, allowed.has(role) ? 200 : 403, role);
  }
});
test("writes require the app's own Origin, before authentication is considered", async () => {
  const owner = await app.as("owner");
  for (const origin of ["https://evil.example", "http://127.0.0.1:1"]) {
    const r = await owner.request("/api/academy/players/save", {
      method: "POST",
      body: {},
      origin,
    });
    assert.equal(r.status, 403, origin);
    assert.match(error(r) ?? "", /origin/i);
  }
  const missing = await owner.request("/api/academy/players/save", {
    method: "POST",
    body: {},
    origin: null,
  });
  assert.equal(missing.status, 403);
  const training = await owner.request("/api/training/sessions", {
    method: "POST",
    body: {},
    origin: "https://evil.example",
  });
  assert.equal(training.status, 403);
  // The anonymous user with a bad origin also gets 403 (origin is checked first).
  const anon = await app.anonymous().request("/api/academy/players/save", {
    method: "POST",
    body: {},
    origin: "https://evil.example",
  });
  assert.equal(anon.status, 403);
});
/**
 * Authorization is evaluated before payload validation in these actions, so an empty body
 * separates the outcomes cleanly: 403 = role refused, 422 = role accepted (validation failed).
 */
const matrix: [route: string, allowed: string[]][] = [
  ["players/save", ["OWNER", "ADMIN", "HEAD_COACH"]],
  ["players/guardian", ["OWNER", "ADMIN", "HEAD_COACH"]],
  ["admissions/save", ["OWNER", "ADMIN", "HEAD_COACH"]],
  ["calendar/event", ["OWNER", "ADMIN", "HEAD_COACH"]],
  ["calendar/preview", ["OWNER", "ADMIN", "HEAD_COACH"]],
  ["settings/save", ["OWNER", "ADMIN"]],
  ["settings/branch", ["OWNER", "ADMIN", "HEAD_COACH"]],
  ["settings/member", ["OWNER"]],
  ["fees/plan", ["OWNER", "ADMIN", "FINANCE"]],
  ["communications/template", ["OWNER", "ADMIN", "HEAD_COACH"]],
  ["reports/create", ["OWNER", "ADMIN", "HEAD_COACH", "COACH"]],
  ["media/review", ["OWNER", "ADMIN", "HEAD_COACH", "COACH"]],
];
test("action authorization is enforced per role at the HTTP boundary", async () => {
  for (const [route, allowed] of matrix)
    for (const role of ROLES) {
      const client = await app.as(ROLE_USER[role]);
      const r = await client.post(`/api/academy/${route}`, {});
      assert.equal(
        r.status,
        allowed.includes(role) ? 422 : 403,
        `${role} ${route}: ${r.status} ${error(r)}`,
      );
    }
});
test("unknown routes, malformed JSON and oversized bodies are rejected cleanly", async () => {
  const owner = await app.as("owner");
  assert.equal((await owner.post("/api/academy/not/a/route", {})).status, 404);
  assert.equal((await owner.get("/api/academy/not-a-route")).status, 404);
  const bad = await owner.request("/api/academy/players/save", {
    method: "POST",
    raw: "{not json",
  });
  assert.equal(bad.status, 400);
  const big = await owner.request("/api/academy/players/save", {
    method: "POST",
    raw: JSON.stringify({ pad: "x".repeat(600_000) }),
  });
  assert.equal(big.status, 413);
});
test("development session cookie: HttpOnly, SameSite=Lax, 12-hour lifetime, host-only, no Secure flag", async () => {
  const client = app.anonymous();
  const r = await client.signIn(USERS.owner.email, FIXTURE_PASSWORD);
  assert.equal(r.status, 200);
  const cookie = r.setCookies.find((c) => c.includes("session_token"));
  assert.ok(cookie, "no session cookie issued");
  assert.match(cookie, /^better-auth\.session_token=/);
  assert.match(cookie, /;\s*HttpOnly/i);
  assert.match(cookie, /;\s*SameSite=Lax/i);
  assert.match(cookie, /;\s*Path=\//i);
  assert.match(cookie, /;\s*Max-Age=43200(;|$)/i);
  assert.doesNotMatch(cookie, /;\s*Domain=/i, "cookie must be host-only");
  assert.doesNotMatch(
    cookie,
    /;\s*Secure/i,
    "Secure is a production-only flag here",
  );
});
