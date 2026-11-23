import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { and, eq, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import {
  CANARY,
  MEDIA_IDS,
  ROLES,
  ROLE_USER,
  SUBJECT_IDS,
  USERS,
  canaryValues,
} from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { adminUrl } from "./helpers/test-database";
/** The fixtures themselves: complete, isolated, deterministic and unambiguous. */
let app: Harness;
before(
  async () => {
    app = await startHarness("role-fixtures");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
test("all eight roles have exactly one active membership in the fixture academy", async () => {
  const db = database();
  for (const role of ROLES) {
    const user = USERS[ROLE_USER[role]];
    const rows = await db
      .select()
      .from(t.memberships)
      .where(eq(t.memberships.userId, user.id));
    assert.equal(rows.length, 1, role);
    assert.deepEqual(
      [rows[0].academyId, rows[0].role, rows[0].active],
      ["green", role, true],
    );
    const [account] = await db
      .select()
      .from(t.account)
      .where(eq(t.account.userId, user.id));
    assert.equal(account.providerId, "credential");
    assert.ok(account.password && !account.password.includes(user.email));
  }
});
test("the fixture world has the intended relationships", async () => {
  const db = database();
  const links = await db.select().from(t.guardianLinks);
  assert.deepEqual(
    links.map((l) => [l.userId, l.playerId]).sort(),
    [
      [USERS.guardian.id, SUBJECT_IDS.childA],
      [USERS.guardian2.id, SUBJECT_IDS.childB],
      [USERS.blueGuardian.id, SUBJECT_IDS.blue],
    ].sort(),
  );
  const batch = async (academyId: string, id: string) =>
    (
      await db
        .select()
        .from(t.batches)
        .where(and(eq(t.batches.academyId, academyId), eq(t.batches.id, id)))
    )[0];
  assert.equal((await batch("green", "green-main")).coachId, USERS.coach.id);
  assert.equal(
    (await batch("green", "green-other")).coachId,
    USERS.headCoach.id,
  );
  assert.equal((await batch("blue", "blue-batch")).coachId, USERS.blueCoach.id);
  const [adult] = await db
    .select()
    .from(t.profiles)
    .where(eq(t.profiles.playerId, SUBJECT_IDS.adult));
  assert.equal(adult.data.selfUserId, USERS.adult.id);
  const academies = await db.select().from(t.academies);
  assert.deepEqual(academies.map((a) => a.id).sort(), [
    "blue",
    "green",
    "quiet",
  ]);
  const blue = await db
    .select()
    .from(t.players)
    .where(eq(t.players.academyId, "blue"));
  assert.deepEqual(
    blue.map((p) => p.id),
    [SUBJECT_IDS.blue],
  );
});
test("the quiet academy is genuinely empty and the blue academy has its own staff", async () => {
  const db = database();
  const members = async (academyId: string) =>
    (
      await db
        .select()
        .from(t.memberships)
        .where(eq(t.memberships.academyId, academyId))
    )
      .map((m) => m.role)
      .sort();
  assert.deepEqual(await members("quiet"), ["OWNER"]);
  assert.deepEqual(await members("blue"), ["COACH", "GUARDIAN", "NUTRITION_PRO", "OWNER"]);
  for (const table of [
    t.players,
    t.reports,
    t.invoices,
    t.trainingSessions,
    t.messages,
    t.mediaAssets,
    t.audit,
  ])
    assert.equal(
      (await db.select().from(table).where(eq(table.academyId, "quiet")))
        .length,
      0,
      getTableName(table),
    );
});
test("canary values are fictional, unique, and none contains another (so a match is unambiguous)", () => {
  const everything = [
    ...[CANARY.childA, CANARY.childB, CANARY.adult, CANARY.blue].flatMap(
      canaryValues,
    ),
    ...Object.values(CANARY.enquiry),
    ...Object.values(USERS).map((u) => u.email),
  ];
  assert.equal(
    new Set(everything).size,
    everything.length,
    "duplicate canary value",
  );
  for (const a of everything)
    for (const b of everything)
      if (a !== b) assert.ok(!a.includes(b), `"${a}" contains "${b}"`);
  for (const value of everything)
    assert.match(
      value,
      /canary|CANARY|Canary|\+91-00000|^\d{4}-\d{2}-\d{2}$/,
      value,
    );
  for (const u of Object.values(USERS))
    assert.ok(u.email.endsWith("@example.test"), u.email);
});
test("every canary value is stored somewhere in the database, so a leak of any of them is detectable", async () => {
  const db = database();
  const dump: string[] = [];
  for (const table of Object.values(t).filter((x) =>
    is(x, PgTable),
  ) as PgTable[])
    dump.push(JSON.stringify(await db.select().from(table)));
  const text = dump.join("\n");
  const missing = [
    ...[CANARY.childA, CANARY.childB, CANARY.adult, CANARY.blue].flatMap(
      canaryValues,
    ),
    ...Object.values(CANARY.enquiry),
  ].filter((v) => !text.includes(v));
  assert.deepEqual(missing, [], "canaries that are defined but never seeded");
});
test("private media bytes exist on disk for every seeded asset", async () => {
  const root = process.env.PRIVATE_MEDIA_PATH!;
  const rows = await database().select().from(t.mediaAssets);
  assert.equal(rows.length, 6);
  for (const id of Object.values(MEDIA_IDS).flatMap(Object.values)) {
    const row = rows.find((r) => r.id === id);
    assert.ok(row, id);
    const prefix = createHash("sha256")
      .update(row.academyId)
      .digest("hex")
      .slice(0, 16);
    assert.equal(row.storageKey, `${prefix}/${id}`);
    assert.ok(existsSync(join(root, row.storageKey)), `missing file for ${id}`);
  }
});
test("the harness really uses the intended database engine", () => {
  assert.equal(app.database, adminUrl() ? "postgres" : "pglite");
});
