import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { database } from "../src/infrastructure/database/client";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";
import * as t from "../src/infrastructure/database/schema";
import { eq } from "drizzle-orm";
import type { Actor } from "../src/modules/identity/access";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { linkGuardian } from "../src/modules/players/application/service";
import { createSession, mutateSession } from "../src/modules/training/application/service";
import { sampleDrills } from "../src/modules/training/domain/sample-drills";
import { reportAccess, updateReport } from "../src/modules/reports/application/service";
import { batchApprove, batchCreateDrafts, batchReportView } from "../src/modules/reports/application/batch";
import { reportBatchShare } from "../src/modules/communications/application/share-targets";
import { unit } from "../src/modules/academy/application/access";
import { factsSummary, monthRange, previousMonth, reportIssues } from "../src/modules/reports/domain/batch-rules";

process.env.BETTER_AUTH_SECRET = "isolated-report-batch-test-secret-1234567890123";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
/**
 * Batch reports: drafts for many players at once, the ready/flagged judgement, owner batch approval that excludes flagged
 * reports, and the parent-wise list. Real services and database (embedded PGlite, or PostgreSQL via `npm run test:pg`).
 */
let testDb: TestDatabase | undefined;
const actor = (id: string, role: string, academyId = "green"): Actor => ({
  id,
  name: `Test ${id}`,
  role,
  academyId,
  timezone: "Asia/Kolkata",
  academyName: `Academy ${academyId}`,
});
const owner = actor("owner", "OWNER"),
  coach = actor("coach", "COACH"),
  otherCoach = actor("other-coach", "COACH"),
  guardian = actor("parent", "GUARDIAN"),
  blueOwner = actor("blue-owner", "OWNER", "blue");

before(async () => {
  testDb = await provisionTestDatabase("report-batch");
  const db = database();
  for (const id of ["green", "blue"]) {
    await db.insert(t.academies).values({ id, name: `Academy ${id}`, timezone: "Asia/Kolkata" });
    await db.insert(t.academySettings).values({ academyId: id, data: defaultSettings });
    await db.insert(t.entitlements).values({ academyId: id, data: { reports: true, nutrition: true, communications: true, manualVideo: true } });
    await db.insert(t.branches).values({ id: `${id}-branch`, academyId: id, name: "Test branch" });
  }
  for (const a of [owner, coach, otherCoach, guardian, blueOwner]) {
    await db.insert(t.user).values({ id: a.id, name: a.name, email: `${a.id}@example.test` });
    await db.insert(t.memberships).values({ academyId: a.academyId, userId: a.id, role: a.role });
  }
  for (const [id, academyId, coachId, name] of [
    ["green-batch", "green", "coach", "Under 13"],
    ["green-other", "green", "other-coach", "Under 15"],
    ["blue-batch", "blue", "blue-owner", "Blue batch"],
  ])
    await db.insert(t.batches).values({ id, academyId, coachId, branchId: `${academyId}-branch`, name });
  for (const [id, academyId, batchId, name] of [
    ["child-a", "green", "green-batch", "Aadi Sharma"],
    ["child-b", "green", "green-batch", "Bina Rao"],
    ["child-c", "green", "green-other", "Chitra Das"],
    ["blue-child", "blue", "blue-batch", "Blue Child"],
  ]) {
    await db.insert(t.players).values({ id, academyId, batchId, name });
    await db.insert(t.profiles).values({ academyId, playerId: id, data: defaultProfile });
  }
  for (const d of sampleDrills) await db.insert(t.drills).values({ id: d.id, version: d.version, academyId: null, data: d });
  await linkGuardian(owner, { playerId: "child-a", userId: guardian.id, relationship: "Parent", active: true });
  await linkGuardian(owner, { playerId: "child-b", userId: guardian.id, relationship: "Parent", active: true });
});
after(async () => {
  await testDb?.cleanup();
});

const MONTH = "2027-03";
const PERIOD = { periodStart: `${MONTH}-01`, periodEnd: `${MONTH}-31` };
let day = 0;
async function completedSession(attendance: Record<string, "PRESENT" | "ABSENT" | "EXCUSED">) {
  let s = await createSession(coach);
  s = await mutateSession(coach, s.id, {
    version: s.version,
    action: "save",
    payload: {
      ...s.data,
      title: `March session ${++day}`,
      batchId: "green-batch",
      branchId: "green-branch",
      coachId: coach.id,
      localDate: `${MONTH}-${String(day).padStart(2, "0")}`,
      localTime: "17:00",
      duration: 10,
      objective: "Movement.",
      activities: [
        { id: "a1", drillId: "clear-recover", drillVersion: 1, title: "x", minutes: 5, cues: "" },
        { id: "a2", drillId: "doubles-shape", drillVersion: 1, title: "x", minutes: 5, cues: "" },
      ],
    },
  });
  s = await mutateSession(coach, s.id, { version: s.version, action: "publish" });
  s = await mutateSession(coach, s.id, { version: s.version, action: "start" });
  s = await mutateSession(coach, s.id, { version: s.version, action: "attendance", payload: attendance });
  return mutateSession(coach, s.id, {
    version: s.version,
    action: "complete",
    payload: { actuals: { a1: "COMPLETED", a2: "COMPLETED" }, recap: "", acknowledgeAttendance: true },
  });
}
const row = (rows: { playerId: string }[], id: string) => rows.find((r) => r.playerId === id) as never as Awaited<ReturnType<typeof batchReportView>>["rows"][number];
const reportOf = async (id: string) => (await database().select().from(t.reports).where(eq(t.reports.id, id)))[0];

test("the rules: facts are counts only, issues name what is missing, months are read exactly", () => {
  const evidence = [
    { attendance: "PRESENT" as const, practised: [{ skill: "Overhead" }, { skill: null }] },
    { attendance: "PRESENT" as const, practised: [{ skill: "Overhead" }, { skill: "Doubles" }] },
    { attendance: "ABSENT" as const, practised: [] },
    { attendance: "EXCUSED" as const, practised: [] },
  ];
  assert.equal(
    factsSummary({ playerName: "Aadi Sharma", periodStart: "2027-03-01", periodEnd: "2027-03-31", evidence }),
    "Aadi attended 2 of 4 recorded sessions between 2027-03-01 and 2027-03-31 (1 absent, 1 excused). Skills practised: Overhead (2), Doubles (1).",
  );
  assert.deepEqual(reportIssues({ summary: "x", strengths: "y", improvements: "z", evidence }), []);
  assert.deepEqual(
    reportIssues({ evidence }).map((i) => i.code),
    ["SUMMARY_EMPTY", "STRENGTHS_EMPTY", "IMPROVEMENTS_EMPTY"],
  );
  assert.deepEqual(
    reportIssues({ summary: "x", strengths: "y", improvements: "z", evidence: [{ attendance: "ABSENT" }] }).map((i) => i.code),
    ["NO_PRESENT_SESSION"],
  );
  assert.deepEqual(
    reportIssues({ summary: "x", strengths: "y", improvements: "z", evidence: [{ attendance: "PRESENT" }, { attendance: "NOT_MARKED" }] }).map((i) => i.code),
    ["ATTENDANCE_NOT_MARKED"],
  );
  // an older draft with no attendance snapshot is judged only on what the coach wrote
  assert.deepEqual(reportIssues({ summary: "x", strengths: "y", improvements: "z", evidence: [{}] }), []);
  assert.deepEqual(previousMonth("2027-01-15"), { start: "2026-12-01", end: "2026-12-31", title: "December 2026 report" });
  assert.deepEqual(previousMonth("2027-03-01"), { start: "2027-02-01", end: "2027-02-28", title: "February 2027 report" });
  assert.deepEqual(monthRange("2028-02"), { start: "2028-02-01", end: "2028-02-29", title: "February 2028 report" });
  assert.equal(monthRange("2028-13"), null);
  assert.equal(monthRange("garbage"), null);
});

test("drafts are made for the players who have something to report; the rest are skipped with a reason; nothing is made twice", async () => {
  await completedSession({ "child-a": "PRESENT", "child-b": "ABSENT" });
  await completedSession({ "child-a": "PRESENT", "child-b": "PRESENT" });
  await completedSession({ "child-a": "ABSENT", "child-b": "PRESENT" });
  const view0 = await batchReportView(owner, PERIOD);
  assert.deepEqual(view0.rows.map((r) => r.playerId), ["child-a", "child-b", "child-c"], "the owner sees the whole academy, sorted");
  assert.ok(view0.rows.every((r) => r.report === null && !r.ready));
  const made = await batchCreateDrafts(owner, { ...PERIOD, title: "March report", playerIds: ["child-a", "child-b", "child-c"] });
  const by = (id: string) => made.results.find((r) => r.playerId === id)!;
  assert.equal(by("child-a").outcome, "CREATED");
  assert.equal(by("child-b").outcome, "CREATED");
  assert.equal(by("child-c").outcome, "SKIPPED");
  assert.match(by("child-c").reason ?? "", /No completed sessions/);
  const a = await reportOf(by("child-a").reportId!);
  assert.equal(a.status, "DRAFT");
  assert.equal(a.data.summary, "", "the coach's own sections stay empty: nothing is written for them");
  assert.match(a.data.facts ?? "", /^Aadi attended 2 of 3 recorded sessions between 2027-03-01 and 2027-03-31 \(1 absent\)\./);
  const again = await batchCreateDrafts(owner, { ...PERIOD, title: "March report", playerIds: ["child-a", "child-b"] });
  assert.deepEqual(again.results.map((r) => r.outcome), ["EXISTS", "EXISTS"]);
  assert.equal((await database().select().from(t.reports).where(eq(t.reports.academyId, "green"))).length, 2, "no duplicate reports");
  const view = await batchReportView(owner, PERIOD);
  assert.deepEqual(row(view.rows, "child-a").issues.map((i) => i.code), ["SUMMARY_EMPTY", "STRENGTHS_EMPTY", "IMPROVEMENTS_EMPTY"]);
  assert.equal(row(view.rows, "child-a").ready, false);
});

test("batch approval publishes ready reports and excludes flagged ones, leaving them untouched", async () => {
  const view = await batchReportView(owner, PERIOD);
  const a = row(view.rows, "child-a").report!;
  const b = row(view.rows, "child-b").report!;
  // The coach finishes child-a's report only.
  await updateReport(coach, {
    id: a.id, version: a.version, action: "save", reason: "",
    summary: "A steady month.", strengths: "Footwork.", improvements: "Backhand clears.",
  });
  const refused = await batchApprove(coach, { reportIds: [a.id] }).then(() => null, (e: unknown) => e as { status?: number });
  assert.equal(refused?.status, 403, "only someone who may approve reports can approve a batch");
  const before = await reportOf(b.id);
  const done = await batchApprove(owner, { reportIds: [a.id, b.id] });
  const one = (id: string) => done.results.find((r) => r.reportId === id)!;
  assert.equal(one(a.id).outcome, "PUBLISHED");
  assert.equal(one(b.id).outcome, "BLOCKED");
  assert.deepEqual(one(b.id).issues!.map((i) => i.code), ["SUMMARY_EMPTY", "STRENGTHS_EMPTY", "IMPROVEMENTS_EMPTY"]);
  const approved = await reportOf(a.id);
  assert.equal(approved.status, "PUBLISHED");
  assert.equal(approved.data.reviewerId, "owner", "attribution comes from the signed-in owner");
  assert.ok(approved.data.approvedAt);
  const blocked = await reportOf(b.id);
  assert.deepEqual([blocked.status, blocked.version], [before.status, before.version], "a flagged report is left exactly as it was");
  const revisions = await database().select().from(t.recordRevisions).where(eq(t.recordRevisions.entityId, a.id));
  assert.ok(revisions.length >= 4, "every step is in the report's history");
  // Running it again changes nothing.
  assert.equal((await batchApprove(owner, { reportIds: [a.id] })).results[0].outcome, "ALREADY_PUBLISHED");
  // The family sees the published report and only that one.
  const seen = await unit(guardian, (tx) => reportAccess(guardian, a.id, tx));
  assert.equal(seen.status, "PUBLISHED");
  await assert.rejects(() => unit(guardian, (tx) => reportAccess(guardian, b.id, tx)), /not found/i);
  const after = await batchReportView(owner, PERIOD);
  assert.equal(row(after.rows, "child-a").report!.status, "PUBLISHED");
});

test("the parent-wise list names each parent once, covers only published reports and leaves the rest out", async () => {
  const view = await batchReportView(owner, PERIOD);
  const a = row(view.rows, "child-a").report!;
  const b = row(view.rows, "child-b").report!;
  const list = await reportBatchShare(owner, { reportIds: [a.id, b.id] });
  assert.equal(list.reportCount, 1);
  assert.deepEqual(list.notPublished, [b.id]);
  assert.equal(list.people.length, 1);
  assert.equal(list.people[0].email, "parent@example.test");
  assert.deepEqual(list.people[0].children, ["Aadi"], "the unpublished child is not named");
  // Once child-b's report is ready and published, the same parent appears once with both children.
  const rb = await reportOf(b.id);
  await updateReport(coach, { id: rb.id, version: rb.version, action: "save", reason: "", summary: "Good.", strengths: "Smash.", improvements: "Stamina." });
  assert.equal((await batchApprove(owner, { reportIds: [b.id] })).results[0].outcome, "PUBLISHED");
  const both = await reportBatchShare(owner, { reportIds: [a.id, b.id] });
  assert.equal(both.people.length, 1, "one message per parent, not per child");
  assert.deepEqual(both.people[0].children.sort(), ["Aadi", "Bina"]);
  assert.deepEqual(both.notPublished, []);
});

test("scope: a coach sees only their own batch; another academy's players never appear and cannot be drafted", async () => {
  const mine = await batchReportView(coach, PERIOD);
  assert.deepEqual(mine.rows.map((r) => r.playerId), ["child-a", "child-b"]);
  const theirs = await batchReportView(otherCoach, PERIOD);
  assert.deepEqual(theirs.rows.map((r) => r.playerId), ["child-c"]);
  const blueView = await batchReportView(blueOwner, PERIOD);
  assert.deepEqual(blueView.rows.map((r) => r.playerId), ["blue-child"]);
  const cross = await batchCreateDrafts(blueOwner, { ...PERIOD, title: "Cross", playerIds: ["child-a"] });
  assert.equal(cross.results[0].outcome, "SKIPPED", "a player of another academy cannot be drafted");
  const crossApprove = await batchApprove(blueOwner, { reportIds: (await database().select().from(t.reports)).map((r) => r.id).slice(0, 1) });
  assert.notEqual(crossApprove.results[0].outcome, "PUBLISHED", "another academy's report cannot be approved");
});
