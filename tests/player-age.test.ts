import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { ageOn, ageState, daysBetween, isCalendarDay, isUnder18, turns18On } from "../src/modules/players/domain/age";
import { idsFor } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";

/** Players are under 18: the date rules, the refusals on the server, and the owner's age review. */

test("age: a player is under 18 until the day of their 18th birthday", () => {
  assert.equal(ageOn("2008-06-15", "2026-06-14"), 17);
  assert.equal(ageOn("2008-06-15", "2026-06-15"), 18);
  assert.equal(isUnder18("2008-06-15", "2026-06-14"), true);
  assert.equal(isUnder18("2008-06-15", "2026-06-15"), false, "on the birthday they are 18");
  assert.equal(turns18On("2008-06-15"), "2026-06-15");
  assert.equal(turns18On("2008-02-29"), "2026-03-01", "a 29 February birthday turns 18 on 1 March in a common year");
  assert.equal(turns18On("2004-02-29"), "2022-03-01");
  assert.equal(daysBetween("2026-11-18", "2026-12-18"), 30);
  assert.equal(isCalendarDay("2014-02-31"), false);
  assert.equal(isCalendarDay("2014-02-28"), true);
  assert.equal(isCalendarDay("14-02-28"), false);
  assert.equal(isCalendarDay(""), false);
});

test("age: where a player stands for the owner's review", () => {
  const today = "2026-11-18";
  assert.deepEqual(ageState({ birthDate: "", status: "ACTIVE" }, today), { kind: "BIRTH_DATE_MISSING" });
  assert.deepEqual(ageState({ birthDate: "2014-02-03", status: "ACTIVE" }, today), { kind: "OK" });
  assert.deepEqual(ageState({ birthDate: "2008-12-01", status: "ACTIVE" }, today), { kind: "TURNING_18", on: "2026-12-01", inDays: 13 });
  assert.deepEqual(ageState({ birthDate: "2008-11-18", status: "ACTIVE" }, today), { kind: "DECIDE", turnedOn: "2026-11-18" });
  assert.deepEqual(ageState({ birthDate: "2000-01-01", status: "ARCHIVED" }, today), { kind: "OK" }, "an archived player needs nothing");
  const keep = { decision: "KEEP" as const, reason: "Coaching until the season ends.", decidedBy: "o", decidedAt: "2026-11-01T00:00:00Z", recheckOn: "2027-01-31" };
  assert.deepEqual(ageState({ birthDate: "2000-01-01", status: "ACTIVE", ageDecision: keep }, today), { kind: "KEPT", until: "2027-01-31" });
  assert.equal(ageState({ birthDate: "2000-01-01", status: "ACTIVE", ageDecision: keep }, "2027-02-01").kind, "DECIDE", "the decision is asked for again when its day has passed");
});

const A = idsFor("childA");
const route = (p: string) => `/api/academy/${p}`;
let app: Harness;
const db = () => database();
before(async () => { app = await startHarness("player-age"); }, { timeout: HOOK_TIMEOUT });
after(async () => { await app.stop(); }, { timeout: HOOK_TIMEOUT });

const profile = (over: Record<string, unknown>) => ({ adult: false, birthDate: "2014-02-03", email: "", phone: "", notes: "", status: "ACTIVE", selfUserId: null, preferences: "", ...over });
async function save(body: Record<string, unknown>) {
  const owner = await app.as("owner");
  return owner.post(route("players/save"), body);
}
const stored = async () => (await db().select().from(t.profiles).where(and(eq(t.profiles.academyId, "green"), eq(t.profiles.playerId, A.playerId))))[0];
const yearsAgo = (n: number) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
};

test("a new player needs a date of birth, and must be under 18", { timeout: TEST_TIMEOUT }, async () => {
  const base = { name: "Kiran Test", batchId: "green-main" };
  const none = await save({ ...base, profile: profile({ birthDate: "" }) });
  assert.equal(none.status, 422, none.text);
  assert.match(none.text, /date of birth/i);
  const adult = await save({ ...base, profile: profile({ birthDate: yearsAgo(21) }) });
  assert.equal(adult.status, 422, adult.text);
  assert.match(adult.text, /under 18/);
  const eighteenToday = await save({ ...base, profile: profile({ birthDate: yearsAgo(18) }) });
  assert.equal(eighteenToday.status, 422, "turning 18 today is 18");
  const future = await save({ ...base, profile: profile({ birthDate: yearsAgo(-1) }) });
  assert.equal(future.status, 422);
  const impossible = await save({ ...base, profile: profile({ birthDate: "2014-02-31" }) });
  assert.equal(impossible.status, 422);
  const flagged = await save({ ...base, profile: profile({ adult: true }) });
  assert.equal(flagged.status, 422, "the adult flag is refused");
  assert.match(flagged.text, /Adult players are not supported/);
  const selfAccess = await save({ ...base, profile: profile({ selfUserId: "someone" }) });
  assert.equal(selfAccess.status, 422, "player self-access is refused");
  const ok = await save({ ...base, profile: profile({ birthDate: yearsAgo(17) }) });
  assert.equal(ok.status, 200, ok.text);
});

test("the owner decides about a player who has turned 18: keep for now (reject) or archive (accept)", { timeout: TEST_TIMEOUT }, async () => {
  const [row] = await db().select().from(t.profiles).where(and(eq(t.profiles.academyId, "green"), eq(t.profiles.playerId, A.playerId)));
  // The player had no decision needed; make the record 18 or older directly (as if the years had passed).
  await db().update(t.profiles).set({ data: { ...row.data, birthDate: "2000-01-01", status: "ACTIVE" } }).where(and(eq(t.profiles.academyId, "green"), eq(t.profiles.playerId, A.playerId)));
  const owner = await app.as("owner");
  const version = async () => (await stored()).version;
  const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

  // Editing the profile cannot get around the rule.
  const edit = await save({ id: A.playerId, version: await version(), name: "Alpha", batchId: "green-main", profile: profile({ birthDate: "2000-01-01" }) });
  assert.equal(edit.status, 422, "an 18+ player with no owner decision cannot be saved");
  assert.match(edit.text, /age review/);

  const noReason = await owner.post(route("players/age-review"), { playerId: A.playerId, version: await version(), decision: "KEEP", reason: "x", recheckOn: tomorrow });
  assert.equal(noReason.status, 422, "a reason is required");
  const pastDay = await owner.post(route("players/age-review"), { playerId: A.playerId, version: await version(), decision: "KEEP", reason: "Coaching until the season ends.", recheckOn: "2020-01-01" });
  assert.equal(pastDay.status, 422, "the day to look again must be ahead");
  const tooFar = await owner.post(route("players/age-review"), { playerId: A.playerId, version: await version(), decision: "KEEP", reason: "Coaching until the season ends.", recheckOn: "2099-01-01" });
  assert.equal(tooFar.status, 422, "at most a year ahead");

  const keep = await owner.post(route("players/age-review"), { playerId: A.playerId, version: await version(), decision: "KEEP", reason: "Coaching until the season ends.", recheckOn: tomorrow });
  assert.equal(keep.status, 200, keep.text);
  const kept = (await stored()).data;
  assert.equal(kept.ageDecision?.decision, "KEEP");
  assert.equal(kept.ageDecision?.recheckOn, tomorrow);
  assert.equal(kept.status, "ACTIVE", "rejecting leaves the player active");
  // While the decision stands the player can be edited, and the decision cannot be changed from the profile.
  const edited = await save({ id: A.playerId, version: await version(), name: "Alpha", batchId: "green-main", profile: profile({ birthDate: "2000-01-01", notes: "Still coming." }) });
  assert.equal(edited.status, 200, edited.text);
  assert.equal((await stored()).data.ageDecision?.recheckOn, tomorrow, "editing the profile keeps the decision");

  const archive = await owner.post(route("players/age-review"), { playerId: A.playerId, version: await version(), decision: "ARCHIVE" });
  assert.equal(archive.status, 200, archive.text);
  const archived = (await stored()).data;
  assert.equal(archived.status, "ARCHIVED", "accepting archives the player");
  assert.equal(archived.ageDecision, null);
  const again = await owner.post(route("players/age-review"), { playerId: A.playerId, version: await version(), decision: "ARCHIVE" });
  assert.equal(again.status, 409, "an archived player needs no decision");
  assert.equal((await db().select().from(t.audit).where(and(eq(t.audit.academyId, "green"), eq(t.audit.entityId, A.playerId), eq(t.audit.action, "age-review-archive")))).length, 1, "the decision is audited");
});

test("only the owner decides, and players have no login of their own", { timeout: TEST_TIMEOUT }, async () => {
  for (const who of ["coach", "guardian", "finance"] as const) {
    const r = await (await app.as(who)).post(route("players/age-review"), { playerId: A.playerId, version: 1, decision: "ARCHIVE" });
    assert.ok([401, 403].includes(r.status), `${who}: ${r.status}`);
  }
  const owner = await app.as("owner");
  const invite = await owner.post(route("invitations/create"), { email: "adult.player@example.test", kind: "ADULT_PLAYER", expiresInDays: 7 });
  assert.equal(invite.status, 422, invite.text);
  const member = await owner.post(route("settings/member"), { name: "Adult Player", email: "adult.login@example.test", role: "ADULT_PLAYER", active: true, professionalAttestation: "" });
  assert.equal(member.status, 422, member.text);
});
