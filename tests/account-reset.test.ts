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
  addFixtureUser,
} from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { OWNER_REAUTH_MAX_FAILURES } from "../src/modules/identity/sign-in-throttle";
import {
  CHANGE,
  NEW_PASSWORD,
  STATE,
  code,
  events,
  hashOf,
  newMember as makeMember,
  reset,
  secretBearingRows,
  sessionsOf,
  signedIn as signIn,
  temporaryRow,
  type ResetResult,
} from "./helpers/accounts";
/**
 * Owner-authorised administrative reset: who may do it, to whom, what it leaves behind, and what a
 * person holding a temporary password can and cannot do afterwards. Everything is exercised over
 * HTTP with real sessions; authority is checked against the database, never the UI.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("account-reset");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const newMember = (
  role: (typeof ROLES)[number] = "COACH",
  academy: "green" | "blue" | "quiet" = "green",
) => makeMember(role, academy, "rs");
const signedIn = (email: string, password = FIXTURE_PASSWORD) =>
  signIn(app, email, password);
const result = (r: { json: unknown }) => r.json as ResetResult;
// A fresh sign-in per use: every client has its own address, so per-address limits do not couple tests.
const owner = () => signedIn(USERS.owner.email);
test("unauthenticated and forged requests cannot reset anything", async () => {
  const target = await newMember();
  const before = await hashOf(target.id);
  const anon = app.anonymous();
  assert.equal((await reset(anon, target.id)).status, 401);
  const forged = await reset(
    app.anonymous(),
    target.id,
    {},
    { headers: { cookie: "better-auth.session_token=forged.value" } },
  );
  assert.equal(forged.status, 401);
  assert.equal(await hashOf(target.id), before);
  assert.equal(await temporaryRow(target.id), undefined);
});
test("authorization matrix: only an OWNER can initiate a reset, for every role", async () => {
  for (const role of ROLES) {
    const target = await newMember("COACH");
    const before = await hashOf(target.id);
    const initiator = await app.as(ROLE_USER[role]);
    // The password is correct for every initiator, so a refusal can only be about the role.
    const r = await reset(initiator, target.id);
    if (role === "OWNER") {
      assert.equal(r.status, 200, `${role}: ${r.text}`);
      assert.notEqual(
        await hashOf(target.id),
        before,
        "positive control: the owner's reset took effect",
      );
      assert.ok(await temporaryRow(target.id));
    } else {
      assert.equal(r.status, 403, `${role}: ${r.status}`);
      assert.equal(code(r), "NOT_OWNER", role);
      assert.equal(
        await hashOf(target.id),
        before,
        `${role} must not change the target`,
      );
      assert.equal(await temporaryRow(target.id), undefined, role);
      assert.ok(!r.text.includes("temporaryPassword"));
    }
  }
});
test("ADMIN is not silently given reset power and the denial is recorded", async () => {
  const target = await newMember("GUARDIAN");
  const admin = await app.as("admin");
  const r = await reset(admin, target.id);
  assert.equal(r.status, 403);
  assert.equal(code(r), "NOT_OWNER");
  const [denial] = await events(target.id, "ADMIN_RESET_DENIED");
  assert.ok(denial);
  assert.equal(denial.actorId, USERS.admin.id);
  assert.equal((denial.detail as { reason: string }).reason, "NOT_OWNER");
});
test("role is read from the database membership, not from anything the client sends", async () => {
  const target = await newMember();
  const coach = await app.as("coach");
  const r = await reset(coach, target.id, {
    role: "OWNER",
    academyId: "green",
    actor: USERS.owner.id,
    asOwner: true,
  });
  assert.equal(r.status, 403);
  assert.equal(await temporaryRow(target.id), undefined);
  // A deactivated owner membership loses the power immediately.
  const spare = await addFixtureUser(`rs-spare-owner-${Date.now()}`, [
    { academyId: "green", role: "OWNER" },
  ]);
  const client = await signedIn(spare.email);
  const victim = await newMember();
  assert.equal((await reset(client, victim.id)).status, 200);
  await database()
    .update(t.memberships)
    .set({ active: false })
    .where(eq(t.memberships.userId, spare.id));
  const another = await newMember();
  const after = await reset(client, another.id);
  assert.ok(after.status === 403, `deactivated owner: ${after.status}`);
  assert.equal(await temporaryRow(another.id), undefined);
});
test("cross-academy: an owner cannot reset another academy's member, in either direction", async () => {
  const greenCoach = await newMember("COACH", "green");
  const blueCoach = await newMember("COACH", "blue");
  const greenBefore = await hashOf(greenCoach.id);
  const blueBefore = await hashOf(blueCoach.id);
  const blueOwner = await app.as("blueOwner");
  const greenOwner = await owner();
  const toGreen = await reset(blueOwner, greenCoach.id);
  const toBlue = await reset(greenOwner, blueCoach.id);
  const unknown = await reset(greenOwner, "no-such-user-id");
  for (const r of [toGreen, toBlue, unknown]) {
    assert.equal(r.status, 404);
    assert.equal(code(r), "TARGET_NOT_MEMBER");
  }
  // Indistinguishable from an id that does not exist at all.
  assert.deepEqual(toGreen.json, unknown.json);
  assert.deepEqual(toBlue.json, unknown.json);
  assert.equal(await hashOf(greenCoach.id), greenBefore);
  assert.equal(await hashOf(blueCoach.id), blueBefore);
  assert.equal(await temporaryRow(greenCoach.id), undefined);
  assert.equal(await temporaryRow(blueCoach.id), undefined);
  // Positive control: each owner can reset their own academy's member.
  assert.equal((await reset(blueOwner, blueCoach.id)).status, 200);
  assert.equal((await reset(greenOwner, greenCoach.id)).status, 200);
  // The denial rows never reference a foreign or invented user id.
  const rows = await database()
    .select()
    .from(t.securityEvent)
    .where(eq(t.securityEvent.event, "ADMIN_RESET_DENIED"));
  for (const row of rows) assert.notEqual(row.targetUserId, "no-such-user-id");
});
test("an owner cannot reset their own account, another owner, or a person who also belongs to another academy", async () => {
  const greenOwner = await owner();
  const own = await reset(greenOwner, USERS.owner.id);
  assert.equal(own.status, 403);
  assert.equal(code(own), "SELF");
  const otherOwner = await newMember("OWNER");
  const ownerHash = await hashOf(otherOwner.id);
  const peer = await reset(greenOwner, otherOwner.id);
  assert.equal(peer.status, 403);
  assert.equal(code(peer), "TARGET_IS_OWNER");
  assert.equal(await hashOf(otherOwner.id), ownerHash);
  const both = await addFixtureUser(`rs-both-${Date.now()}`, [
    { academyId: "green", role: "COACH" },
    { academyId: "blue", role: "COACH" },
  ]);
  const shared = await reset(greenOwner, both.id);
  assert.equal(shared.status, 409);
  assert.equal(code(shared), "TARGET_MULTI_ACADEMY");
  // An inactive member is not a member to reset.
  const gone = await newMember("COACH");
  await database()
    .update(t.memberships)
    .set({ active: false })
    .where(eq(t.memberships.userId, gone.id));
  assert.equal(code(await reset(greenOwner, gone.id)), "TARGET_NOT_MEMBER");
  assert.equal(await temporaryRow(USERS.owner.id), undefined);
});
test("a reason and the owner's own password are mandatory", async () => {
  const target = await newMember();
  const before = await hashOf(target.id);
  let client = await signedIn(USERS.owner.email);
  let used = 0;
  const post = async (overrides: Record<string, unknown>) => {
    if (used++ % 4 === 3) client = await signedIn(USERS.owner.email);
    return reset(client, target.id, overrides);
  };
  for (const reason of [undefined, "", "   ", "too short", "x".repeat(501)]) {
    const r = await post({ reason });
    assert.equal(
      r.status,
      400,
      `reason ${JSON.stringify(reason)?.slice(0, 20)}`,
    );
  }
  for (const ownerPassword of [undefined, "", 5]) {
    const r = await post({ ownerPassword });
    assert.equal(
      r.status,
      400,
      `ownerPassword ${JSON.stringify(ownerPassword)}`,
    );
  }
  const wrong = await post({ ownerPassword: "not-the-owner-password" });
  assert.equal(wrong.status, 403);
  assert.equal(code(wrong), "REAUTHENTICATION_FAILED");
  assert.equal(await hashOf(target.id), before);
  assert.equal(await temporaryRow(target.id), undefined);
  // Positive control: the same request with both supplied works.
  assert.equal((await post({})).status, 200);
});
test("a successful reset: temporary password, 72 hours, revoked sessions, audit trail, no plaintext stored", async () => {
  const target = await newMember("GUARDIAN");
  const device1 = await signedIn(target.email);
  const device2 = await signedIn(target.email);
  const oldHash = await hashOf(target.id);
  const reason =
    "Parent lost their phone and asked for access at the front desk.";
  const startedAt = Date.now();
  const r = await reset(await owner(), target.id, { reason });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = result(r);
  assert.deepEqual(Object.keys(body).sort(), [
    "authenticatorRemoved",
    "expiresAt",
    "revokedSessions",
    "temporaryPassword",
    "userId",
  ]);
  assert.match(
    body.temporaryPassword,
    /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/,
  );
  assert.equal(body.userId, target.id);
  assert.equal(body.revokedSessions, 2);
  const lifetime = new Date(body.expiresAt).getTime() - startedAt;
  assert.ok(
    Math.abs(lifetime - 72 * 3600 * 1000) < 60_000,
    `lifetime ${lifetime}`,
  );
  // Old sessions and the old password are dead.
  assert.equal(await sessionsOf(target.id), 0);
  assert.equal((await device1.get("/api/academy/identity")).status, 401);
  assert.equal((await device2.get("/api/academy/identity")).status, 401);
  assert.equal(
    (await app.anonymous().signIn(target.email, FIXTURE_PASSWORD)).status,
    401,
  );
  assert.notEqual(await hashOf(target.id), oldHash);
  // Stored state: a hash (not the plaintext), a marker, and the audit record.
  assert.ok(!(await hashOf(target.id)).includes(body.temporaryPassword));
  const marker = await temporaryRow(target.id);
  assert.equal(marker.issuedBy, USERS.owner.id);
  assert.equal(marker.source, "OWNER_RESET");
  assert.equal(marker.expiresAt.toISOString(), body.expiresAt);
  const [event] = await events(target.id, "ADMIN_PASSWORD_RESET");
  assert.equal(event.actorId, USERS.owner.id);
  assert.equal(event.academyId, "green");
  assert.ok(Date.now() - event.createdAt.getTime() < 60_000);
  assert.equal((event.detail as { reason: string }).reason, reason);
  assert.equal(
    (event.detail as { revokedSessions: number }).revokedSessions,
    2,
  );
  // The temporary password is returned once and exists nowhere in readable form.
  assert.ok(!(await secretBearingRows()).includes(body.temporaryPassword));
  assert.ok(
    !JSON.stringify(await database().select().from(t.account)).includes(
      body.temporaryPassword,
    ),
  );
  // Positive control: the temporary password signs the person in.
  assert.equal(
    (await app.anonymous().signIn(target.email, body.temporaryPassword)).status,
    200,
  );
});
const academyActions = [
  "admissions/save",
  "admissions/trial",
  "admissions/convert",
  "players/save",
  "players/guardian",
  "players/consent",
  "calendar/event",
  "calendar/preview",
  "calendar/session",
  "settings/save",
  "settings/branch",
  "settings/batch",
  "settings/member",
  "fees/plan",
  "fees/invoice",
  "fees/payment",
  "fees/verify",
  "fees/refund",
  "fees/credit",
  "fees/void",
  "reports/create",
  "reports/review",
  "reports/update",
  "reports/withdraw",
  "privacy/policy",
  "privacy/request",
  "privacy/review",
  "privacy/hold",
  "nutrition/plan",
  "nutrition/withdraw",
  "nutrition/restrictions",
  "nutrition/question",
  "communications/save",
  "communications/preview",
  "communications/process",
  "communications/template",
  "communications/conversation",
  "media/review",
  "media/note",
  "media/upload",
];
const readRoutes = [
  "/api/academy",
  "/api/academy/identity",
  "/api/academy/reports/x/pdf",
  "/api/academy/fees/x/receipt",
  "/api/academy/access-events",
  "/api/academy/privacy/overview",
  "/api/academy/media/x/link",
  "/api/academy/media/x/file",
  "/api/academy/nothing-here",
  "/api/training",
];
const trainingWrites = [
  "sessions",
  "sessions/x",
  "favourites",
  "drills",
  "goals",
];
async function gatedSession(role: (typeof ROLES)[number]) {
  const target = await newMember(role);
  const r = await reset(await owner(), target.id);
  assert.equal(r.status, 200);
  const temporary = result(r).temporaryPassword;
  const client = app.anonymous();
  const signin = await client.signIn(target.email, temporary);
  assert.equal(signin.status, 200, "a temporary password does sign in");
  assert.ok(client.hasSession());
  return { ...target, temporary, client };
}
test("forced rotation: a temporary-password session reaches nothing protected, on any route", async () => {
  // The gate is by account state, so it is checked for a coach, a family member and a finance user.
  for (const role of ["COACH", "GUARDIAN", "FINANCE"] as const) {
    const { client } = await gatedSession(role);
    const blocked: [string, number][] = [];
    for (const path of readRoutes)
      blocked.push([path, (await client.get(path)).status]);
    for (const action of academyActions)
      blocked.push([
        `/api/academy/${action}`,
        (await client.post(`/api/academy/${action}`, {})).status,
      ]);
    for (const path of trainingWrites)
      blocked.push([
        `/api/training/${path}`,
        (await client.post(`/api/training/${path}`, {})).status,
      ]);
    for (const [path, status] of blocked)
      assert.equal(status, 403, `${role} ${path}`);
    // The refusal says why, so the app can send the person to the change-password screen.
    const sample = await client.get("/api/academy");
    assert.equal(code(sample), "PASSWORD_CHANGE_REQUIRED");
    assert.match(
      (sample.json as { error: string }).error,
      /replace your temporary password/i,
    );
    // Authentication endpoints are gated too (a session must not manage itself around the gate).
    for (const [path, body] of [
      ["/api/auth/revoke-sessions", {}],
      ["/api/auth/revoke-other-sessions", {}],
      ["/api/auth/update-user", { name: "New Name" }],
      ["/api/auth/two-factor/enable", { password: FIXTURE_PASSWORD }],
      ["/api/auth/two-factor/disable", { password: FIXTURE_PASSWORD }],
      [
        "/api/auth/two-factor/generate-backup-codes",
        { password: FIXTURE_PASSWORD },
      ],
      [
        "/api/auth/account/admin/reset-password",
        { userId: "x", reason: "xxxxxxxxxxxx", ownerPassword: "x" },
      ],
    ] as const) {
      const r = await client.post(path, body);
      assert.equal(r.status, 403, `${role} ${path}`);
      assert.equal(code(r), "PASSWORD_CHANGE_REQUIRED", `${role} ${path}`);
    }
    assert.equal((await client.get("/api/auth/list-sessions")).status, 403);
    // The few things a gated person needs still work.
    assert.equal((await client.get("/api/auth/get-session")).status, 200);
    const state = await client.get(STATE);
    assert.equal(state.status, 200);
    assert.equal(
      (state.json as { gate: string }).gate,
      "PASSWORD_CHANGE_REQUIRED",
    );
    assert.equal(
      (state.json as { passwordChangeRequired: boolean })
        .passwordChangeRequired,
      true,
    );
  }
});
test("forced rotation: the gate cannot be skipped with path tricks or alternate verbs", async () => {
  const { client } = await gatedSession("COACH");
  for (const path of [
    "/api/academy/",
    "/api/academy//identity",
    "/api/academy/identity/",
    "/api/academy/identity?x=1",
    "/api/academy/%69dentity",
    "/api/academy/./identity",
    "/API/academy/identity",
  ]) {
    const r = await client.get(path);
    assert.ok(r.status === 403 || r.status === 404, `${path}: ${r.status}`);
    assert.ok(!r.text.includes("CANARY"), path);
  }
  const post = await client.request("/api/academy/identity", {
    method: "POST",
    body: {},
  });
  assert.notEqual(post.status, 200);
  // A request carrying only the cookie (no origin) is refused for writes anyway.
  assert.equal(
    (await client.post("/api/academy/players/save", {}, { origin: null }))
      .status,
    403,
  );
});
test("forced rotation: choosing a new password ends the gate and consumes the temporary one", async () => {
  const { id, email, temporary, client } = await gatedSession("COACH");
  const second = await signedIn(email, temporary);
  // Reusing the temporary password as the new password, or a weak one, changes nothing.
  const same = await client.post(CHANGE, {
    currentPassword: temporary,
    newPassword: temporary,
  });
  assert.equal(code(same), "PASSWORD_UNCHANGED");
  const weak = await client.post(CHANGE, {
    currentPassword: temporary,
    newPassword: "Password12345",
  });
  assert.equal(code(weak), "WEAK_PASSWORD");
  const wrong = await client.post(CHANGE, {
    currentPassword: "not-the-temporary",
    newPassword: NEW_PASSWORD(),
  });
  assert.equal(code(wrong), "INVALID_PASSWORD");
  assert.ok(await temporaryRow(id), "still gated after rejected attempts");
  assert.equal((await client.get("/api/academy/identity")).status, 403);
  const chosen = NEW_PASSWORD();
  const r = await client.post(CHANGE, {
    currentPassword: temporary,
    newPassword: chosen,
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(await temporaryRow(id), undefined);
  // The gate is gone for the replacement session and the other device's session is revoked.
  assert.equal((await client.get("/api/academy/identity")).status, 200);
  assert.equal((await second.get("/api/academy/identity")).status, 401);
  assert.equal((await app.anonymous().signIn(email, temporary)).status, 401);
  assert.equal((await app.anonymous().signIn(email, chosen)).status, 200);
  const [changed] = await events(id, "PASSWORD_CHANGED");
  assert.equal(
    (changed.detail as { wasTemporary: boolean }).wasTemporary,
    true,
  );
  assert.equal(
    (await client.get(STATE).then((s) => s.json as { gate: unknown })).gate,
    null,
  );
});
test("a person can sign out of a gated session and the cookie is then useless", async () => {
  const { client } = await gatedSession("GUARDIAN");
  const copy = client.clone();
  assert.equal((await client.signOut()).status, 200);
  assert.equal((await copy.get("/api/auth/get-session")).json, null);
  assert.equal((await copy.get(STATE)).status, 401);
});
test("two simultaneous resets leave exactly one valid temporary password", async () => {
  const target = await newMember("COACH");
  const a = await signedIn(USERS.owner.email);
  const b = await signedIn(USERS.owner.email);
  const [ra, rb] = await Promise.all([
    reset(a, target.id),
    reset(b, target.id),
  ]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  const passwords = [
    result(ra).temporaryPassword,
    result(rb).temporaryPassword,
  ];
  assert.notEqual(passwords[0], passwords[1]);
  const accepted: number[] = [];
  for (const [i, password] of passwords.entries())
    if ((await app.anonymous().signIn(target.email, password)).status === 200)
      accepted.push(i);
  assert.equal(accepted.length, 1, "exactly one of the two passwords works");
  assert.equal(
    (
      await database()
        .select()
        .from(t.temporaryCredential)
        .where(eq(t.temporaryCredential.userId, target.id))
    ).length,
    1,
  );
  // A third reset supersedes both.
  const third = await reset(a, target.id);
  assert.equal(third.status, 200);
  for (const password of passwords)
    assert.equal(
      (await app.anonymous().signIn(target.email, password)).status,
      401,
    );
  assert.equal(
    (
      await app
        .anonymous()
        .signIn(target.email, result(third).temporaryPassword)
    ).status,
    200,
  );
});
test("resetting a member never disturbs the owner's own credential or session", async () => {
  const client = await signedIn(USERS.owner.email);
  const before = await hashOf(USERS.owner.id);
  const target = await newMember("ADMIN");
  assert.equal((await reset(client, target.id)).status, 200);
  assert.equal(await hashOf(USERS.owner.id), before);
  assert.equal((await client.get("/api/academy/identity")).status, 200);
  assert.equal(await temporaryRow(USERS.owner.id), undefined);
});
test("the reset endpoint is rate limited per address", async () => {
  const spare = await newMember("OWNER");
  const client = await signedIn(spare.email);
  const target = await newMember();
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++)
    statuses.push(
      (await reset(client, target.id, { ownerPassword: "wrong-wrong-wrong" }))
        .status,
    );
  // RC-2 (owner decision 2026-11-11): the shared owner re-authentication counter locks after five failures.
  assert.ok(
    statuses.slice(0, OWNER_REAUTH_MAX_FAILURES).every((s) => s === 403),
    statuses.join(","),
  );
  assert.ok(
    statuses.slice(OWNER_REAUTH_MAX_FAILURES).every((s) => s === 429),
    statuses.join(","),
  );
  assert.equal(await temporaryRow(target.id), undefined);
});
test("provisioning a member through Settings issues a random 72-hour temporary password", async () => {
  const client = await signedIn(USERS.owner.email);
  const email = `rs-new-${Date.now()}@example.test`;
  const create = (overrides: Record<string, unknown>) =>
    client.post("/api/academy/settings/member", {
      name: "New Staff Fixture",
      email,
      role: "COACH",
      active: true,
      professionalAttestation: "",
      ...overrides,
    });
  // A typed password must meet the policy.
  const weak = await create({ initialPassword: "Password12345" });
  assert.equal(weak.status, 422);
  assert.match((weak.json as { error: string }).error, /not accepted/i);
  assert.equal(
    (await database().select().from(t.user).where(eq(t.user.email, email)))
      .length,
    0,
  );
  // Leaving it blank generates one, returned once.
  const created = await create({});
  assert.equal(created.status, 200, created.text);
  const body = created.json as {
    id: string;
    temporaryPassword: string;
    temporaryPasswordExpiresAt: string;
  };
  assert.match(
    body.temporaryPassword,
    /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/,
  );
  const marker = await temporaryRow(body.id);
  assert.equal(marker.source, "MEMBER_CREATED");
  assert.equal(marker.issuedBy, USERS.owner.id);
  assert.ok(
    Math.abs(marker.expiresAt.getTime() - Date.now() - 72 * 3600 * 1000) <
      60_000,
  );
  assert.ok(!(await secretBearingRows()).includes(body.temporaryPassword));
  const person = app.anonymous();
  assert.equal(
    (await person.signIn(email, body.temporaryPassword)).status,
    200,
  );
  assert.equal((await person.get("/api/academy")).status, 403);
  assert.equal(
    (
      await person.post(CHANGE, {
        currentPassword: body.temporaryPassword,
        newPassword: NEW_PASSWORD(),
      })
    ).status,
    200,
  );
  assert.equal((await person.get("/api/academy/identity")).status, 200);
  // An owner-typed password is accepted but is equally temporary, and is not echoed back.
  const typedEmail = `rs-typed-${Date.now()}@example.test`;
  const typed = await client.post("/api/academy/settings/member", {
    name: "Typed Staff Fixture",
    email: typedEmail,
    role: "FINANCE",
    active: true,
    professionalAttestation: "",
    initialPassword: "Bright-Harbour-Seven-Lamps",
  });
  assert.equal(typed.status, 200, typed.text);
  assert.equal(
    (typed.json as { temporaryPassword?: string }).temporaryPassword,
    undefined,
  );
  assert.ok(await temporaryRow((typed.json as { id: string }).id));
  assert.ok(!typed.text.includes("Bright-Harbour"));
  const typedPerson = app.anonymous();
  assert.equal(
    (await typedPerson.signIn(typedEmail, "Bright-Harbour-Seven-Lamps")).status,
    200,
  );
  assert.equal((await typedPerson.get("/api/academy")).status, 403);
  assert.equal(
    code(await typedPerson.get("/api/academy")),
    "PASSWORD_CHANGE_REQUIRED",
  );
  // Non-owners still cannot provision.
  const admin = await app.as("admin");
  assert.equal(
    (
      await admin.post("/api/academy/settings/member", {
        name: "X Y",
        email: "x@y.test",
        role: "COACH",
        active: true,
        professionalAttestation: "",
      })
    ).status,
    403,
  );
});
test("existing accounts with no credential marker are unaffected", async () => {
  for (const role of ROLES) {
    const client = await app.as(ROLE_USER[role]);
    assert.equal((await client.get("/api/academy/identity")).status, 200, role);
    const state = await client.get(STATE);
    assert.equal((state.json as { gate: unknown }).gate, null, role);
    assert.equal(
      (state.json as { twoFactorEnabled: boolean }).twoFactorEnabled,
      false,
    );
  }
});
test(
  "a membership that changes while a reset is in flight cannot be reset through the stale decision",
  {
    // Needs two real database connections: the embedded database serialises everything on one.
    skip: process.env.TEST_POSTGRES_ADMIN_URL
      ? false
      : "TEST_POSTGRES_ADMIN_URL not set - run `npm run test:pg`",
  },
  async () => {
    const target = await newMember("COACH");
    const before = await hashOf(target.id);
    const client = await owner();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    // Another owner is promoting the target right now, holding the academy lock as Settings does.
    const promotion = database().transaction(async (tx) => {
      await tx
        .select()
        .from(t.academies)
        .where(eq(t.academies.id, "green"))
        .for("update");
      await hold;
      await tx
        .update(t.memberships)
        .set({ role: "OWNER" })
        .where(eq(t.memberships.userId, target.id));
    });
    await new Promise((r) => setTimeout(r, 300));
    const pending = reset(client, target.id);
    await new Promise((r) => setTimeout(r, 2000));
    release();
    await promotion;
    const r = await pending;
    assert.ok(r.status === 409 || r.status === 403, `status ${r.status}`);
    assert.ok(
      ["MEMBERSHIP_CHANGED", "TARGET_IS_OWNER"].includes(code(r) ?? ""),
      String(code(r)),
    );
    assert.equal(await temporaryRow(target.id), undefined);
    assert.equal(await hashOf(target.id), before);
  },
);
