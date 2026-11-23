import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import {
  DEFAULT_REQUIRED_ROLES,
  MfaPolicyError,
  ROLE_NAMES,
  effectiveLevel,
  levelFor,
  mfaPolicy,
  normaliseRoles,
  stricterLevel,
  stricterMode,
  type MfaMode,
} from "../src/modules/identity/mfa-policy";
import { FIXTURE_PASSWORD, ROLE_USER, ROLES, USERS, addFixtureUser, type Role } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { OWNER_REAUTH_MAX_FAILURES } from "../src/modules/identity/sign-in-throttle";
import { nextTestAddress, type TestClient } from "./helpers/client";
import {
  AUTH,
  CHANGE,
  NEW_PASSWORD,
  RESET,
  STATE,
  code,
  events,
  newMember as makeMember,
  reset,
  setExpiry,
  signedIn as signIn,
  type ResetResult,
} from "./helpers/accounts";
import { MFA_GRACE_DAYS, MfaAdminError, changeMfaPolicy, graceStatus, meaningfulReason } from "../src/modules/identity/mfa-admin";
import { TF, enroll as enrollUser, startChallenge, twoFactorRedirect } from "./helpers/mfa";
/**
 * Phase 4: MFA policy (system + academy layers, per role), enforcement on every route, owner-only
 * administration with re-authentication, staged rollout, readiness reporting and the surrounding
 * lifecycle (role changes, reactivation, new accounts, several memberships, stale sessions).
 * The policy is read from the database / environment on every request, so tests change it in-process.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("mfa-policy");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    delete process.env.MFA_ENFORCEMENT;
    delete process.env.MFA_REQUIRED_ROLES;
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
beforeEach(async () => {
  delete process.env.MFA_ENFORCEMENT;
  delete process.env.MFA_REQUIRED_ROLES;
  await database().delete(t.academyMfaPolicy);
});
const POLICY = `${AUTH}/account/mfa-policy`;
const STAFF = [...DEFAULT_REQUIRED_ROLES];
const newMember = (role: Role = "COACH", academy: "green" | "blue" | "quiet" = "green") =>
  makeMember(role, academy, "mp");
const signedIn = (email: string, password = FIXTURE_PASSWORD) => signIn(app, email, password);
/** Direct setup (bypasses the API) for scenarios that are not about changing the policy. */
const setPolicy = (mode: MfaMode, roles: string[] = STAFF, academyId = "green") =>
  database()
    .insert(t.academyMfaPolicy)
    .values({ academyId, mode, roles, warnSince: mode === "warn" ? new Date() : null })
    .onConflictDoUpdate({ target: t.academyMfaPolicy.academyId, set: { mode, roles } });
const stored = async (academyId = "green") =>
  (await database().select().from(t.academyMfaPolicy).where(eq(t.academyMfaPolicy.academyId, academyId)))[0];
type Body = { mode: string; roles: string[]; reason?: string; ownerPassword?: string; acknowledgeRisk?: boolean; emergencyOverride?: boolean; emergencyReason?: string };
const DAY = 86_400_000;
/** Moves the stored warning start back in time (the only way to simulate days passing over HTTP). */
const ageWarning = (ms: number, academyId = "green") =>
  database().update(t.academyMfaPolicy).set({ warnSince: new Date(Date.now() - ms) }).where(eq(t.academyMfaPolicy.academyId, academyId));
const change = (client: TestClient, body: Body) =>
  client.clone(nextTestAddress()).post(POLICY, {
    reason: "Rolling out two-factor authentication to staff in stages.",
    ownerPassword: FIXTURE_PASSWORD,
    ...body,
  });
async function enrolledOwner() {
  const member = await newMember("OWNER");
  const e = await enrollUser(app, member);
  return { ...member, client: e.client, enrolled: e };
}
const gateOf = async (client: TestClient) => ((await client.get(STATE)).json as { gate: string | null }).gate;
type Overview = {
  stage: string;
  canEdit: boolean;
  roles: { role: string; level: string; source: string; members: number; enrolled: number }[];
  totals: { accounts: number; enrolled: number; needingAction: number };
  needsAction: { id: string; name: string; role: string; level: string; hasTemporaryPassword: boolean }[];
  recovery: { activeOwners: number; enrolledOwners: number; singleOwner: boolean };
  enforcement: { ready: boolean; blockers: { code: string }[]; warnings: { code: string }[] };
  academy: { mode: string; roles: string[]; warnSince: string | null };
  deployment: { mode: string; roles: string[] };
};
const overview = async (client: TestClient) => (await client.clone(nextTestAddress()).get(POLICY)).json as Overview;
const count = async () => (await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, "MFA_POLICY_CHANGED"))).length;
test("policy model: approved defaults, levels, and the stricter layer always wins", () => {
  assert.deepEqual(DEFAULT_REQUIRED_ROLES, ["OWNER", "ADMIN", "HEAD_COACH", "COACH", "FINANCE", "NUTRITION_PRO"]);
  const enforce = { mode: "enforce" as const, roles: STAFF };
  for (const role of ROLE_NAMES) {
    const staff = STAFF.includes(role);
    assert.equal(levelFor(enforce, role), staff ? "required" : "optional", role);
    assert.equal(levelFor({ mode: "warn", roles: STAFF }, role), staff ? "warn" : "optional", role);
    assert.equal(levelFor({ mode: "off", roles: STAFF }, role), "optional", role);
  }
  assert.equal(levelFor(null, "OWNER"), "optional");
  assert.equal(levelFor(enforce, null), "optional");
  assert.equal(stricterLevel("warn", "required"), "required");
  assert.equal(stricterLevel("optional", "warn"), "warn");
  assert.equal(stricterMode("off", "warn"), "warn");
  assert.equal(stricterMode("enforce", "off"), "enforce");
  // Per role, never the weaker layer: an academy cannot lower the deployment.
  const system = mfaPolicy({ MFA_ENFORCEMENT: "enforce", MFA_REQUIRED_ROLES: "OWNER" });
  assert.equal(effectiveLevel(system, { mode: "off", roles: [] }, "OWNER"), "required");
  assert.equal(effectiveLevel(system, null, "OWNER"), "required");
  assert.equal(effectiveLevel(system, { mode: "warn", roles: ["COACH"] }, "COACH"), "warn");
  assert.equal(effectiveLevel(system, { mode: "enforce", roles: ["COACH"] }, "OWNER"), "required");
  assert.equal(effectiveLevel(mfaPolicy({}), null, "OWNER"), "optional", "nothing is required by default");
  assert.deepEqual(normaliseRoles(["coach", "OWNER"]), ["OWNER", "COACH"]);
  assert.throws(() => normaliseRoles(["OWNER", "CHEF"]), MfaPolicyError);
  assert.throws(() => normaliseRoles(["OWNER", "owner"]), /more than once/);
});
test("the policy table rejects unknown modes and orphan academies", async () => {
  // Drizzle wraps the driver error: the constraint name is on the cause.
  const names = (pattern: RegExp) => (e: unknown) => pattern.test(`${e} ${(e as { cause?: unknown }).cause}`);
  await assert.rejects(() => database().insert(t.academyMfaPolicy).values({ academyId: "green", mode: "maybe", roles: [] }), names(/academy_mfa_policy_mode_check|check constraint/i));
  await assert.rejects(() => database().insert(t.academyMfaPolicy).values({ academyId: "no-such-academy", mode: "warn", roles: [] }), names(/foreign key|academy_mfa_policy_academy_id/i));
});
test("reading the policy: owners and admins only; every other role and anonymous callers are refused", async () => {
  for (const role of ROLES) {
    const r = await (await app.as(ROLE_USER[role])).get(POLICY);
    if (role === "OWNER" || role === "ADMIN") {
      assert.equal(r.status, 200, role);
      assert.equal((r.json as Overview).canEdit, role === "OWNER", role);
    } else {
      assert.equal(r.status, 403, role);
      assert.equal(code(r), "NOT_AUTHORIZED", role);
    }
  }
  assert.equal((await app.anonymous().get(POLICY)).status, 401);
});
test("changing the policy: only an owner, never admin or anyone else, and nothing is stored when refused", async () => {
  for (const role of ROLES) {
    if (role === "OWNER") continue; // exercised below
    const client = await app.as(ROLE_USER[role]);
    const r = await change(client, { mode: "warn", roles: STAFF });
    assert.equal(r.status, 403, role);
    assert.equal(code(r), "NOT_OWNER", role);
  }
  assert.equal(await stored(), undefined);
  assert.equal((await app.anonymous().post(POLICY, { mode: "warn", roles: STAFF, reason: "Anonymous attempt to change.", ownerPassword: "x" })).status, 401);
  // A forged cross-site request is refused even with a valid owner session.
  const boss = await enrolledOwner();
  const forged = await boss.client.post(POLICY, { mode: "warn", roles: STAFF, reason: "Cross-site forgery attempt.", ownerPassword: FIXTURE_PASSWORD }, { origin: "https://evil.example" });
  assert.ok(forged.status >= 400, `forged origin ${forged.status}`);
  assert.equal(await stored(), undefined);
  // The academy comes from the owner's membership: a body field cannot redirect the change.
  const sneaky = await change(boss.client, { mode: "warn", roles: STAFF, academyId: "blue" } as Body);
  assert.equal(sneaky.status, 200, sneaky.text);
  assert.equal((await stored("green")).mode, "warn");
  assert.equal(await stored("blue"), undefined);
});
test("validation, re-authentication and its throttle", async () => {
  const boss = await enrolledOwner();
  const bad = (body: Record<string, unknown>) => boss.client.post(POLICY, { mode: "warn", roles: STAFF, reason: "A perfectly good reason.", ownerPassword: FIXTURE_PASSWORD, ...body });
  assert.equal((await bad({ mode: "mandatory" })).status, 400);
  assert.equal((await bad({ roles: "OWNER" })).status, 400);
  assert.equal((await bad({ reason: "short" })).status, 400);
  assert.equal((await bad({ reason: "x".repeat(501) })).status, 400);
  assert.equal((await bad({ ownerPassword: "" })).status, 400);
  assert.equal(code(await bad({ roles: ["OWNER", "WIZARD"] })), "BAD_ROLES");
  assert.equal(code(await bad({ roles: ["OWNER", "OWNER"] })), "BAD_ROLES");
  assert.equal(code(await bad({ roles: [] })), "ROLES_REQUIRED");
  const wrong = await bad({ ownerPassword: "Not-The-Owners-Password-1" });
  assert.equal(wrong.status, 403);
  assert.equal(code(wrong), "REAUTHENTICATION_FAILED");
  assert.equal(await stored(), undefined, "nothing changed by any refused request");
  assert.equal((await bad({})).status, 200);
  // The wrong-password counter is the owner's shared re-authentication counter: ten judged, rest paused.
  const other = await enrolledOwner();
  const clones = Array.from({ length: 14 }, () => other.client.clone(`198.51.100.${100 + Math.floor(Math.random() * 100)}`));
  const results = await Promise.all(clones.map((c, i) => c.post(POLICY, { mode: "warn", roles: STAFF, reason: "Parallel wrong password.", ownerPassword: `Wrong-${i}-Policy-Password` })));
  const judged = results.filter((r) => code(r) === "REAUTHENTICATION_FAILED").length;
  assert.ok(judged <= 10, `${judged} wrong passwords were judged`);
  assert.ok(results.every((r) => r.status === 403 || r.status === 429));
});
test("rollout is staged: off to warn to required; a role cannot skip the warning stage", async () => {
  const boss = await enrolledOwner();
  const first = await count();
  const direct = await change(boss.client, { mode: "enforce", roles: STAFF, acknowledgeRisk: true });
  assert.equal(direct.status, 409);
  assert.equal(code(direct), "WARN_FIRST");
  assert.equal(await stored(), undefined);
  const warn = await change(boss.client, { mode: "warn", roles: STAFF });
  assert.equal(warn.status, 200, warn.text);
  assert.equal((warn.json as { changed: boolean }).changed, true);
  const row = await stored();
  assert.deepEqual([row.mode, row.roles, row.warnSince instanceof Date, row.updatedBy], ["warn", STAFF, true, boss.id]);
  // Warning has just begun: enforcement is refused even with the acknowledgement (see the P4-01 tests).
  assert.equal(code(await change(boss.client, { mode: "enforce", roles: STAFF, acknowledgeRisk: true })), "GRACE_PERIOD_ACTIVE");
  await ageWarning(MFA_GRACE_DAYS * DAY + 1000);
  const noAck = await change(boss.client, { mode: "enforce", roles: STAFF });
  assert.equal(code(noAck), "ACKNOWLEDGEMENT_REQUIRED");
  const falseAck = await change(boss.client, { mode: "enforce", roles: STAFF, acknowledgeRisk: false });
  assert.equal(code(falseAck), "ACKNOWLEDGEMENT_REQUIRED");
  assert.equal((await stored()).mode, "warn");
  // Roles added to enforcement must already be at warn.
  const widen = await change(boss.client, { mode: "enforce", roles: [...STAFF, "GUARDIAN"], acknowledgeRisk: true });
  assert.equal(code(widen), "WARN_FIRST");
  assert.match((widen.json as { message: string }).message, /GUARDIAN/);
  const ok = await change(boss.client, { mode: "enforce", roles: STAFF, acknowledgeRisk: true });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await stored()).mode, "enforce");
  // Narrowing or lowering is always allowed and needs no acknowledgement.
  assert.equal((await change(boss.client, { mode: "enforce", roles: ["OWNER", "ADMIN"] })).status, 200);
  assert.equal((await change(boss.client, { mode: "warn", roles: STAFF })).status, 200);
  assert.equal((await change(boss.client, { mode: "off", roles: [] })).status, 200);
  assert.equal((await stored()).warnSince, null);
  // An identical request changes and records nothing.
  const before = await count();
  assert.equal(before - first, 5, "warn, enforce, narrowed, warn, off");
  const same = await change(boss.client, { mode: "off", roles: [] });
  assert.equal((same.json as { changed: boolean }).changed, false);
  assert.equal(await count(), before);
});
test("making a role required needs the changing owner to be enrolled themselves", async () => {
  const lone = await newMember("OWNER");
  await setPolicy("warn");
  const client = await signedIn(lone.email);
  const r = await change(client, { mode: "enforce", roles: STAFF, acknowledgeRisk: true });
  assert.equal(r.status, 409);
  assert.equal(code(r), "ACTOR_NOT_ENROLLED");
  assert.equal((await stored()).mode, "warn");
  const view = await overview(client);
  assert.ok(view.enforcement.blockers.some((b) => b.code === "ACTOR_NOT_ENROLLED"));
  assert.equal(view.enforcement.ready, false);
});
test("every policy change is a security event with who, what and why, visible only to its own academy", async () => {
  const boss = await enrolledOwner();
  const first = await count();
  assert.equal((await change(boss.client, { mode: "warn", roles: ["OWNER", "COACH"], reason: "Pilot with owners and coaches first." })).status, 200);
  const [event] = await events(boss.id, "MFA_POLICY_CHANGED");
  assert.equal(event, undefined, "target is the academy, not a person");
  const rows = (await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, "MFA_POLICY_CHANGED"))).filter((e) => e.actorId === boss.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].academyId, "green");
  assert.deepEqual(rows[0].detail, { fromMode: "off", toMode: "warn", fromRoles: [], roles: ["OWNER", "COACH"], reason: "Pilot with owners and coaches first." });
  const log = await boss.client.get(`/api/academy/security-events?event=MFA_POLICY_CHANGED&person=${boss.id}`);
  const shown = (log.json as { events: { label: string; actor: { id: string } | null; detail: Record<string, unknown> }[] }).events;
  assert.equal(shown.length, 1);
  assert.equal(shown[0].actor?.id, boss.id);
  assert.deepEqual(shown[0].detail, { fromMode: "off", toMode: "warn", fromRoles: [], roles: ["OWNER", "COACH"], reason: "Pilot with owners and coaches first." });
  assert.ok(!/password|secret|backup|totp/i.test(JSON.stringify(shown)));
  const blue = await signedIn(USERS.blueOwner.email);
  assert.equal(((await blue.get("/api/academy/security-events?event=MFA_POLICY_CHANGED")).json as { events: unknown[] }).events.length, 0);
  // Refused changes leave no event.
  const refused = await change(boss.client, { mode: "enforce", roles: STAFF });
  assert.equal(refused.status, 409);
  assert.equal(await count(), first + 1);
});
test("one academy's policy never touches another's", async () => {
  await setPolicy("enforce");
  const blueCoach = await signedIn(USERS.blueCoach.email);
  assert.equal((await blueCoach.get("/api/academy/identity")).status, 200);
  assert.equal(await gateOf(blueCoach), null);
  const greenCoach = await signedIn((await newMember("COACH")).email);
  assert.equal(code(await greenCoach.get("/api/academy")), "MFA_ENROLLMENT_REQUIRED");
  const blueOwner = await signedIn(USERS.blueOwner.email);
  const view = await overview(blueOwner);
  assert.equal(view.academy.mode, "off");
  assert.ok(view.roles.every((r) => r.level === "optional"));
  assert.ok(!JSON.stringify(view).includes("Fixture green") && !JSON.stringify(view).includes(USERS.owner.id));
});
test("academy enforcement: each of the eight roles, signed in and not enrolled", async () => {
  await setPolicy("enforce");
  for (const role of ROLES) {
    const client = await signedIn((await newMember(role)).email);
    const staff = STAFF.includes(role);
    const academy = await client.get("/api/academy/identity");
    const training = await client.get("/api/training");
    if (staff) {
      assert.equal(academy.status, 403, role);
      assert.equal(code(academy), "MFA_ENROLLMENT_REQUIRED", role);
      assert.equal(training.status, 403, role);
      assert.equal((await client.post("/api/academy/players/save", {})).status, 403, role);
      assert.equal(await gateOf(client), "MFA_ENROLLMENT_REQUIRED", role);
    } else {
      assert.equal(academy.status, 200, role);
      assert.equal(await gateOf(client), null, role);
    }
    const state = (await client.get(STATE)).json as { mfa: { mode: string; level: string; required: boolean; enrolmentRequired: boolean } };
    assert.deepEqual(state.mfa, { mode: "enforce", level: staff ? "required" : "optional", required: staff, enrolmentRequired: staff }, role);
  }
});
test("warning stage: every staff role is told, nobody loses access, optional roles are not told", async () => {
  await setPolicy("warn");
  for (const role of ROLES) {
    const client = await signedIn((await newMember(role)).email);
    assert.equal((await client.get("/api/academy/identity")).status, 200, role);
    assert.equal(await gateOf(client), null, role);
    const mfa = ((await client.get(STATE)).json as { mfa: { level: string; required: boolean } }).mfa;
    assert.equal(mfa.level, STAFF.includes(role) ? "warn" : "optional", role);
  }
});
test("a required person is never locked out: enrol from the gated session, then the second factor is part of sign-in", async () => {
  await setPolicy("enforce");
  const finance = await newMember("FINANCE");
  const e = await enrollUser(app, finance);
  assert.equal((await e.client.get("/api/academy/identity")).status, 200);
  assert.equal(await gateOf(e.client), null);
  const next = await startChallenge(app, finance.email);
  assert.ok(twoFactorRedirect(next.step1), "password alone no longer opens a session");
  assert.equal((await next.client.get("/api/academy")).status, 401);
  assert.equal((await next.client.post(`${TF}/verify-totp`, { code: e.code() })).status, 200);
  assert.equal((await next.client.get("/api/academy/identity")).status, 200);
});
test("a stricter deployment setting cannot be lowered by an academy; an academy can raise a weaker one", async () => {
  const coach = await signedIn((await newMember("COACH")).email);
  const owner = await enrolledOwner();
  process.env.MFA_ENFORCEMENT = "enforce";
  process.env.MFA_REQUIRED_ROLES = "OWNER";
  await setPolicy("off", []);
  assert.equal((await coach.get("/api/academy/identity")).status, 200, "coach is not in the deployment list");
  const lowered = await change(owner.client, { mode: "off", roles: [] });
  assert.equal(lowered.status, 200);
  const view = await overview(owner.client);
  const row = (r: string) => view.roles.find((x) => x.role === r)!;
  assert.deepEqual([row("OWNER").level, row("OWNER").source], ["required", "deployment"]);
  assert.equal(view.stage, "enforce");
  // Academy raises the coach to warn on top of the deployment's owner-only enforcement.
  await setPolicy("warn", ["COACH"]);
  assert.equal((await overview(owner.client)).roles.find((r) => r.role === "COACH")!.level, "warn");
  assert.equal(await gateOf(coach), null);
  // Deployment warn, academy enforce: the academy's stricter level applies.
  process.env.MFA_ENFORCEMENT = "warn";
  process.env.MFA_REQUIRED_ROLES = "COACH";
  await setPolicy("enforce", ["COACH"]);
  assert.equal(code(await coach.get("/api/academy")), "MFA_ENROLLMENT_REQUIRED");
});
test("a misconfigured deployment value fails closed: no authenticated request is served", async () => {
  const coach = await signedIn((await newMember("COACH")).email);
  assert.equal((await coach.get("/api/academy/identity")).status, 200);
  process.env.MFA_ENFORCEMENT = "enforced";
  const r = await coach.get("/api/academy/identity");
  assert.ok(r.status >= 500, `status ${r.status}`);
  assert.ok(!r.text.includes("enforced"), "the bad value is not echoed");
});
test("role changes take effect immediately, in both directions, on existing sessions", async () => {
  const boss = (await enrolledOwner()).client;
  await setPolicy("enforce", ["OWNER", "ADMIN"]);
  const person = await newMember("COACH");
  const session = await signedIn(person.email);
  assert.equal((await session.get("/api/academy/identity")).status, 200, "coach is not required");
  const save = (role: string, active = true) =>
    boss.post("/api/academy/settings/member", { id: person.id, name: `Fixture ${person.id}`, email: person.email, role, active, professionalAttestation: "" });
  assert.equal((await save("ADMIN")).status, 200);
  assert.equal(code(await session.get("/api/academy/identity")), "MFA_ENROLLMENT_REQUIRED", "promotion gates the same session at once");
  assert.equal((await save("GUARDIAN")).status, 200);
  assert.equal((await session.get("/api/academy/identity")).status, 200, "demotion lifts it");
  // Deactivate, then reactivate into a required role: no session survives, and the new login is gated.
  assert.equal((await save("ADMIN", false)).status, 200);
  assert.equal((await session.get("/api/academy/identity")).status, 401);
  assert.equal((await save("ADMIN", true)).status, 200);
  const back = await signedIn(person.email);
  assert.equal(code(await back.get("/api/academy/identity")), "MFA_ENROLLMENT_REQUIRED");
  assert.equal(await gateOf(back), "MFA_ENROLLMENT_REQUIRED");
});
test("an enrolled person who is promoted keeps working; an unenrolled one is held to enrolment only", async () => {
  const boss = (await enrolledOwner()).client;
  await setPolicy("enforce", ["ADMIN"]);
  const enrolledPerson = await newMember("COACH");
  const e = await enrollUser(app, enrolledPerson);
  await boss.post("/api/academy/settings/member", { id: enrolledPerson.id, name: `Fixture ${enrolledPerson.id}`, email: enrolledPerson.email, role: "ADMIN", active: true, professionalAttestation: "" });
  assert.equal((await e.client.get("/api/academy/identity")).status, 200);
});
test("a brand-new member: temporary password first, then required enrolment, then access", async () => {
  const boss = (await enrolledOwner()).client;
  await setPolicy("enforce");
  const email = `new-hire-${Date.now()}@example.test`;
  const created = await boss.post("/api/academy/settings/member", { name: "New Hire", email, role: "COACH", active: true, professionalAttestation: "" });
  assert.equal(created.status, 200, created.text);
  const { temporaryPassword, id } = created.json as { temporaryPassword: string; id: string };
  const person = app.anonymous();
  assert.equal((await person.signIn(email, temporaryPassword)).status, 200);
  assert.equal(code(await person.get("/api/academy")), "PASSWORD_CHANGE_REQUIRED");
  assert.equal((await person.post(`${TF}/enable`, { password: temporaryPassword })).status, 403, "no enrolment before the password is replaced");
  const replacement = NEW_PASSWORD();
  assert.equal((await person.post(CHANGE, { currentPassword: temporaryPassword, newPassword: replacement })).status, 200);
  assert.equal(code(await person.get("/api/academy")), "MFA_ENROLLMENT_REQUIRED");
  const enable = await person.post(`${TF}/enable`, { password: replacement });
  assert.equal(enable.status, 200, enable.text);
  const { parseProvisioningUri, totpAt } = await import("./helpers/totp");
  assert.equal((await person.post(`${TF}/verify-totp`, { code: totpAt(parseProvisioningUri((enable.json as { totpURI: string }).totpURI).secret, 0) })).status, 200);
  assert.equal((await person.get("/api/academy/identity")).status, 200);
  assert.equal((await events(id, "MFA_ENABLED")).length, 1);
});
test("an expired temporary password is reported before any MFA requirement", async () => {
  const target = await newMember("COACH");
  const issued = await reset(await signedIn(USERS.owner.email), target.id);
  const temporary = (issued.json as ResetResult).temporaryPassword;
  await setPolicy("enforce");
  await setExpiry(target.id, new Date(Date.now() - 1000), new Date(Date.now() - 73 * 3600 * 1000));
  const r = await app.anonymous().signIn(target.email, temporary);
  assert.equal(code(r), "TEMPORARY_PASSWORD_EXPIRED");
});
test("several memberships: the strictest requirement applies, never the weakest", async () => {
  const both = await addFixtureUser("mp-both", [
    { academyId: "green", role: "GUARDIAN" },
    { academyId: "blue", role: "COACH" },
  ]);
  await setPolicy("enforce", STAFF, "blue");
  const client = await signedIn(both.email);
  assert.equal(await gateOf(client), "MFA_ENROLLMENT_REQUIRED", "the blue coach membership requires it");
  const mfa = ((await client.get(STATE)).json as { mfa: { level: string } }).mfa;
  assert.equal(mfa.level, "required");
  await setPolicy("off", [], "blue");
  assert.equal(await gateOf(client), null);
  await setPolicy("warn", STAFF, "green");
  await setPolicy("enforce", STAFF, "blue");
  assert.equal(await gateOf(client), "MFA_ENROLLMENT_REQUIRED");
  // An inactive membership does not count.
  const stale = await addFixtureUser("mp-stale", [
    { academyId: "green", role: "GUARDIAN" },
    { academyId: "blue", role: "COACH", active: false },
  ]);
  assert.equal(await gateOf(await signedIn(stale.email)), null);
});
test("an enrolled person cannot turn off a required second factor; optional and warn-stage people can", async () => {
  await setPolicy("enforce");
  const coach = await newMember("COACH");
  const guardian = await newMember("GUARDIAN");
  const c = await enrollUser(app, coach);
  const g = await enrollUser(app, guardian);
  const refused = await c.client.post(`${TF}/disable`, { password: FIXTURE_PASSWORD });
  assert.equal(refused.status, 403);
  assert.equal(code(refused), "MFA_REQUIRED_BY_POLICY");
  assert.equal((await database().select().from(t.user).where(eq(t.user.id, coach.id)))[0].twoFactorEnabled, true);
  assert.equal((await database().select().from(t.twoFactor).where(eq(t.twoFactor.userId, coach.id))).length, 1);
  assert.equal((await g.client.post(`${TF}/disable`, { password: FIXTURE_PASSWORD })).status, 200, "optional role may turn it off");
  await setPolicy("warn");
  const w = await enrollUser(app, await newMember("FINANCE"));
  assert.equal((await w.client.post(`${TF}/disable`, { password: FIXTURE_PASSWORD })).status, 200, "warn stage is not a requirement");
  // Recovery material is still the person's own to renew while required.
  const codes = await c.client.post(`${TF}/generate-backup-codes`, { password: FIXTURE_PASSWORD });
  assert.equal(codes.status, 200);
});
test("lost device under enforcement: an owner's authenticator reset leads back through enrolment, audited", async () => {
  await setPolicy("enforce");
  const boss = await enrolledOwner();
  const target = await newMember("NUTRITION_PRO");
  const e = await enrollUser(app, target);
  // Admins cannot; the owner needs a reason and their own password.
  const admin = await signedIn((await newMember("ADMIN")).email);
  assert.equal((await reset(admin, target.id, { resetAuthenticator: true })).status, 403);
  assert.equal((await reset(boss.client, target.id, { resetAuthenticator: true, ownerPassword: "Wrong-Owner-Password-1" })).status, 403);
  assert.equal((await reset(boss.client, target.id, { resetAuthenticator: true, reason: "short" })).status, 400);
  const done = await reset(boss.client, target.id, { resetAuthenticator: true, reason: "Lost phone and recovery codes; verified in person." });
  assert.equal(done.status, 200, done.text);
  assert.equal((done.json as ResetResult).authenticatorRemoved, true);
  assert.equal((await e.client.get("/api/academy/identity")).status, 401, "old sessions end");
  assert.equal((await events(target.id, "MFA_RESET_BY_ADMIN")).length, 1);
  assert.ok(!JSON.stringify(await events(target.id)).includes((done.json as ResetResult).temporaryPassword));
  const person = app.anonymous();
  assert.equal((await person.signIn(target.email, (done.json as ResetResult).temporaryPassword)).status, 200);
  assert.equal(code(await person.get("/api/academy")), "PASSWORD_CHANGE_REQUIRED");
  const replacement = NEW_PASSWORD();
  assert.equal((await person.post(CHANGE, { currentPassword: (done.json as ResetResult).temporaryPassword, newPassword: replacement })).status, 200);
  assert.equal(code(await person.get("/api/academy")), "MFA_ENROLLMENT_REQUIRED", "required again, never bypassed");
  // A deactivated person cannot be reset (not a member of this academy any more).
  const gone = await newMember("COACH");
  await boss.client.post("/api/academy/settings/member", { id: gone.id, name: `Fixture ${gone.id}`, email: gone.email, role: "COACH", active: false, professionalAttestation: "" });
  const denied = await reset(boss.client, gone.id, { resetAuthenticator: true });
  assert.ok(denied.status === 404 || denied.status === 403, `status ${denied.status}`);
});
test("recovery codes sign in once under enforcement, and the session they open is not gated", async () => {
  await setPolicy("enforce");
  const person = await newMember("HEAD_COACH");
  const e = await enrollUser(app, person);
  const first = e.backupCodes[0];
  const a = await startChallenge(app, person.email);
  assert.ok(twoFactorRedirect(a.step1));
  assert.equal((await a.client.post(`${TF}/verify-backup-code`, { code: first })).status, 200);
  assert.equal((await a.client.get("/api/academy/identity")).status, 200);
  const b = await startChallenge(app, person.email);
  assert.notEqual((await b.client.post(`${TF}/verify-backup-code`, { code: first })).status, 200, "each code works once");
});
test("readiness report: accurate counts, names without e-mail, active members only, nothing secret", async () => {
  await setPolicy("warn");
  const boss = await enrolledOwner();
  const enrolledCoach = await newMember("COACH");
  await enrollUser(app, enrolledCoach);
  const waiting = await newMember("FINANCE");
  const away = await newMember("COACH");
  await database().update(t.memberships).set({ active: false }).where(eq(t.memberships.userId, away.id));
  const guardian = await newMember("GUARDIAN");
  const view = await overview(boss.client);
  assert.equal(view.stage, "warn");
  const row = (r: string) => view.roles.find((x) => x.role === r)!;
  assert.ok(row("COACH").enrolled >= 1 && row("COACH").members > row("COACH").enrolled - 1);
  assert.ok(view.needsAction.some((m) => m.id === waiting.id && m.level === "warn" && m.hasTemporaryPassword === false));
  assert.ok(!view.needsAction.some((m) => m.id === enrolledCoach.id), "enrolled people need nothing");
  assert.ok(!view.needsAction.some((m) => m.id === away.id), "deactivated members are not counted");
  assert.ok(!view.needsAction.some((m) => m.id === guardian.id), "optional roles are not asked");
  assert.equal(row("GUARDIAN").level, "optional");
  assert.equal(view.totals.accounts - view.totals.enrolled, view.totals.needingAction);
  assert.equal(view.recovery.singleOwner, view.recovery.activeOwners < 2);
  assert.ok(view.enforcement.blockers.some((b) => b.code === "GRACE_PERIOD_ACTIVE"), "the grace period is a blocker, not advice");
  assert.equal(view.enforcement.ready, false);
  assert.equal((view as unknown as { grace: { met: boolean; days: number } }).grace.met, false);
  // A member holding a temporary password is flagged as needing to replace it first.
  const temp = await newMember("COACH");
  await reset(await signedIn(USERS.owner.email), temp.id);
  assert.ok((await overview(boss.client)).needsAction.find((m) => m.id === temp.id)!.hasTemporaryPassword);
  const text = JSON.stringify(view);
  assert.ok(!/@example\.test|secret|backup|totp|hash/i.test(text), "no e-mail addresses or authenticator material");
  for (const m of view.needsAction) assert.deepEqual(Object.keys(m).sort(), ["hasTemporaryPassword", "id", "level", "name", "role"]);
  // Admins see the same report but are told they cannot edit.
  const admin = await signedIn((await newMember("ADMIN")).email);
  const adminView = await overview(admin);
  assert.equal(adminView.canEdit, false);
  assert.deepEqual(adminView.roles.map((r) => r.role), view.roles.map((r) => r.role));
  assert.ok(adminView.totals.accounts >= view.totals.accounts);
});
test("concurrent policy changes are serialised: one wins, one is a no-op, one event is written", async () => {
  const boss = await enrolledOwner();
  const clones = [boss.client.clone("198.51.100.201"), boss.client.clone("198.51.100.202")];
  const results = await Promise.all(clones.map((c) => change(c, { mode: "warn", roles: ["OWNER", "ADMIN"] })));
  assert.ok(results.every((r) => r.status === 200), results.map((r) => r.text).join());
  assert.deepEqual(results.map((r) => (r.json as { changed: boolean }).changed).sort(), [false, true]);
  assert.equal((await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, "MFA_POLICY_CHANGED"))).filter((e) => e.actorId === boss.id).length, 1);
  // Two different targets at once: the final row is exactly one of them, never a blend.
  const race = await Promise.all([
    change(clones[0], { mode: "warn", roles: ["COACH"] }),
    change(clones[1], { mode: "warn", roles: ["FINANCE", "COACH"] }),
  ]);
  assert.ok(race.every((r) => r.status === 200));
  const final = (await stored()).roles.slice().sort().join(",");
  assert.ok(["COACH", "COACH,FINANCE"].includes(final), final);
});
test("the policy endpoint is rate limited per address", async () => {
  const boss = await enrolledOwner();
  const statuses: number[] = [];
  for (let i = 0; i < 13; i++) statuses.push((await boss.client.get(POLICY)).status);
  assert.ok(statuses.includes(429), statuses.join());
  assert.equal(statuses[0], 200);
});
test("the admin owner password is never needed or accepted anywhere else, and the reset route stays owner-only", async () => {
  const admin = await signedIn((await newMember("ADMIN")).email);
  const r = await admin.post(RESET, { userId: USERS.coach.id, reason: "An admin trying the owner route.", ownerPassword: FIXTURE_PASSWORD });
  assert.equal(r.status, 403);
});

/* ---------------------------------------------------------------------------------------------
 * Phase 4.1 (P4-01): the 14-day warning period is a server-side rule, with an owner-only,
 * audited emergency override.
 * ------------------------------------------------------------------------------------------- */
const WARN_START = new Date("2026-03-01T08:30:15.250Z");
const seedWarn = async (warnSince: Date | null = WARN_START, roles: string[] = STAFF, mode: MfaMode = "warn") => {
  await database().delete(t.academyMfaPolicy);
  await database().insert(t.academyMfaPolicy).values({ academyId: "green", mode, roles, warnSince });
};
/** Override events in the academy, optionally by one person (the log is not reset between tests). */
const overrides = async (actorId?: string) => (await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, "MFA_EMERGENCY_OVERRIDE"))).filter((e) => e.academyId === "green" && (!actorId || e.actorId === actorId));
const REASON = "Active phishing campaign against staff accounts; enforcing today.";
const ENFORCE = { mode: "enforce", roles: STAFF, acknowledgeRisk: true } as const;
test("P4-01 grace period boundary: rejected until 14 complete days, accepted at exactly 14 and after (service, injected clock)", async () => {
  const boss = await enrolledOwner();
  const actor = { id: boss.id, academyId: "green" };
  const attempt = (now: Date, extra: Partial<Parameters<typeof changeMfaPolicy>[2]> = {}) =>
    database().transaction((tx) => changeMfaPolicy(tx, actor, { mode: "enforce", roles: STAFF, reason: "Moving staff to required two-factor.", acknowledgeRisk: true, ...extra }, process.env, now));
  const tooEarly = (e: unknown) => e instanceof MfaAdminError && e.status === "CONFLICT" && e.code === "GRACE_PERIOD_ACTIVE";
  const at = (ms: number) => new Date(WARN_START.getTime() + ms);
  const before = (await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, "MFA_POLICY_CHANGED"))).length;
  for (const [label, ms] of [
    ["the moment the warning begins", 0],
    ["one day in", DAY],
    ["13 days 23 hours", 14 * DAY - 3_600_000],
    ["one millisecond short of 14 days", 14 * DAY - 1],
    ["before it began (clock behind)", -DAY],
  ] as const) {
    await seedWarn();
    await assert.rejects(() => attempt(at(ms)), tooEarly, label);
    // Acknowledging the risk is not an emergency override.
    await assert.rejects(() => attempt(at(ms), { acknowledgeRisk: true, emergencyReason: REASON }), tooEarly, `${label}: a reason alone is not an override`);
    const row = await stored();
    assert.deepEqual([row.mode, row.warnSince?.getTime()], ["warn", WARN_START.getTime()], `${label}: nothing changed`);
  }
  for (const [label, ms] of [
    ["exactly 14 days", 14 * DAY],
    ["14 days and one millisecond", 14 * DAY + 1],
    ["15 days", 15 * DAY],
    ["a year", 365 * DAY],
  ] as const) {
    await seedWarn();
    assert.equal((await stored()).warnSince?.getTime(), WARN_START.getTime(), "the start time round-trips exactly");
    const done = await attempt(at(ms));
    assert.equal(done.changed, true, label);
    const row = await stored();
    assert.equal(row.mode, "enforce", label);
    assert.equal(row.warnSince?.getTime(), WARN_START.getTime(), `${label}: the warning start is kept, not rewritten`);
  }
  assert.equal((await overrides(boss.id)).length, 0, "a normal transition never records an emergency override");
  const events = (await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, "MFA_POLICY_CHANGED"))).length;
  assert.equal(events - before, 4, "only the four accepted transitions were logged");
});
test("P4-01 pure helpers: graceStatus counts only this academy's warning for every role, meaningfulReason wants words", () => {
  const warn = (roles: string[], warnSince: Date | null = WARN_START) => ({ mode: "warn" as const, roles, warnSince });
  const now = new Date(WARN_START.getTime() + 14 * DAY);
  assert.equal(graceStatus(warn(STAFF), STAFF, now).met, true);
  assert.equal(graceStatus(warn(STAFF), STAFF, new Date(now.getTime() - 1)).met, false);
  assert.equal(graceStatus(warn(STAFF), ["COACH"], now).met, true, "a subset of the warned roles");
  assert.equal(graceStatus(warn(["COACH"]), STAFF, now).met, false, "a role that was not at warn has had no notice");
  assert.equal(graceStatus(warn(STAFF, null), STAFF, now).met, false, "no recorded start proves nothing");
  assert.equal(graceStatus(null, STAFF, now).met, false);
  assert.equal(graceStatus({ mode: "enforce", roles: STAFF, warnSince: WARN_START }, STAFF, now).met, false, "an enforce row is not a warning");
  assert.equal(graceStatus({ mode: "off", roles: [], warnSince: WARN_START }, STAFF, now).met, false);
  assert.equal(graceStatus(warn(STAFF), STAFF, new Date(WARN_START.getTime() - DAY)).elapsedDays, 0, "never negative");
  assert.equal(meaningfulReason(REASON), true);
  for (const bad of ["", "   ", "short", "urgent urgent urgent urgent", "a b c d e f g h i j k l", "1234567890 1234567890 1234", "x".repeat(40), "test test test test test test"])
    assert.equal(meaningfulReason(bad), false, JSON.stringify(bad));
  assert.equal(meaningfulReason(REASON, REASON.toUpperCase()), false, "the ordinary reason repeated is not an emergency reason");
});
test("P4-01 over HTTP: premature enforcement is a stable 409 even with the acknowledgement; nothing is stored or logged", async () => {
  const boss = await enrolledOwner();
  await seedWarn(new Date(Date.now() - 13 * DAY - 23 * 3_600_000));
  const first = await count();
  const r = await change(boss.client, ENFORCE);
  assert.equal(r.status, 409);
  assert.equal(code(r), "GRACE_PERIOD_ACTIVE");
  assert.match((r.json as { message: string }).message, /14 full days/);
  // Ordinary variations do not get around it either.
  for (const body of [{ ...ENFORCE, acknowledgeRisk: true, emergencyReason: REASON }, { ...ENFORCE, emergencyOverride: false, emergencyReason: REASON }, { ...ENFORCE, emergencyOverride: undefined }] as Body[])
    assert.equal(code(await change(boss.client, body)), "GRACE_PERIOD_ACTIVE");
  assert.equal((await stored()).mode, "warn");
  assert.equal(await count(), first);
  assert.equal((await overrides(boss.id)).length, 0);
  // Once the 14th day is reached it goes through.
  await ageWarning(14 * DAY + 1000);
  assert.equal((await change(boss.client, ENFORCE)).status, 200);
  assert.equal((await stored()).mode, "enforce");
  assert.equal((await overrides(boss.id)).length, 0, "no emergency event for a normal transition");
});
test("P4-01 emergency override: owner, password, explicit flag, real reason, acknowledgement - then it is accepted and audited", async () => {
  const boss = await enrolledOwner();
  await seedWarn(new Date(Date.now() - DAY));
  const warnStart = (await stored()).warnSince!.getTime();
  const eventsBefore = await count();
  // Not explicit: a reason or the acknowledgement alone never counts.
  assert.equal(code(await change(boss.client, { ...ENFORCE, emergencyReason: REASON })), "GRACE_PERIOD_ACTIVE");
  // Explicit but the reason is missing or meaningless.
  const noReason = await change(boss.client, { ...ENFORCE, emergencyOverride: true });
  assert.equal(noReason.status, 400);
  assert.equal(code(noReason), "EMERGENCY_REASON_REQUIRED");
  for (const emergencyReason of ["", "   ", "short", "urgent urgent urgent urgent urgent", "a b c d e f g h i j k l", "x".repeat(60), "Rolling out two-factor authentication to staff in stages."])
    assert.equal(code(await change(boss.client, { ...ENFORCE, emergencyOverride: true, emergencyReason })), "EMERGENCY_REASON_REQUIRED", JSON.stringify(emergencyReason));
  // The acknowledgement is still needed; the override does not replace it.
  assert.equal(code(await change(boss.client, { mode: "enforce", roles: STAFF, emergencyOverride: true, emergencyReason: REASON })), "ACKNOWLEDGEMENT_REQUIRED");
  // Re-authentication is still needed.
  const wrongPassword = await change(boss.client, { ...ENFORCE, emergencyOverride: true, emergencyReason: REASON, ownerPassword: "Not-The-Owners-Password-1" });
  assert.equal(wrongPassword.status, 403);
  assert.equal(code(wrongPassword), "REAUTHENTICATION_FAILED");
  // The staged-rollout rules still apply.
  assert.equal(code(await change(boss.client, { ...ENFORCE, roles: [...STAFF, "GUARDIAN"], emergencyOverride: true, emergencyReason: REASON })), "WARN_FIRST");
  assert.equal((await stored()).mode, "warn", "every refusal left the policy alone");
  assert.equal(await count(), eventsBefore);
  assert.equal((await overrides(boss.id)).length, 0);
  const ok = await change(boss.client, { ...ENFORCE, emergencyOverride: true, emergencyReason: `  ${REASON}  ` });
  assert.equal(ok.status, 200, ok.text);
  const row = await stored();
  assert.deepEqual([row.mode, row.roles, row.warnSince?.getTime(), row.updatedBy], ["enforce", STAFF, warnStart, boss.id]);
  // Exactly one override event, with who, where, why, and how much notice was actually given.
  const rows = (await overrides(boss.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].academyId, "green");
  assert.ok(rows[0].createdAt instanceof Date);
  assert.deepEqual(rows[0].detail, { reason: REASON, roles: ROLE_NAMES.filter((r) => STAFF.includes(r)), requiredDays: 14, daysElapsed: 1 });
  // ... next to the ordinary change event, which says it was an emergency.
  const changed = (await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, "MFA_POLICY_CHANGED"))).filter((e) => e.actorId === boss.id);
  assert.equal(changed.length, 1);
  assert.deepEqual(changed[0].detail, { fromMode: "warn", toMode: "enforce", fromRoles: STAFF, roles: STAFF, reason: "Rolling out two-factor authentication to staff in stages.", emergency: true });
  // Visible to this academy's owner in the log; not to another academy; nothing secret in it.
  const log = await boss.client.get("/api/academy/security-events?event=MFA_EMERGENCY_OVERRIDE");
  const shown = (log.json as { events: { label: string; actor: { id: string } | null; detail: Record<string, unknown> }[] }).events;
  assert.equal(shown.length, 1);
  assert.equal(shown[0].actor?.id, boss.id);
  assert.equal(shown[0].detail.reason, REASON);
  assert.equal(shown[0].detail.daysElapsed, 1);
  assert.ok(!/password|secret|backup|totp/i.test(JSON.stringify(shown)));
  const blue = await signedIn(USERS.blueOwner.email);
  assert.equal(((await blue.get("/api/academy/security-events?event=MFA_EMERGENCY_OVERRIDE")).json as { events: unknown[] }).events.length, 0);
});
test("P4-01 an override that is not needed is not recorded as one", async () => {
  const boss = await enrolledOwner();
  await seedWarn(new Date(Date.now() - 20 * DAY));
  assert.equal((await change(boss.client, { ...ENFORCE, emergencyOverride: true, emergencyReason: REASON })).status, 200);
  assert.equal((await overrides(boss.id)).length, 0, "the grace period was already met");
  const [event] = (await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, "MFA_POLICY_CHANGED"))).filter((e) => e.actorId === boss.id);
  assert.ok(!("emergency" in (event.detail as object)));
  // Lowering is never an emergency matter either.
  assert.equal((await change(boss.client, { mode: "warn", roles: STAFF, emergencyOverride: true, emergencyReason: REASON })).status, 200);
  assert.equal((await overrides(boss.id)).length, 0);
});
test("P4-01 only the academy's owner can use the override: admin and every other role, anonymous callers and other academies are refused", async () => {
  await seedWarn(new Date(Date.now() - DAY));
  const overridesBefore = (await overrides()).length;
  const body = { ...ENFORCE, emergencyOverride: true, emergencyReason: REASON };
  for (const role of ROLES) {
    if (role === "OWNER") continue;
    const r = await change(await app.as(ROLE_USER[role]), body);
    assert.equal(r.status, 403, role);
    assert.equal(code(r), "NOT_OWNER", role);
  }
  const admin = await signedIn((await newMember("ADMIN")).email);
  const denied = await change(admin, body);
  assert.equal(denied.status, 403);
  assert.equal(code(denied), "NOT_OWNER");
  assert.equal((await app.anonymous().post(POLICY, { ...body, reason: "Anonymous emergency attempt.", ownerPassword: "x" })).status, 401);
  // An owner of another academy cannot reach this academy's policy; their own is separate.
  const blueOwner = await signedIn(USERS.blueOwner.email);
  assert.equal(code(await change(blueOwner, body)), "WARN_FIRST", "acts on blue's own (off) policy, never green's");
  const row = await stored();
  assert.deepEqual([row.mode, row.updatedBy], ["warn", null]);
  assert.equal((await overrides()).length, overridesBefore, "nothing was recorded");
  // The service refuses a non-owner on its own, not only the route.
  const adminId = (await newMember("ADMIN")).id;
  await assert.rejects(
    () => database().transaction((tx) => changeMfaPolicy(tx, { id: adminId, academyId: "green" }, { ...ENFORCE, reason: "Admin straight at the service.", emergencyOverride: true, emergencyReason: REASON })),
    (e: unknown) => e instanceof MfaAdminError && e.code === "NOT_OWNER",
  );
});
test("P4-01 the warning start cannot be moved earlier: not by ordinary changes, forged fields, adding roles, or switching modes", async () => {
  const boss = await enrolledOwner();
  assert.equal((await change(boss.client, { mode: "warn", roles: ["OWNER", "ADMIN"] })).status, 200);
  await ageWarning(20 * DAY);
  const started = (await stored()).warnSince!.getTime();
  // A forged start time in the body is ignored; narrowing keeps the start.
  const forged = await change(boss.client, { mode: "warn", roles: ["OWNER"], warnSince: new Date(0).toISOString(), warnStarted: "2000-01-01" } as Body);
  assert.equal(forged.status, 200, forged.text);
  assert.equal((await stored()).warnSince!.getTime(), started, "narrowing the roles keeps the start");
  // Adding roles restarts the clock (they have had no notice), so 20 old days cannot cover them.
  assert.equal((await change(boss.client, { mode: "warn", roles: STAFF })).status, 200);
  const restarted = (await stored()).warnSince!.getTime();
  assert.ok(restarted > started && Math.abs(Date.now() - restarted) < 60_000, "restarted at now, never earlier");
  const early = await change(boss.client, ENFORCE);
  assert.equal(code(early), "GRACE_PERIOD_ACTIVE", "the added roles cannot ride on the old warning");
  assert.equal((await stored()).mode, "warn");
  // Same roles, re-submitted, changes nothing (no reset, no event).
  const events = await count();
  assert.equal(((await change(boss.client, { mode: "warn", roles: STAFF })).json as { changed: boolean }).changed, false);
  assert.equal((await stored()).warnSince!.getTime(), restarted);
  assert.equal(await count(), events);
  // Required keeps the start; going back to warn starts a new notice period; off clears it.
  await ageWarning(15 * DAY);
  const aged = (await stored()).warnSince!.getTime();
  assert.equal((await change(boss.client, ENFORCE)).status, 200);
  assert.equal((await stored()).warnSince!.getTime(), aged, "required keeps the start");
  assert.equal((await change(boss.client, { mode: "warn", roles: STAFF })).status, 200);
  assert.ok((await stored()).warnSince!.getTime() > aged, "required -> warn begins a fresh warning period");
  assert.equal(code(await change(boss.client, ENFORCE)), "GRACE_PERIOD_ACTIVE", "so lowering and re-raising cannot be used to dodge the notice");
  assert.equal((await change(boss.client, { mode: "off", roles: [] })).status, 200);
  assert.equal((await stored()).warnSince, null);
  assert.equal(code(await change(boss.client, ENFORCE)), "WARN_FIRST");
});
test("P4-01 a warning that exists only in the server-wide setting has no start time here, so the academy must start its own (or use the override)", async () => {
  const boss = await enrolledOwner();
  process.env.MFA_ENFORCEMENT = "warn";
  process.env.MFA_REQUIRED_ROLES = "COACH";
  const r = await change(boss.client, { mode: "enforce", roles: ["COACH"], acknowledgeRisk: true });
  assert.equal(r.status, 409);
  assert.equal(code(r), "GRACE_PERIOD_ACTIVE");
  assert.match((r.json as { message: string }).message, /own warning stage/);
  assert.equal(await stored(), undefined);
  const view = await overview(boss.client);
  assert.ok(view.enforcement.blockers.some((b) => b.code === "GRACE_PERIOD_ACTIVE"));
  const emergency = await change(boss.client, { mode: "enforce", roles: ["COACH"], acknowledgeRisk: true, emergencyOverride: true, emergencyReason: REASON });
  assert.equal(emergency.status, 200, emergency.text);
  assert.equal((await stored()).mode, "enforce");
  const [row] = await overrides(boss.id);
  assert.deepEqual(row.detail, { reason: REASON, roles: ["COACH"], requiredDays: 14 }, "no elapsed time is claimed when none is known");
});
test("P4-01 the overview reports the grace period and clears the blocker only when it has been served", async () => {
  const boss = await enrolledOwner();
  await seedWarn(new Date(Date.now() - DAY));
  type WithGrace = Overview & { grace: { days: number; eligibleAt: string | null; met: boolean } };
  const early = (await overview(boss.client)) as WithGrace;
  assert.equal(early.grace.days, 14);
  assert.equal(early.grace.met, false);
  assert.ok(early.grace.eligibleAt && new Date(early.grace.eligibleAt).getTime() > Date.now());
  assert.ok(early.enforcement.blockers.some((b) => b.code === "GRACE_PERIOD_ACTIVE"));
  await ageWarning(14 * DAY + 1000);
  const late = (await overview(boss.client)) as WithGrace;
  assert.equal(late.grace.met, true);
  assert.equal(late.enforcement.blockers.length, 0, JSON.stringify(late.enforcement.blockers));
  assert.equal(late.enforcement.ready, true);
});
test("P4-01 concurrency: parallel premature requests all fail; a racing role addition cannot sneak enforcement past the clock; one override wins", async () => {
  const boss = await enrolledOwner();
  await seedWarn(new Date(Date.now() - 13 * DAY));
  // RC-2: at most OWNER_REAUTH_MAX_FAILURES (5) owner re-authentications can be in flight at once (each claims an
  // attempt before its password is checked), so the parallel burst is five requests, not six.
  const premature = await Promise.all(Array.from({ length: OWNER_REAUTH_MAX_FAILURES }, () => change(boss.client, ENFORCE)));
  assert.ok(premature.every((r) => r.status === 409 && code(r) === "GRACE_PERIOD_ACTIVE"), premature.map((r) => `${r.status}:${code(r)}`).join());
  assert.equal((await stored()).mode, "warn");
  // Served 20 days of warning for STAFF; at the same moment someone adds GUARDIAN to the warning.
  // Whatever the order, enforcement for STAFF is only ever accepted against a start that was 14+ days old.
  await ageWarning(20 * DAY);
  const [widen, enforce] = await Promise.all([change(boss.client, { mode: "warn", roles: [...STAFF, "GUARDIAN"] }), change(boss.client, ENFORCE)]);
  assert.equal(widen.status, 200, widen.text);
  const stateNow = await stored();
  if (enforce.status === 200) {
    // Enforcement ran first (20 days served); the widening then lowered it to warn with a fresh start.
    assert.equal(stateNow.mode, "warn");
    assert.ok(Date.now() - stateNow.warnSince!.getTime() < 60_000);
  } else {
    assert.equal(code(enforce), "GRACE_PERIOD_ACTIVE", enforce.text);
    assert.equal(stateNow.mode, "warn");
  }
  const enforced = (await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, "MFA_POLICY_CHANGED"))).filter((e) => e.actorId === boss.id && (e.detail as { toMode?: string }).toMode === "enforce");
  assert.equal(enforced.length, enforce.status === 200 ? 1 : 0, "an enforcement event exists only if enforcement was accepted");
  // An override racing ordinary requests: one change, one event.
  await seedWarn(new Date(Date.now() - DAY));
  const mixed = await Promise.all([
    change(boss.client, { ...ENFORCE, emergencyOverride: true, emergencyReason: REASON }),
    change(boss.client, ENFORCE),
    change(boss.client, ENFORCE),
    change(boss.client, { ...ENFORCE, emergencyOverride: true, emergencyReason: REASON }),
  ]);
  assert.equal(mixed.filter((r) => r.status === 200 && (r.json as { changed: boolean }).changed).length, 1, mixed.map((r) => `${r.status}:${r.text.slice(0, 80)}`).join(" | "));
  assert.ok(mixed.every((r) => r.status === 200 || code(r) === "GRACE_PERIOD_ACTIVE"));
  assert.equal((await overrides(boss.id)).length, 1, "exactly one emergency override was recorded");
  assert.equal((await stored()).mode, "enforce");
});
test("P4-01 the override skips only the waiting period: enrolment, acknowledgement and the warn-first rule still apply", async () => {
  const lone = await newMember("OWNER");
  await seedWarn(new Date(Date.now() - DAY));
  const client = await signedIn(lone.email);
  const body = { ...ENFORCE, emergencyOverride: true, emergencyReason: REASON };
  assert.equal(code(await change(client, body)), "ACTOR_NOT_ENROLLED", "an unenrolled owner cannot force it on others, emergency or not");
  assert.equal((await stored()).mode, "warn");
  assert.equal((await overrides(lone.id)).length, 0);
});
