import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { CANARY, FIXTURE_PASSWORD, addFixtureUser, canaryValues, idsFor, type AcademyId, type Role } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { assertNoLeak } from "./helpers/payload";
import { code, unique } from "./helpers/accounts";
import type { TestClient } from "./helpers/client";

/**
 * One global account, several academies (migration 0017 / MULTI_ACADEMY_IDENTITY_DESIGN.md). Signing in identifies the
 * person; the academy a request acts in is resolved on the server from the person's CURRENT memberships and the choice
 * stored for the session, and the client never supplies an academy id for authorization. Real HTTP, real route handlers.
 */
let app: Harness;
before(async () => {
  app = await startHarness("multi-academy-selection");
}, { timeout: HOOK_TIMEOUT });
after(async () => {
  await app.stop();
}, { timeout: HOOK_TIMEOUT });

const db = () => database();
const ACADEMIES = "/api/auth/account/academies";
const SELECT = "/api/auth/account/select-academy";
const GREEN = "Fixture Green Academy";
const BLUE = "Fixture Blue Academy";
type Held = { academyId: AcademyId; role: Role; active?: boolean };
/** A person with the given memberships (default: OWNER of green and HEAD_COACH of blue: different roles, both see everything). */
async function person(memberships: Held[] = [{ academyId: "green", role: "OWNER" }, { academyId: "blue", role: "HEAD_COACH" }]) {
  const id = `ma-${unique()}`;
  const { email } = await addFixtureUser(id, memberships);
  return { id, email };
}
async function signedIn(email: string) {
  const client = app.anonymous();
  const r = await client.signIn(email, FIXTURE_PASSWORD);
  assert.equal(r.status, 200, r.text.slice(0, 150));
  return client;
}
type Academies = { academies: { academyId: string; name: string; role: string; current: boolean }[]; selectionRequired: boolean; noAccess: string | null };
const mine = async (c: TestClient) => (await c.get(ACADEMIES)).json as Academies;
const choose = (c: TestClient, academyId: string) => c.post(SELECT, { academyId });
const identity = async (c: TestClient) => (await c.get("/api/academy/identity")).json as { role: string; name: string; academy: { name: string } };
const idOf = (list: Academies, name: string) => list.academies.find((a) => a.name === name)!.academyId;
const selections = (userId: string) => db().select().from(t.sessionAcademy).where(eq(t.sessionAcademy.userId, userId));
const membershipRows = async (userId: string) => JSON.stringify(await db().select().from(t.memberships).where(eq(t.memberships.userId, userId)).orderBy(t.memberships.academyId));

test("several academies and no choice: every application area answers 'choose an academy' and reveals nothing; the chooser lists only the person's own", async () => {
  const p = await person();
  const c = await signedIn(p.email);
  for (const path of ["/api/academy", "/api/academy/identity", "/api/training"]) {
    const r = await c.get(path);
    assert.equal(r.status, 409, path);
    assert.equal(code(r), "ACADEMY_SELECTION_REQUIRED");
    assertNoLeak(r.json, [...canaryValues(CANARY.childA), ...canaryValues(CANARY.blue), GREEN, BLUE], path);
  }
  const list = await mine(c);
  assert.equal(list.selectionRequired, true);
  assert.deepEqual(list.academies.map((a) => [a.name, a.role, a.current]).sort(), [[BLUE, "HEAD_COACH", false], [GREEN, "OWNER", false]]);
  assert.ok(!JSON.stringify(list).includes("Quiet"), "no other academy is listed");
  assert.deepEqual((await selections(p.id)).length, 0, "listing chooses nothing");
});

test("choosing and switching: each academy shows only its own data and the person's role THERE, without signing out", async () => {
  const p = await person();
  const c = await signedIn(p.email);
  const list = await mine(c);
  const cookieBefore = c.sessionCookie;
  const green = await choose(c, idOf(list, GREEN));
  assert.equal(green.status, 200, green.text);
  assert.deepEqual(green.json, { academyId: idOf(list, GREEN), name: GREEN, role: "OWNER" });
  assert.deepEqual(c.sessionCookie, cookieBefore, "same session: no new cookie, no sign-in");
  assert.equal(green.headers.getSetCookie().length, 0);
  let me = await identity(c);
  assert.deepEqual([me.role, me.academy.name], ["OWNER", GREEN]);
  let data = JSON.stringify((await c.get("/api/academy")).json);
  assert.ok(data.includes(CANARY.childA.name), "green data is visible");
  assertNoLeak(data, canaryValues(CANARY.blue), "green view");

  assert.equal((await choose(c, idOf(list, BLUE))).status, 200);
  me = await identity(c);
  assert.deepEqual([me.role, me.academy.name], ["HEAD_COACH", BLUE]);
  data = JSON.stringify((await c.get("/api/academy")).json);
  assert.ok(data.includes(CANARY.blue.name), "blue data is visible");
  assertNoLeak(data, canaryValues(CANARY.childA), "blue view");
  assert.equal((await mine(c)).academies.find((a) => a.name === BLUE)!.current, true);
  assert.equal((await mine(c)).academies.find((a) => a.name === GREEN)!.current, false);
  assert.equal((await selections(p.id)).length, 1, "one selection per session");

  // A resource of the other academy is out of reach while working in this one, and back in reach after switching.
  const green1 = idsFor("childA");
  assert.ok([403, 404].includes((await c.get(`/api/academy/reports/${green1.reportId}/pdf`)).status), "green report while in blue");
  await choose(c, idOf(list, GREEN));
  assert.equal((await c.get(`/api/academy/reports/${green1.reportId}/pdf`)).status, 200, "the same report after switching to green");
});

test("a client-supplied academy id never decides authorization: query, header and body are ignored on every data route", async () => {
  const p = await person();
  const c = await signedIn(p.email);
  const list = await mine(c);
  await choose(c, idOf(list, BLUE));
  const green = idOf(list, GREEN);
  const sneaky = await c.get(`/api/academy/identity?academyId=${green}&academy=${green}`, { headers: { "x-academy-id": green, "x-sportozen-academy": green } });
  assert.equal(((sneaky.json as { academy: { name: string } }).academy.name), BLUE, "still the academy chosen on the server");
  const post = await c.post("/api/academy/settings/member", { academyId: green, id: "x", name: "x" });
  assert.notEqual(post.status, 200);
  assert.equal((await identity(c)).academy.name, BLUE);
});

test("choosing an academy the person is not an ACTIVE member of is refused, identically for unknown, other and switched-off academies; the current choice is unchanged", async () => {
  const p = await person([{ academyId: "green", role: "OWNER" }, { academyId: "blue", role: "HEAD_COACH" }, { academyId: "quiet", role: "COACH", active: false }]);
  const other = await person([{ academyId: "quiet", role: "OWNER" }]);
  const c = await signedIn(p.email);
  const list = await mine(c);
  assert.equal(list.academies.length, 2, "a switched-off membership is not offered");
  await choose(c, idOf(list, GREEN));
  const otherList = await mine(await signedIn(other.email));
  const quietId = otherList.academies[0].academyId;
  const bodies = new Set<string>();
  for (const target of [quietId, "no-such-academy", "", "green' OR '1'='1"]) {
    const r = await choose(c, target);
    assert.ok([400, 404].includes(r.status), `${JSON.stringify(target)} -> ${r.status}`);
    if (r.status === 404) {
      assert.equal(code(r), "ACADEMY_NOT_AVAILABLE");
      bodies.add(r.text);
    }
  }
  assert.equal(bodies.size, 1, "an unknown academy and somebody else's academy answer exactly alike");
  assert.equal((await identity(c)).academy.name, GREEN, "the choice survived every refused attempt");
  assert.equal((await selections(p.id)).length, 1);
});

test("one active membership is used automatically (no choice stored); a person with none, or only switched-off ones, gets the usual answers", async () => {
  const one = await person([{ academyId: "green", role: "COACH" }]);
  const c = await signedIn(one.email);
  assert.deepEqual([(await identity(c)).role, (await identity(c)).academy.name], ["COACH", GREEN]);
  const list = await mine(c);
  assert.deepEqual([list.academies.length, list.academies[0].current, list.selectionRequired], [1, true, false]);
  assert.equal((await selections(one.id)).length, 0, "nothing needed choosing");
  assert.equal((await choose(c, list.academies[0].academyId)).status, 200, "choosing the only academy is harmless");

  const none = await person([]);
  const n = await signedIn(none.email);
  assert.equal(code(await n.get("/api/academy/identity")), "NO_MEMBERSHIP");
  assert.deepEqual(await mine(n), { academies: [], selectionRequired: false, noAccess: "NO_MEMBERSHIP" });
  const off = await person([{ academyId: "green", role: "COACH", active: false }]);
  const o = await signedIn(off.email);
  assert.equal(code(await o.get("/api/academy/identity")), "MEMBERSHIP_INACTIVE");
  assert.equal((await mine(o)).noAccess, "MEMBERSHIP_INACTIVE");
});

test("a membership switched off while chosen: the next request already falls back, the stale choice is forgotten, and switching it back on does not resurrect it", async () => {
  const p = await person();
  const c = await signedIn(p.email);
  const list = await mine(c);
  await choose(c, idOf(list, GREEN));
  assert.equal((await identity(c)).academy.name, GREEN);
  const before = await membershipRows(p.id);
  await db().update(t.memberships).set({ active: false }).where(and(eq(t.memberships.userId, p.id), eq(t.memberships.academyId, "green")));
  // green is gone at once; blue is the only active membership, so it is used without being chosen
  let me = await identity(c);
  assert.deepEqual([me.role, me.academy.name], ["HEAD_COACH", BLUE]);
  assert.equal((await selections(p.id)).length, 0, "the stale choice was removed");
  await db().update(t.memberships).set({ active: true }).where(and(eq(t.memberships.userId, p.id), eq(t.memberships.academyId, "green")));
  const r = await c.get("/api/academy/identity");
  assert.equal(r.status, 409, "two academies again and the person has not chosen: they must choose, green does not silently return");
  assert.equal(code(r), "ACADEMY_SELECTION_REQUIRED");
  assert.equal(await membershipRows(p.id), before, "memberships themselves are exactly as before");
  me = (await choose(c, idOf(list, GREEN))).status === 200 ? await identity(c) : me;
  assert.equal(me.academy.name, GREEN);
});

test("the choice belongs to ONE session: another session, a new sign-in and a signed-out session start with none", async () => {
  const p = await person();
  const a = await signedIn(p.email);
  const list = await mine(a);
  await choose(a, idOf(list, GREEN));
  const b = await signedIn(p.email);
  assert.equal((await b.get("/api/academy/identity")).status, 409, "a second session has not chosen");
  assert.equal((await identity(a)).academy.name, GREEN, "and did not disturb the first");
  await choose(b, idOf(list, BLUE));
  assert.equal((await identity(a)).academy.name, GREEN, "each session keeps its own academy");
  assert.equal((await identity(b)).academy.name, BLUE);
  assert.equal((await selections(p.id)).length, 2);
  assert.equal((await a.signOut()).status, 200);
  assert.equal((await selections(p.id)).length, 1, "signing out removes that session's choice only");
  const again = await signedIn(p.email);
  assert.equal((await again.get("/api/academy/identity")).status, 409, "signing in again starts with no choice");
});

test("an account gate is answered BEFORE 'choose an academy', and a gated session cannot switch", async () => {
  const p = await person();
  await db().insert(t.temporaryCredential).values({ userId: p.id, source: "MEMBER_CREATED", issuedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 3_600_000) });
  const c = await signedIn(p.email);
  const r = await c.get("/api/academy/identity");
  assert.equal(code(r), "PASSWORD_CHANGE_REQUIRED", "told to replace the temporary password, not to choose");
  assert.equal(r.status, 403);
  const list = await db().select().from(t.memberships).where(eq(t.memberships.userId, p.id));
  const pick = await choose(c, list[0].academyId);
  assert.equal(code(pick), "PASSWORD_CHANGE_REQUIRED", "a gated session cannot choose");
  assert.equal((await selections(p.id)).length, 0);
});

test("two-factor: the strictest requirement across ALL active memberships applies wherever the person is working", async () => {
  const p = await person([{ academyId: "green", role: "COACH" }, { academyId: "blue", role: "COACH" }]);
  await db().insert(t.academyMfaPolicy).values({ academyId: "blue", mode: "enforce", roles: ["COACH"] }).onConflictDoUpdate({ target: t.academyMfaPolicy.academyId, set: { mode: "enforce", roles: ["COACH"] } });
  try {
    const c = await signedIn(p.email);
    // green has no requirement of its own, yet the person is held to blue's: the authenticator is theirs, not an academy's
    const r = await c.get("/api/academy/identity");
    assert.equal(code(r), "MFA_ENROLLMENT_REQUIRED");
    assert.equal(r.status, 403);
    const state = (await c.get("/api/auth/account/security-state")).json as { gate: string };
    assert.equal(state.gate, "MFA_ENROLLMENT_REQUIRED");
  } finally {
    await db().delete(t.academyMfaPolicy).where(eq(t.academyMfaPolicy.academyId, "blue"));
  }
});

test("an academy's display name for a person is used only in that academy; the person's own name is untouched", async () => {
  const p = await person();
  await db().update(t.memberships).set({ displayName: "Coach Priya (Blue)" }).where(and(eq(t.memberships.userId, p.id), eq(t.memberships.academyId, "blue")));
  const c = await signedIn(p.email);
  const list = await mine(c);
  await choose(c, idOf(list, BLUE));
  assert.equal((await identity(c)).name, "Coach Priya (Blue)");
  await choose(c, idOf(list, GREEN));
  assert.equal((await identity(c)).name, `Fixture ${p.id}`, "green shows the person's own name");
  assert.equal((await db().select().from(t.user).where(eq(t.user.id, p.id)))[0].name, `Fixture ${p.id}`);
});

test("choosing is audited in the academy that was entered, and neither academy's log names the other", async () => {
  const p = await person();
  const c = await signedIn(p.email);
  const list = await mine(c);
  await choose(c, idOf(list, GREEN));
  await choose(c, idOf(list, BLUE));
  await choose(c, idOf(list, BLUE));
  const rows = (await db().select().from(t.securityEvent).where(eq(t.securityEvent.targetUserId, p.id))).filter((e) => e.event === "ACADEMY_SELECTED");
  assert.deepEqual(rows.map((e) => [e.academyId, (e.detail as { switched: boolean }).switched]).sort(), [["blue", false], ["blue", true], ["green", false]].sort());
  for (const e of rows) {
    const other = e.academyId === "green" ? "blue" : "green";
    assert.ok(!JSON.stringify(e.detail).includes(other), "the entry names no other academy");
  }
});

test("single-academy people are unaffected: same answers, no stored choice, and deactivation still ends their sessions", async () => {
  const p = await person([{ academyId: "green", role: "COACH" }]);
  const c = await signedIn(p.email);
  assert.equal((await c.get("/api/academy/identity")).status, 200);
  assert.equal((await selections(p.id)).length, 0);
  await db().update(t.memberships).set({ active: false }).where(eq(t.memberships.userId, p.id));
  assert.equal(code(await c.get("/api/academy/identity")), "MEMBERSHIP_INACTIVE");
});
