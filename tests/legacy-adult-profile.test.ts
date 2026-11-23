import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { bootstrapAcademy } from "../src/modules/academy/application/bootstrap";
import { savePlayer } from "../src/modules/players/application/service";

process.env.BETTER_AUTH_SECRET = "isolated-legacy-adult-test-secret-123456789012345";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
/**
 * A LEGACY adult-player record (the application no longer creates one, but an older database could still hold one, and the
 * database still permits it). Editing it through the ordinary player form must never change who may see it:
 *
 *   before the fix, saving it with the adult flag cleared rewrote the stored flag to "minor", revoked the grants the adult
 *   had made, removed the adult's own-account link (locking the adult out of their own record) and handed the whole record
 *   (contact details, birth date, notes) to every linked guardian, silently, as an ordinary edit.
 *
 * The rows are planted directly in an isolated test database, which is the only way such a record can exist now.
 */
let testDb: TestDatabase | undefined;
const actor = (id: string, role: string): Actor => ({ id, name: `Test ${id}`, role, academyId: "green", timezone: "Asia/Kolkata", academyName: "Academy green" });
const owner = actor("owner", "OWNER"),
  adminActor = actor("admin", "ADMIN"),
  coach = actor("coach", "COACH"),
  guardian = actor("guardian", "GUARDIAN"),
  grantedGuardian = actor("granted", "GUARDIAN"),
  adultSelf = actor("adult-self", "ADULT_PLAYER"),
  minorGuardian = actor("minor-parent", "GUARDIAN");
const ADULT = "adult-p";
const MINOR = "minor-p";
const LEGACY_PROFILE = { ...defaultProfile, adult: true, selfUserId: "adult-self", birthDate: "1990-04-01", email: "adult.private@example.test", phone: "+919800000042", notes: "PRIVATE ADULT NOTE" };

before(async () => {
  testDb = await provisionTestDatabase("legacy-adult");
  const db = database();
  await db.insert(t.academies).values({ id: "green", name: "Academy green", timezone: "Asia/Kolkata" });
  await db.insert(t.academySettings).values({ academyId: "green", data: defaultSettings });
  await db.insert(t.entitlements).values({ academyId: "green", data: { reports: true, nutrition: true, communications: true, manualVideo: true } });
  await db.insert(t.branches).values({ id: "green-branch", academyId: "green", name: "Test branch" });
  for (const a of [owner, adminActor, coach, guardian, grantedGuardian, adultSelf, minorGuardian]) {
    await db.insert(t.user).values({ id: a.id, name: a.name, email: `${a.id}@example.test` });
    await db.insert(t.memberships).values({ academyId: "green", userId: a.id, role: a.role });
  }
  await db.insert(t.batches).values({ id: "green-batch", academyId: "green", coachId: "coach", branchId: "green-branch", name: "Mixed" });
  await db.insert(t.players).values({ id: ADULT, academyId: "green", batchId: "green-batch", name: "Legacy Adult" });
  await db.insert(t.players).values({ id: MINOR, academyId: "green", batchId: "green-batch", name: "Young Player" });
  await db.insert(t.profiles).values({ academyId: "green", playerId: ADULT, data: LEGACY_PROFILE });
  await db.insert(t.profiles).values({ academyId: "green", playerId: MINOR, data: { ...defaultProfile, birthDate: "2014-06-01" } });
  const consent = { portal: true, email: false, whatsapp: false };
  for (const [playerId, userId, relationship] of [
    [ADULT, "adult-self", "Adult self"],
    [ADULT, "guardian", "Parent"],
    [ADULT, "granted", "Parent"],
    [MINOR, "minor-parent", "Parent"],
  ] as const)
    await db.insert(t.guardianLinks).values({ academyId: "green", playerId, userId, relationship, active: true, consent });
  // The adult had shared FEES with one guardian (a live grant).
  await db.insert(t.guardianAccessGrants).values({ academyId: "green", playerId: ADULT, guardianUserId: "granted", scopes: ["FEES"], grantedBy: "adult-self" });
});
after(async () => {
  await testDb?.cleanup();
});

const profileRow = async (playerId: string) => (await database().select().from(t.profiles).where(and(eq(t.profiles.academyId, "green"), eq(t.profiles.playerId, playerId))))[0];
const seenBy = async (a: Actor) => (await bootstrapAcademy(a)).players.map((p) => p.id);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { status?: number; code?: string; message?: string });
/** What the player form would send to "clear the adult flag" for the legacy record. */
const clearTheFlag = (version: number) => ({
  id: ADULT,
  version,
  name: "Legacy Adult",
  batchId: "green-batch",
  profile: { ...LEGACY_PROFILE, adult: false, selfUserId: null, birthDate: "2014-04-01" },
});

test("the starting point: only the adult sees the adult's record; an ungranted guardian sees nothing of it; the granted guardian sees only what was granted", async () => {
  assert.ok((await seenBy(adultSelf)).includes(ADULT), "the adult sees their own record");
  assert.ok(!(await seenBy(guardian)).includes(ADULT), "a guardian with no grant sees nothing of an adult");
  const granted = await seenBy(grantedGuardian);
  assert.ok(granted.includes(ADULT), "a grant opens the record, for the granted sections only");
  assert.ok(!JSON.stringify(await bootstrapAcademy(guardian)).includes("PRIVATE ADULT NOTE"));
});

test("PRIVACY: saving a stored adult profile with the adult flag cleared is refused and changes NOTHING (flag, own-account link, grants, who can see it)", async () => {
  const before = await profileRow(ADULT);
  const eventsBefore = (await database().select().from(t.guardianAccessEvents)).length;
  for (const who of [owner, adminActor]) {
    const e = await refusal(savePlayer(who, clearTheFlag(before.version)));
    assert.equal(e?.status, 409, `${who.role}: ${e?.message}`);
    assert.equal(e?.code, "ADULT_RECORD_PROTECTED");
  }
  const after = await profileRow(ADULT);
  assert.equal(after.version, before.version, "no new version was written");
  assert.deepEqual(after.data, before.data, "the stored profile is byte for byte what it was");
  assert.equal(after.data.adult, true);
  assert.equal(after.data.selfUserId, "adult-self");
  const grants = await database().select().from(t.guardianAccessGrants).where(eq(t.guardianAccessGrants.playerId, ADULT));
  assert.deepEqual(grants.map((g) => [g.guardianUserId, g.revokedAt === null, g.version]), [["granted", true, 1]], "the adult's grant is still live and untouched");
  assert.equal((await database().select().from(t.guardianAccessEvents)).length, eventsBefore, "no ENDED_ADULT_FLAG_CLEARED (or any other) event was written");
  // Who can see the record is exactly what it was.
  assert.ok((await seenBy(adultSelf)).includes(ADULT), "the adult still sees their own record");
  assert.ok(!(await seenBy(guardian)).includes(ADULT), "an ungranted guardian still sees nothing");
  assert.ok(!JSON.stringify(await bootstrapAcademy(guardian)).includes("PRIVATE ADULT NOTE"), "and none of the adult's private details");
  assert.ok((await seenBy(grantedGuardian)).includes(ADULT), "the granted guardian keeps what was granted");
});

test("every other way of saving a stored adult profile is refused too, and a coach cannot either; the record is still protected afterwards", async () => {
  const before = await profileRow(ADULT);
  const variants = [
    { ...LEGACY_PROFILE }, // still an adult
    { ...LEGACY_PROFILE, adult: false }, // flag cleared, own-account link kept
    { ...LEGACY_PROFILE, selfUserId: null }, // link removed, flag kept
    { ...LEGACY_PROFILE, adult: false, selfUserId: null, notes: "changed" }, // an ordinary-looking edit
  ];
  for (const profile of variants) {
    const e = await refusal(savePlayer(owner, { id: ADULT, version: before.version, name: "Legacy Adult", batchId: "green-batch", profile }));
    assert.ok(e?.status === 409 || e?.status === 422, `refused: ${e?.code}`);
  }
  const forCoach = await refusal(savePlayer(coach, clearTheFlag(before.version)));
  assert.equal(forCoach?.status, 403, "a coach may not edit players at all");
  const after = await profileRow(ADULT);
  assert.deepEqual([after.version, after.data], [before.version, before.data]);
  assert.ok(!(await seenBy(guardian)).includes(ADULT));
});

test("a stored profile that is malformed (no adult flag) is treated like an adult record: the edit that would widen access is refused", async () => {
  await database().insert(t.players).values({ id: "odd-p", academyId: "green", batchId: "green-batch", name: "Odd Record" });
  const odd = { ...defaultProfile, birthDate: "2014-06-01" } as Record<string, unknown>;
  delete odd.adult;
  await database().insert(t.profiles).values({ academyId: "green", playerId: "odd-p", data: odd as never });
  const e = await refusal(savePlayer(owner, { id: "odd-p", version: 1, name: "Odd Record", batchId: "green-batch", profile: { ...defaultProfile, birthDate: "2014-06-01" } }));
  assert.equal(e?.code, "ADULT_RECORD_PROTECTED", "the access layer already treats it as adult-controlled, so an edit must not flip it");
  assert.equal((await profileRow("odd-p")).version, 1);
});

test("an ordinary under-18 player is unaffected: editing still works and bumps the version; sending adult flags is still refused", async () => {
  const row = await profileRow(MINOR);
  const saved = await savePlayer(owner, { id: MINOR, version: row.version, name: "Young Player", batchId: "green-batch", profile: { ...defaultProfile, birthDate: "2014-06-01", notes: "Edited note" } });
  assert.equal(saved.version, row.version + 1);
  const stored = await profileRow(MINOR);
  assert.deepEqual([stored.data.adult, stored.data.selfUserId, stored.data.notes], [false, null, "Edited note"]);
  assert.ok((await seenBy(minorGuardian)).includes(MINOR), "the parent of a minor still sees the minor");
  const adultAttempt = await refusal(savePlayer(owner, { id: MINOR, version: stored.version, name: "Young Player", batchId: "green-batch", profile: { ...defaultProfile, adult: true, selfUserId: "adult-self", birthDate: "2014-06-01" } }));
  assert.equal(adultAttempt?.code, "ADULT_PLAYERS_NOT_SUPPORTED");
  assert.equal((await profileRow(MINOR)).data.adult, false);
});
