import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { database } from "../src/infrastructure/database/client";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import type { ReportData } from "../src/modules/academy/domain/types";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { bootstrapAcademy } from "../src/modules/academy/application/bootstrap";
import { linkGuardian } from "../src/modules/players/application/service";
import { createSession, mutateSession } from "../src/modules/training/application/service";
import { sampleDrills } from "../src/modules/training/domain/sample-drills";
import { createReport, reviewObservation, updateReport } from "../src/modules/reports/application/service";
import { reportPdf } from "../src/modules/reports/application/pdf";
import { buildReportSheet, sheetLines } from "../src/modules/reports/domain/report-sheet";
import { analyse, type SessionFact } from "../src/modules/reports/domain/report-analysis";

process.env.BETTER_AUTH_SECRET = "isolated-report-progress-test-secret-1234567890123";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
/**
 * The progress analysis in what a FAMILY receives: the published report and its PDF. Attendance and its percentage, practice
 * minutes by area, reviewed observations with their category, the comparison with the period before in numbers, and an explicit
 * list of what the records do not contain. Never an unreviewed note, never a judgement, never the coach's drafting aid, and the
 * approved report's snapshot is not changed by anything that happens afterwards. Real services and database.
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
  guardian = actor("parent", "GUARDIAN"),
  otherGuardian = actor("other-parent", "GUARDIAN");

before(async () => {
  testDb = await provisionTestDatabase("report-progress");
  const db = database();
  await db.insert(t.academies).values({ id: "green", name: "Academy green", timezone: "Asia/Kolkata" });
  await db.insert(t.academySettings).values({ academyId: "green", data: defaultSettings });
  await db.insert(t.entitlements).values({ academyId: "green", data: { reports: true, nutrition: true, communications: true, manualVideo: true } });
  await db.insert(t.branches).values({ id: "green-branch", academyId: "green", name: "Test branch" });
  for (const a of [owner, coach, guardian, otherGuardian]) {
    await db.insert(t.user).values({ id: a.id, name: a.name, email: `${a.id}@example.test` });
    await db.insert(t.memberships).values({ academyId: "green", userId: a.id, role: a.role });
  }
  await db.insert(t.batches).values({ id: "green-batch", academyId: "green", coachId: "coach", branchId: "green-branch", name: "Under 13" });
  for (const [id, name] of [["child-a", "Aadi Sharma"], ["child-c", "Chitra Das"]]) {
    await db.insert(t.players).values({ id, academyId: "green", batchId: "green-batch", name });
    await db.insert(t.profiles).values({ academyId: "green", playerId: id, data: defaultProfile });
  }
  for (const d of sampleDrills) await db.insert(t.drills).values({ id: d.id, version: d.version, academyId: null, data: d });
  for (const [playerId, userId] of [["child-a", guardian.id], ["child-c", otherGuardian.id]])
    await linkGuardian(owner, {
      playerId,
      userId,
      relationship: "Parent",
      active: true,
      consent: { portal: true, email: true, whatsapp: false },
      consentMethod: "STAFF_WRITTEN",
      evidenceRef: "Paper form (test fixture)",
    });
});
after(async () => {
  await testDb?.cleanup();
});

/** The text a PDF displays, read from its (deflated) content streams. */
function pdfText(bytes: Uint8Array) {
  const raw = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let text = m[1];
    try {
      text = inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      /* not deflated */
    }
    for (const h of text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(h[1], "hex").toString("latin1"));
    for (const h of text.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(h[1]);
  }
  return out.join("\n").replace(/\s+/g, " ");
}

type Mark = "PRESENT" | "ABSENT" | "EXCUSED" | null;
/** A completed session on `date`. `mark` null leaves child-a's attendance unmarked. `note` adds a private note about child-a. */
async function held(date: string, mark: Mark, note?: string) {
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
        { id: "a1", drillId: "clear-recover", drillVersion: 1, title: "x", minutes: 5, cues: "" }, // Overhead: technical
        { id: "a2", drillId: "doubles-shape", drillVersion: 1, title: "x", minutes: 5, cues: "" }, // Doubles: tactical
        { id: "a3", drillId: null, drillVersion: null, title: "Club warm-up", minutes: 5, cues: "" }, // no skill: other
      ],
    },
  });
  s = await mutateSession(coach, s.id, { version: s.version, action: "publish" });
  s = await mutateSession(coach, s.id, { version: s.version, action: "start" });
  s = await mutateSession(coach, s.id, { version: s.version, action: "attendance", payload: mark ? { "child-a": mark } : { "child-c": "PRESENT" } });
  let noteId: string | null = null;
  if (note) {
    noteId = crypto.randomUUID();
    s = await mutateSession(coach, s.id, { version: s.version, action: "note", payload: { id: noteId, playerId: "child-a", activityId: "a1", text: note } });
  }
  s = await mutateSession(coach, s.id, {
    version: s.version,
    action: "complete",
    payload: { actuals: { a1: "COMPLETED", a2: "COMPLETED", a3: "COMPLETED" }, recap: "PRIVATE RECAP", acknowledgeAttendance: true },
  });
  return { id: s.id, noteId };
}
const step = (a: Actor, r: { id: string; version: number }, action: string, fields: Record<string, unknown> = {}) =>
  updateReport(a, { id: r.id, version: r.version, action, summary: "", reason: "", ...fields });

const base = (over: Partial<ReportData> = {}): ReportData => ({
  playerId: "p1",
  periodStart: "2027-03-01",
  periodEnd: "2027-03-31",
  title: "March",
  summary: "",
  evidence: [],
  academyName: "Sportozen Academy",
  playerName: "Aadi Sharma",
  reviewer: null,
  approvedAt: null,
  ...over,
});
const meta = { status: "DRAFT", version: 1, generatedOn: "2027-03-31" };
const fact = (date: string, attendance: SessionFact["attendance"], minutes = 0, skill: string | null = "Overhead", categories: SessionFact["categories"] = []): SessionFact => ({
  date,
  attendance,
  practised: minutes ? [{ skill, minutes }] : [],
  categories,
});

test("the sheet's progress section: numbers for both periods, the difference as arithmetic, and every gap listed", () => {
  const analysis = analyse(
    [fact("2027-02-10", "PRESENT", 10), fact("2027-02-12", "ABSENT"), fact("2027-03-02", "PRESENT", 20), fact("2027-03-04", "PRESENT", 10, "Fitness", ["TECHNICAL", null]), fact("2027-03-06", "NOT_MARKED")],
    "2027-03-01",
    "2027-03-31",
  );
  const g = buildReportSheet(base({ analysis }), meta).progress!;
  assert.equal(g.attendance.now, "2 of 3 sessions (100%)");
  assert.equal(g.attendance.before, "1 of 2 sessions (50%)");
  assert.equal(g.attendance.change, "50 percentage points higher than before");
  assert.deepEqual(g.practice, [
    { label: "Technical", now: 20, before: 10 },
    { label: "Physical", now: 10, before: 0 },
  ]);
  assert.deepEqual(g.practiceTotal, { now: 30, before: 10 });
  assert.deepEqual(g.observationCounts, [{ label: "Technical", count: 1 }]);
  assert.equal(g.previousLabel, "29 Jan 2027 – 28 Feb 2027");
  assert.deepEqual(g.notRecorded, [
    "Attendance was not marked for 1 session in this period; it is left out of the attendance percentage and adds no practice time.",
    "No reviewed observation is recorded for: tactical, physical, behaviour and discipline.",
    "1 reviewed observation has no category and is not counted in an area.",
  ]);
  const lines = sheetLines(buildReportSheet(base({ analysis }), meta)).join("\n");
  assert.match(lines, /Progress compared with the period before \(29 Jan 2027 – 28 Feb 2027\):/);
  assert.match(lines, /Attendance: 2 of 3 sessions \(100%\); before: 1 of 2 sessions \(50%\); 50 percentage points higher than before/);
  assert.match(lines, /Practice time by area: Technical 20 min \(before: 10\), Physical 10 min \(before: 0\); total 30 min \(before: 10\)/);
  assert.match(lines, /Not recorded: No reviewed observation is recorded for: tactical, physical, behaviour and discipline\./);
  assert.ok(!/improv|struggl|excellent|poor|score|rating|grade/i.test(JSON.stringify(g)), "numbers only: no verdict, no score");
});

test("no earlier period and no practice time are disclosed, not hidden; an older report with no analysis shows no progress section", () => {
  const none = analyse([fact("2027-03-02", "PRESENT")], "2027-03-01", "2027-03-31");
  const g = buildReportSheet(base({ analysis: none }), meta).progress!;
  assert.equal(g.hasPrevious, false);
  assert.equal(g.attendance.before, null);
  assert.equal(g.attendance.change, null);
  assert.deepEqual(g.practice, []);
  assert.ok(g.notRecorded[0].startsWith("No sessions were recorded in the period before (29 Jan 2027 – 28 Feb 2027), so there is nothing to compare with."));
  assert.ok(g.notRecorded.includes("No practice time was recorded for this player in this period."));
  const older = buildReportSheet(base(), meta);
  assert.equal(older.progress, null);
  assert.ok(!sheetLines(older).join("\n").includes("Progress compared"), "nothing is invented for a report made before the comparison existed");
  // The percentage uses recorded sessions only, the same rule as the headline figure, so the two can never disagree.
  const mixed = analyse([fact("2027-03-02", "PRESENT"), fact("2027-03-04", "ABSENT"), fact("2027-03-06", "NOT_MARKED")], "2027-03-01", "2027-03-31");
  assert.equal(mixed.current.percent, 50);
  assert.equal(buildReportSheet(base({ analysis: mixed }), meta).progress!.attendance.now, "1 of 3 sessions (50%)");
});

test("published report and PDF carry the progress analysis, the same on both; nothing private or unreviewed, and nothing changes the approved snapshot", async () => {
  await held("2027-02-10", "PRESENT");
  await held("2027-02-17", "ABSENT");
  const m1 = await held("2027-03-02", "PRESENT", "PRIVATE NOTE ONE: working note, never for families");
  const m2 = await held("2027-03-04", "PRESENT", "PRIVATE NOTE TWO: another working note");
  await held("2027-03-06", "PRESENT", "PRIVATE NOTE THREE: never reviewed");
  await held("2027-03-08", null); // child-a's attendance is never marked
  await reviewObservation(coach, { sessionId: m1.id, observationId: m1.noteId, approvedText: "Held a good base position at the net.", category: "TECHNICAL" });
  await reviewObservation(coach, { sessionId: m2.id, observationId: m2.noteId, approvedText: "Stayed calm and polite when a point went against them.", category: "BEHAVIOUR" });

  let r = await createReport(coach, { playerId: "child-a", periodStart: "2027-03-01", periodEnd: "2027-03-31", title: "March development" });
  assert.ok(r.data.facts, "the coach gets a counts-only drafting aid");
  const snapshot = JSON.stringify(r.data.analysis);
  r = await step(coach, r, "save", { summary: "A steady month.", strengths: "Footwork.", improvements: "Backhand clear depth.", priorities: ["Net play consistency", "Backhand clear"], closingNote: "Keep going." });
  r = await step(coach, r, "submit");
  r = await step(owner, r, "approve");
  r = await step(owner, r, "publish");

  // What the family's screen draws from: the published report, without the coach's drafting aid.
  const shown = (await bootstrapAcademy(guardian)).reports.find((x) => x.id === r.id)!;
  assert.equal((shown.data as { facts?: string }).facts, undefined, "the drafting aid is not sent to a family");
  assert.equal(JSON.stringify(shown.data.analysis), snapshot, "the family sees the snapshot taken when the draft was made");
  const sheet = buildReportSheet(shown.data, { status: shown.status, version: shown.version, generatedOn: "2027-04-01" });
  const g = sheet.progress!;
  assert.equal(g.attendance.now, "3 of 4 sessions (100%)", "3 present of the 3 sessions with attendance marked; one session was never marked");
  assert.equal(g.attendance.before, "1 of 2 sessions (50%)");
  assert.equal(g.attendance.change, "50 percentage points higher than before");
  assert.deepEqual(g.practice, [
    { label: "Technical", now: 15, before: 5 },
    { label: "Tactical", now: 15, before: 5 },
    { label: "Other", now: 15, before: 5 },
  ]);
  assert.deepEqual(g.observationCounts, [{ label: "Technical", count: 1 }, { label: "Behaviour and discipline", count: 1 }]);
  assert.ok(g.notRecorded.some((n) => n.includes("not marked for 1 session")));
  assert.ok(g.notRecorded.some((n) => n.includes("tactical, physical")), "the areas with no reviewed observation are named");
  assert.deepEqual(
    sheet.observations.map((o) => [o.text, o.category]),
    [["Held a good base position at the net.", "Technical"], ["Stayed calm and polite when a point went against them.", "Behaviour and discipline"]],
    "only the two reviewed observations, each with its category",
  );

  // The PDF is drawn from the same model: every progress fact is in it, and so are the coach's words.
  const bytes = (await reportPdf(guardian, r.id)).bytes;
  const pdf = pdfText(bytes);
  const must = [
    "Progress compared with the period before",
    g.attendance.now,
    g.attendance.before!,
    `Attendance rate: ${g.attendance.change}.`,
    "Practice: technical",
    "Practice: tactical",
    "Practice time in total",
    "45 min",
    "15 min",
    "5 min",
    "Reviewed coaching observations this period: Technical 1, Behaviour and discipline 1.",
    "Not recorded in this period",
    ...g.notRecorded,
    "Held a good base position at the net.",
    "(Technical)",
    "(Behaviour and discipline)",
    "A steady month.",
    "Footwork.",
    "Backhand clear depth.",
    "Net play consistency",
    "Keep going.",
  ];
  for (const f of must) assert.ok(pdf.includes(f.replace(/\s+/g, " ")), `PDF is missing: ${f}`);
  const lines = sheetLines(sheet).join("\n");
  for (const f of [g.attendance.now, g.attendance.before!, ...g.notRecorded]) assert.ok(lines.includes(f), `sheet lines are missing: ${f}`);

  // Nothing private, unreviewed or judgemental reaches the family, in the data or the document.
  const familyJson = JSON.stringify(await bootstrapAcademy(guardian));
  for (const secret of ["PRIVATE NOTE", "PRIVATE RECAP", "never reviewed"]) {
    assert.ok(!familyJson.includes(secret), `family data leaks: ${secret}`);
    assert.ok(!pdf.includes(secret), `PDF leaks: ${secret}`);
  }
  assert.ok(!/improv(ed|ing) |struggl|excellent|poor|score|rating|grade|out of 10/i.test(pdf.replace("Areas to improve", "").replace("Backhand clear depth.", "")), "no judgement or score in the PDF");

  // Another family cannot obtain it.
  await assert.rejects(() => reportPdf(otherGuardian, r.id), /not found|denied|access/i);

  // Approval protections: the approved snapshot cannot be edited, and a revision keeps the analysis exactly as it was.
  await assert.rejects(() => step(coach, r, "save", { summary: "Changed after approval" }), /Only report drafts can be edited|version|conflict/i);
  const revised = await step(owner, r, "revise", { reason: "Correct a typo in the summary" });
  assert.equal(JSON.stringify(revised.data.analysis), snapshot, "a revision keeps the analysis snapshot");
  assert.equal(revised.status, "DRAFT");
  const stillShown = (await bootstrapAcademy(guardian)).reports.find((x) => x.id === r.id)!;
  assert.equal(stillShown.data.summary, "A steady month.", "the family keeps the published version until the revision is published");
});
