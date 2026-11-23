import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { throttleKey } from "../src/modules/identity/sign-in-throttle";
import { saveBranch, assertAnotherActiveOwner, ownerChangeKind } from "../src/modules/settings/application/service";
import { verifyPayment } from "../src/modules/fees/application/service";
import { createDrill, createSession, mutateSession, saveGoal } from "../src/modules/training/application/service";
import { DomainError } from "../src/modules/training/domain/rules";
import { FIXTURE_PASSWORD, USERS, addFixtureUser } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { newMember, signedIn } from "./helpers/accounts";
import { enroll, type Enrolled } from "./helpers/mfa";
import { totpAt } from "./helpers/totp";
import type { TestClient } from "./helpers/client";
/**
 * RC-2 over real HTTP and the real services (AUTHORIZATION_SECURITY_ARCHITECTURE.md, TD-1, TD-2, S-2):
 *
 *   AT-7   granting or removing OWNER needs the acting owner's password AND a second factor, checked in the
 *          request; replayed codes, wrong passwords, wrong codes and missing fields change nothing; a recovery
 *          code works once; five failures lock the shared owner re-authentication counter (429).
 *   AT-7.7/7.8 (PD-1 Option A)  an owner without an authenticator keeps ordinary member management but is
 *          refused every owner change, with no password-only fallback.
 *   AT-8   the last active owner cannot be removed (application layer).
 *   AT-10  an actor whose membership changed after authorization cannot write: lockActor inside the
 *          transaction refuses (403 MEMBERSHIP_INACTIVE / 409 ACCESS_CHANGED) on the academy API and on the
 *          four Training Studio mutations.
 *   AT-12  every owner change and every refused confirmation is in the security log.
 */
let app: Harness;
let owner: Enrolled & { client: TestClient };
before(
  async () => {
    app = await startHarness("rc2-owner-step-up");
    owner = await enroll(app, USERS.owner);
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
const API = "/api/academy";
type Err = { error?: string; code?: string };
const err = (r: { json: unknown }) => (r.json ?? {}) as Err;
const membership = async (userId: string) =>
  (await db().select().from(t.memberships).where(eq(t.memberships.userId, userId)))[0];
const eventsOf = async (event: string) =>
  db().select().from(t.securityEvent).where(eq(t.securityEvent.event, event));
const ownerKey = (userId: string) => throttleKey(process.env.BETTER_AUTH_SECRET!, "owner-reauth", userId);
const counter = async (userId: string) =>
  (await db().select().from(t.signInThrottle).where(eq(t.signInThrottle.key, ownerKey(userId))))[0];
const clearCounter = (userId: string) => db().delete(t.signInThrottle).where(eq(t.signInThrottle.key, ownerKey(userId)));
const clearClaims = (userId: string) => db().delete(t.totpUsed).where(eq(t.totpUsed.userId, userId));
function change(
  c: TestClient,
  target: { id: string; email: string },
  role: string,
  extra: Record<string, unknown> = {},
  active = true,
) {
  return c.post(`${API}/settings/member`, {
    id: target.id,
    name: `Fixture ${target.id}`,
    email: target.email,
    role,
    active,
    professionalAttestation: "",
    ...extra,
  });
}
/** The current code for fx-owner, with earlier replay claims cleared so a fast test never runs out of codes. */
async function fresh() {
  await clearClaims(USERS.owner.id);
  return totpAt(owner.uri.secret, 0);
}
const confirm = (code: string, password = FIXTURE_PASSWORD) => ({ ownerPassword: password, mfaCode: code });
const failures = async (reason: string) =>
  (await eventsOf("OWNER_CHANGE_REAUTH_FAILED")).filter(
    (e) => (e.detail as { reason?: string }).reason === reason && e.actorId === USERS.owner.id,
  ).length;

test("ownerChangeKind: which member changes grant or remove OWNER", () => {
  const k = (old: [string, boolean] | null, next: [string, boolean], creating = false) =>
    ownerChangeKind(old && { role: old[0], active: old[1] }, { role: next[0], active: next[1] }, creating);
  assert.equal(k(null, ["OWNER", true], true), "GRANT", "create an owner");
  assert.equal(k(null, ["OWNER", false], true), "GRANT", "create an inactive owner");
  assert.equal(k(null, ["COACH", true], true), null, "create a coach");
  assert.equal(k(["COACH", true], ["OWNER", true]), "GRANT", "promote");
  assert.equal(k(["COACH", true], ["OWNER", false]), "GRANT", "promote while inactive");
  assert.equal(k(["OWNER", false], ["OWNER", true]), "GRANT", "reactivate an owner");
  assert.equal(k(["OWNER", true], ["COACH", true]), "REVOKE", "demote");
  assert.equal(k(["OWNER", true], ["OWNER", false]), "REVOKE", "deactivate an owner");
  assert.equal(k(["OWNER", false], ["ADMIN", false]), "REVOKE", "change an inactive owner's role");
  assert.equal(k(["OWNER", true], ["OWNER", true]), null, "rename only");
  assert.equal(k(["COACH", true], ["FINANCE", false]), null, "ordinary change");
  assert.equal(k(null, ["OWNER", true]), null, "unknown member (404 later)");
});

test("PD-1 / AT-7.7, AT-7.8: an owner without an authenticator manages members but cannot grant or remove OWNER", async () => {
  const plain = await addFixtureUser("rc2-unenrolled-owner", [{ academyId: "green", role: "OWNER" }]);
  const client = await signedIn(app, plain.email);
  const target = await newMember("COACH", "green", "rc2-pd1");
  // AT-7.7: ordinary member edit, no confirmation needed.
  const ordinary = await change(client, target, "FINANCE");
  assert.equal(ordinary.status, 200, ordinary.text);
  assert.equal((await membership(target.id)).role, "FINANCE");
  // AT-7.8: every owner change is refused before any credential is looked at, whatever is sent.
  const before = await failures("MFA_NOT_ENROLLED");
  for (const extra of [{}, { ownerPassword: FIXTURE_PASSWORD }, confirm("123456")]) {
    const r = await change(client, target, "OWNER", extra);
    assert.equal(r.status, 403, r.text);
    assert.equal(err(r).code, "MFA_ENROLLMENT_REQUIRED_FOR_OWNER_CHANGE");
    assert.match(err(r).error ?? "", /Enroll MFA in your Account Settings/);
  }
  // Removing an owner is refused the same way (no password-only fallback).
  const demote = await change(client, { id: USERS.owner.id, email: USERS.owner.email }, "COACH", {
    ownerPassword: FIXTURE_PASSWORD,
  });
  assert.equal(demote.status, 403);
  assert.equal(err(demote).code, "MFA_ENROLLMENT_REQUIRED_FOR_OWNER_CHANGE");
  assert.equal((await membership(target.id)).role, "FINANCE");
  assert.equal((await membership(USERS.owner.id)).role, "OWNER");
  // Creating a new owner account is an owner grant too.
  const create = await client.post(`${API}/settings/member`, {
    name: "Would Be Owner",
    email: "rc2-would-be-owner@example.test",
    role: "OWNER",
    active: true,
    professionalAttestation: "",
  });
  assert.equal(create.status, 403);
  assert.equal((await db().select().from(t.user).where(eq(t.user.email, "rc2-would-be-owner@example.test"))).length, 0);
  assert.equal(await failures("MFA_NOT_ENROLLED"), before, "these were the un-enrolled owner's events, not fx-owner's");
  const own = (await eventsOf("OWNER_CHANGE_REAUTH_FAILED")).filter((e) => e.actorId === plain.id);
  assert.equal(own.length, 5);
  assert.ok(own.every((e) => (e.detail as { reason: string }).reason === "MFA_NOT_ENROLLED"));
  // Refusals for an un-enrolled owner do not consume owner re-authentication attempts.
  assert.equal(await counter(plain.id), undefined);
});

test("AT-7.5: missing or malformed confirmation is 422 and consumes no attempt", async () => {
  const target = await newMember("COACH", "green", "rc2-missing");
  for (const extra of [
    {},
    { ownerPassword: FIXTURE_PASSWORD },
    { mfaCode: await fresh() },
    confirm("12345"),
    confirm("not-a-code-at-all"),
    { ownerPassword: "", mfaCode: "123456" },
    { ownerPassword: 12345678, mfaCode: "123456" },
  ]) {
    const r = await change(owner.client, target, "OWNER", extra);
    assert.equal(r.status, 422, `${JSON.stringify(Object.keys(extra))}: ${r.text}`);
    assert.equal(err(r).code, "REAUTHENTICATION_REQUIRED");
  }
  assert.equal((await membership(target.id)).role, "COACH");
  assert.equal(await counter(USERS.owner.id), undefined, "no attempt reserved");
  assert.ok((await failures("CREDENTIALS_MISSING")) >= 7);
});

test("AT-7.4 / AT-7.3(invalid): a wrong password or a wrong code changes nothing", async () => {
  const target = await newMember("COACH", "green", "rc2-wrong");
  const wrongPassword = await change(owner.client, target, "OWNER", confirm(await fresh(), "Not-The-Owner-Password-1"));
  assert.equal(wrongPassword.status, 403, wrongPassword.text);
  assert.equal(err(wrongPassword).code, "REAUTHENTICATION_FAILED");
  const wrongCode = await change(owner.client, target, "OWNER", confirm("000000"));
  assert.equal(wrongCode.status, 403);
  assert.equal(err(wrongCode).code, "REAUTHENTICATION_FAILED");
  // The same answer for both: the response does not say which factor failed.
  assert.equal(err(wrongPassword).error, err(wrongCode).error);
  assert.equal((await membership(target.id)).role, "COACH");
  assert.equal((await counter(USERS.owner.id))?.failures, 2, "both attempts counted");
  assert.ok((await failures("PASSWORD_REJECTED")) >= 1);
  assert.ok((await failures("CODE_REJECTED")) >= 1);
  await clearCounter(USERS.owner.id);
});

test("AT-7.1 / AT-7.2 / AT-12: password + TOTP grants OWNER once; the same code cannot be replayed", async () => {
  const target = await newMember("COACH", "green", "rc2-grant");
  const code = await fresh();
  const granted = await change(owner.client, target, "OWNER", confirm(code));
  assert.equal(granted.status, 200, granted.text);
  assert.deepEqual(
    { role: (await membership(target.id)).role, active: (await membership(target.id)).active },
    { role: "OWNER", active: true },
  );
  const [event] = (await eventsOf("OWNER_GRANTED")).filter((e) => e.targetUserId === target.id);
  assert.ok(event, "OWNER_GRANTED logged");
  assert.equal(event.actorId, USERS.owner.id);
  assert.equal(event.academyId, "green");
  assert.deepEqual(event.detail, {
    targetUserId: target.id,
    method: "password+totp",
    fromRole: "COACH",
    toRole: "OWNER",
    fromActive: true,
    toActive: true,
  });
  assert.ok((await eventsOf("MEMBER_ROLE_CHANGED")).some((e) => e.targetUserId === target.id));
  assert.equal(await counter(USERS.owner.id), undefined, "success clears the counter");
  // No credential reaches the log.
  for (const e of await db().select().from(t.securityEvent)) {
    const text = JSON.stringify(e.detail);
    assert.ok(!text.includes(FIXTURE_PASSWORD) && !text.includes(`"${code}"`), `${e.event} leaks a credential`);
  }
  // AT-7.2: replay the accepted code to remove the owner just made.
  const replay = await change(owner.client, target, "COACH", confirm(code));
  assert.equal(replay.status, 403, replay.text);
  assert.equal(err(replay).code, "REAUTHENTICATION_FAILED");
  assert.equal((await membership(target.id)).role, "OWNER");
  assert.ok((await failures("CODE_REPLAYED")) >= 1);
  await clearCounter(USERS.owner.id);
  // AT-12: removing OWNER with a fresh code is logged as OWNER_REVOKED.
  const revoke = await change(owner.client, target, "COACH", confirm(await fresh()));
  assert.equal(revoke.status, 200, revoke.text);
  assert.equal((await membership(target.id)).role, "COACH");
  const [revoked] = (await eventsOf("OWNER_REVOKED")).filter((e) => e.targetUserId === target.id);
  assert.equal((revoked.detail as { method: string; toRole: string }).method, "password+totp");
  assert.equal((revoked.detail as { toRole: string }).toRole, "COACH");
});

test("AT-7.3 / AT-7.6: a recovery code works exactly once, with or without its hyphen", async () => {
  await clearClaims(USERS.owner.id);
  const target = await newMember("COACH", "green", "rc2-backup");
  const [first, second] = owner.backupCodes;
  const ok = await change(owner.client, target, "OWNER", confirm(first));
  assert.equal(ok.status, 200, ok.text);
  const [event] = (await eventsOf("OWNER_GRANTED")).filter((e) => e.targetUserId === target.id);
  assert.equal((event.detail as { method: string }).method, "password+backup");
  const used = (await eventsOf("MFA_RECOVERY_CODE_USED")).filter((e) => e.actorId === USERS.owner.id);
  assert.equal(used.length, 1);
  assert.deepEqual(used[0].detail, { purpose: "OWNER_CHANGE", remaining: owner.backupCodes.length - 1 });
  // Reuse is refused, first by the replay claim and, once that window is gone, because the code was spent.
  const again = await change(owner.client, target, "COACH", confirm(first));
  assert.equal(again.status, 403);
  await clearClaims(USERS.owner.id);
  const spent = await change(owner.client, target, "COACH", confirm(first));
  assert.equal(spent.status, 403, "the code was removed from the stored list");
  assert.equal((await membership(target.id)).role, "OWNER");
  // Typed without the hyphen, another unused code still works.
  const ok2 = await change(owner.client, target, "COACH", confirm(second.replace("-", "")));
  assert.equal(ok2.status, 200, ok2.text);
  assert.equal((await membership(target.id)).role, "COACH");
  await clearCounter(USERS.owner.id);
});

test("AT-7: deactivation, reactivation and creation of owners need confirmation; a rename does not", async () => {
  await clearClaims(USERS.owner.id);
  const second = await addFixtureUser("rc2-second-owner", [{ academyId: "green", role: "OWNER" }]);
  const rename = await owner.client.post(`${API}/settings/member`, {
    id: second.id,
    name: "Second Owner Renamed",
    email: second.email,
    role: "OWNER",
    active: true,
    professionalAttestation: "",
  });
  assert.equal(rename.status, 200, rename.text);
  const deactivateWithout = await owner.client.post(`${API}/settings/member`, {
    id: second.id,
    name: "Second Owner Renamed",
    email: second.email,
    role: "OWNER",
    active: false,
    professionalAttestation: "",
  });
  assert.equal(deactivateWithout.status, 422);
  assert.equal((await membership(second.id)).active, true);
  const deactivate = await owner.client.post(`${API}/settings/member`, {
    id: second.id,
    name: "Second Owner Renamed",
    email: second.email,
    role: "OWNER",
    active: false,
    professionalAttestation: "",
    ...confirm(await fresh()),
  });
  assert.equal(deactivate.status, 200, deactivate.text);
  assert.equal((await membership(second.id)).active, false);
  assert.ok((await eventsOf("OWNER_REVOKED")).some((e) => e.targetUserId === second.id));
  const reactivate = await owner.client.post(`${API}/settings/member`, {
    id: second.id,
    name: "Second Owner Renamed",
    email: second.email,
    role: "OWNER",
    active: true,
    professionalAttestation: "",
    ...confirm(await fresh()),
  });
  assert.equal(reactivate.status, 200, reactivate.text);
  assert.equal((await membership(second.id)).active, true);
  // Create an owner account: confirmation required, then logged as a grant to the new account.
  await clearClaims(USERS.owner.id);
  const body = { name: "Created Owner", email: "rc2-created-owner@example.test", role: "OWNER", active: true, professionalAttestation: "" };
  assert.equal((await owner.client.post(`${API}/settings/member`, body)).status, 422);
  const created = await owner.client.post(`${API}/settings/member`, { ...body, ...confirm(await fresh()) });
  assert.equal(created.status, 200, created.text);
  const id = (created.json as { id: string }).id;
  assert.equal((await membership(id)).role, "OWNER");
  const [grant] = (await eventsOf("OWNER_GRANTED")).filter((e) => e.targetUserId === id);
  assert.equal((grant.detail as { fromRole: null }).fromRole, null);
  await clearCounter(USERS.owner.id);
});

test("AT-3 preserved: an Administrator never reaches the owner confirmation; self-demotion is refused first", async () => {
  const admin = await app.as("admin");
  const target = await newMember("COACH", "green", "rc2-admin");
  const before = (await eventsOf("OWNER_CHANGE_REAUTH_FAILED")).length;
  const r = await change(admin, target, "OWNER", confirm("123456"));
  assert.equal(r.status, 403);
  assert.equal(err(r).error, "Your role cannot perform this action.");
  assert.equal((await eventsOf("OWNER_CHANGE_REAUTH_FAILED")).length, before, "no step-up attempted");
  const self = await change(owner.client, { id: USERS.owner.id, email: USERS.owner.email }, "COACH", confirm("123456"));
  assert.equal(self.status, 422);
  assert.match(err(self).error ?? "", /Use another owner account/);
  assert.equal((await eventsOf("OWNER_CHANGE_REAUTH_FAILED")).length, before);
  assert.equal(await counter(USERS.owner.id), undefined);
});

test("AT-8: the last active owner cannot be removed (application layer)", async () => {
  // The quiet academy has exactly one owner.
  const owners = await db()
    .select()
    .from(t.memberships)
    .where(and(eq(t.memberships.academyId, "quiet"), eq(t.memberships.role, "OWNER"), eq(t.memberships.active, true)));
  assert.equal(owners.length, 1);
  await assert.rejects(
    db().transaction((tx) => assertAnotherActiveOwner(tx, "quiet", USERS.quietOwner.id)),
    (e: unknown) => e instanceof DomainError && e.status === 409 && e.code === "LAST_OWNER",
  );
  // With another active owner it passes; an inactive owner does not count.
  await addFixtureUser("rc2-quiet-inactive-owner", [{ academyId: "quiet", role: "OWNER", active: false }]);
  await assert.rejects(db().transaction((tx) => assertAnotherActiveOwner(tx, "quiet", USERS.quietOwner.id)));
  await db().transaction((tx) => assertAnotherActiveOwner(tx, "green", USERS.owner.id));
});

/** An actor exactly as resolveActor returned it at the start of a request. */
const actorOf = (key: keyof typeof USERS, academyName = "Green"): Actor => ({
  id: USERS[key].id,
  name: USERS[key].name,
  academyId: USERS[key].academyId,
  role: USERS[key].role,
  timezone: "Asia/Kolkata",
  academyName,
});
const setMembership = (userId: string, values: { role?: string; active?: boolean }) =>
  db().update(t.memberships).set(values).where(eq(t.memberships.userId, userId));
const refusedWith = (status: number, code: string) => (e: unknown) =>
  e instanceof DomainError && e.status === status && e.code === code;

test("AT-10: a membership changed after authorization cannot write through the academy API (lockActor)", async () => {
  const finance = actorOf("finance");
  const payment = { id: "rc2-no-such-payment", version: 1, decision: "VERIFIED", reason: "stale actor test" };
  // Control: the current actor passes lockActor and reaches the service's own lookup (404).
  await assert.rejects(verifyPayment(finance, payment), (e: unknown) => e instanceof DomainError && e.status === 404);
  await setMembership(finance.id, { active: false });
  await assert.rejects(verifyPayment(finance, payment), refusedWith(403, "MEMBERSHIP_INACTIVE"));
  await setMembership(finance.id, { active: true, role: "COACH" });
  await assert.rejects(verifyPayment(finance, payment), refusedWith(409, "ACCESS_CHANGED"));
  await setMembership(finance.id, { role: "FINANCE" });
  // A write that would succeed is not written when the actor is stale.
  const head = actorOf("headCoach");
  const branches = async () => (await db().select().from(t.branches).where(eq(t.branches.academyId, "green"))).length;
  const count = await branches();
  await setMembership(head.id, { role: "COACH" });
  await assert.rejects(saveBranch(head, { name: "Stale Branch" }), refusedWith(409, "ACCESS_CHANGED"));
  assert.equal(await branches(), count, "nothing written");
  await setMembership(head.id, { role: "HEAD_COACH" });
  await saveBranch(head, { name: "Fresh Branch" });
  assert.equal(await branches(), count + 1, "control: the same call writes once the actor is current");
});

test("AT-10: the four Training Studio mutations refuse a stale actor and write nothing", async () => {
  // A head coach with no batches: the Stage 5D triggers allow deactivating or re-designating it (they refuse
  // to strand assigned coaching work), and a manager's goal scope covers every player.
  const hc = await addFixtureUser("rc2-stale-hc", [{ academyId: "green", role: "HEAD_COACH" }]);
  const coach: Actor = { ...actorOf("headCoach"), id: hc.id, name: `Fixture ${hc.id}` };
  const created = await createSession(coach);
  const counts = async () => ({
    sessions: (await db().select().from(t.trainingSessions)).length,
    drills: (await db().select().from(t.drills)).length,
    goals: (await db().select().from(t.goals)).length,
    audit: (await db().select().from(t.audit)).length,
  });
  const before = await counts();
  const drill = {
    title: "Stale drill",
    objective: "Should never be saved",
    setup: "Half court",
    steps: ["Step"],
    cues: [],
    minutes: 10,
    skill: "Defence",
    level: "Beginner",
    format: "Singles",
    players: 2,
    equipment: [],
    mistakes: [],
    easier: "",
    harder: "",
  };
  const [player] = await db()
    .select({ id: t.players.id })
    .from(t.players)
    .innerJoin(t.batches, and(eq(t.players.academyId, t.batches.academyId), eq(t.players.batchId, t.batches.id)))
    .where(eq(t.players.academyId, "green"));
  assert.ok(player, "a green player in a batch");
  const goal = { playerId: player.id, title: "Stale goal", method: "Never saved", status: "ACTIVE" };
  const calls = [
    () => createSession(coach),
    () => mutateSession(coach, created.id, { version: created.version, action: "save", payload: {} }),
    () => createDrill(coach, drill),
    () => saveGoal(coach, goal),
  ];
  for (const [state, expected] of [
    [{ active: false }, refusedWith(403, "MEMBERSHIP_INACTIVE")],
    [{ active: true, role: "ADMIN" }, refusedWith(409, "ACCESS_CHANGED")],
  ] as const) {
    await setMembership(coach.id, state);
    for (const [i, call] of calls.entries()) await assert.rejects(call(), expected, `call ${i} with ${JSON.stringify(state)}`);
  }
  assert.deepEqual(await counts(), before, "no session, drill, goal or audit row was written");
  await setMembership(coach.id, { role: "HEAD_COACH", active: true });
  // Controls: the same calls succeed for the current actor.
  await createDrill(coach, drill);
  await saveGoal(coach, goal);
  const after = await counts();
  assert.equal(after.drills, before.drills + 1);
  assert.equal(after.goals, before.goals + 1);
});

test("AT-7.6: five failures lock the shared owner counter for every owner re-authentication (429)", async () => {
  await clearCounter(USERS.owner.id);
  await clearClaims(USERS.owner.id);
  const target = await newMember("COACH", "green", "rc2-lock");
  for (let i = 0; i < 5; i++) {
    const r = await change(owner.client, target, "OWNER", confirm(await fresh(), `Wrong-Password-${i}-xxxxxx`));
    assert.equal(r.status, 403, `attempt ${i + 1}: ${r.text}`);
    await clearClaims(USERS.owner.id);
  }
  const locked = await change(owner.client, target, "OWNER", confirm(await fresh()));
  assert.equal(locked.status, 429, locked.text);
  assert.equal(err(locked).code, "TOO_MANY_ATTEMPTS");
  assert.equal((await membership(target.id)).role, "COACH");
  assert.ok((await failures("TOO_MANY_ATTEMPTS")) >= 1);
  const row = await counter(USERS.owner.id);
  assert.ok(row?.lockedUntil && row.lockedUntil.getTime() > Date.now() + 14 * 60_000, "locked for about 15 minutes");
  // The same counter guards the other owner re-authentications (shared key, owner decision 2026-11-11).
  const hold = await owner.client.post(`${API}/privacy/release`, {
    id: "rc2-no-such-hold",
    reason: "Shared counter check for RC-2.",
    ownerPassword: FIXTURE_PASSWORD,
  });
  assert.equal(hold.status, 429, hold.text);
  await clearCounter(USERS.owner.id);
  const after = await change(owner.client, target, "OWNER", confirm(await fresh()));
  assert.equal(after.status, 200, "usable again once the lock is gone");
});

test("AT-7.6 atomicity: a simultaneous burst of wrong passwords, wrong codes and privacy re-authentications judges exactly five", async () => {
  await clearCounter(USERS.owner.id);
  await clearClaims(USERS.owner.id);
  const target = await newMember("COACH", "green", "rc2-burst");
  const code = totpAt(owner.uri.secret, 0);
  const burst = await Promise.all([
    // Correct password, wrong second factor.
    ...Array.from({ length: 8 }, () => change(owner.client, target, "OWNER", confirm("000000"))),
    // Wrong password, current second factor.
    ...Array.from({ length: 8 }, (_, i) => change(owner.client, target, "OWNER", confirm(code, `Burst-Wrong-${i}-xxxxxxxx`))),
    // The other owner re-authentication on the same counter.
    ...Array.from({ length: 6 }, (_, i) =>
      owner.client.post(`${API}/privacy/release`, { id: "rc2-no-such-hold", reason: "Burst on the shared counter.", ownerPassword: `Burst-Privacy-${i}-xxxx` }),
    ),
  ]);
  const tally: Record<number, number> = {};
  for (const r of burst) tally[r.status] = (tally[r.status] ?? 0) + 1;
  console.log(`AT-7.6 burst (${app.database}): ${JSON.stringify(tally)}`);
  assert.deepEqual(tally, { 403: 5, 429: 17 }, JSON.stringify(burst.map((r) => [r.status, err(r).code])));
  assert.equal((await membership(target.id)).role, "COACH", "nothing changed");
  const row = await counter(USERS.owner.id);
  assert.ok(row?.lockedUntil && row.lockedUntil.getTime() > Date.now(), "the counter is locked");
  await clearCounter(USERS.owner.id);
  await clearClaims(USERS.owner.id);
});
