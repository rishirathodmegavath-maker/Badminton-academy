import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { FIXTURE_PASSWORD, addFixtureUser } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { code, unique } from "./helpers/accounts";
import {
  MAX_OWNED_ACADEMIES,
  NEW_ACADEMY_FEATURES,
  cleanAcademyName,
  cleanCity,
  cleanContactEmail,
  validTimezone,
} from "../src/modules/identity/academy-creation";
import { inviteTokenFrom } from "../src/modules/identity/ui/create-academy-form";

/**
 * A signed-in person with no academy can start one and becomes its owner (they used to be stuck on "not part of an academy
 * yet"). Real HTTP, real route handlers. The server decides the role and checks every input; the client only supplies what
 * the academy needs to begin (name, contact email, country, city, currency and, optionally, a time zone).
 */
let app: Harness;
before(async () => {
  app = await startHarness("academy-creation");
}, { timeout: HOOK_TIMEOUT });
after(async () => {
  await app.stop();
}, { timeout: HOOK_TIMEOUT });

const db = () => database();
const CREATE = "/api/auth/account/create-academy";
const ACADEMIES = "/api/auth/account/academies";
const valid = { name: "Riverside Badminton Academy", contactEmail: "Owner@Example.test", country: "IN", city: "Gurugram", currency: "INR" };
async function newcomer() {
  const id = `ac-${unique()}`;
  const { email } = await addFixtureUser(id, []);
  const client = app.anonymous();
  const r = await client.signIn(email, FIXTURE_PASSWORD);
  assert.equal(r.status, 200, r.text.slice(0, 150));
  return { id, email, client };
}

test("name, city, contact email and time zone checks are pure and strict", () => {
  assert.equal(cleanAcademyName("  Riverside   Badminton \n Academy "), "Riverside Badminton Academy");
  for (const bad of ["", " ", "A", "x".repeat(81), "Bad\u0000name", "Tab\u0007bell"])
    assert.throws(() => cleanAcademyName(bad), /academy name/, JSON.stringify(bad));
  assert.equal(cleanCity("  Navi   Mumbai "), "Navi Mumbai");
  for (const bad of ["", "G", "x".repeat(81), "Bad\u0000city"]) assert.throws(() => cleanCity(bad), /city/i, JSON.stringify(bad));
  assert.equal(cleanContactEmail("  Owner@Example.TEST "), "owner@example.test");
  for (const bad of ["", "no-at-sign", "a@b", "a b@c.com", "@x.com", `${"x".repeat(250)}@a.com`]) assert.throws(() => cleanContactEmail(bad), /email/i, bad);
  assert.ok(validTimezone("Asia/Kolkata"));
  assert.ok(validTimezone("America/New_York"));
  for (const bad of ["", "Mars/Olympus", "not a zone", "x".repeat(65)]) assert.ok(!validTimezone(bad), bad);
});

test("an invitation link or its bare code is understood; anything else is not", () => {
  const token = "aof6GObk9g6YHpWfXoMc7TOOCNB9gEYAOwV_y5cYbvs";
  assert.equal(token.length, 43);
  assert.equal(inviteTokenFrom(`http://127.0.0.1:3300/invite#${token}`), token);
  assert.equal(inviteTokenFrom(`  ${token}  `), token);
  assert.equal(inviteTokenFrom(`https://academy.example/invite#${token}\n`), token);
  for (const bad of ["", "hello", "http://127.0.0.1:3300/invite", "short-code", `${token}extra`]) assert.equal(inviteTokenFrom(bad), null, bad);
});

test("a person with no academy starts one: they become its OWNER, it opens for the session, with its settings and features", async () => {
  const p = await newcomer();
  const before = await p.client.get(ACADEMIES);
  assert.equal((before.json as { noAccess: string }).noAccess, "NO_MEMBERSHIP");

  const r = await p.client.post(CREATE, { ...valid, name: "  Riverside   Badminton Academy ", timezone: "Asia/Kolkata" });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const made = r.json as { academyId: string; name: string; role: string };
  assert.equal(made.name, "Riverside Badminton Academy");
  assert.equal(made.role, "OWNER");

  const after = (await p.client.get(ACADEMIES)).json as { academies: { academyId: string; name: string; role: string; current: boolean }[] };
  assert.deepEqual(after.academies, [{ academyId: made.academyId, name: "Riverside Badminton Academy", role: "OWNER", current: true }]);

  const identity = (await p.client.get("/api/academy/identity")).json as { role: string; academy: { name: string } };
  assert.equal(identity.role, "OWNER");
  assert.equal(identity.academy.name, "Riverside Badminton Academy");

  const [academy] = await db().select().from(t.academies).where(eq(t.academies.id, made.academyId));
  assert.equal(academy.timezone, "Asia/Kolkata");
  const [settings] = await db().select().from(t.academySettings).where(eq(t.academySettings.academyId, made.academyId));
  assert.equal(settings.data.country, "IN");
  assert.equal(settings.data.currency, "INR");
  assert.equal(settings.data.city, "Gurugram");
  assert.equal(settings.data.contactEmail, "owner@example.test");
  const [plan] = await db().select().from(t.entitlements).where(eq(t.entitlements.academyId, made.academyId));
  assert.deepEqual(plan.data, { ...NEW_ACADEMY_FEATURES }, "reports, nutrition, communications and video are available from the start");
  const rows = await db().select().from(t.memberships).where(eq(t.memberships.userId, p.id));
  assert.deepEqual(rows.map((m) => [m.academyId, m.role, m.active]), [[made.academyId, "OWNER", true]]);

  const events = (await db().select().from(t.securityEvent).where(eq(t.securityEvent.targetUserId, p.id))).filter((e) => e.event === "ACADEMY_CREATED");
  assert.equal(events.length, 1);
  assert.equal(events[0].academyId, made.academyId);
  assert.equal(events[0].actorId, p.id);
});

test("the time zone is optional: the country's usual one is used, and US academies get USD settings", async () => {
  const india = await newcomer();
  const a = (await india.client.post(CREATE, valid)).json as { academyId: string };
  assert.equal((await db().select().from(t.academies).where(eq(t.academies.id, a.academyId)))[0].timezone, "Asia/Kolkata");

  const us = await newcomer();
  const b = (await us.client.post(CREATE, { ...valid, country: "US", currency: "USD", city: "Brooklyn", name: "Brooklyn Shuttlers" })).json as { academyId: string };
  assert.equal((await db().select().from(t.academies).where(eq(t.academies.id, b.academyId)))[0].timezone, "America/New_York");
  const [settings] = await db().select().from(t.academySettings).where(eq(t.academySettings.academyId, b.academyId));
  assert.deepEqual([settings.data.country, settings.data.currency], ["US", "USD"]);
});

test("saving the academy settings later keeps the city and contact email", async () => {
  const p = await newcomer();
  const made = (await p.client.post(CREATE, valid)).json as { academyId: string };
  const [row] = await db().select().from(t.academySettings).where(eq(t.academySettings.academyId, made.academyId));
  const save = await p.client.post("/api/academy/settings/save", {
    version: row.version,
    name: "Riverside Badminton Academy",
    timezone: "Asia/Kolkata",
    country: "IN",
    currency: "INR",
    colour: "#17644e",
    policy: "",
    retentionDays: 365,
    features: { reports: true, nutrition: true, communications: true, manualVideo: true },
  });
  assert.equal(save.status, 200, save.text.slice(0, 200));
  const [after] = await db().select().from(t.academySettings).where(eq(t.academySettings.academyId, made.academyId));
  assert.equal(after.data.city, "Gurugram");
  assert.equal(after.data.contactEmail, "owner@example.test");
});

test("an academy is empty when created: no other academy's people, players or records are in it", async () => {
  const p = await newcomer();
  const made = (await p.client.post(CREATE, { ...valid, name: "Brand New Academy" })).json as { academyId: string };
  const players = await db().select().from(t.players).where(eq(t.players.academyId, made.academyId));
  const batches = await db().select().from(t.batches).where(eq(t.batches.academyId, made.academyId));
  const members = await db().select().from(t.memberships).where(eq(t.memberships.academyId, made.academyId));
  assert.equal(players.length, 0);
  assert.equal(batches.length, 0);
  assert.equal(members.length, 1);
  // The built-in drill library is available to a new academy straight away (50 drills, not stored per academy).
  const training = await p.client.get("/api/training");
  assert.equal(training.status, 200, training.text.slice(0, 200));
  const drills = (training.json as { drills: { id: string }[] }).drills;
  assert.equal(drills.filter((d) => d.id.startsWith("bd-")).length, 50);
});

test("bad input is refused with a reason and creates nothing", async () => {
  const p = await newcomer();
  for (const [body, expected] of [
    [{ ...valid, name: "A" }, "ACADEMY_NAME_INVALID"],
    [{ ...valid, name: "   " }, "ACADEMY_NAME_INVALID"],
    [{ ...valid, contactEmail: "not-an-email" }, "CONTACT_EMAIL_INVALID"],
    [{ ...valid, city: " " }, "CITY_INVALID"],
    [{ ...valid, timezone: "Mars/Olympus" }, "TIMEZONE_INVALID"],
  ] as const) {
    const r = await p.client.post(CREATE, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(code(r), expected);
  }
  for (const body of [{ ...valid, country: "FR" }, { ...valid, currency: "EUR" }, { name: "Fine Academy" }]) {
    const r = await p.client.post(CREATE, body);
    assert.ok(r.status >= 400 && r.status < 500, `refused: ${JSON.stringify(body)} (${r.status})`);
  }
  assert.equal((await db().select().from(t.memberships).where(eq(t.memberships.userId, p.id))).length, 0);
});

test("the role is never taken from the request, and a signed-out caller is refused", async () => {
  const p = await newcomer();
  const r = await p.client.post(CREATE, { ...valid, role: "ADMIN", academyId: "academy-green", userId: "someone-else" });
  assert.ok(r.status === 200 || r.status === 400, `extra fields are ignored or refused, not obeyed (${r.status})`);
  const rows = await db().select().from(t.memberships).where(eq(t.memberships.userId, p.id));
  for (const m of rows) assert.equal(m.role, "OWNER");
  assert.ok(!rows.some((m) => m.academyId === "academy-green"));

  const anonymous = await app.anonymous().post(CREATE, valid);
  assert.equal(anonymous.status, 401);
});

test(`one person can own at most ${MAX_OWNED_ACADEMIES} academies`, async () => {
  const p = await newcomer();
  for (let i = 1; i <= MAX_OWNED_ACADEMIES; i++) {
    const body = { ...valid, name: `Limit Academy ${i}` };
    const r = await p.client.post(CREATE, body);
    // The request limiter allows a few creations a minute; wait it out rather than weaken it.
    if (r.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      const again = await p.client.post(CREATE, body);
      assert.equal(again.status, 200, again.text.slice(0, 150));
    } else assert.equal(r.status, 200, r.text.slice(0, 150));
  }
  await new Promise((resolve) => setTimeout(resolve, 61_000));
  const over = await p.client.post(CREATE, { ...valid, name: "One Too Many" });
  assert.equal(over.status, 409);
  assert.equal(code(over), "ACADEMY_LIMIT");
  assert.equal((await db().select().from(t.memberships).where(eq(t.memberships.userId, p.id))).length, MAX_OWNED_ACADEMIES);
});
