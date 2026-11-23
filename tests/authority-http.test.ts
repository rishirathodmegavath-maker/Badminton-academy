import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { MEMBERSHIP_MESSAGES } from "../src/modules/identity/membership-messages";
import { OWNER_EXCLUSIVE_CAPABILITIES, STORED_ROLES } from "../src/modules/identity/authority";
import { CANARY, FIXTURE_PASSWORD, ROLES, ROLE_USER, USERS, addFixtureUser, type Role } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { code, newMember, reset, signedIn } from "./helpers/accounts";
import type { TestClient } from "./helpers/client";
/**
 * Role consolidation RC-1 over real HTTP: real route handlers, real Better Auth sessions, a disposable database.
 *
 *   AT-3   an Administrator (stored ADMIN) is refused every one of the five OWNER-only actions, whatever it sends,
 *          and nothing changes; an OWNER passes the same authority gate.
 *   AT-6   a membership whose stored role is not one of the eight gets ROLE_NOT_SUPPORTED and no data.
 *          Inactive memberships are refused before any authority decision, for every role and every action kind.
 *   AT-18  an OWNER of another academy holds the capabilities but reaches nothing outside its academy.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("authority-http");
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
const POLICY = "/api/auth/account/mfa-policy";
const PW = { ownerPassword: FIXTURE_PASSWORD };
type Err = { error?: string; code?: string };
const err = (r: { json: unknown }) => (r.json ?? {}) as Err;

const membership = async (userId: string) =>
  (await db().select().from(t.memberships).where(eq(t.memberships.userId, userId)));
const retentionRows = async () => (await db().select().from(t.retentionPolicies)).length;
const mfaPolicyRow = async (academyId: string) =>
  (await db().select().from(t.academyMfaPolicy).where(eq(t.academyMfaPolicy.academyId, academyId)))[0];
const securityEvents = async () => (await db().select().from(t.securityEvent)).length;
const credentialHash = async (userId: string) =>
  (await db().select().from(t.account).where(and(eq(t.account.userId, userId), eq(t.account.providerId, "credential"))))[0]
    ?.password;

/** The five OWNER-only actions (D1), each as one HTTP request a client can make. */
function ownerOnlyRequests(target: { id: string; email: string }) {
  return [
    {
      capability: "members.manage",
      // Promote an existing member to OWNER: the most direct escalation attempt.
      send: (c: TestClient) =>
        c.post(`${API}/settings/member`, {
          id: target.id,
          name: `Fixture ${target.id}`,
          email: target.email,
          role: "OWNER",
          active: true,
          professionalAttestation: "",
        }),
    },
    {
      capability: "members.resetCredentials",
      send: (c: TestClient) => reset(c, target.id),
    },
    {
      capability: "security.mfa.edit",
      send: (c: TestClient) =>
        c.post(POLICY, {
          mode: "warn",
          roles: ["OWNER", "ADMIN"],
          reason: "RC-1 escalation attempt by a non-owner.",
          ...PW,
        }),
    },
    {
      capability: "privacy.retention",
      send: (c: TestClient) =>
        c.post(`${API}/privacy/policy`, {
          category: "NOPE",
          decision: "APPROVE",
          action: "ERASE",
          retentionDays: 30,
          basis: "RC-1 escalation attempt by a non-owner.",
          ...PW,
        }),
    },
    {
      capability: "privacy.releaseHold",
      send: (c: TestClient) =>
        c.post(`${API}/privacy/release`, { id: "rc1-no-such-hold", reason: "RC-1 escalation attempt by a non-owner.", ...PW }),
    },
  ] as const;
}

async function snapshot(target: { id: string }) {
  return {
    target: await membership(target.id),
    admin: await membership(USERS.admin.id),
    hash: await credentialHash(target.id),
    retention: await retentionRows(),
    mfa: JSON.stringify((await mfaPolicyRow("green")) ?? null),
    owners: (await db().select().from(t.memberships).where(and(eq(t.memberships.academyId, "green"), eq(t.memberships.role, "OWNER"))))
      .map((m) => m.userId)
      .sort(),
  };
}

test("AT-3: the Administrator is refused all five OWNER-only actions and nothing changes", async () => {
  const target = await newMember("COACH", "green", "rc1-target");
  const requests = ownerOnlyRequests(target);
  assert.deepEqual(requests.map((r) => r.capability).sort(), [...OWNER_EXCLUSIVE_CAPABILITIES].sort());
  const admin = await app.as("admin");
  const before = await snapshot(target);
  for (const r of requests) {
    const response = await r.send(admin);
    assert.equal(response.status, 403, `ADMIN ${r.capability}: ${response.status} ${response.text.slice(0, 160)}`);
    // The identity endpoints keep their stable code; the academy API keeps its sentence.
    if (r.capability === "members.resetCredentials" || r.capability === "security.mfa.edit")
      assert.equal(code(response), "NOT_OWNER", r.capability);
    else assert.equal(err(response).error, "Your role cannot perform this action.", r.capability);
  }
  assert.deepEqual(await snapshot(target), before, "no membership, credential, retention or MFA-policy change");
  assert.equal((await membership(USERS.admin.id))[0].role, "ADMIN");
});

test("AT-3: tampering cannot lift the Administrator (self-promotion, forged fields, query and headers)", async () => {
  const admin = await app.as("admin");
  const before = await snapshot({ id: USERS.coach.id });
  const self = {
    id: USERS.admin.id,
    name: USERS.admin.name,
    email: USERS.admin.email,
    role: "OWNER",
    active: true,
    professionalAttestation: "",
  };
  const attempts = [
    () => admin.post(`${API}/settings/member`, self),
    () => admin.post(`${API}/settings/member?role=OWNER&accountType=OWNER`, { ...self, actorRole: "OWNER", accountType: "OWNER", designation: null }),
    () => admin.post(`${API}/settings/member`, self, { headers: { "x-role": "OWNER", "x-account-type": "OWNER", "x-academy-id": "blue" } }),
    () => admin.post(`${API}/settings/member`, { ...self, id: USERS.coach.id, email: USERS.coach.email, name: USERS.coach.name }),
    () => admin.post(`${API}/privacy/policy?role=OWNER`, { category: "NOPE", decision: "APPROVE", basis: "x".repeat(20), role: "OWNER", ...PW }),
  ];
  for (const [i, attempt] of attempts.entries()) {
    const r = await attempt();
    assert.equal(r.status, 403, `attempt ${i}: ${r.status} ${r.text.slice(0, 160)}`);
  }
  assert.deepEqual(await snapshot({ id: USERS.coach.id }), before);
  // The Administrator keeps today's ADMIN permissions (it is not demoted either).
  assert.equal((await admin.get(`${API}/security-events`)).status, 200, "logs.security");
  assert.equal((await admin.get(POLICY)).status, 200, "security.mfa.view");
  const identity = await admin.get(`${API}/identity`);
  assert.equal(identity.status, 200);
  assert.equal((identity.json as { role?: string }).role, "ADMIN", "the stored role is still reported as ADMIN");
});

test("AT-3: every other role is refused the OWNER-only actions; the OWNER passes the same authority gate", async () => {
  const target = await newMember("COACH", "green", "rc1-gate");
  const before = await snapshot(target);
  for (const role of ROLES) {
    if (role === "OWNER") continue;
    const client = await app.as(ROLE_USER[role]);
    for (const r of ownerOnlyRequests(target)) {
      const response = await r.send(client);
      assert.equal(response.status, 403, `${role} ${r.capability}: ${response.status}`);
    }
  }
  assert.deepEqual(await snapshot(target), before);
  // OWNER control: the authority gate lets it through; each request then stops at its own validation (unknown
  // category, unknown hold) or succeeds where it is harmless. None of these is a 403.
  const owner = await app.as("owner");
  const [, resetRequest, , retention, release] = ownerOnlyRequests(target);
  const r1 = await resetRequest.send(owner);
  assert.equal(r1.status, 200, `owner reset ${r1.status} ${r1.text.slice(0, 160)}`);
  assert.notEqual(await credentialHash(target.id), before.hash, "the owner's reset took effect");
  const r2 = await retention.send(owner);
  assert.equal(r2.status, 404, `owner retention ${r2.status}`);
  const r3 = await release.send(owner);
  assert.equal(r3.status, 404, `owner release ${r3.status}`);
  const fresh = await newMember("COACH", "green", "rc1-promote");
  const r4 = await owner.post(`${API}/settings/member`, {
    id: fresh.id,
    name: `Fixture ${fresh.id}`,
    email: fresh.email,
    role: "FINANCE",
    active: true,
    professionalAttestation: "",
  });
  assert.equal(r4.status, 200, `owner member change ${r4.status} ${r4.text.slice(0, 160)}`);
  assert.equal((await membership(fresh.id))[0].role, "FINANCE");
});

test("AT-6: a stored role that is not one of the eight is refused everywhere with ROLE_NOT_SUPPORTED", async () => {
  const unknown = ["STAFF", "PLAYER", "ADMINISTRATOR", "owner", "Owner", "OWNER ", "", "constructor", "__proto__", "COACH,FINANCE"];
  for (const [i, value] of unknown.entries()) {
    assert.ok(!(STORED_ROLES as readonly string[]).includes(value));
    const person = await addFixtureUser(`fx-rc1-unknown-${i}`, [{ academyId: "green", role: value as Role }]);
    const client = await signedIn(app, person.email);
    const academy = await client.get(API);
    assert.equal(academy.status, 403, `${JSON.stringify(value)} academy`);
    assert.equal(err(academy).code, "ROLE_NOT_SUPPORTED", JSON.stringify(value));
    for (const v of Object.values(CANARY.childA)) assert.ok(!academy.text.includes(String(v)), "no data");
    assert.equal((await client.get(`${API}/identity`)).status, 403);
    // The training API refuses by audience first (unchanged order of checks).
    assert.equal((await client.get("/api/training")).status, 403, `${JSON.stringify(value)} training`);
    // Writes are refused too, OWNER-only or not, and nothing is stored.
    const events = await securityEvents();
    for (const path of ["settings/member", "settings/save", "privacy/policy", "fees/plan"])
      assert.equal((await client.post(`${API}/${path}`, { name: "x" })).status, 403, `${JSON.stringify(value)} ${path}`);
    assert.equal(await securityEvents(), events);
  }
});

test("inactive memberships are refused before any authority decision, for the most privileged roles too", async () => {
  for (const role of ["OWNER", "ADMIN", "FINANCE", "HEAD_COACH", "GUARDIAN"] as const) {
    const person = await addFixtureUser(`fx-rc1-off-${role.toLowerCase()}`, [{ academyId: "green", role }]);
    const client = await signedIn(app, person.email);
    assert.equal((await client.get(`${API}/identity`)).status, 200, `${role} while active`);
    await db()
      .update(t.memberships)
      .set({ active: false })
      .where(and(eq(t.memberships.academyId, "green"), eq(t.memberships.userId, person.id)));
    const target = await newMember("COACH", "green", `rc1-off-target-${role.toLowerCase()}`);
    const before = await snapshot(target);
    for (const r of ownerOnlyRequests(target)) {
      const response = await r.send(client);
      assert.equal(response.status, 403, `${role} ${r.capability}`);
    }
    for (const path of ["settings/save", "privacy/request", "fees/plan", "calendar/event"]) {
      const response = await client.post(`${API}/${path}`, { name: "x" });
      assert.equal(response.status, 403, `${role} ${path}`);
      assert.equal(err(response).code, "MEMBERSHIP_INACTIVE", `${role} ${path}`);
      assert.equal(err(response).error, MEMBERSHIP_MESSAGES.MEMBERSHIP_INACTIVE);
    }
    assert.deepEqual(await snapshot(target), before, role);
  }
});

test("AT-18: an OWNER of another academy holds the capabilities but cannot use them on this academy", async () => {
  const blue = await app.as("blueOwner");
  const before = await snapshot({ id: USERS.coach.id });
  // Member management: the green coach is not a member of blue.
  const member = await blue.post(`${API}/settings/member`, {
    id: USERS.coach.id,
    name: USERS.coach.name,
    email: USERS.coach.email,
    role: "OWNER",
    active: true,
    professionalAttestation: "",
  });
  assert.equal(member.status, 404, `cross-academy member ${member.status}`);
  // Credential reset of a green member.
  const r = await reset(blue, USERS.coach.id);
  assert.ok(r.status === 403 || r.status === 404, `cross-academy reset ${r.status}`);
  assert.equal(code(r), "TARGET_NOT_MEMBER");
  // A green legal hold cannot be released from blue (no such hold in blue).
  const [hold] = await db().select().from(t.legalHolds).where(eq(t.legalHolds.academyId, "green"));
  const release = await blue.post(`${API}/privacy/release`, { id: hold?.id ?? "rc1-none", reason: "Cross-academy attempt.", ...PW });
  assert.equal(release.status, 404);
  assert.deepEqual(await snapshot({ id: USERS.coach.id }), before);
});
