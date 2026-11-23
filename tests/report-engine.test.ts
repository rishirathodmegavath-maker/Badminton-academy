import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { createSession, mutateSession } from "../src/modules/training/application/service";
import { sampleDrills } from "../src/modules/training/domain/sample-drills";
import { createReport, reviewObservation, updateReport } from "../src/modules/reports/application/service";
import { batchApprove } from "../src/modules/reports/application/batch";
import {
  createDueDrafts,
  getReportPolicy,
  prepareDraft,
  reportsDue,
  runReportScheduler,
  saveReportPolicy,
} from "../src/modules/reports/application/policy";
import {
  analyse,
  areaOf,
  attendanceLine,
  computeDue,
  monthBefore,
  periodStats,
  practiceLine,
  previousRange,
  reportWarnings,
  type SessionFact,
} from "../src/modules/reports/domain/report-analysis";
import { reportIssues } from "../src/modules/reports/domain/batch-rules";

process.env.BETTER_AUTH_SECRET = "isolated-report-engine-test-secret-1234567890123";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
/**
 * Report engine: the numbers a draft carries (attendance, practice time by area, reviewed observations by category, and the
 * same for the period before), what is flagged as missing, and the monthly and after-N-sessions triggers. Automated preparation
 * only ever makes DRAFTS, never duplicates, and never touches an existing report. Real services and database (PGlite).
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
  otherOwner = actor("other-owner", "OWNER");
before(async () => {
  testDb = await provisionTestDatabase("report-engine");
  const db = database();
  await db.insert(t.academies).values({ id: "green", name: "Academy green", timezone: "Asia/Kolkata" });
  await db.insert(t.academySettings).values({ academyId: "green", data: defaultSettings });
  await db.insert(t.entitlements).values({ academyId: "green", data: { reports: true, nutrition: true, communications: true, manualVideo: true } });
  await db.insert(t.branches).values({ id: "green-branch", academyId: "green", name: "Test branch" });
  for (const a of [owner, coach, otherOwner]) {
    await db.insert(t.user).values({ id: a.id, name: a.name, email: `${a.id}@example.test` });
    await db.insert(t.memberships).values({ academyId: "green", userId: a.id, role: a.role });
  }
  await db.insert(t.batches).values({ id: "green-batch", academyId: "green", coachId: "coach", branchId: "green-branch", name: "Under 13" });
  for (const [id, name] of [["child-a", "Aadi Sharma"], ["child-b", "Bina Rao"], ["child-c", "Chitra Das"]]) {
    await db.insert(t.players).values({ id, academyId: "green", batchId: "green-batch", name });
    await db.insert(t.profiles).values({ academyId: "green", playerId: id, data: { ...defaultProfile, status: "ACTIVE" } });
  }
  for (const d of sampleDrills) await db.insert(t.drills).values({ id: d.id, version: d.version, academyId: null, data: d });
});
after(async () => {
  await testDb?.cleanup();
});

/** A completed session on `date`; `observe` adds one note about child-a and returns its id. */
async function session(date: string, attendance: Record<string, "PRESENT" | "ABSENT" | "EXCUSED">, observe = false) {
  let s = await createSession(coach);
  s = await mutateSession(coach, s.id, {
    version: s.version,
    action: "save",
    payload: {
      ...s.data,
      title: `Session ${date}`,
      batchId: "green-batch",
      branchId: "green-branch",
      coachId: coach.id,
      localDate: date,
      localTime: "17:00",
      duration: 15,
      objective: "Movement.",
      activities: [
        { id: "a1", drillId: "clear-recover", drillVersion: 1, title: "x", minutes: 5, cues: "" }, // Overhead = technical
        { id: "a2", drillId: "doubles-shape", drillVersion: 1, title: "x", minutes: 5, cues: "" }, // Doubles = tactical
        { id: "a3", drillId: null, drillVersion: null, title: "Club warm-up", minutes: 5, cues: "" }, // no skill = other
      ],
    },
  });
  s = await mutateSession(coach, s.id, { version: s.version, action: "publish" });
  s = await mutateSession(coach, s.id, { version: s.version, action: "start" });
  s = await mutateSession(coach, s.id, { version: s.version, action: "attendance", payload: attendance });
  let noteId: string | null = null;
  if (observe) {
    noteId = crypto.randomUUID();
    s = await mutateSession(coach, s.id, { version: s.version, action: "note", payload: { id: noteId, playerId: "child-a", activityId: "a1", text: `private ${date}` } });
  }
  s = await mutateSession(coach, s.id, {
    version: s.version,
    action: "complete",
    payload: { actuals: { a1: "COMPLETED", a2: "COMPLETED", a3: "COMPLETED" }, recap: "", acknowledgeAttendance: true },
  });
  return { id: s.id, noteId };
}
const PRESENT = { "child-a": "PRESENT", "child-b": "PRESENT", "child-c": "PRESENT" } as const;
const reportRows = async () => database().select().from(t.reports).where(eq(t.reports.academyId, "green"));

test("the pure analysis: counts per period, practice time by area, the period before, and wording that states numbers only", () => {
  assert.equal(areaOf("Overhead"), "TECHNICAL");
  assert.equal(areaOf("Doubles"), "TACTICAL");
  assert.equal(areaOf("Fitness"), "PHYSICAL");
  assert.equal(areaOf(null), "OTHER");
  assert.equal(areaOf("Something new"), "OTHER");
  assert.deepEqual(previousRange("2027-03-01", "2027-03-31"), { start: "2027-01-29", end: "2027-02-28" }, "same length, ending the day before");
  const f = (date: string, attendance: SessionFact["attendance"], practised: SessionFact["practised"] = [], categories: SessionFact["categories"] = []): SessionFact => ({ date, attendance, practised, categories });
  const facts = [
    f("2027-02-10", "PRESENT", [{ skill: "Overhead", minutes: 10 }]),
    f("2027-02-12", "ABSENT"),
    f("2027-03-02", "PRESENT", [{ skill: "Overhead", minutes: 20 }, { skill: "Fitness", minutes: 15 }], ["BEHAVIOUR", null]),
    f("2027-03-04", "PRESENT", [{ skill: "Doubles", minutes: 5 }, { skill: null, minutes: 5 }], ["TECHNICAL"]),
    f("2027-03-06", "EXCUSED"),
    f("2027-03-08", "NOT_MARKED"),
  ];
  const a = analyse(facts, "2027-03-01", "2027-03-31");
  assert.deepEqual([a.current.sessions, a.current.present, a.current.excused, a.current.unmarked, a.current.percent], [4, 2, 1, 1, 67]); // 2 of the 3 sessions whose attendance was marked: the same rule as the report headline
  assert.deepEqual(a.current.minutesByArea, { TECHNICAL: 20, TACTICAL: 5, PHYSICAL: 15, OTHER: 5 }, "time counts only while present");
  assert.deepEqual([a.previous?.sessions, a.previous?.present, a.previous?.percent], [2, 1, 50]);
  assert.deepEqual(a.observationsByCategory, { TECHNICAL: 1, TACTICAL: 0, PHYSICAL: 0, BEHAVIOUR: 1, UNTAGGED: 1 });
  assert.equal(attendanceLine(a), "Attendance 2 of 4 sessions (67%, of the 3 with attendance marked); the period before: 1 of 2 sessions (50%), 17 percentage points higher now.");
  assert.match(practiceLine(a) ?? "", /technical 20 min \(before: 10\), tactical 5 min \(before: 0\), physical 15 min \(before: 0\), other 5 min \(before: 0\)/);
  assert.equal(periodStats([], "2027-03-01", "2027-03-31").percent, null, "no sessions, no percentage");
  assert.equal(analyse([f("2027-03-02", "PRESENT")], "2027-03-01", "2027-03-31").previous, null, "nothing to compare with");
  // wording never judges
  const text = JSON.stringify([attendanceLine(a), practiceLine(a)]);
  assert.ok(!/improv|struggl|excellent|poor|progress/i.test(text), "numbers only, no verdict");
  // warnings: a gap is flagged, and becomes a blocking issue only when the academy requires that category
  const w = reportWarnings(a);
  assert.deepEqual(w.map((x) => x.code), ["NO_OBSERVATION_TACTICAL", "NO_OBSERVATION_PHYSICAL", "UNTAGGED_OBSERVATIONS"]);
  assert.deepEqual(reportWarnings(analyse([f("2027-03-02", "PRESENT")], "2027-03-01", "2027-03-31")).map((x) => x.code).slice(0, 1), ["NO_COMPARISON"]);
  assert.deepEqual(reportWarnings(undefined), [], "an older draft has nothing to warn about");
  const draft = { summary: "x", strengths: "y", improvements: "z", evidence: [{ attendance: "PRESENT" as const }], analysis: a };
  assert.deepEqual(reportIssues(draft).map((i) => i.code), []);
  assert.deepEqual(reportIssues(draft, { requiredCategories: ["PHYSICAL", "BEHAVIOUR"] }).map((i) => i.text), ["No reviewed physical observation is recorded, and this academy requires one."]);
});

test("the pure triggers: monthly for the month before, after N present sessions, never overlapping an existing report", () => {
  assert.deepEqual(monthBefore("2027-01-03"), { start: "2026-12-01", end: "2026-12-31", title: "December 2026 report" });
  const player = (id: string, rosterDates: string[], presentDates = rosterDates, active = true) => ({ id, name: id, active, rosterDates, presentDates });
  const policy = { monthlyEnabled: true, sessionsEnabled: false, sessionsN: 3, requiredCategories: [] };
  const march = ["2027-03-02", "2027-03-09"];
  assert.deepEqual(computeDue({ today: "2027-04-02", policy, players: [player("a", march)], reports: [] }).map((d) => [d.kind, d.periodStart, d.periodEnd]), [["MONTHLY", "2027-03-01", "2027-03-31"]]);
  assert.deepEqual(computeDue({ today: "2027-04-02", policy, players: [player("a", ["2027-02-02"])], reports: [] }), [], "no session in the month, nothing due");
  assert.deepEqual(computeDue({ today: "2027-04-02", policy, players: [player("a", march, march, false)], reports: [] }), [], "an inactive player is skipped");
  assert.deepEqual(computeDue({ today: "2027-04-02", policy: { ...policy, monthlyEnabled: false }, players: [player("a", march)], reports: [] }), [], "switched off");
  const covering = { playerId: "a", periodStart: "2027-03-05", periodEnd: "2027-03-20", status: "PUBLISHED" };
  assert.deepEqual(computeDue({ today: "2027-04-02", policy, players: [player("a", march)], reports: [covering] }), [], "an overlapping report is preserved, not duplicated");
  assert.equal(computeDue({ today: "2027-04-02", policy, players: [player("a", march)], reports: [{ ...covering, status: "WITHDRAWN" }] }).length, 1, "a withdrawn report does not count");
  const sessions = { ...policy, monthlyEnabled: false, sessionsEnabled: true, sessionsN: 3 };
  const dates = ["2027-03-02", "2027-03-04", "2027-03-04", "2027-03-09", "2027-03-11"];
  const due = computeDue({ today: "2027-03-12", policy: sessions, players: [player("a", dates)], reports: [] });
  assert.deepEqual(due.map((d) => [d.kind, d.periodStart, d.periodEnd]), [["SESSIONS", "2027-03-02", "2027-03-04"]], "the third session was on the 4th");
  assert.equal(computeDue({ today: "2027-03-12", policy: sessions, players: [player("a", ["2027-03-02", "2027-03-04"])], reports: [] }).length, 0, "fewer than N");
  const later = computeDue({ today: "2027-03-30", policy: sessions, players: [player("a", dates)], reports: [{ playerId: "a", periodStart: "2027-03-02", periodEnd: "2027-03-04", status: "DRAFT" }] });
  assert.equal(later.length, 0, "counting restarts after the latest report: only two sessions since");
  const both = computeDue({ today: "2027-04-02", policy: { ...policy, sessionsEnabled: true, sessionsN: 2 }, players: [player("a", march)], reports: [] });
  assert.equal(both.length, 1, "the two triggers never both draft the same days");
});

test("a draft carries the analysis, observation categories and the period before; the coach's own sections stay empty", async () => {
  // February (the period before) and March
  await session("2027-02-10", { "child-a": "PRESENT", "child-b": "ABSENT", "child-c": "PRESENT" });
  await session("2027-02-17", { "child-a": "ABSENT", "child-b": "PRESENT", "child-c": "PRESENT" });
  const s1 = await session("2027-03-02", PRESENT, true);
  const s2 = await session("2027-03-04", { "child-a": "PRESENT", "child-b": "ABSENT", "child-c": "PRESENT" }, true);
  await session("2027-03-06", { "child-a": "EXCUSED", "child-b": "PRESENT", "child-c": "PRESENT" });
  await reviewObservation(coach, { sessionId: s1.id, observationId: s1.noteId, approvedText: "Calm and focused when behind in points.", category: "BEHAVIOUR" });
  await reviewObservation(coach, { sessionId: s2.id, observationId: s2.noteId, approvedText: "Cleaner footwork on the backhand side." });
  const report = await createReport(coach, { playerId: "child-a", periodStart: "2027-03-01", periodEnd: "2027-03-31", title: "March" });
  const d = report.data;
  assert.equal(d.summary, "");
  assert.equal(d.strengths, "");
  assert.equal(d.improvements, "");
  assert.ok(d.analysis);
  assert.deepEqual([d.analysis!.current.sessions, d.analysis!.current.present, d.analysis!.current.excused, d.analysis!.current.percent], [3, 2, 1, 67]);
  assert.deepEqual(d.analysis!.current.minutesByArea, { TECHNICAL: 10, TACTICAL: 10, PHYSICAL: 0, OTHER: 10 }, "5 minutes per activity while present, grouped by the drill's skill");
  assert.deepEqual([d.analysis!.previous?.sessions, d.analysis!.previous?.present, d.analysis!.previous?.percent], [2, 1, 50]);
  assert.deepEqual(d.analysis!.observationsByCategory, { TECHNICAL: 0, TACTICAL: 0, PHYSICAL: 0, BEHAVIOUR: 1, UNTAGGED: 1 });
  const details = d.evidence.flatMap((e) => e.observationDetails ?? []);
  assert.deepEqual(details.map((x) => x.category).sort(), ["BEHAVIOUR", null]);
  assert.ok(!JSON.stringify(d).includes("private 2027"), "the coach's private note text is never in the draft; only the reviewed wording");
  // an unknown category is refused at review time
  await assert.rejects(() => reviewObservation(coach, { sessionId: s1.id, observationId: s1.noteId, approvedText: "x", category: "FLAIR" }));
  const w = reportWarnings(d.analysis).map((x) => x.code);
  assert.ok(w.includes("NO_OBSERVATION_TACTICAL") && w.includes("UNTAGGED_OBSERVATIONS") && !w.includes("NO_COMPARISON"));
  // a required category that is missing blocks batch approval, with the reason
  const policy = await saveReportPolicy(owner, { monthlyEnabled: false, sessionsEnabled: false, sessionsN: 8, requiredCategories: ["TACTICAL"] });
  assert.deepEqual(policy.policy.requiredCategories, ["TACTICAL"]);
  await updateReport(coach, { id: report.id, version: report.version, action: "save", reason: "", summary: "A steady month.", strengths: "Footwork.", improvements: "Backhand." });
  const blocked = await batchApprove(owner, { reportIds: [report.id] });
  assert.equal(blocked.results[0].outcome, "BLOCKED");
  assert.match(blocked.results[0].issues?.[0].text ?? "", /tactical observation is recorded, and this academy requires one/);
  await saveReportPolicy(owner, { monthlyEnabled: false, sessionsEnabled: false, sessionsN: 8, requiredCategories: [] });
  assert.equal((await batchApprove(owner, { reportIds: [report.id] })).results[0].outcome, "PUBLISHED", "without the requirement it is only a warning");
});

test("policy: bounded values, owner-level to change, recorded in the audit trail; reading is allowed to those who read reports", async () => {
  const read = await getReportPolicy(coach);
  assert.equal(read.canEdit, false);
  const refused = await saveReportPolicy(coach, { monthlyEnabled: true, sessionsEnabled: false, sessionsN: 8, requiredCategories: [] }).then(() => null, (e: { status?: number }) => e);
  assert.equal(refused?.status, 403, "a coach cannot change it");
  for (const bad of [{ sessionsN: 1 }, { sessionsN: 61 }, { requiredCategories: ["FLAIR"] }])
    await assert.rejects(() => saveReportPolicy(owner, { monthlyEnabled: true, sessionsEnabled: true, sessionsN: 8, requiredCategories: [], ...bad }));
  const saved = await saveReportPolicy(owner, { monthlyEnabled: true, sessionsEnabled: true, sessionsN: 4, requiredCategories: ["BEHAVIOUR", "BEHAVIOUR"] });
  assert.deepEqual(saved.policy, { monthlyEnabled: true, sessionsEnabled: true, sessionsN: 4, requiredCategories: ["BEHAVIOUR"] });
  const [row] = await database().select().from(t.reportPolicies).where(eq(t.reportPolicies.academyId, "green"));
  assert.equal(row.enabledBy, "owner", "the person who switched it on is recorded");
  const audits = await database().select().from(t.audit).where(and(eq(t.audit.academyId, "green"), eq(t.audit.action, "report-policy")));
  assert.ok(audits.length >= 3, `policy changes are audited (found ${audits.length})`);
  assert.equal((await getReportPolicy(otherOwner)).policy.monthlyEnabled, true, "same academy sees the same policy");
});

test("due drafts are listed, created once as DRAFTS, never duplicate and never touch an existing report; a coach sees only their own", async () => {
  await saveReportPolicy(owner, { monthlyEnabled: true, sessionsEnabled: false, sessionsN: 8, requiredCategories: [] });
  const now = new Date("2027-04-03T08:00:00+05:30");
  const before = await reportRows();
  const listed = await reportsDue(owner, undefined, now);
  // child-a already has a March report (published above); child-b and child-c have March sessions and none yet
  assert.deepEqual(listed.due.map((d) => d.playerId), ["child-b", "child-c"], "a player with an overlapping report is not due");
  const made = await createDueDrafts(owner, undefined, now);
  assert.deepEqual(made.results.map((r) => r.outcome), ["CREATED", "CREATED"]);
  const created = (await reportRows()).filter((r) => !before.some((b) => b.id === r.id));
  assert.equal(created.length, 2);
  assert.ok(created.every((r) => r.status === "DRAFT" && r.version === 1), "drafts only, never approved or published");
  assert.ok(created.every((r) => r.data.summary === "" && r.data.strengths === ""), "no coach words are written");
  const hist = await database().select().from(t.recordRevisions).where(eq(t.recordRevisions.entityId, created[0].id));
  assert.equal((hist[0].data as { via: string }).via, "manual");
  const again = await createDueDrafts(owner, undefined, now);
  assert.deepEqual(again.results, [], "a second press finds nothing due");
  // the published report is untouched
  const published = before.find((r) => r.playerId === "child-a")!;
  const still = (await reportRows()).find((r) => r.id === published.id)!;
  assert.deepEqual([still.status, still.version], [published.status, published.version]);
  // concurrency: two simultaneous attempts for the same player and period create ONE draft
  const due = { playerId: "child-a", playerName: "Aadi", kind: "SESSIONS" as const, periodStart: "2027-02-01", periodEnd: "2027-02-28", title: "February" };
  const race = await Promise.all([prepareDraft(owner, due, "scheduler"), prepareDraft(owner, due, "scheduler"), prepareDraft(owner, due, "scheduler")]);
  assert.equal(race.filter((r) => r.outcome === "CREATED").length, 1, "exactly one creator");
  assert.equal(race.filter((r) => r.outcome === "EXISTS").length, 2);
  assert.equal((await reportRows()).filter((r) => r.playerId === "child-a" && r.data.periodStart === "2027-02-01").length, 1);
  // nothing for a player outside the actor's scope
  const other = await prepareDraft(actor("owner", "OWNER", "elsewhere"), { ...due, playerId: "child-a" }, "manual").catch((e) => e);
  assert.ok(other, "another academy cannot prepare drafts for these players");
});

test("the scheduler acts for the person who switched it on, makes drafts only, is safe to repeat, and stops when that person can no longer author", async () => {
  await database().delete(t.reportPolicies);
  assert.deepEqual(await runReportScheduler(new Date("2027-05-03T08:00:00+05:30")), [], "no policy switched on, nothing runs");
  await session("2027-04-07", PRESENT);
  await session("2027-04-09", PRESENT);
  await saveReportPolicy(owner, { monthlyEnabled: true, sessionsEnabled: false, sessionsN: 8, requiredCategories: [] });
  const now = new Date("2027-05-03T08:00:00+05:30");
  const before = (await reportRows()).length;
  const first = await runReportScheduler(now);
  assert.equal(first.length, 1);
  assert.equal(first[0].created, 3, "an April draft for each of the three players");
  const fresh = (await reportRows()).filter((r) => r.data.periodStart === "2027-04-01");
  assert.equal(fresh.length, 3);
  assert.ok(fresh.every((r) => r.status === "DRAFT"), "never approved, never published");
  assert.equal((await reportRows()).length, before + 3);
  const who = await database().select().from(t.audit).where(and(eq(t.audit.entityId, fresh[0].id)));
  assert.equal(who[0].actorId, "owner", "attributed to the person who switched the schedule on, as a scheduled run");
  const hist = await database().select().from(t.recordRevisions).where(eq(t.recordRevisions.entityId, fresh[0].id));
  assert.equal((hist[0].data as { via: string }).via, "scheduler");
  const second = await runReportScheduler(now);
  assert.deepEqual([second[0].created, second[0].existing, second[0].skipped], [0, 0, 0], "a repeat finds nothing due");
  // the person who switched it on is switched off: nothing is created under anyone else's name
  await session("2027-05-07", PRESENT);
  await database().update(t.memberships).set({ active: false }).where(and(eq(t.memberships.academyId, "green"), eq(t.memberships.userId, "owner")));
  const stopped = await runReportScheduler(new Date("2027-06-03T08:00:00+05:30"));
  assert.equal(stopped[0].created, 0);
  assert.match(stopped[0].note ?? "", /can no longer author reports/);
  await database().update(t.memberships).set({ active: true }).where(and(eq(t.memberships.academyId, "green"), eq(t.memberships.userId, "owner")));
});
