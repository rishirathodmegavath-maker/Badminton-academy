import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import {
  CANARY,
  FIXTURE_PASSWORD,
  ROLES,
  ROLE_USER,
  USERS,
  addFixtureUser,
  idsFor,
  type Role,
} from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { MEMBERSHIP_MESSAGES } from "../src/modules/identity/membership-messages";
/**
 * Stage 3 / AUTH-02: signing in proves identity; belonging to an academy is a separate fact. Each way of not
 * belonging gets its own code and an actionable, non-leaking sentence, and none of them grants anything.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("membership-resolution");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const db = () => database();
type Err = { error?: string; code?: string };
const err = (r: { json: unknown }) => (r.json ?? {}) as Err;
const API_AREAS = [
  "/api/academy",
  "/api/academy/identity",
  "/api/training",
] as const;
/** What an error body may contain: a sentence and a code, never an identifier, academy or person. */
function assertNoLeak(text: string) {
  for (const forbidden of [
    "green",
    "blue",
    "quiet",
    "Fixture",
    "academy_id",
    "membership_id",
    "postgres",
    "select ",
    "drizzle",
    "fx-",
    ...Object.values(CANARY.childA),
  ])
    assert.ok(
      !text.includes(forbidden),
      `error text must not contain "${forbidden}": ${text}`,
    );
}
async function signedIn(email: string) {
  const client = app.anonymous();
  const r = await client.signIn(email, FIXTURE_PASSWORD);
  assert.equal(r.status, 200, "authentication itself succeeds");
  assert.ok(client.hasSession());
  return client;
}
const setActive = (userId: string, active: boolean) =>
  db()
    .update(t.memberships)
    .set({ active })
    .where(eq(t.memberships.userId, userId));
const membershipCount = async (userId: string) =>
  (
    await db()
      .select()
      .from(t.memberships)
      .where(eq(t.memberships.userId, userId))
  ).length;

test("a valid member of each of the eight roles reaches the workspace with the right role", async () => {
  for (const role of ROLES) {
    const client = await app.as(ROLE_USER[role]);
    const r = await client.get("/api/academy/identity");
    assert.equal(r.status, 200, role);
    assert.equal((r.json as { role: string }).role, role);
    assert.equal(
      (await client.get("/api/academy")).status,
      200,
      `${role} bootstrap`,
    );
  }
});

test("authenticated but no membership: a clear 'not assigned' answer on every area, no data, nothing created", async () => {
  const none = await addFixtureUser("fx-s3-none", []);
  const client = await signedIn(none.email);
  for (const path of API_AREAS) {
    const r = await client.get(path);
    assert.equal(r.status, 403, path);
    assert.equal(err(r).code, "NO_MEMBERSHIP", path);
    assert.equal(err(r).error, MEMBERSHIP_MESSAGES.NO_MEMBERSHIP);
    assert.match(err(r).error ?? "", /not assigned to an academy/i);
    assertNoLeak(JSON.stringify(r.json));
  }
  // Writes are refused the same way and create nothing.
  for (const action of ["players/save", "settings/member", "fees/invoice"]) {
    const w = await client.post(`/api/academy/${action}`, {});
    assert.equal(w.status, 403, action);
    assert.equal(err(w).code, "NO_MEMBERSHIP");
  }
  assert.equal(
    await membershipCount(none.id),
    0,
    "no membership was created or granted",
  );
  // The old, misleading wording is gone.
  assert.ok(
    !(err(await client.get("/api/academy")).error ?? "").match(/database/i),
  );
});

test("an inactive membership gets its own answer for every one of the eight roles, and no data", async () => {
  for (const role of ROLES) {
    const member = await addFixtureUser(`fx-s3-off-${role.toLowerCase()}`, [
      { academyId: "green", role, active: true },
    ]);
    const client = await signedIn(member.email);
    assert.equal(
      (await client.get("/api/academy/identity")).status,
      200,
      `${role} while active`,
    );
    await setActive(member.id, false);
    for (const path of API_AREAS) {
      const r = await client.get(path);
      assert.equal(r.status, 403, `${role} ${path}`);
      assert.equal(err(r).code, "MEMBERSHIP_INACTIVE", `${role} ${path}`);
      assert.equal(err(r).error, MEMBERSHIP_MESSAGES.MEMBERSHIP_INACTIVE);
      assertNoLeak(JSON.stringify(r.json));
    }
    // It is told apart from "never assigned", and reactivation restores access without any other change.
    assert.notEqual(
      err(await client.get("/api/academy")).error,
      MEMBERSHIP_MESSAGES.NO_MEMBERSHIP,
    );
    await setActive(member.id, true);
    const back = await client.get("/api/academy/identity");
    assert.equal(back.status, 200, `${role} after reactivation`);
    assert.equal((back.json as { role: string }).role, role);
  }
});

test("two active memberships and no choice yet: 'choose an academy' (409), no data on any area; nothing is merged", async () => {
  const two = await addFixtureUser("fx-s3-two", [
    { academyId: "green", role: "COACH" },
    { academyId: "blue", role: "COACH" },
  ]);
  const client = await signedIn(two.email);
  for (const path of API_AREAS) {
    const r = await client.get(path);
    assert.equal(r.status, 409, path);
    assert.equal(err(r).code, "ACADEMY_SELECTION_REQUIRED");
    assert.equal(err(r).error, MEMBERSHIP_MESSAGES.ACADEMY_SELECTION_REQUIRED);
    assertNoLeak(JSON.stringify(r.json));
  }
  assert.equal(await membershipCount(two.id), 2, "memberships untouched");
});
test("an invalid session is an authentication failure (401), never a membership message", async () => {
  const anon = app.anonymous();
  for (const path of API_AREAS) {
    const r = await anon.get(path);
    assert.equal(r.status, 401, path);
    assert.equal(err(r).code, undefined);
    assert.match(err(r).error ?? "", /sign in/i);
  }
  const forged = await anon.request("/api/academy/identity", {
    headers: { cookie: "better-auth.session_token=forged.value" },
  });
  assert.equal(forged.status, 401);
  // A revoked (signed-out) session is also 401, not a membership answer.
  const member = await addFixtureUser("fx-s3-signout", [
    { academyId: "green", role: "COACH" },
  ]);
  const client = await signedIn(member.email);
  const stolen = client.clone();
  await client.signOut();
  const after = await stolen.get("/api/academy/identity");
  assert.equal(after.status, 401);
  assert.equal(err(after).code, undefined);
  // And wrong credentials never yield a session at all.
  const bad = await app
    .anonymous()
    .signIn(member.email, "wrong-password-value");
  assert.notEqual(bad.status, 200);
});

test("cross-academy: a membership never reaches into another academy, in either direction", async () => {
  const green = idsFor("childA");
  const blue = idsFor("blue");
  // A green coach asking for blue's records by id: not found, with no content.
  const coach = await app.as("coach");
  for (const path of [
    `/api/academy/reports/${blue.reportId}/pdf`,
    `/api/academy/fees/${blue.invoiceId}/receipt`,
    `/api/academy/media/${blue.media.shared}/link`,
  ]) {
    const r = await coach.get(path);
    assert.equal(r.status, 404, path);
    assertNoLeak(r.text.replace(/blue/g, ""));
  }
  // A blue coach asking for green's records.
  const blueCoach = await app.as("blueCoach");
  for (const path of [
    `/api/academy/reports/${green.reportId}/pdf`,
    `/api/academy/fees/${green.invoiceId}/receipt`,
  ])
    assert.equal((await blueCoach.get(path)).status, 404, path);
  // Someone inactive in green but active in blue is placed in blue only and sees none of green.
  const mover = await addFixtureUser("fx-s3-mover", [
    { academyId: "green", role: "COACH", active: false },
    { academyId: "blue", role: "COACH", active: true },
  ]);
  const client = await signedIn(mover.email);
  const identity = await client.get("/api/academy/identity");
  assert.equal(identity.status, 200);
  assert.equal(
    (identity.json as { academy: { name: string } }).academy.name,
    "Fixture Blue Academy",
  );
  assert.equal(
    (await client.get(`/api/academy/reports/${green.reportId}/pdf`)).status,
    404,
  );
  const boot = JSON.stringify((await client.get("/api/academy")).json);
  for (const value of Object.values(CANARY.childA))
    assert.ok(!boot.includes(value), "green data must not appear");
});

test("a deactivated or unassigned account cannot act on any role's authority (writes are refused before any role check)", async () => {
  const roles: Role[] = [
    "OWNER",
    "ADMIN",
    "FINANCE",
    "NUTRITION_PRO",
    "GUARDIAN",
  ];
  for (const role of roles) {
    const member = await addFixtureUser(`fx-s3-write-${role.toLowerCase()}`, [
      { academyId: "green", role },
    ]);
    const client = await signedIn(member.email);
    await setActive(member.id, false);
    const before = await db().select().from(t.audit);
    const r = await client.post("/api/academy/settings/member", {
      id: USERS.coach.id,
      name: "Taken Over",
      email: USERS.coach.email,
      role: "OWNER",
      active: true,
      professionalAttestation: "",
    });
    assert.equal(r.status, 403, role);
    assert.equal(err(r).code, "MEMBERSHIP_INACTIVE");
    assert.equal(
      (await db().select().from(t.audit)).length,
      before.length,
      `${role}: nothing was written`,
    );
    const [coachRow] = await db()
      .select()
      .from(t.memberships)
      .where(
        and(
          eq(t.memberships.userId, USERS.coach.id),
          eq(t.memberships.academyId, "green"),
        ),
      );
    assert.equal(coachRow.role, "COACH");
  }
});
