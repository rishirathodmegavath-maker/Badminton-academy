import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { bootstrapAcademy } from "../src/modules/academy/application/bootstrap";
import {
  accessiblePlayers,
  familyScope,
  unit,
} from "../src/modules/academy/application/access";
import { invoiceAccess, ledger } from "../src/modules/fees/application/service";
import {
  CANARY,
  SUBJECT_IDS,
  USERS,
  addFixtureUser,
  canaryValues,
  idsFor,
  seedFixtures,
  type FixtureUserKey,
} from "./helpers/fixtures";
import {
  accessiblePlayers as legacyAccessiblePlayers,
  legacyBootstrapAcademy,
  legacyInvoiceAccess,
  legacyLedger,
} from "./helpers/family-oracle";
import { captureStatements, type Statement } from "./helpers/statement-log";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";
/**
 * STAGE 5F: Family Portal query isolation.
 *
 *  - Equivalence: for every family actor the new loader returns exactly what the frozen pre-5F loader returns
 *    (tests/helpers/family-oracle.ts); for every staff actor, byte for byte (same order).
 *  - Isolation at the SQL level: no statement of a family request returns another family's rows.
 *  - Empty scope, removed links, shared children, JSON edge cases, D-5b, invoice access and the ledger.
 *
 * Arrays the old loader returned in database order (no ORDER BY) are compared as multisets for family actors,
 * because the new queries read different tables first; everything else is compared exactly.
 */
// Throw-away values for this disposable, in-process instance (no server is started).
process.env.BETTER_AUTH_SECRET = "family-isolation-test-secret-0123456789abcdef";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3999";
let db: TestDatabase;
const A = SUBJECT_IDS.childA;
const B = SUBJECT_IDS.childB;
const STAMP = "2027-01-02T10:00:00.000Z";
const actorOf = (key: FixtureUserKey): Actor => {
  const u = USERS[key];
  return {
    id: u.id,
    name: u.name,
    academyId: u.academyId,
    role: u.role,
    timezone: u.academyId === "blue" ? "America/New_York" : "Asia/Kolkata",
    academyName: `Fixture ${u.academyId}`,
  };
};
const extra = (id: string, role: string, academyId = "green"): Actor => ({
  id,
  name: `Fixture ${id}`,
  academyId,
  role,
  timezone: academyId === "blue" ? "America/New_York" : "Asia/Kolkata",
  academyName: `Fixture ${academyId}`,
});
// Extra accounts of this file (fixture users are untouched).
const G3 = extra("fx5f-inactive", "GUARDIAN"); // only an INACTIVE link (to ALPHA)
const GNONE = extra("fx5f-nolink", "GUARDIAN"); // no link at all
const GK = extra("fx5f-both", "GUARDIAN"); // ALPHA and BRAVO, no deliveries
const GK1 = extra("fx5f-one", "GUARDIAN"); // ALPHA only, no deliveries
const AD2 = extra("fx5f-adult-false", "ADULT_PLAYER"); // a profile naming it, but adult: false
const FAMILY: Actor[] = [
  actorOf("guardian"),
  actorOf("guardian2"),
  actorOf("adult"),
  actorOf("blueGuardian"),
  G3,
  GNONE,
  GK,
  GK1,
  AD2,
];
const STAFF: FixtureUserKey[] = [
  "owner",
  "admin",
  "headCoach",
  "coach",
  "finance",
  "nutrition",
  "nutrition2",
  "blueOwner",
  "blueCoach",
  "blueNutrition",
  "quietOwner",
];
const json = (v: unknown) => JSON.parse(JSON.stringify(v));
/** Order-insensitive canonical form: every array sorted by the JSON text of its elements. */
function canon(v: unknown): unknown {
  if (Array.isArray(v))
    return v.map(canon).sort((x, y) => {
      const a = JSON.stringify(x);
      const b = JSON.stringify(y);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canon(x)]),
    );
  return v;
}
/** The access-audit record written by one call (Phase 7 contract). */
async function accessRecordOf<T>(a: Actor, fn: () => Promise<T>) {
  const before = new Set(
    (await database().select({ id: t.accessEvents.id }).from(t.accessEvents)).map((r) => r.id),
  );
  const value = await fn();
  const rows = (
    await database()
      .select()
      .from(t.accessEvents)
      .where(eq(t.accessEvents.actorId, a.id))
  ).filter((r) => !before.has(r.id));
  assert.equal(rows.length, 1, `one access record for ${a.id}`);
  const { id: _id, createdAt: _at, ...rest } = rows[0];
  return { value, record: rest };
}
async function compareFamily(a: Actor) {
  const legacy = await accessRecordOf(a, () => legacyBootstrapAcademy(a));
  const current = await accessRecordOf(a, () => bootstrapAcademy(a));
  assert.deepEqual(
    canon(json(current.value)),
    canon(json(legacy.value)),
    `family payload of ${a.id} equals the pre-5F payload`,
  );
  assert.deepEqual(current.record, legacy.record, `access record of ${a.id}`);
  return json(current.value) as Record<string, any>;
}
const FAMILY_TABLES = [
  "player",
  "player_profile",
  "guardian_link",
  "calendar_event",
  "training_session",
  "invoice",
  "payment_reference",
  "payment_refund",
  "lesson_credit",
  "player_report",
  "nutrition_plan",
  "restricted_nutrition",
  "nutrition_question",
  "message_draft",
  "outbox_delivery",
  "private_conversation",
  "private_media_asset",
  "record_revision",
  "membership",
  "player_history",
  "observation_review",
  "goal",
  "audit_event",
];
const reads = (log: Statement[]) => log.filter((s) => /^\s*select/i.test(s.sql));
async function insertEdgeCases() {
  const d = database();
  for (const u of [G3, GNONE, GK, GK1])
    await addFixtureUser(u.id, [{ academyId: "green", role: "GUARDIAN" }]);
  await addFixtureUser(AD2.id, [{ academyId: "green", role: "ADULT_PLAYER" }]);
  const consent = { portal: true, email: false, whatsapp: false };
  await d.insert(t.guardianLinks).values([
    // Shared child: ALPHA also has guardian two (without portal consent for ALPHA).
    { academyId: "green", playerId: A, userId: USERS.guardian2.id, relationship: "Aunt", consent: { ...consent, portal: false } },
    { academyId: "green", playerId: A, userId: G3.id, relationship: "Former", consent, active: false },
    { academyId: "green", playerId: A, userId: GK.id, relationship: "Parent", consent },
    { academyId: "green", playerId: B, userId: GK.id, relationship: "Parent", consent },
    { academyId: "green", playerId: A, userId: GK1.id, relationship: "Parent", consent },
  ]);
  // An adult-shaped profile that is not adult: never a scope for AD2.
  await d.insert(t.players).values({ id: "fx5f-not-adult", academyId: "green", batchId: "green-main", name: "Canary NOTADULT" });
  await d.insert(t.profiles).values({
    academyId: "green",
    playerId: "fx5f-not-adult",
    data: { adult: false, birthDate: "", email: "", phone: "", notes: "CANARY-NOTADULT-NOTES", status: "ACTIVE", selfUserId: AD2.id, preferences: "" },
  });
  const invoice = (id: string, playerIds: string[], familyUserId: string | null, description: string) => ({
    id,
    academyId: "green",
    data: {
      number: `INV-${id}`,
      playerIds,
      familyUserId,
      planId: null,
      description,
      currency: "INR" as const,
      subtotal: 1000,
      discount: 0,
      total: 1000,
      dueDate: "2027-02-01",
      issuedAt: STAMP,
      voidReason: "",
    },
  });
  await d.insert(t.invoices).values([
    invoice("inv5f-shared-a", [A], null, "CANARY-5F-SHARED-A-INVOICE"),
    invoice("inv5f-ab", [A, B], null, "CANARY-5F-AB-INVOICE"),
    invoice("inv5f-a-to-g2", [A], USERS.guardian2.id, "CANARY-5F-G2-ONLY-INVOICE"),
    invoice("inv5f-a-empty-contact", [A], "", "CANARY-5F-EMPTY-CONTACT-INVOICE"),
    invoice("inv5f-null-elem", [A, null as unknown as string], null, "CANARY-5F-NULL-ELEMENT-INVOICE"),
    invoice("inv5f-numeric-elem", [A, 5 as unknown as string], null, "CANARY-5F-NUMERIC-ELEMENT-INVOICE"),
  ]);
  const payment = (id: string, invoiceId: string, status: string, reference: string) => ({
    id,
    academyId: "green",
    invoiceId,
    status,
    idempotencyKey: `idem-${id}`,
    reference,
    data: {
      invoiceId,
      amount: 300,
      currency: "INR" as const,
      reference,
      method: "UPI",
      submittedBy: USERS.guardian.id,
      verifiedBy: status === "VERIFIED" ? USERS.finance.id : null,
      reason: "",
      receiptNumber: status === "VERIFIED" ? `RCT-${id}` : null,
    },
  });
  await d.insert(t.payments).values([
    payment("pay5f-shared-a", "inv5f-shared-a", "VERIFIED", "CANARY-5F-PAY-SHARED-A"),
    payment("pay5f-ab", "inv5f-ab", "SUBMITTED", "CANARY-5F-PAY-AB"),
  ] as never);
  await d.insert(t.refunds).values({
    id: "refund5f-shared-a",
    academyId: "green",
    paymentId: "pay5f-shared-a",
    amount: 50,
    reason: "CANARY-5F-REFUND-SHARED-A",
    idempotencyKey: "idem-refund5f-shared-a",
  });
  const session = (id: string, status: string, roster: unknown, attendance: Record<string, string>) => ({
    id,
    academyId: "green",
    coachId: USERS.coach.id,
    batchId: "green-main",
    status,
    data: {
      title: `Session ${id}`,
      batchId: "green-main",
      branchId: "green-branch",
      coachId: USERS.coach.id,
      localDate: "2027-04-02",
      localTime: "17:00",
      startsAt: "2027-04-02T11:30:00.000Z",
      timezone: "Asia/Kolkata",
      duration: 10,
      objective: `CANARY-5F-OBJECTIVE-${id}`,
      activities: [],
      roster,
      attendance,
      observations: id === "s5f-ab" ? [{ id: "obs5f-b", playerId: B, activityId: null, text: "CANARY-5F-PRIVATE-OBS-B", author: "coach", at: STAMP, visibility: "PRIVATE_DRAFT" }] : [],
      adjustments: [
        { playerId: A, note: "CANARY-5F-ADJ-A" },
        { playerId: B, note: "CANARY-5F-ADJ-B" },
      ],
      progress: { index: 0, elapsed: 0, runningSince: null },
      actuals: {},
      recap: id === "s5f-ab" ? "CANARY-5F-PRIVATE-RECAP" : "",
    },
  });
  await d.insert(t.trainingSessions).values([
    session("s5f-ab", "PUBLISHED", [{ id: A, name: "a" }, { id: B, name: "b" }], { [A]: "PRESENT", [B]: "ABSENT" }),
    session("s5f-draft-a", "DRAFT", [{ id: A, name: "a" }], {}),
    session("s5f-cancelled-a", "CANCELLED", [{ id: A, name: "a" }], {}),
    session("s5f-empty", "PUBLISHED", [], {}),
    session("s5f-no-id", "PUBLISHED", [{ name: "nobody" }], {}),
    session("s5f-numeric-id", "PUBLISHED", [{ id: 5, name: "numeric" }], {}),
    session("s5f-b-only", "PUBLISHED", [{ id: B, name: "b" }], { [B]: "PRESENT" }),
  ] as never);
  const event = (id: string, kind: string, playerIds: unknown) => ({
    id,
    academyId: "green",
    kind,
    data: {
      title: `CANARY-5F-EVENT-${id}`,
      localDate: "2027-03-05",
      localTime: "10:00",
      duration: 60,
      startsAt: "2027-03-05T04:30:00.000Z",
      endsAt: "2027-03-05T05:30:00.000Z",
      timezone: "Asia/Kolkata",
      branchId: "green-branch",
      coachId: kind === "CLOSURE" ? "" : USERS.coach.id,
      batchId: null,
      playerIds,
      enquiryId: "enquiry-should-be-nulled",
      seriesId: null,
    },
  });
  await d.insert(t.calendarEvents).values([
    event("ev5f-closure", "CLOSURE", []),
    event("ev5f-ab", "EVENT", [A, B]),
    event("ev5f-b", "EVENT", [B]),
  ] as never);
  // One message to both families of the batch, delivered to guardian one's portal.
  const recipient = (key: "guardian" | "guardian2", playerId: string) => ({
    userId: USERS[key].id,
    name: USERS[key].name,
    email: USERS[key].email,
    playerIds: [playerId],
    channels: ["PORTAL"],
  });
  await d.insert(t.messages).values({
    id: "msg5f-batch",
    authorId: USERS.coach.id,
    academyId: "green",
    status: "SENT",
    data: {
      subject: "CANARY-5F-BATCH-MESSAGE",
      body: "To every family of the batch",
      playerIds: [A, B],
      batchIds: ["green-main"],
      allBatches: false,
      channels: ["PORTAL"],
      recipients: [recipient("guardian", A), recipient("guardian2", B)],
      scheduledAt: null,
      approvedBy: USERS.coach.id,
      approvalHash: "fixture-hash",
      templateId: null,
    },
  } as never);
  await d.insert(t.deliveries).values({
    id: "delivery5f-batch-g1",
    academyId: "green",
    messageId: "msg5f-batch",
    userId: USERS.guardian.id,
    channel: "PORTAL",
    status: "AVAILABLE_IN_PORTAL",
    detail: "Available in the family portal",
  });
  // An expired shared clip of ALPHA (never shown).
  await d.insert(t.mediaAssets).values({
    id: "00000000-0000-4000-8000-000000005f01",
    academyId: "green",
    playerId: A,
    ownerId: USERS.coach.id,
    name: "CANARY-5F-EXPIRED.png",
    mime: "image/png",
    size: 72,
    storageKey: "unused/expired",
    status: "SHARED",
    expiresAt: new Date("2020-01-01T00:00:00.000Z"),
  });
}
before(
  async () => {
    db = await provisionTestDatabase("family-isolation");
    await seedFixtures();
    await insertEdgeCases();
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await db.cleanup();
  },
  { timeout: HOOK_TIMEOUT },
);
test("T-S1 familyScope and accessiblePlayers equal the pre-5F player set for every actor", { timeout: TEST_TIMEOUT }, async () => {
  const ids = (rows: { id: string }[]) => rows.map((p) => p.id).sort();
  for (const a of FAMILY) {
    const legacy = ids(await legacyAccessiblePlayers(a));
    assert.deepEqual(ids([...(await familyScope(a)).players]), legacy, `scope of ${a.id}`);
    assert.deepEqual([...(await familyScope(a)).playerIds].sort(), legacy, `scope ids of ${a.id}`);
    assert.deepEqual(ids(await accessiblePlayers(a)), legacy, `accessiblePlayers of ${a.id}`);
  }
  for (const key of STAFF) {
    const a = actorOf(key);
    assert.deepEqual(json(await accessiblePlayers(a)), json(await legacyAccessiblePlayers(a)), `staff ${key}`);
  }
  // Spot checks of the expected scopes.
  assert.deepEqual([...(await familyScope(actorOf("guardian"))).playerIds], [A]);
  assert.deepEqual([...(await familyScope(GK)).playerIds].sort(), [A, B].sort());
  assert.deepEqual([...(await familyScope(G3)).playerIds], [], "inactive link only: empty scope");
  assert.deepEqual([...(await familyScope(GNONE)).playerIds], [], "no link: empty scope");
  assert.deepEqual([...(await familyScope(AD2)).playerIds], [], "adult: false profile: empty scope");
  assert.deepEqual([...(await familyScope(actorOf("adult"))).playerIds], [SUBJECT_IDS.adult]);
  assert.equal((await familyScope(G3)).links.length, 1, "the inactive link is still returned as a link");
});
test("T-RB2 familyScope refuses every staff role", { timeout: TEST_TIMEOUT }, async () => {
  for (const key of STAFF) await assert.rejects(familyScope(actorOf(key)), /only defined for family roles/);
});
test("T-C1 every family actor receives exactly the pre-5F payload, and the same access record", { timeout: TEST_TIMEOUT }, async () => {
  for (const a of FAMILY) await compareFamily(a);
});
test("T-RB1 every staff actor receives the pre-5F payload byte for byte, with the same statements", { timeout: TEST_TIMEOUT }, async () => {
  for (const key of STAFF) {
    const a = actorOf(key);
    const legacy = await captureStatements(() => legacyBootstrapAcademy(a));
    const current = await captureStatements(() => bootstrapAcademy(a));
    assert.equal(JSON.stringify(current.value), JSON.stringify(legacy.value), `staff payload ${key}`);
    assert.deepEqual(
      current.log.map((s) => s.sql).sort(),
      legacy.log.map((s) => s.sql).sort(),
      `staff statements ${key}`,
    );
  }
});
test("T-A1/T-A2/T-Q1 no statement of a guardian's request returns another family's data", { timeout: TEST_TIMEOUT }, async () => {
  const g1 = actorOf("guardian");
  const foreign = [
    ...canaryValues(CANARY.childB),
    ...canaryValues(CANARY.blue),
    ...canaryValues(CANARY.adult),
    "CANARY-5F-AB-INVOICE",
    "CANARY-5F-G2-ONLY-INVOICE",
    "CANARY-5F-PAY-AB",
    "CANARY-5F-ADJ-B",
    "CANARY-5F-PRIVATE-OBS-B",
    "CANARY-5F-PRIVATE-RECAP",
    "CANARY-NOTADULT-NOTES",
    USERS.guardian2.email,
    USERS.owner.email,
    USERS.coach.email,
    B,
  ];
  const leaks = (log: Statement[]) =>
    log.flatMap((s) => foreign.filter((c) => s.text.includes(c)).map((c) => `${c} in ${s.tables.join(",")}`));
  const current = await captureStatements(() => bootstrapAcademy(g1));
  assert.deepEqual(leaks(current.log), [], "no foreign value in any SQL result of the new loader");
  // Positive control: the same search finds foreign values in the pre-5F loader's result sets.
  const legacy = await captureStatements(() => legacyBootstrapAcademy(g1));
  assert.ok(leaks(legacy.log).length > 0, "the search is meaningful (the old loader read other families' rows)");
  // Every read of a family-data table is limited to the academy.
  for (const s of reads(current.log))
    if (s.tables.some((x) => FAMILY_TABLES.includes(x)))
      assert.match(s.sql, /"academy_id" = \$\d+/, `academy filter: ${s.sql}`);
  const rows = (log: Statement[]) => reads(log).reduce((n, s) => n + s.rows, 0);
  assert.ok(rows(current.log) < rows(legacy.log), `rows read ${rows(current.log)} < ${rows(legacy.log)}`);
  // The payload itself is what it was (and holds none of the foreign values either).
  const text = JSON.stringify(current.value);
  for (const c of foreign) assert.ok(!text.includes(c), `payload holds no ${c}`);
});
test("T-E0 an empty scope runs no child-keyed query and returns what it returned before", { timeout: TEST_TIMEOUT }, async () => {
  // "invoice" is no longer child-keyed only: owner decision D-5b makes a zero-child invoice addressed to this account
  // visible to it, so the invoice read also runs with an empty scope. It is checked separately below.
  const childKeyed = [
    "player_profile",
    "calendar_event",
    "training_session",
    "payment_reference",
    "payment_refund",
    "lesson_credit",
    "player_report",
    "nutrition_plan",
    "restricted_nutrition",
    "nutrition_question",
    "message_draft",
    "private_conversation",
    "private_media_asset",
    "record_revision",
  ];
  for (const a of [G3, GNONE, AD2]) {
    const { log, value } = await captureStatements(() => bootstrapAcademy(a));
    // The scope statements themselves (an adult scope reads player_profile) are excluded; the rest are sections.
    // (Parallel statements finish in any order on a connection pool, so they are identified by their text.)
    const scopeSql = new Set((await captureStatements(() => familyScope(a))).log.map((s) => s.sql));
    const sections = reads(log).filter((s) => !scopeSql.has(s.sql));
    for (const s of sections)
      assert.ok(!s.tables.some((x) => childKeyed.includes(x)), `${a.id}: no child-keyed read (${s.sql})`);
    // The one invoice read of an empty scope can match only an invoice listing no child and addressed to this
    // account (none exists here): it has no child-list branch, is keyed by this account, and returns nothing.
    const invoiceReads = sections.filter((s) => s.tables.includes("invoice"));
    assert.equal(invoiceReads.length, 1, `${a.id}: one invoice read`);
    assert.equal(invoiceReads[0].rows, 0, `${a.id}: no invoice row read`);
    assert.ok(!/<@/.test(invoiceReads[0].sql), `${a.id}: no child-list branch in the empty-scope invoice read`);
    assert.ok(invoiceReads[0].params.includes(a.id), `${a.id}: the invoice read is keyed by this account`);
    assert.equal(value.players.length, 0);
    assert.equal(value.invoices.length, 0);
    assert.equal(value.guardianLinks.length, 0);
    await compareFamily(a);
  }
});
test("T-Q2 the statement count does not grow with the number of children", { timeout: TEST_TIMEOUT }, async () => {
  const one = await captureStatements(() => bootstrapAcademy(GK1));
  const two = await captureStatements(() => bootstrapAcademy(GK));
  assert.equal(two.log.length, one.log.length, "1 child and 2 children: same number of statements");
  assert.equal(two.value.players.length, 2);
  assert.equal(
    two.log.filter((s) => s.tables.includes("guardian_link")).length,
    1,
    "guardian links are read once",
  );
});
test("T-A3/D-5 shared child: unaddressed invoices reach every guardian of all invoiced children only", { timeout: TEST_TIMEOUT }, async () => {
  const invoicesOf = async (a: Actor) =>
    (await bootstrapAcademy(a)).invoices.map((i) => i.id).filter((id) => id.startsWith("inv5f-")).sort();
  // ALPHA: guardian one, guardian two (shared), GK, GK1.  BRAVO: guardian two, GK.
  assert.deepEqual(await invoicesOf(actorOf("guardian")), ["inv5f-a-empty-contact", "inv5f-shared-a"]);
  assert.deepEqual(await invoicesOf(actorOf("guardian2")), ["inv5f-a-empty-contact", "inv5f-a-to-g2", "inv5f-ab", "inv5f-shared-a"]);
  assert.deepEqual(await invoicesOf(GK), ["inv5f-a-empty-contact", "inv5f-ab", "inv5f-shared-a"]);
  assert.deepEqual(await invoicesOf(GK1), ["inv5f-a-empty-contact", "inv5f-shared-a"]);
  // Payments and refunds follow their invoice; conversations, questions and links stay per guardian.
  const g1 = await bootstrapAcademy(actorOf("guardian"));
  assert.ok(g1.payments.some((p) => p.id === "pay5f-shared-a"));
  assert.ok(!g1.payments.some((p) => p.id === "pay5f-ab"));
  assert.ok(g1.refunds.some((r) => r.id === "refund5f-shared-a"));
  const g2 = await bootstrapAcademy(actorOf("guardian2"));
  assert.ok(g2.guardianLinks.every((l) => l.userId === USERS.guardian2.id));
  assert.ok(g2.conversations.every((c) => c.guardianId === USERS.guardian2.id));
  assert.ok(g2.questions.every((q) => q.authorId === USERS.guardian2.id));
  // Guardian two has no portal consent for ALPHA: ALPHA's portal message does not reach it.
  assert.ok(!JSON.stringify(g2.messages).includes(CANARY.childA.messageSubject));
  // A message to several families reaches guardian one with only its own child, and no other recipient.
  const batch = g1.messages.find((m) => m.id === "msg5f-batch");
  assert.ok(batch, "batch message delivered to guardian one");
  assert.deepEqual(batch.data.playerIds, [A]);
  assert.deepEqual(batch.data.recipients, []);
});
test("T-SE1/T-EV1 sessions and events: JSON edge cases, redaction and the Stage 5E event shape", { timeout: TEST_TIMEOUT }, async () => {
  const g1 = actorOf("guardian");
  const { value, log } = await captureStatements(() => bootstrapAcademy(g1));
  const sessions = value.sessions.map((s) => s.id).sort();
  assert.deepEqual(sessions, [idsFor("childA").sessionId, "s5f-ab"].sort(), "no draft, cancelled, empty, id-less or other-child session");
  const ab = value.sessions.find((s) => s.id === "s5f-ab")!;
  assert.deepEqual(Object.keys(ab.data.attendance), [A], "attendance of own children only");
  assert.deepEqual(ab.data.adjustments.map((x) => x.playerId), [A]);
  assert.deepEqual(ab.data.roster, []);
  const events = value.events.map((e) => e.id).sort();
  assert.deepEqual(events, [`event-${A}`, "ev5f-ab"].sort(), "closure (no participants) and other-child events not sent");
  for (const e of value.events) {
    assert.deepEqual(Object.keys(e).sort(), ["academyId", "data", "id", "kind", "status", "version"]);
    assert.ok(!("overrides" in e.data) && !("cancellation" in e.data), "Stage 5E staff fields withheld");
    assert.equal(e.data.enquiryId, null);
    assert.ok(e.data.playerIds.every((id) => id === A));
  }
  assert.deepEqual(value.calendarSeries, []);
  for (const s of log) {
    assert.ok(!/"series_id"|"occurrence_date"/.test(s.sql), `family SQL never selects Stage 5E series columns: ${s.sql}`);
    assert.ok(!s.tables.includes("calendar_series"));
  }
  const media = value.media.map((m) => m.name);
  assert.ok(!media.includes("CANARY-5F-EXPIRED.png"), "expired media not sent");
  assert.ok(value.media.every((m) => !("storageKey" in m)));
  assert.ok(log.every((s) => !/"storage_key"|"reference_key"|"rejection_kind"/.test(s.sql)), "internal columns never selected");
});
test("T-L1 removing a link restricts the very next request and every invoice check", { timeout: TEST_TIMEOUT }, async () => {
  const g1 = actorOf("guardian");
  const link = and(
    eq(t.guardianLinks.academyId, "green"),
    eq(t.guardianLinks.playerId, A),
    eq(t.guardianLinks.userId, g1.id),
  );
  await database().update(t.guardianLinks).set({ active: false }).where(link);
  try {
    const p = await compareFamily(g1);
    assert.deepEqual(p.players, []);
    assert.deepEqual(p.invoices, []);
    await assert.rejects(unit(g1, (tx) => invoiceAccess(g1, idsFor("childA").invoiceId, tx)), /Player not found/);
  } finally {
    await database().update(t.guardianLinks).set({ active: true }).where(link);
  }
  assert.equal((await bootstrapAcademy(g1)).players.length, 1, "restored link works again");
});
async function outcome(fn: () => Promise<{ id: string }>) {
  try {
    return { ok: (await fn()).id };
  } catch (error) {
    const e = error as { status?: number; message: string };
    return { status: e.status, message: e.message };
  }
}
test("T-E1/T-X2 invoice access: same answer as before for every family actor and invoice, fewer statements", { timeout: TEST_TIMEOUT }, async () => {
  const invoices = (await database().select({ id: t.invoices.id }).from(t.invoices)).map((i) => i.id);
  invoices.push("no-such-invoice");
  for (const a of [...FAMILY, actorOf("finance"), actorOf("coach")])
    for (const id of invoices) {
      const legacy = await outcome(() => unit(a, (tx) => legacyInvoiceAccess(a, id, tx)));
      const current = await outcome(() => unit(a, (tx) => invoiceAccess(a, id, tx)));
      assert.deepEqual(current, legacy, `${a.id} / ${id}`);
    }
  // One scope read whatever the number of invoiced players (the old check read players and links per player).
  const count = async (id: string, fn: typeof invoiceAccess) =>
    (await captureStatements(() => unit(GK, (tx) => fn(GK, id, tx)))).log.length;
  assert.equal(await count("inv5f-ab", invoiceAccess), await count("inv5f-shared-a", invoiceAccess));
  assert.ok((await count("inv5f-ab", invoiceAccess)) < (await count("inv5f-ab", legacyInvoiceAccess)));
});
test("T-F3 ledger: same totals as before, reading only the refunds of the invoice's payments", { timeout: TEST_TIMEOUT }, async () => {
  const invoices = await database().select({ id: t.invoices.id, academyId: t.invoices.academyId }).from(t.invoices);
  const owner = actorOf("owner");
  for (const i of invoices) {
    const legacy = await unit(owner, (tx) => legacyLedger(tx, i.academyId, i.id));
    const current = await captureStatements(() => unit(owner, (tx) => ledger(tx, i.academyId, i.id)));
    assert.deepEqual(current.value, legacy, i.id);
    for (const s of current.log)
      if (s.tables.includes("payment_refund"))
        assert.match(s.sql, /"payment_id" in \(/, `refunds by payment: ${s.sql}`);
  }
  const shared = await captureStatements(() => unit(owner, (tx) => ledger(tx, "green", "inv5f-shared-a")));
  const refundRows = shared.log.filter((s) => s.tables.includes("payment_refund")).reduce((n, s) => n + s.rows, 0);
  assert.equal(refundRows, 1, "exactly the one refund of this invoice");
});
test("T-X1 cross-academy: a blue guardian's requests never touch green rows, and the reverse", { timeout: TEST_TIMEOUT }, async () => {
  const blue = actorOf("blueGuardian");
  const { log } = await captureStatements(() => bootstrapAcademy(blue));
  const green = [A, B, SUBJECT_IDS.adult, ...canaryValues(CANARY.childA), ...canaryValues(CANARY.childB)];
  for (const s of log) for (const c of green) assert.ok(!s.text.includes(c), `${c} in a blue request`);
  const g1 = await captureStatements(() => bootstrapAcademy(actorOf("guardian")));
  for (const s of g1.log) for (const c of canaryValues(CANARY.blue)) assert.ok(!s.text.includes(c));
  await assert.rejects(
    unit(actorOf("guardian"), (tx) => invoiceAccess(actorOf("guardian"), idsFor("blue").invoiceId, tx)),
    /Invoice not found/,
  );
});
test("D-5b an invoice naming no player reaches only the account it is addressed to (the old loader showed it to every family)", { timeout: TEST_TIMEOUT }, async () => {
  const d = database();
  const base = {
    academyId: "green",
    data: {
      number: "INV-5F-EMPTY",
      playerIds: [] as string[],
      familyUserId: null as unknown,
      planId: null,
      description: "",
      currency: "INR" as const,
      subtotal: 1000,
      discount: 0,
      total: 1000,
      dueDate: "2027-02-01",
      issuedAt: STAMP,
      voidReason: "",
    },
  };
  const row = (id: string, familyUserId: unknown, description: string) => ({
    ...base,
    id,
    data: { ...base.data, familyUserId, description },
  });
  // Owner decision D-5b (approved): addressed -> that account only; not addressed -> no family.
  const addressed: Record<string, string> = {
    "inv5f-empty-g1": USERS.guardian.id, // a guardian with a child
    "inv5f-empty-adult": USERS.adult.id, // an adult player
    "inv5f-empty-gnone": GNONE.id, // an active guardian with no linked child
    "inv5f-empty-g3": G3.id, // an active guardian whose only link is inactive
  };
  const unaddressed = ["inv5f-empty", "inv5f-empty-blank", "inv5f-empty-object"];
  const rows = [
    ...Object.entries(addressed).map(([id, user]) => row(id, user, `CANARY-5F-EMPTY-TO-${id}`)),
    row("inv5f-empty", null, "CANARY-5F-EMPTY-UNADDRESSED-inv5f-empty"),
    row("inv5f-empty-blank", "", "CANARY-5F-EMPTY-UNADDRESSED-inv5f-empty-blank"),
    // Not a string: never an address, although it holds guardian one's id.
    row("inv5f-empty-object", { id: USERS.guardian.id }, "CANARY-5F-EMPTY-UNADDRESSED-inv5f-empty-object"),
    // The same address in the other academy: never visible in green.
    { ...row("inv5f-empty-blue-g1", USERS.guardian.id, "CANARY-5F-EMPTY-BLUE-TO-G1"), academyId: "blue" },
  ];
  await d.insert(t.invoices).values(rows as never);
  const all = rows.map((r) => r.id);
  try {
    for (const a of FAMILY) {
      const mine = Object.keys(addressed).filter((id) => addressed[id] === a.id && a.academyId === "green");
      const legacy = (await legacyBootstrapAcademy(a)).invoices.map((i) => i.id);
      const { value, log } = await captureStatements(() => bootstrapAcademy(a));
      const current = value.invoices.map((i) => i.id);
      // Documents the pre-5F exposure: every green family, including accounts with no children, saw the
      // unaddressed one.
      if (a.academyId === "green") assert.ok(legacy.includes("inv5f-empty"), `pre-5F: ${a.id} saw the unaddressed invoice`);
      assert.deepEqual(current.filter((id) => all.includes(id)).sort(), [...mine].sort(), `${a.id}: zero-child invoices`);
      // Exactly the pre-5F answer for addressed invoices; only the unaddressed ones are withdrawn.
      assert.deepEqual(
        current.filter((id) => all.includes(id)).sort(),
        legacy.filter((id) => all.includes(id) && !unaddressed.includes(id)).sort(),
        `${a.id}: same as pre-5F apart from unaddressed zero-child invoices`,
      );
      // SQL level: no statement of this request returns another account's or an unaddressed zero-child invoice.
      const foreign = rows.filter((r) => !mine.includes(r.id)).map((r) => r.data.description);
      for (const s of log)
        for (const c of foreign) assert.ok(!s.text.includes(c), `${a.id}: ${c} returned by ${s.tables.join(",")}`);
      const invoiceRows = log.filter((s) => s.tables.includes("invoice")).reduce((n, s) => n + s.rows, 0);
      assert.ok(invoiceRows <= value.invoices.length, `${a.id}: the invoice read returns only visible invoices`);
      // Single-record access (payment submission, receipt) gives the same answer as the loader.
      for (const id of all) {
        if (mine.includes(id)) assert.equal((await unit(a, (tx) => invoiceAccess(a, id, tx))).id, id);
        else await assert.rejects(unit(a, (tx) => invoiceAccess(a, id, tx)), /Invoice not found/, `${a.id} / ${id}`);
      }
      // Apart from these invoices the payload is unchanged.
      const strip = (p: Record<string, any>) => ({
        ...p,
        invoices: p.invoices.filter((i: { id: string }) => !all.includes(i.id)),
        summary: { ...p.summary, outstanding: 0, overdue: 0 },
      });
      assert.deepEqual(canon(strip(json(value))), canon(strip(json(await legacyBootstrapAcademy(a)))));
    }
    // Staff: unchanged (finance roles see every invoice of their academy; T-RB1 proves byte identity).
    for (const key of ["owner", "finance"] as const) {
      const ids = (await bootstrapAcademy(actorOf(key))).invoices.map((i) => i.id);
      assert.deepEqual(ids.filter((id) => all.includes(id)).sort(), all.filter((id) => id !== "inv5f-empty-blue-g1").sort(), key);
      for (const id of all.filter((x) => x !== "inv5f-empty-blue-g1"))
        assert.equal((await unit(actorOf(key), (tx) => invoiceAccess(actorOf(key), id, tx))).id, id);
    }
  } finally {
    await d.delete(t.invoices).where(inArray(t.invoices.id, all));
  }
});
test("T-J malformed JSON never widens access (the old loader failed the whole request instead)", { timeout: TEST_TIMEOUT }, async () => {
  const d = database();
  const g1 = actorOf("guardian");
  const malformed = [
    { table: t.invoices, id: "inv5f-bad", row: { id: "inv5f-bad", academyId: "green", data: { number: "X", playerIds: { [A]: true }, familyUserId: null, description: "CANARY-5F-BAD-INVOICE", currency: "INR", subtotal: 1, discount: 0, total: 1, dueDate: "2027-01-01", issuedAt: STAMP, voidReason: "" } } },
    { table: t.calendarEvents, id: "ev5f-bad", row: { id: "ev5f-bad", academyId: "green", kind: "EVENT", data: { title: "CANARY-5F-BAD-EVENT", playerIds: { [A]: true } } } },
    { table: t.trainingSessions, id: "s5f-bad", row: { id: "s5f-bad", academyId: "green", coachId: USERS.coach.id, batchId: "green-main", status: "PUBLISHED", data: { title: "CANARY-5F-BAD-SESSION", roster: { id: A } } } },
  ];
  for (const m of malformed) {
    await d.insert(m.table as typeof t.invoices).values(m.row as never);
    try {
      const value = await bootstrapAcademy(g1);
      assert.ok(!JSON.stringify(value).includes("CANARY-5F-BAD"), `${m.id} not sent`);
      await assert.rejects(legacyBootstrapAcademy(g1), TypeError, `pre-5F: ${m.id} broke the request`);
    } finally {
      await d.delete(m.table as typeof t.invoices).where(eq((m.table as typeof t.invoices).id, m.id));
    }
  }
  await compareFamily(g1);
});
