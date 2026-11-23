import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import {
  accessiblePlayers,
  billablePlayers,
  requireBillablePlayer,
  requirePlayer,
} from "../src/modules/academy/application/access";
import type { Actor } from "../src/modules/identity/access";
import {
  CANARY,
  FIXTURE_PASSWORD,
  SUBJECT_IDS,
  USERS,
  addFixtureUser,
  canaryValues,
  idsFor,
  type FixtureUserKey,
  type Role,
} from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";
import { assertNoLeak, assertPresent } from "./helpers/payload";
/**
 * Phase 2.3: role-based data access, enforced server-side and deny-by-default.
 *
 *  - FINANCE: money records and a bare billing roster, nothing else about any player.
 *  - NUTRITION_PRO: only players with an ACTIVE assignment, on lists and on direct IDs.
 *  - GUARDIAN / ADULT_PLAYER / COACH: their existing boundaries, now also probed by direct ID
 *    inside the academy (not just across academies).
 *  - Unknown roles, inactive and missing memberships: nothing.
 *
 * Every refusal is paired with a positive control, and assertions inspect payloads for canary
 * values rather than trusting status codes. State-changing refusals also prove the database did not
 * change.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("data-access");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const A = idsFor("childA");
const B = idsFor("childB");
const BL = idsFor("blue");
const ADULT = SUBJECT_IDS.adult;
const db = () => database();
const denied = (status: number) => status === 403 || status === 404;
const all = (...subjects: Record<string, string>[]) =>
  subjects.flatMap(canaryValues);
const route = (path: string) => `/api/academy/${path}`;
const post = async (user: FixtureUserKey, path: string, body: unknown) =>
  (await app.as(user)).post(route(path), body);
const get = async (user: FixtureUserKey, path: string) =>
  (await app.as(user)).get(route(path));
const payload = async (user: FixtureUserKey) =>
  (await get(user, "")).json as Record<string, any>;
const body = (r: { text: string }) => r.text;
const actor = (role: string, id: string, academyId = "green"): Actor => ({
  id,
  name: "x",
  academyId,
  role,
  timezone: "UTC",
  academyName: "x",
});
/** One fingerprint of every table a refused request could plausibly touch. */
async function fingerprint() {
  const tables = [
    t.players,
    t.profiles,
    t.guardianLinks,
    t.enquiries,
    t.calendarEvents,
    t.calendarSeries,
    t.trainingSessions,
    t.reports,
    t.observationReviews,
    t.nutritionPlans,
    t.restrictedNutrition,
    t.nutritionQuestions,
    t.nutritionAssignments,
    t.mediaAssets,
    t.messages,
    t.conversations,
    t.invoices,
    t.payments,
    t.refunds,
    t.lessonCredits,
    t.feePlans,
    t.memberships,
    t.recordRevisions,
  ];
  return JSON.stringify(
    await Promise.all(tables.map((table) => db().select().from(table))),
  );
}
/** A refused write: denied status, a body that discloses nothing, and no database change. */
async function refuse(
  user: FixtureUserKey,
  path: string,
  request: unknown,
  forbidden: readonly string[] = all(CANARY.childA, CANARY.childB, CANARY.adult),
) {
  const before = await fingerprint();
  const r = await post(user, path, request);
  assert.ok(
    denied(r.status),
    `${user} ${path}: expected a refusal, got ${r.status} ${body(r).slice(0, 140)}`,
  );
  assertNoLeak(r.json ?? r.text, forbidden, `${user} ${path} response`);
  assert.equal(
    await fingerprint(),
    before,
    `${user} ${path}: the refused request changed data`,
  );
}
async function refuseRead(
  user: FixtureUserKey,
  path: string,
  forbidden: readonly string[] = all(CANARY.childA, CANARY.childB, CANARY.adult),
) {
  const r = await get(user, path);
  assert.ok(
    denied(r.status),
    `${user} GET ${path}: expected a refusal, got ${r.status}`,
  );
  assert.notEqual(r.headers.get("content-type"), "application/pdf");
  assertNoLeak(r.json ?? r.text, forbidden, `${user} GET ${path}`);
}
/** node-postgres/PGlite report the SQLSTATE text on the error's cause; match across both. */
const constraint = (pattern: RegExp) => (error: unknown) =>
  pattern.test(`${error} ${(error as { cause?: unknown })?.cause ?? ""}`);
/* ============================== deny-by-default primitives ============================== */
test("player access is deny-by-default: unknown roles get nothing, Finance gets only the billing roster", async () => {
  const names = (rows: { name: string }[]) => rows.map((p) => p.name).sort();
  const everyone = names([
    { name: CANARY.childA.name },
    { name: CANARY.childB.name },
    { name: CANARY.adult.name },
  ]);
  // Positive controls: the roles that may see players still do.
  assert.deepEqual(
    names(await accessiblePlayers(actor("OWNER", USERS.owner.id))),
    everyone,
  );
  assert.deepEqual(
    names(await accessiblePlayers(actor("ADMIN", USERS.admin.id))),
    everyone,
  );
  assert.deepEqual(
    names(await accessiblePlayers(actor("HEAD_COACH", USERS.headCoach.id))),
    everyone,
  );
  assert.deepEqual(
    names(await accessiblePlayers(actor("COACH", USERS.coach.id))),
    names([{ name: CANARY.childA.name }, { name: CANARY.adult.name }]),
    "a coach sees their batch only",
  );
  assert.deepEqual(
    names(await accessiblePlayers(actor("GUARDIAN", USERS.guardian.id))),
    [CANARY.childA.name],
  );
  assert.deepEqual(
    names(await accessiblePlayers(actor("ADULT_PLAYER", USERS.adult.id))),
    [CANARY.adult.name],
  );
  // Denials.
  for (const role of ["WIZARD", "", "owner", "Owner ", "SUPERADMIN", "null"])
    assert.deepEqual(
      await accessiblePlayers(actor(role, USERS.owner.id)),
      [],
      `role ${JSON.stringify(role)} must see no players`,
    );
  assert.deepEqual(
    await accessiblePlayers(actor("FINANCE", USERS.finance.id)),
    [],
    "FINANCE has no player-level access",
  );
  await assert.rejects(
    requirePlayer(actor("FINANCE", USERS.finance.id), A.playerId),
    { status: 404 },
  );
  // The billing roster is the whole academy, and only that academy.
  assert.deepEqual(
    names(await billablePlayers(actor("FINANCE", USERS.finance.id))),
    everyone,
  );
  await assert.rejects(
    requireBillablePlayer(actor("FINANCE", USERS.finance.id), BL.playerId),
    { status: 404 },
  );
  assert.deepEqual(
    await billablePlayers(actor("WIZARD", USERS.finance.id)),
    [],
  );
  // Other roles are billed against what they can already see (no widening).
  assert.deepEqual(
    names(await billablePlayers(actor("COACH", USERS.coach.id))),
    names(await accessiblePlayers(actor("COACH", USERS.coach.id))),
  );
});
test("a Nutrition Pro's players are exactly their ACTIVE assignments in their own academy", async () => {
  const ids = async (a: Actor) => (await accessiblePlayers(a)).map((p) => p.id);
  assert.deepEqual(await ids(actor("NUTRITION_PRO", USERS.nutrition.id)), [
    A.playerId,
  ]);
  assert.deepEqual(await ids(actor("NUTRITION_PRO", USERS.nutrition2.id)), [
    B.playerId,
  ]);
  // The withdrawn BRAVO assignment of `nutrition` exists but grants nothing.
  const rows = await db()
    .select()
    .from(t.nutritionAssignments)
    .where(
      and(
        eq(t.nutritionAssignments.playerId, B.playerId),
        eq(t.nutritionAssignments.professionalId, USERS.nutrition.id),
      ),
    );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].active, false);
  // The same user id acting in another academy (or an unassigned professional) sees nobody.
  assert.deepEqual(
    await ids(actor("NUTRITION_PRO", USERS.nutrition.id, "blue")),
    [],
  );
  assert.deepEqual(
    await ids(actor("NUTRITION_PRO", USERS.blueNutrition.id, "blue")),
    [BL.playerId],
  );
  assert.deepEqual(await ids(actor("NUTRITION_PRO", USERS.owner.id)), []);
});
test("assignments cannot cross academies or point at non-members (database constraints)", async () => {
  const insert = (v: {
    academyId: string;
    playerId: string;
    professionalId: string;
  }) => db().insert(t.nutritionAssignments).values(v);
  await assert.rejects(
    insert({
      academyId: "green",
      playerId: BL.playerId,
      professionalId: USERS.nutrition.id,
    }),
    constraint(/foreign key|violates/i),
    "a blue player cannot be assigned inside green",
  );
  await assert.rejects(
    insert({
      academyId: "green",
      playerId: A.playerId,
      professionalId: USERS.blueNutrition.id,
    }),
    constraint(/foreign key|violates/i),
    "a blue professional has no green membership",
  );
  await assert.rejects(
    insert({
      academyId: "green",
      playerId: A.playerId,
      professionalId: "nobody",
    }),
    constraint(/foreign key|violates/i),
  );
  await assert.rejects(
    insert({
      academyId: "green",
      playerId: A.playerId,
      professionalId: USERS.nutrition.id,
    }),
    constraint(/duplicate|unique|primary/i),
    "one row per professional and player",
  );
});
test("unknown roles, inactive memberships and missing memberships are denied at the HTTP boundary", async () => {
  const cases: [string, { academyId: "green"; role: Role; active?: boolean }[]][] =
    [
      ["da-unknown-role", [{ academyId: "green", role: "WIZARD" as Role }]],
      ["da-inactive-owner", [{ academyId: "green", role: "OWNER", active: false }]],
      [
        "da-inactive-nutrition",
        [{ academyId: "green", role: "NUTRITION_PRO", active: false }],
      ],
      ["da-no-membership", []],
    ];
  for (const [id, memberships] of cases) {
    const { email } = await addFixtureUser(id, memberships);
    // An assigned-but-inactive professional is still nobody.
    if (id === "da-inactive-nutrition")
      await db().insert(t.nutritionAssignments).values({
        academyId: "green",
        playerId: A.playerId,
        professionalId: id,
      });
    const client = app.anonymous();
    assert.equal((await client.signIn(email, FIXTURE_PASSWORD)).status, 200);
    for (const path of ["/api/academy", "/api/academy/identity", "/api/training"]) {
      const r = await client.get(path);
      assert.equal(r.status, 403, `${id} ${path}`);
      assertNoLeak(r.json ?? r.text, all(CANARY.childA, CANARY.childB), `${id} ${path}`);
    }
    const write = await client.post(route("nutrition/plan"), {
      playerId: A.playerId,
      title: "Plan title",
      guidance: "Some guidance text",
      action: "save",
      reviewNote: "",
    });
    assert.equal(write.status, 403, `${id} write`);
  }
  const anon = app.anonymous();
  assert.equal((await anon.get("/api/academy")).status, 401);
});
/* ============================== FINANCE ============================== */
test("FINANCE keeps its financial workflows (positive controls)", async () => {
  // Receipts and the money read model.
  for (const id of [A.paymentId, B.paymentId]) {
    const r = await get("finance", `fees/${id}/receipt`);
    assert.equal(r.status, 200, id);
    assert.match(r.headers.get("content-type") ?? "", /application\/pdf/);
  }
  const p = await payload("finance");
  assert.ok(p.invoices.length >= 2 && p.payments.length >= 2);
  assert.ok(p.feePlans.length >= 1 && p.credits.length >= 1);
  assert.ok(p.refunds.length >= 1);
  // Billing roster: every player of the academy, by name, for invoicing.
  assert.deepEqual(
    p.players.map((x: { name: string }) => x.name).sort(),
    [CANARY.adult.name, CANARY.childA.name, CANARY.childB.name].sort(),
  );
  // It can still invoice, adjust credit and manage plans for any of them.
  const invoiceFor = (playerId: string) => ({
    id: crypto.randomUUID(),
    playerIds: [playerId],
    familyUserId: null,
    planId: null,
    description: "Monthly coaching fee",
    subtotal: 1500,
    discount: 0,
    currency: "INR",
    dueDate: "2030-01-31",
  });
  for (const playerId of [A.playerId, B.playerId, ADULT]) {
    const r = await post("finance", "fees/invoice", invoiceFor(playerId));
    assert.equal(r.status, 200, `invoice for ${playerId}: ${body(r).slice(0, 120)}`);
  }
  const credit = await post("finance", "fees/credit", {
    playerId: B.playerId,
    units: 2,
    reason: "Goodwill sessions",
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(credit.status, 200, body(credit));
  const plan = await post("finance", "fees/plan", {
    name: "Plan from test",
    amount: 900,
    currency: "INR",
    archived: false,
  });
  assert.equal(plan.status, 200);
  // The billing roster stops at the academy edge.
  await refuse("finance", "fees/invoice", invoiceFor(BL.playerId));
  await refuse("finance", "fees/credit", {
    playerId: BL.playerId,
    units: 1,
    reason: "Not mine to give",
    idempotencyKey: crypto.randomUUID(),
  });
});
test("FINANCE cannot read any player, clinical, consent or media record by id", async () => {
  for (const [path, forbidden] of [
    [`reports/${A.reportId}/pdf`, all(CANARY.childA)],
    [`reports/${B.reportId}/pdf`, all(CANARY.childB)],
    [`media/${A.media.shared}/link`, all(CANARY.childA)],
    [`media/${A.media.private}/link`, all(CANARY.childA)],
    [`media/${B.media.shared}/file`, all(CANARY.childB)],
    [`media/${B.media.private}/file`, all(CANARY.childB)],
    ["players", all(CANARY.childA, CANARY.childB, CANARY.adult)],
  ] as const)
    await refuseRead("finance", path, forbidden);
});
test("FINANCE cannot create, update or delete anything outside money records", async () => {
  const attempts: [string, unknown][] = [
    ["players/save", { name: "New Player Name", batchId: "green-main", adult: false, birthDate: "2015-01-01", email: "", phone: "", notes: "", status: "ACTIVE", preferences: "" }],
    ["players/save", { id: A.playerId, version: 1, name: "Renamed", batchId: "green-main" }],
    ["players/guardian", { playerId: A.playerId, userId: USERS.guardian.id, relationship: "Mother", active: false }],
    ["players/consent", { playerId: A.playerId, consent: { portal: false, email: false, whatsapp: false } }],
    ["admissions/save", { name: "Prospect Name", contact: "x@example.test" }],
    ["calendar/event", { title: "Event", kind: "CLOSURE" }],
    ["calendar/preview", { title: "Event", kind: "CLOSURE", cancel: true, scope: "SERIES" }],
    ["calendar/session", { batchId: "green-main" }],
    ["reports/create", { playerId: A.playerId, periodStart: "2030-01-01", periodEnd: "2030-01-31", title: "Period report" }],
    ["reports/update", { id: A.reportId, version: 3, action: "save", summary: "Edited by finance", reason: "" }],
    ["reports/review", { id: "x", version: 1 }],
    ["nutrition/plan", { playerId: A.playerId, title: "Plan title", guidance: "Some guidance text", action: "save", reviewNote: "" }],
    ["nutrition/plan", { id: `nutrition-draft-${A.playerId}`, version: 1, playerId: A.playerId, title: "Edited plan", guidance: "Edited guidance text", action: "save", reviewNote: "" }],
    ["nutrition/restrictions", { playerId: A.playerId, version: 1, allergies: "none", restrictions: "" }],
    ["nutrition/question", { playerId: A.playerId, question: "Is this safe?", answer: "" }],
    ["communications/save", { subject: "S", body: "B" }],
    ["communications/conversation", { playerId: A.playerId, guardianId: USERS.guardian.id, subject: "Hello there", text: "Hello there", entryId: crypto.randomUUID() }],
    ["communications/template", { name: "T", subject: "S", body: "B" }],
    ["media/review", { id: A.media.shared, version: 1, feedback: "Reviewed by finance", share: true }],
    ["media/note", { id: A.media.shared, seconds: 1, note: "A note by finance" }],
    ["settings/save", { version: 1, name: "Renamed Academy" }],
    ["settings/branch", { name: "Branch" }],
    ["settings/member", { name: "Someone", email: "someone@example.test", role: "OWNER", active: true, professionalAttestation: "" }],
    ["nutrition/assign", { playerId: A.playerId, professionalId: USERS.nutrition.id, active: false }],
  ];
  for (const [path, request] of attempts) await refuse("finance", path, request);
});
test("FINANCE's response carries no profile, contact, clinical, consent or account data, at any depth", async () => {
  const p = await payload("finance");
  const text = JSON.stringify(p);
  assertNoLeak(
    p,
    [CANARY.childA, CANARY.childB, CANARY.adult].flatMap((s) => [
      s.notes, s.phone, s.email, s.birthDate, s.allergy, s.question,
      s.reportPublished, s.reportDraft, s.nutritionShared, s.nutritionDraft,
      s.history, s.event, s.sessionNote, s.sessionObjective, s.goal,
      s.messageBody, s.mediaShared, s.mediaPrivate, s.conversation,
    ].filter(Boolean)),
    "FINANCE",
  );
  // Every player is a bare record: identification plus the status flag, in a fixed shape.
  for (const player of p.players)
    assert.deepEqual(player.profile, {
      adult: false, birthDate: "", email: "", phone: "", notes: "",
      status: "ACTIVE", selfUserId: null, preferences: "",
    });
  assert.deepEqual(p.guardianLinks, []);
  for (const empty of ["events","sessions","reports","reviews","nutrition","restrictions","questions","messages","deliveries","templates","conversations","media","history","versions","goals","audits","enquiries","assignments"])
    assert.deepEqual(p[empty], [], `FINANCE ${empty}`);
  // Only itself, and billing contacts by name (no address): nobody else's account.
  const emails = text.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [];
  assert.deepEqual([...new Set(emails)], [USERS.finance.email]);
  for (const member of p.members as { id: string; email: string }[])
    if (member.id !== USERS.finance.id) assert.equal(member.email, "");
  assert.ok(!/storageKey|backupCodes|"password"|"token"/.test(text));
  for (const batch of p.batches) assert.equal(batch.coachId, "");
});
/* ============================== NUTRITION PRO ============================== */
test("NUTRITION_PRO works on assigned players: plans, restrictions and questions (positive controls)", async () => {
  const draft = await post("nutrition", "nutrition/plan", {
    playerId: A.playerId,
    title: "Match-week plan",
    guidance: "Hydration and carbohydrate guidance",
    action: "save",
    reviewNote: "",
  });
  assert.equal(draft.status, 200, body(draft));
  const [restriction] = await db()
    .select()
    .from(t.restrictedNutrition)
    .where(eq(t.restrictedNutrition.playerId, A.playerId));
  const saved = await post("nutrition", "nutrition/restrictions", {
    playerId: A.playerId,
    version: restriction.version,
    allergies: CANARY.childA.allergy,
    restrictions: "",
  });
  assert.equal(saved.status, 200, body(saved));
  const answered = await post("nutrition", "nutrition/question", {
    id: `q-${A.playerId}`,
    version: 1,
    playerId: A.playerId,
    question: "Question text",
    answer: "Answer from the professional",
  });
  assert.equal(answered.status, 200, body(answered));
  // The other professional works on theirs.
  const other = await post("nutrition2", "nutrition/plan", {
    playerId: B.playerId,
    title: "Second child plan",
    guidance: "Guidance for the second child",
    action: "save",
    reviewNote: "",
  });
  assert.equal(other.status, 200, body(other));
});
test("NUTRITION_PRO cannot reach unassigned or withdrawn players by id (read or write)", async () => {
  // nutrition: ALPHA yes; BRAVO withdrawn; ADULT never assigned.  nutrition2: BRAVO only.
  const [restrictionB] = await db()
    .select()
    .from(t.restrictedNutrition)
    .where(eq(t.restrictedNutrition.playerId, B.playerId));
  const [restrictionA] = await db()
    .select()
    .from(t.restrictedNutrition)
    .where(eq(t.restrictedNutrition.playerId, A.playerId));
  const plan = (playerId: string) => ({
    playerId,
    title: "Plan title",
    guidance: "Some guidance text",
    action: "save",
    reviewNote: "",
  });
  const edit = (playerId: string) => ({
    ...plan(playerId),
    id: `nutrition-draft-${playerId}`,
    version: 1,
  });
  const restrictions = (playerId: string, version: number) => ({
    playerId,
    version,
    allergies: "tampered",
    restrictions: "",
  });
  const question = (playerId: string) => ({
    id: `q-${playerId}`,
    version: 1,
    playerId,
    question: "Question text",
    answer: "tampered answer",
  });
  const forbiddenFor = (...subjects: Record<string, string>[]) => all(...subjects);
  for (const [user, playerId, version, subject] of [
    ["nutrition", B.playerId, restrictionB.version, CANARY.childB],
    ["nutrition", ADULT, 1, CANARY.adult],
    ["nutrition2", A.playerId, restrictionA.version, CANARY.childA],
    ["nutrition2", ADULT, 1, CANARY.adult],
  ] as const) {
    const guard = forbiddenFor(subject);
    await refuse(user, "nutrition/plan", plan(playerId), guard);
    await refuse(user, "nutrition/plan", edit(playerId), guard);
    await refuse(user, "nutrition/restrictions", restrictions(playerId, version), guard);
    await refuse(user, "nutrition/question", question(playerId), guard);
  }
  // Everything else about a player is staff or family territory, assigned or not.
  for (const [user, ids] of [
    ["nutrition", A],
    ["nutrition", B],
    ["nutrition2", B],
    ["nutrition2", A],
  ] as const) {
    const subject = ids === A ? CANARY.childA : CANARY.childB;
    const guard = all(subject);
    await refuseRead(user, `reports/${ids.reportId}/pdf`, guard);
    await refuseRead(user, `media/${ids.media.shared}/link`, guard);
    await refuseRead(user, `media/${ids.media.private}/file`, guard);
    await refuseRead(user, `fees/${ids.paymentId}/receipt`, guard);
  }
  for (const [path, request] of [
    ["reports/create", { playerId: A.playerId, periodStart: "2030-01-01", periodEnd: "2030-01-31", title: "Period report" }],
    ["reports/update", { id: A.reportId, version: 3, action: "save", summary: "Edited", reason: "" }],
    ["players/save", { id: A.playerId, version: 1, name: "Renamed", batchId: "green-main" }],
    ["players/consent", { playerId: A.playerId, consent: { portal: false, email: false, whatsapp: false } }],
    ["media/review", { id: A.media.shared, version: 1, feedback: "Reviewed", share: true }],
    ["communications/conversation", { playerId: A.playerId, guardianId: USERS.guardian.id, subject: "Hello there", text: "Hello there", entryId: crypto.randomUUID() }],
    ["fees/invoice", { id: crypto.randomUUID(), playerIds: [A.playerId], familyUserId: null, planId: null, description: "Fee", subtotal: 100, discount: 0, currency: "INR", dueDate: "2030-01-01" }],
    ["nutrition/assign", { playerId: B.playerId, professionalId: USERS.nutrition.id, active: true }],
  ] as const)
    await refuse("nutrition", path, request);
});
test("NUTRITION_PRO's response is limited to assigned players, at any depth", async () => {
  for (const [user, own, other, other2] of [
    ["nutrition", CANARY.childA, CANARY.childB, CANARY.adult],
    ["nutrition2", CANARY.childB, CANARY.childA, CANARY.adult],
    ["blueNutrition", CANARY.blue, CANARY.childA, CANARY.childB],
  ] as const) {
    const p = await payload(user);
    assertNoLeak(p, all(other, other2), `${user}: unassigned players`);
    assertPresent(p, [own.name, own.allergy, own.question, own.nutritionShared, own.nutritionDraft], `${user}: assigned player`);
    assertNoLeak(
      p,
      [own.notes, own.phone, own.email, own.birthDate, own.reportPublished, own.reportDraft, own.history, own.event, own.sessionNote, own.mediaShared, own.mediaPrivate, own.invoice, own.paymentRef, own.conversation],
      `${user}: the assigned player's non-nutrition data`,
    );
    assert.equal(p.players.length, 1, `${user} players`);
    assert.deepEqual(p.players[0].profile, {
      adult: false, birthDate: "", email: "", phone: "", notes: "",
      status: "ACTIVE", selfUserId: null, preferences: "",
    });
    assert.deepEqual(p.guardianLinks, []);
    for (const empty of ["events","sessions","reports","reviews","invoices","payments","refunds","credits","feePlans","messages","deliveries","templates","conversations","media","history","goals","audits","enquiries"])
      assert.deepEqual(p[empty], [], `${user} ${empty}`);
    assert.equal(p.members.length, 1, `${user} members: only itself`);
    assert.equal(p.members[0].id, USERS[user].id);
    // Revision history is nutrition-plan revisions of the assigned player only.
    assert.ok(p.versions.length > 0);
    for (const v of p.versions) assert.equal(v.kind, "nutrition-plan");
    assert.ok(p.assignments.every((r: { professionalId: string }) => r.professionalId === USERS[user].id));
    const emails = JSON.stringify(p).match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [];
    assert.deepEqual([...new Set(emails)], [USERS[user].email], `${user} e-mail addresses`);
  }
});
test("assignments: owner and admin manage them; the effect is immediate and reversible", async () => {
  const count = async (id: string) =>
    (await payload("nutrition2")).players.filter((p: { id: string }) => p.id === id).length;
  assert.equal(await count(A.playerId), 0, "before: ALPHA is invisible to nutrition2");
  const assign = (user: FixtureUserKey, active: boolean, playerId = A.playerId) =>
    post(user, "nutrition/assign", { playerId, professionalId: USERS.nutrition2.id, active });
  assert.equal((await assign("owner", true)).status, 200);
  assert.equal(await count(A.playerId), 1, "owner granted access");
  const gained = await payload("nutrition2");
  assertPresent(gained, [CANARY.childA.name, CANARY.childA.nutritionShared, CANARY.childA.allergy], "newly assigned player");
  assertNoLeak(gained, [CANARY.childA.phone, CANARY.childA.reportDraft, CANARY.childA.history], "newly assigned: still only nutrition data");
  const write = await post("nutrition2", "nutrition/plan", {
    playerId: A.playerId, title: "Plan title", guidance: "Some guidance text", action: "save", reviewNote: "",
  });
  assert.equal(write.status, 200);
  // Idempotent.
  assert.equal((await assign("owner", true)).status, 200);
  assert.equal(
    (await db().select().from(t.nutritionAssignments).where(and(eq(t.nutritionAssignments.playerId, A.playerId), eq(t.nutritionAssignments.professionalId, USERS.nutrition2.id)))).length,
    1,
  );
  // Admin withdraws it; the same session loses access at once.
  assert.equal((await assign("admin", false)).status, 200);
  assert.equal(await count(A.playerId), 0, "admin withdrew access");
  assertNoLeak(await payload("nutrition2"), all(CANARY.childA), "after withdrawal");
  await refuse("nutrition2", "nutrition/plan", { playerId: A.playerId, title: "Plan title", guidance: "Some guidance text", action: "save", reviewNote: "" });
  const [row] = await db().select().from(t.nutritionAssignments).where(and(eq(t.nutritionAssignments.playerId, A.playerId), eq(t.nutritionAssignments.professionalId, USERS.nutrition2.id)));
  assert.equal(row.active, false);
  assert.equal(row.assignedBy, USERS.admin.id);
  assert.ok(row.updatedAt instanceof Date && row.createdAt instanceof Date);
  const log = (await db().select().from(t.audit).where(eq(t.audit.entityId, A.playerId))).map((r) => r.action);
  assert.ok(log.includes("nutrition-assigned") && log.includes("nutrition-unassigned"));
  // The professional also stops being shown the assignment, but the owner keeps the record.
  assert.ok((await payload("owner")).assignments.some((r: { professionalId: string; active: boolean }) => r.professionalId === USERS.nutrition2.id && !r.active));
});
test("only owner and admin can assign; every other role and anonymous callers are refused", async () => {
  const request = { playerId: ADULT, professionalId: USERS.nutrition.id, active: true };
  for (const user of ["headCoach", "coach", "finance", "nutrition", "nutrition2", "guardian", "guardian2", "adult", "blueOwner", "blueNutrition"] as const)
    await refuse(user, "nutrition/assign", request);
  const anon = await app.anonymous().post(route("nutrition/assign"), request);
  assert.equal(anon.status, 401);
  assert.equal((await db().select().from(t.nutritionAssignments).where(eq(t.nutritionAssignments.playerId, ADULT))).length, 0);
  // Positive control.
  assert.equal((await post("owner", "nutrition/assign", request)).status, 200);
  assert.equal((await post("owner", "nutrition/assign", { ...request, active: false })).status, 200);
});
test("assignment targets must be an active Nutrition Pro and a player of the caller's own academy", async () => {
  const inactivePro = await addFixtureUser("da-retired-pro", [{ academyId: "green", role: "NUTRITION_PRO", active: false }]);
  const targets: [FixtureUserKey, unknown][] = [
    ["owner", { playerId: A.playerId, professionalId: USERS.coach.id, active: true }], // wrong role
    ["owner", { playerId: A.playerId, professionalId: USERS.guardian.id, active: true }],
    ["owner", { playerId: A.playerId, professionalId: USERS.owner.id, active: true }], // not self-serve
    ["owner", { playerId: A.playerId, professionalId: USERS.blueNutrition.id, active: true }], // other academy
    ["owner", { playerId: A.playerId, professionalId: "no-such-user", active: true }],
    ["owner", { playerId: A.playerId, professionalId: inactivePro.id, active: true }], // inactive membership
    ["owner", { playerId: BL.playerId, professionalId: USERS.nutrition.id, active: true }], // other academy's player
    ["blueOwner", { playerId: A.playerId, professionalId: USERS.blueNutrition.id, active: true }],
    ["blueOwner", { playerId: BL.playerId, professionalId: USERS.nutrition.id, active: true }],
    ["admin", { playerId: "no-such-player", professionalId: USERS.nutrition.id, active: true }],
  ];
  for (const [user, request] of targets) await refuse(user, "nutrition/assign", request);
  for (const bad of [{}, { playerId: A.playerId }, { playerId: A.playerId, professionalId: USERS.nutrition.id }, { playerId: A.playerId, professionalId: USERS.nutrition.id, active: "yes" }]) {
    const r = await post("owner", "nutrition/assign", bad);
    assert.equal(r.status, 422, JSON.stringify(bad));
  }
});
test("a professional demoted or deactivated after being assigned keeps nothing", async () => {
  const pro = await addFixtureUser("da-temp-pro", [{ academyId: "green", role: "NUTRITION_PRO" }]);
  assert.equal((await post("owner", "nutrition/assign", { playerId: A.playerId, professionalId: pro.id, active: true })).status, 200);
  const client = app.anonymous();
  assert.equal((await client.signIn(pro.email, FIXTURE_PASSWORD)).status, 200);
  const seen = await client.get("/api/academy");
  assert.equal(seen.status, 200);
  assertPresent(seen.json, [CANARY.childA.name], "assigned");
  // Role changed to COACH (no batch): the stale assignment does not follow them.
  await db().update(t.memberships).set({ role: "COACH" }).where(eq(t.memberships.userId, pro.id));
  const asCoach = await client.get("/api/academy");
  assert.equal(asCoach.status, 200);
  assertNoLeak(
    asCoach.json,
    all(CANARY.childA, CANARY.childB, CANARY.adult).filter((v) => v !== CANARY.childA.template && v !== CANARY.childA.feePlan),
    "demoted professional",
  );
  await db().update(t.memberships).set({ role: "NUTRITION_PRO", active: false }).where(eq(t.memberships.userId, pro.id));
  assert.equal((await client.get("/api/academy")).status, 403);
});
/* ============================== GUARDIAN / ADULT / COACH / OWNER / ADMIN ============================== */
test("GUARDIAN: linked child only, including by direct id inside the academy", async () => {
  // Positive controls for the linked child.
  for (const path of [`reports/${A.reportId}/pdf`, `fees/${A.paymentId}/receipt`])
    assert.equal((await get("guardian", path)).status, 200, path);
  assert.equal((await get("guardian", `media/${A.media.shared}/link`)).status, 200);
  const other = all(CANARY.childB, CANARY.adult);
  for (const path of [`reports/${B.reportId}/pdf`, `fees/${B.paymentId}/receipt`, `media/${B.media.shared}/link`, `media/${B.media.shared}/file`, `media/${B.media.private}/link`])
    await refuseRead("guardian", path, other);
  // The sibling's guardian is shut out of the first child symmetrically.
  for (const path of [`reports/${A.reportId}/pdf`, `fees/${A.paymentId}/receipt`, `media/${A.media.shared}/link`])
    await refuseRead("guardian2", path, all(CANARY.childA, CANARY.adult));
  await refuse("guardian", "nutrition/question", { playerId: B.playerId, question: "Question text", answer: "" }, other);
  await refuse("guardian", "nutrition/restrictions", { playerId: B.playerId, version: 1, allergies: "x", restrictions: "" }, other);
  await refuse("guardian", "players/consent", { playerId: B.playerId, consent: { portal: false, email: false, whatsapp: false } }, other);
  await refuse("guardian", "players/consent", { playerId: ADULT, consent: { portal: false, email: false, whatsapp: false } }, other);
  await refuse("guardian", "communications/conversation", { playerId: B.playerId, guardianId: USERS.guardian.id, subject: "Hello there", text: "Hello there", entryId: crypto.randomUUID() }, other);
  await refuse("guardian", "fees/invoice", { id: crypto.randomUUID(), playerIds: [A.playerId], familyUserId: null, planId: null, description: "Fee", subtotal: 100, discount: 0, currency: "INR", dueDate: "2030-01-01" }, other);
  await refuse("guardian", "nutrition/assign", { playerId: A.playerId, professionalId: USERS.nutrition.id, active: false }, other);
  // The linked child's own question is still writable (positive control).
  const ask = await post("guardian", "nutrition/question", { playerId: A.playerId, question: "A new question", answer: "" });
  assert.equal(ask.status, 200, body(ask));
});
test("ADULT_PLAYER: self only, including by direct id", async () => {
  const others = all(CANARY.childA, CANARY.childB);
  for (const path of [`reports/${A.reportId}/pdf`, `reports/${B.reportId}/pdf`, `fees/${A.paymentId}/receipt`, `media/${A.media.shared}/link`, `media/${B.media.shared}/file`])
    await refuseRead("adult", path, others);
  await refuse("adult", "nutrition/question", { playerId: A.playerId, question: "Question text", answer: "" }, others);
  await refuse("adult", "players/consent", { playerId: A.playerId, consent: { portal: false, email: false, whatsapp: false } }, others);
  await refuse("adult", "nutrition/assign", { playerId: ADULT, professionalId: USERS.nutrition.id, active: true }, others);
  // Nothing from the children appears in the adult's whole payload; the adult's own record does.
  const p = await payload("adult");
  assertNoLeak(p, all(CANARY.childA, CANARY.childB, CANARY.blue), "ADULT_PLAYER");
  assertPresent(p, [CANARY.adult.name], "ADULT_PLAYER self");
  assert.deepEqual(p.players.map((x: { id: string }) => x.id), [ADULT]);
});
test("COACH: own batch only by direct id; OWNER and ADMIN keep their full access", async () => {
  const outside = all(CANARY.childB);
  // childB is in the head coach's batch, not this coach's.
  for (const path of [`reports/${B.reportId}/pdf`, `media/${B.media.shared}/link`, `media/${B.media.private}/file`])
    await refuseRead("coach", path, outside);
  await refuse("coach", "reports/create", { playerId: B.playerId, periodStart: "2030-01-01", periodEnd: "2030-01-31", title: "Period report" }, outside);
  await refuse("coach", "media/review", { id: B.media.shared, version: 1, feedback: "Reviewed by the wrong coach", share: false }, outside);
  await refuse("coach", "nutrition/plan", { playerId: B.playerId, title: "Plan title", guidance: "Some guidance text", action: "save", reviewNote: "" }, outside);
  await refuse("coach", "fees/credit", { playerId: A.playerId, units: 1, reason: "Coach cannot do money", idempotencyKey: crypto.randomUUID() }, outside);
  await refuse("coach", "nutrition/assign", { playerId: A.playerId, professionalId: USERS.nutrition.id, active: false }, outside);
  // Positive controls: their own batch works.
  for (const path of [`reports/${A.reportId}/pdf`, `media/${A.media.private}/link`])
    assert.equal((await get("coach", path)).status, 200, path);
  // Owner and admin read every player's report, media and receipt.
  for (const user of ["owner", "admin"] as const)
    for (const ids of [A, B])
      for (const path of [`reports/${ids.reportId}/pdf`, `media/${ids.media.private}/link`, `fees/${ids.paymentId}/receipt`])
        assert.equal((await get(user, path)).status, 200, `${user} ${path}`);
});
test("every other tenant is still shut out, including from the new assignment data", async () => {
  for (const user of ["blueOwner", "blueCoach", "blueGuardian", "blueNutrition", "quietOwner"] as const) {
    const p = await payload(user);
    assertNoLeak(p, [...all(CANARY.childA, CANARY.childB, CANARY.adult), USERS.nutrition.email, USERS.nutrition2.email, USERS.nutrition.id, USERS.nutrition2.id], `${user}: green data`);
  }
  assert.deepEqual((await payload("quietOwner")).assignments, []);
  assert.deepEqual((await payload("blueOwner")).assignments.map((r: { professionalId: string }) => r.professionalId), [USERS.blueNutrition.id]);
  // Green owner sees green assignments only.
  const green = (await payload("owner")).assignments as { professionalId: string }[];
  assert.ok(green.length >= 3);
  assert.ok(green.every((r) => r.professionalId !== USERS.blueNutrition.id));
});
