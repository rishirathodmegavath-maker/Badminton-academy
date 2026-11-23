import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { approveOwnerRestore, describeOwnerRestore, requestOwnerRestore } from "../src/modules/identity/owner-recovery";
import { FIXTURE_PASSWORD, addFixtureUser, type AcademyId, type Role } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { code, hashOf, reset, sessionsOf, unique } from "./helpers/accounts";

/**
 * What changes when one login belongs to several academies (MULTI_ACADEMY_IDENTITY_DESIGN.md, D3-D7): an academy's
 * action about a person must change only that academy's view of them, never their global identity, their credentials or
 * their access elsewhere. Real HTTP over the real route handlers; owner restoration is driven through the service the
 * operator command calls.
 */
let app: Harness;
before(async () => {
  app = await startHarness("multi-academy-side-effects");
}, { timeout: HOOK_TIMEOUT });
after(async () => {
  await app.stop();
}, { timeout: HOOK_TIMEOUT });

const db = () => database();
const SELECT = "/api/auth/account/select-academy";
const ACADEMIES = "/api/auth/account/academies";
type Held = { academyId: AcademyId; role: Role; active?: boolean };
async function person(memberships: Held[], tag = "se") {
  const id = `${tag}-${unique()}`;
  const { email } = await addFixtureUser(id, memberships);
  return { id, email };
}
async function signedIn(email: string) {
  const client = app.anonymous();
  const r = await client.signIn(email, FIXTURE_PASSWORD);
  assert.equal(r.status, 200, r.text.slice(0, 150));
  return client;
}
const memberBody = (id: string, name: string, role: Role, email: string, active = true) => ({
  id, name, email, role, active,
  professionalAttestation: "",
});
const membership = async (userId: string, academyId: string) =>
  (await db().select().from(t.memberships).where(and(eq(t.memberships.userId, userId), eq(t.memberships.academyId, academyId))))[0];
const nameOf = async (id: string) => (await db().select().from(t.user).where(eq(t.user.id, id)))[0].name;
const eventsOf = async (userId: string, event: string) =>
  (await db().select().from(t.securityEvent).where(eq(t.securityEvent.targetUserId, userId))).filter((e) => e.event === event);

test("D3: an academy's rename changes only how THAT academy shows the person; their own name and the other academy are untouched", async () => {
  const p = await person([{ academyId: "green", role: "COACH" }, { academyId: "blue", role: "COACH" }]);
  const own = await nameOf(p.id);
  const owner = await app.as("owner");
  const r = await owner.post("/api/academy/settings/member", memberBody(p.id, "Coach Priya (Green)", "COACH", p.email));
  assert.equal(r.status, 200, r.text);
  assert.equal((await membership(p.id, "green")).displayName, "Coach Priya (Green)");
  assert.equal((await membership(p.id, "blue")).displayName, null, "the other academy is untouched");
  assert.equal(await nameOf(p.id), own, "the global identity is never rewritten by an academy");
  // each academy's own screens
  const green = JSON.stringify((await owner.get("/api/academy")).json);
  const blue = JSON.stringify((await (await app.as("blueOwner")).get("/api/academy")).json);
  assert.ok(green.includes("Coach Priya (Green)"), "green shows its own name for the person");
  assert.ok(!blue.includes("Coach Priya (Green)") && blue.includes(own), "blue shows the person's own name");
  // and the person themselves, working in each
  const c = await signedIn(p.email);
  const list = (await c.get(ACADEMIES)).json as { academies: { academyId: string; name: string }[] };
  const idOf = (n: string) => list.academies.find((a) => a.name.includes(n))!.academyId;
  await c.post(SELECT, { academyId: idOf("Green") });
  assert.equal(((await c.get("/api/academy/identity")).json as { name: string }).name, "Coach Priya (Green)");
  await c.post(SELECT, { academyId: idOf("Blue") });
  assert.equal(((await c.get("/api/academy/identity")).json as { name: string }).name, own);
  // naming them what they are already called clears the override (no stale copy of the person's name)
  const back = await owner.post("/api/academy/settings/member", memberBody(p.id, own, "COACH", p.email));
  assert.equal(back.status, 200, back.text);
  assert.equal((await membership(p.id, "green")).displayName, null);
});

test("D4: switching a member off in ONE academy leaves their other academy, their login and their session working", async () => {
  const p = await person([{ academyId: "green", role: "COACH" }, { academyId: "blue", role: "COACH" }]);
  const c = await signedIn(p.email);
  const list = (await c.get(ACADEMIES)).json as { academies: { academyId: string; name: string }[] };
  await c.post(SELECT, { academyId: list.academies.find((a) => a.name.includes("Green"))!.academyId });
  assert.equal(((await c.get("/api/academy/identity")).json as { academy: { name: string } }).academy.name, "Fixture Green Academy");
  const sessionsBefore = await sessionsOf(p.id);

  const owner = await app.as("owner");
  const off = await owner.post("/api/academy/settings/member", memberBody(p.id, await nameOf(p.id), "COACH", p.email, false));
  assert.equal(off.status, 200, off.text);
  assert.equal((await membership(p.id, "green")).active, false);
  assert.equal((await membership(p.id, "blue")).active, true, "the other academy is untouched");
  assert.equal(await sessionsOf(p.id), sessionsBefore, "their session was NOT ended");
  assert.equal((await db().select().from(t.sessionAcademy).where(eq(t.sessionAcademy.userId, p.id))).length, 0, "but its choice of the academy that switched them off is gone");
  // the live session now works in blue, the only academy left, and cannot reach green
  const me = (await c.get("/api/academy/identity")).json as { academy: { name: string } };
  assert.equal(me.academy.name, "Fixture Blue Academy");
  const [event] = await eventsOf(p.id, "MEMBER_DEACTIVATED");
  assert.deepEqual([event.academyId, (event.detail as { endedAllSessions: boolean }).endedAllSessions, (event.detail as { revokedSessions: number }).revokedSessions], ["green", false, 0]);
  assert.ok(!JSON.stringify(event.detail).includes("blue"), "the green log does not mention the other academy");

  // switching off the LAST active membership ends every session, as it always did
  const blueOwner = await app.as("blueOwner");
  const last = await blueOwner.post("/api/academy/settings/member", memberBody(p.id, await nameOf(p.id), "COACH", p.email, false));
  assert.equal(last.status, 200, last.text);
  assert.equal(await sessionsOf(p.id), 0, "nothing left to work in: all sessions ended");
  assert.equal((await c.get("/api/academy/identity")).status, 401);
  const events = await eventsOf(p.id, "MEMBER_DEACTIVATED");
  assert.equal(events.some((e) => e.academyId === "blue" && (e.detail as { endedAllSessions: boolean }).endedAllSessions === true), true);
});

test("D5: an owner cannot reset the password of a person who belongs to another academy, and is told the right way", async () => {
  const p = await person([{ academyId: "green", role: "COACH" }, { academyId: "blue", role: "COACH" }]);
  const before = await hashOf(p.id);
  const owner = await app.as("owner");
  const r = await reset(owner, p.id);
  assert.equal(r.status, 409);
  assert.equal(code(r), "TARGET_MULTI_ACADEMY");
  assert.match(r.text, /reset it themselves by email|operator can recover/);
  assert.ok(!/blue|Blue/.test(r.text), "the refusal names no other academy");
  assert.equal(await hashOf(p.id), before, "nothing changed");
});

test("a person's phone number is theirs: an owner may change it only while this is their one academy", async () => {
  const shared = await person([{ academyId: "green", role: "GUARDIAN" }, { academyId: "blue", role: "GUARDIAN" }]);
  const sole = await person([{ academyId: "green", role: "GUARDIAN" }]);
  const owner = await app.as("owner");
  const refused = await owner.post("/api/academy/communications/phone", { userId: shared.id, phone: "+919876543210" });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(code(refused), "PHONE_MANAGED_BY_PERSON");
  assert.equal((await db().select().from(t.user).where(eq(t.user.id, shared.id)))[0].phone, null, "unchanged");
  const ok = await owner.post("/api/academy/communications/phone", { userId: sole.id, phone: "+919876543211" });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await db().select().from(t.user).where(eq(t.user.id, sole.id)))[0].phone, "+919876543211");
  // the person themselves can always change their own
  const c = await signedIn(shared.email);
  const list = (await c.get(ACADEMIES)).json as { academies: { academyId: string }[] };
  await c.post(SELECT, { academyId: list.academies[0].academyId });
  const own = await c.post("/api/academy/communications/phone", { phone: "+919876543212" });
  assert.equal(own.status, 200, own.text);
  assert.equal((await db().select().from(t.user).where(eq(t.user.id, shared.id)))[0].phone, "+919876543212");
});

/** Two academies with no owner, and former owners to restore (an inactive OWNER membership is a "former owner"). */
async function formerOwner(academyId: string, alsoActiveInGreen: boolean) {
  const p = await person(alsoActiveInGreen ? [{ academyId: "green", role: "COACH" }] : [], "fo");
  await db().insert(t.memberships).values({ academyId, userId: p.id, role: "OWNER", active: false });
  return p;
}
async function academyWithoutOwner(id: string) {
  await db().insert(t.academies).values({ id, name: `Recovery ${id}`, timezone: "UTC" });
  return id;
}
const restore = async (email: string, academyId?: string) => {
  const req = await requestOwnerRestore({ email, reason: "Ticket 7788: identity verified by phone call", operator: "alice", academyId });
  return approveOwnerRestore({ requestId: req.requestId, approvalCode: req.approvalCode, operator: "bob" });
};

test("D6: owner restoration for a person in several academies names the academy, restores only that role, and leaves their password and sessions alone", async () => {
  const academy = await academyWithoutOwner(`rec-${unique()}`);
  const p = await formerOwner(academy, true);
  const c = await signedIn(p.email);
  const list = (await c.get(ACADEMIES)).json as { academies: { academyId: string }[] };
  assert.equal(list.academies.length, 1, "before: only green is active");
  const hash = await hashOf(p.id);
  const sessions = await sessionsOf(p.id);

  await assert.rejects(() => requestOwnerRestore({ email: p.email, reason: "Ticket 7788: identity verified by phone call", operator: "alice" }), /more than one academy.*--academy/s);
  await assert.rejects(() => describeOwnerRestore(p.email, "blue"), /no membership in that academy/);
  const preview = await describeOwnerRestore(p.email, academy);
  assert.equal(preview.credentialsShared, true);

  const done = await restore(p.email, academy);
  assert.equal(done.credentialsChanged, false);
  assert.equal(done.temporaryPassword, null, "no temporary password is issued");
  assert.equal(done.expiresAt, null);
  assert.deepEqual([(await membership(p.id, academy)).role, (await membership(p.id, academy)).active], ["OWNER", true]);
  assert.equal((await membership(p.id, "green")).role, "COACH", "their other academy is untouched");
  assert.equal(await hashOf(p.id), hash, "the password is unchanged");
  assert.equal(await sessionsOf(p.id), sessions, "no session was ended");
  assert.equal(await db().select().from(t.temporaryCredential).where(eq(t.temporaryCredential.userId, p.id)).then((r) => r.length), 0, "and they are not forced to change it");
  // the same session carries on, and now offers both academies
  assert.equal(((await c.get(ACADEMIES)).json as { academies: unknown[] }).academies.length, 2);
  const logged = (await db().select().from(t.securityEvent).where(eq(t.securityEvent.event, "OPERATOR_OWNER_RESTORED"))).filter((e) => e.targetUserId === p.id);
  assert.equal(logged.length, 1);
  assert.deepEqual([logged[0].academyId, (logged[0].detail as { credentialsChanged: boolean }).credentialsChanged], [academy, false]);
});

test("D6: a person who belongs to only that academy is restored exactly as before: temporary password, sessions ended", async () => {
  const academy = await academyWithoutOwner(`rec-${unique()}`);
  const p = await formerOwner(academy, false);
  // a sole-membership former owner has no session while inactive; give them one to prove it is revoked
  await db().insert(t.session).values({ id: `s-${p.id}`, token: `t-${p.id}`, userId: p.id, expiresAt: new Date(Date.now() + 3_600_000) });
  const hash = await hashOf(p.id);
  assert.equal((await describeOwnerRestore(p.email)).credentialsShared, false);
  const done = await restore(p.email);
  assert.equal(done.credentialsChanged, true);
  assert.ok(done.temporaryPassword && done.temporaryPassword.length >= 12);
  assert.ok(done.expiresAt && done.expiresAt.getTime() > Date.now());
  assert.equal(done.revokedSessions, 1);
  assert.notEqual(await hashOf(p.id), hash, "a new temporary password replaced the old");
  assert.equal(((await membership(p.id, academy)).role), "OWNER");
});
