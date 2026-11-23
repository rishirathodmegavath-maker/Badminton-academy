import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { database } from "../src/infrastructure/database/client";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { bootstrapAcademy } from "../src/modules/academy/application/bootstrap";
import { linkGuardian } from "../src/modules/players/application/service";
import { createSession, mutateSession } from "../src/modules/training/application/service";
import { sampleDrills } from "../src/modules/training/domain/sample-drills";
import { createReport, reviewObservation, updateReport, withdrawReport } from "../src/modules/reports/application/service";
import { reportPdf } from "../src/modules/reports/application/pdf";
import { buildReportSheet, dayLabel, sheetLines } from "../src/modules/reports/domain/report-sheet";

process.env.BETTER_AUTH_SECRET = "isolated-monthly-report-test-secret-1234567890123";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
/**
 * The monthly development report, end to end on the real services and database: what a draft snapshots, how coach
 * feedback is saved and reloaded, who may do what, what a family can and cannot see, and that the PDF carries the same
 * facts as the report the screen previews. Runs on embedded PGlite, or on PostgreSQL via `npm run test:pg`.
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
  admin = actor("admin", "ADMIN"),
  headCoach = actor("head", "HEAD_COACH"),
  coach = actor("coach", "COACH"),
  otherCoach = actor("other-coach", "COACH"),
  finance = actor("finance", "FINANCE"),
  pro = actor("pro", "NUTRITION_PRO"),
  guardian = actor("parent", "GUARDIAN"),
  otherGuardian = actor("other-parent", "GUARDIAN"),
  blueOwner = actor("blue-owner", "OWNER", "blue");

before(async () => {
  testDb = await provisionTestDatabase("monthly-report");
  const db = database();
  for (const id of ["green", "blue"]) {
    await db.insert(t.academies).values({ id, name: `Academy ${id}`, timezone: "Asia/Kolkata" });
    await db.insert(t.academySettings).values({ academyId: id, data: defaultSettings });
    await db.insert(t.entitlements).values({
      academyId: id,
      data: { reports: true, nutrition: true, communications: true, manualVideo: true },
    });
    await db.insert(t.branches).values({ id: `${id}-branch`, academyId: id, name: "Test branch" });
  }
  for (const a of [owner, admin, headCoach, coach, otherCoach, finance, pro, guardian, otherGuardian, blueOwner]) {
    await db.insert(t.user).values({ id: a.id, name: a.name, email: `${a.id}@example.test` });
    await db.insert(t.memberships).values({ academyId: a.academyId, userId: a.id, role: a.role });
  }
  for (const [id, academyId, coachId, name] of [
    ["green-batch", "green", "coach", "Under 13"],
    ["green-other", "green", "other-coach", "Under 15"],
    ["blue-batch", "blue", "blue-owner", "Blue batch"],
  ])
    await db.insert(t.batches).values({ id, academyId, coachId, branchId: `${academyId}-branch`, name });
  for (const [id, academyId, batchId] of [
    ["child-a", "green", "green-batch"],
    ["child-b", "green", "green-batch"],
    ["child-c", "green", "green-other"],
    ["blue-child", "blue", "blue-batch"],
  ]) {
    await db.insert(t.players).values({ id, academyId, batchId, name: id === "child-a" ? "Aadi Sharma" : id });
    await db.insert(t.profiles).values({ academyId, playerId: id, data: defaultProfile });
  }
  for (const d of sampleDrills) await db.insert(t.drills).values({ id: d.id, version: d.version, academyId: null, data: d });
  for (const [playerId, userId] of [
    ["child-a", guardian.id],
    ["child-c", otherGuardian.id],
  ])
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

let day = 0;
const MONTH = "2027-03";
/** A completed session in the report month: real drills (skills come from the drill), one custom activity. */
async function completedSession(attendance: Record<string, "PRESENT" | "ABSENT" | "EXCUSED">, onDate?: string) {
  let s = await createSession(coach);
  ++day;
  const date = onDate ?? `${MONTH}-${String(day).padStart(2, "0")}`;
  s = await mutateSession(coach, s.id, {
    version: s.version,
    action: "save",
    payload: {
      ...s.data,
      title: `March session ${day}`,
      batchId: "green-batch",
      branchId: "green-branch",
      coachId: coach.id,
      localDate: date,
      localTime: "17:00",
      duration: 15,
      objective: "Movement and net control.",
      activities: [
        { id: "a1", drillId: "clear-recover", drillVersion: 1, title: "x", minutes: 5, cues: "" },
        { id: "a2", drillId: "doubles-shape", drillVersion: 1, title: "x", minutes: 5, cues: "" },
        { id: "a3", drillId: null, drillVersion: null, title: "Club warm-up", minutes: 5, cues: "" },
      ],
    },
  });
  s = await mutateSession(coach, s.id, { version: s.version, action: "publish" });
  s = await mutateSession(coach, s.id, { version: s.version, action: "start" });
  s = await mutateSession(coach, s.id, { version: s.version, action: "attendance", payload: attendance });
  s = await mutateSession(coach, s.id, {
    version: s.version,
    action: "note",
    payload: {
      id: crypto.randomUUID(),
      playerId: "child-a",
      activityId: "a1",
      text: `PRIVATE ORIGINAL ${day}: coach-only working note.`,
    },
  });
  return mutateSession(coach, s.id, {
    version: s.version,
    action: "complete",
    payload: {
      actuals: { a1: "COMPLETED", a2: "MODIFIED", a3: "COMPLETED" },
      recap: "Private recap.",
      acknowledgeAttendance: true,
    },
  });
}
const input = (over: Record<string, unknown> = {}) => ({
  playerId: "child-a",
  periodStart: `${MONTH}-01`,
  periodEnd: `${MONTH}-31`,
  title: "March development",
  ...over,
});
const save = (a: Actor, r: { id: string; version: number }, fields: Record<string, unknown> = {}) =>
  updateReport(a, { id: r.id, version: r.version, action: "save", summary: "", reason: "", ...fields });
const step = (a: Actor, r: { id: string; version: number }, action: string) =>
  updateReport(a, { id: r.id, version: r.version, action, summary: "", reason: "" });

/** The text a PDF displays, read from its (deflated) content streams. */
function pdfText(bytes: Uint8Array) {
  const raw = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const body = Buffer.from(m[1], "latin1");
    let text = m[1];
    try {
      text = inflateSync(body).toString("latin1");
    } catch {
      /* not deflated */
    }
    for (const h of text.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(h[1], "hex").toString("latin1"));
    for (const h of text.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(h[1]);
  }
  return out.join("\n").replace(/\s+/g, " ");
}

test("a draft snapshots the recorded attendance, the skill of each activity and the player's group — nothing else", async () => {
  await completedSession({ "child-a": "PRESENT", "child-b": "ABSENT" });
  await completedSession({ "child-a": "PRESENT", "child-b": "PRESENT" });
  await completedSession({ "child-a": "ABSENT", "child-b": "PRESENT" });
  const a = await createReport(coach, input());
  assert.equal(a.data.group, "Under 13");
  assert.deepEqual(
    a.data.evidence.map((e) => e.attendance),
    ["PRESENT", "PRESENT", "ABSENT"],
  );
  const first = a.data.evidence[0];
  assert.deepEqual(first.practised, [
    { title: "Clear & recover", skill: "Overhead", status: "COMPLETED" },
    { title: "Doubles positioning", skill: "Doubles", status: "MODIFIED" },
    { title: "Club warm-up", skill: null, status: "COMPLETED" },
  ]);
  assert.deepEqual(a.data.evidence[2].practised, [], "an absent player practised nothing");
  // Coach-entered sections start empty: nothing is pre-filled or generated.
  assert.equal(a.data.summary, "");
  assert.equal(a.data.strengths, "");
  assert.equal(a.data.improvements, "");
  assert.deepEqual(a.data.priorities, []);
  assert.equal(a.data.closingNote, "");
  assert.equal(a.status, "DRAFT");
  const sheet = buildReportSheet(a.data, { status: a.status, version: a.version, generatedOn: "2027-03-31" });
  assert.equal(sheet.stats.sessions, 3);
  assert.equal(sheet.stats.attended, 2);
  assert.equal(sheet.stats.percent, 67);
  assert.equal(sheet.stats.activities, 6);
  assert.deepEqual(sheet.practised.map((g) => g.skill), ["Overhead", "Doubles", "Other"]);
  // The other child in the batch has a different, independently recorded history.
  const b = await createReport(coach, input({ playerId: "child-b" }));
  assert.deepEqual(b.data.evidence.map((e) => e.attendance), ["ABSENT", "PRESENT", "PRESENT"]);
});

test("coach feedback saves, reloads and survives; omitted sections are left unchanged; limits are enforced", async () => {
  const r0 = await createReport(coach, input({ title: "Feedback draft" }));
  const r1 = await save(coach, r0, {
    summary: "Good month overall.",
    strengths: "  Footwork and recovery.  ",
    improvements: "Backhand clears.",
    priorities: ["Net play consistency", "  net play CONSISTENCY ", "", "Backhand clear"],
    closingNote: "Keep working on fitness.",
  });
  assert.equal(r1.version, r0.version + 1);
  assert.equal(r1.data.strengths, "Footwork and recovery.", "trimmed");
  assert.deepEqual(r1.data.priorities, ["Net play consistency", "Backhand clear"], "de-duplicated and blanks dropped");
  // Reload: what the staff screen reads back is what was saved.
  const loaded = (await bootstrapAcademy(coach)).reports.find((x) => x.id === r0.id)!;
  assert.equal(loaded.data.summary, "Good month overall.");
  assert.deepEqual(loaded.data.priorities, ["Net play consistency", "Backhand clear"]);
  assert.equal(loaded.data.closingNote, "Keep working on fitness.");
  // A save that names only the summary (an older client) does not wipe the other sections.
  const r2 = await save(coach, r1, { summary: "Revised summary." });
  assert.equal(r2.data.summary, "Revised summary.");
  assert.equal(r2.data.strengths, "Footwork and recovery.");
  assert.deepEqual(r2.data.priorities, ["Net play consistency", "Backhand clear"]);
  // Explicitly clearing works.
  const r3 = await save(coach, r2, { summary: "Revised summary.", priorities: [], strengths: "" });
  assert.deepEqual(r3.data.priorities, []);
  assert.equal(r3.data.strengths, "");
  // Limits.
  await assert.rejects(() => save(coach, r3, { priorities: ["1", "2", "3", "4", "5", "6"] }), /too_big|at most|Too big/i);
  await assert.rejects(() => save(coach, r3, { priorities: ["x".repeat(81)] }), /too_big|at most|Too big/i);
  await assert.rejects(() => save(coach, r3, { strengths: "x".repeat(1501) }), /too_big|at most|Too big/i);
  await assert.rejects(() => save(coach, r3, { closingNote: "x".repeat(501) }), /too_big|at most|Too big/i);
  // A stale save (another editor saved first) is refused rather than overwriting.
  await assert.rejects(() => save(coach, r1, { summary: "Stale" }), /changed|version|Reload/i);
  // Only drafts are editable.
  const submitted = await step(coach, r3, "submit");
  await assert.rejects(() => save(coach, submitted, { summary: "After submit" }), /Only report drafts/);
});

test("who may prepare, approve and publish: coaches within their own players, approval by owner, admin or head coach only", async () => {
  const draft = await createReport(coach, input({ title: "Authority draft" }));
  // A coach for another batch cannot see, edit or create a report for this player.
  await assert.rejects(() => save(otherCoach, draft, { summary: "Not mine" }), /not found/i);
  await assert.rejects(() => createReport(otherCoach, input()), /not found/i);
  // Guardians, finance and nutrition cannot author.
  for (const who of [guardian, finance, pro]) {
    await assert.rejects(() => save(who, draft, { summary: "No" }), /role|not allowed|permission/i, who.role);
    await assert.rejects(() => createReport(who, input()), /role|not allowed|permission/i, who.role);
  }
  const inReview = await step(coach, await save(coach, draft, { summary: "Ready", priorities: ["Smash power"] }), "submit");
  assert.equal(inReview.status, "IN_REVIEW");
  // The coach prepares but does not approve; nobody outside the approving roles can.
  for (const who of [coach, otherCoach, guardian, finance, pro])
    await assert.rejects(() => step(who, inReview, "approve"), /role|not found|permission|allowed/i, who.role);
  const approved = await step(headCoach, inReview, "approve");
  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.data.reviewer, headCoach.name, "approver is attributed from the session");
  assert.equal(approved.data.strengths, "");
  // Not visible to the family until published.
  assert.ok(!(await bootstrapAcademy(guardian)).reports.some((x) => x.id === draft.id));
  await assert.rejects(() => reportPdf(guardian, draft.id), /not found/i);
  const published = await step(admin, approved, "publish");
  assert.equal(published.status, "PUBLISHED");
  const mine = (await bootstrapAcademy(guardian)).reports.find((x) => x.id === draft.id)!;
  assert.equal(mine.data.summary, "Ready");
  assert.deepEqual(mine.data.priorities, ["Smash power"]);
  // Another family and another academy never see it.
  assert.ok(!(await bootstrapAcademy(otherGuardian)).reports.some((x) => x.id === draft.id));
  await assert.rejects(() => reportPdf(otherGuardian, draft.id), /not found/i);
  await assert.rejects(() => step(blueOwner, published, "revise"), /not found/i);
  await assert.rejects(() => reportPdf(blueOwner, draft.id), /not found/i);
});

test("a revision is edited privately; the family keeps the last published copy, including its feedback, until the new one is published", async () => {
  const d = await createReport(coach, input({ title: "Revision draft" }));
  let r = await save(coach, d, { summary: "Published wording.", closingNote: "Published note." });
  r = await step(coach, r, "submit");
  r = await step(owner, r, "approve");
  r = await step(owner, r, "publish");
  const revised = await updateReport(owner, { id: r.id, version: r.version, action: "revise", summary: "", reason: "Fix wording" });
  assert.equal(revised.status, "DRAFT");
  const edited = await save(coach, revised, { summary: "UNPUBLISHED NEW WORDING", closingNote: "UNPUBLISHED NOTE" });
  const family = (await bootstrapAcademy(guardian)).reports.find((x) => x.id === r.id)!;
  assert.equal(family.data.summary, "Published wording.");
  assert.equal(family.data.closingNote, "Published note.");
  assert.ok(!JSON.stringify(await bootstrapAcademy(guardian)).includes("UNPUBLISHED"));
  const pdf = pdfText((await reportPdf(guardian, r.id)).bytes);
  assert.ok(pdf.includes("Published wording."));
  assert.ok(!pdf.includes("UNPUBLISHED"));
  assert.equal(edited.version, revised.version + 1);
});

test("coach-only notes never reach the family or the PDF; only explicitly reviewed wording does", async () => {
  const s = await completedSession({ "child-a": "PRESENT", "child-b": "PRESENT" });
  const note = s.data.observations.find((n) => n.playerId === "child-a")!;
  const unreviewed = await createReport(coach, input({ title: "Unreviewed", periodStart: s.data.localDate, periodEnd: s.data.localDate }));
  assert.deepEqual(unreviewed.data.evidence[0].observations, [], "a private note is not evidence until reviewed");
  await reviewObservation(coach, { sessionId: s.id, observationId: note.id, approvedText: "Recovered to base with balance." });
  let r = await createReport(coach, input({ title: "Reviewed", periodStart: s.data.localDate, periodEnd: s.data.localDate }));
  assert.deepEqual(r.data.evidence[0].observations, ["Recovered to base with balance."]);
  r = await save(coach, r, { summary: "Reviewed summary." });
  r = await step(coach, r, "submit");
  r = await step(owner, r, "approve");
  r = await step(owner, r, "publish");
  const familyJson = JSON.stringify(await bootstrapAcademy(guardian));
  assert.ok(!familyJson.includes("PRIVATE ORIGINAL"), "the private note is not in the family's data");
  assert.ok(!familyJson.includes("Private recap"), "the session recap is not in the family's data");
  const text = pdfText((await reportPdf(guardian, r.id)).bytes);
  assert.ok(!text.includes("PRIVATE ORIGINAL") && !text.includes("Private recap"));
  assert.ok(text.includes("Recovered to base with balance."));
});

test("the PDF and the preview are the same approved report: every fact on one is on the other", async () => {
  const d = await createReport(coach, input({ title: "March development" }));
  let r = await save(coach, d, {
    summary: "Aadi moved well and recovered quicker this month.",
    strengths: "Court movement and recovery.",
    improvements: "Backhand clear depth.",
    priorities: ["Net play consistency", "Backhand clear", "Smash power"],
    closingNote: "Keep working on fitness.",
  });
  r = await step(coach, r, "submit");
  r = await step(owner, r, "approve");
  r = await step(owner, r, "publish");
  // What the family's screen builds its preview from, and what the PDF endpoint renders.
  const shown = (await bootstrapAcademy(guardian)).reports.find((x) => x.id === r.id)!;
  const sheet = buildReportSheet(shown.data, { status: shown.status, version: shown.version, generatedOn: "2027-03-31" });
  const pdf = await reportPdf(guardian, r.id);
  assert.match(pdf.name, new RegExp(`^report-${r.id}-v${r.version}\\.pdf$`));
  const doc = await PDFDocument.load(pdf.bytes);
  assert.ok(doc.getPageCount() >= 1);
  assert.equal(doc.getTitle(), "March development - Aadi Sharma");
  const text = pdfText(pdf.bytes);
  const must = [
    "Sportozen Academy",
    "Badminton Academy",
    sheet.periodLabel, // "March 2027"
    sheet.player.name,
    sheet.player.group!,
    String(sheet.stats.sessions),
    `${sheet.stats.percent}%`,
    ...sheet.practised.map((g) => g.label),
    ...sheet.practised.flatMap((g) => g.activities.map((a) => a.title)),
    "Monthly summary",
    sheet.feedback.summary,
    sheet.feedback.strengths,
    sheet.feedback.improvements,
    ...sheet.feedback.priorities,
    sheet.feedback.closingNote,
    ...sheet.sessions.map((s) => s.title),
    ...sheet.sessions.map((s) => dayLabel(s.date)),
    "Reviewed and approved by",
    sheet.reviewer!,
    "Published",
  ];
  for (const fact of must) assert.ok(text.includes(fact.replace(/\s+/g, " ")), `PDF is missing: ${fact}`);
  // The plain-text lines the renderer is given carry the same facts as the sheet.
  const lines = sheetLines(sheet).join("\n");
  for (const p of sheet.feedback.priorities) assert.ok(lines.includes(p));
  // Attendance shown as recorded: present twice, absent once.
  assert.ok(text.includes("Present") && text.includes("Absent"));
  assert.equal((text.match(/Present/g) ?? []).length, sheet.stats.attended);
  // Four March sessions by now (the earlier tests recorded them): present, present, absent, present.
  assert.equal(sheet.stats.sessions, 4);
  assert.equal(sheet.stats.percent, 75);
  // Nothing in the PDF that the sheet does not carry: no invented score or rating wording.
  assert.ok(!/rating|score|out of 10|grade/i.test(text.replace("Sessions conducted", "")), "no invented scores");
});

test("a withdrawn report's PDF is clearly marked for staff and gone for the family; long unbroken text still renders", async () => {
  const d = await createReport(coach, input({ title: "Layout stress" }));
  const long = "Wordy ".repeat(450) + "U".repeat(300);
  let r = await save(coach, d, { summary: long.slice(0, 3000), improvements: "I".repeat(400), closingNote: "End." });
  r = await step(coach, r, "submit");
  r = await step(owner, r, "approve");
  const bytes = (await reportPdf(owner, r.id)).bytes;
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 2, "long content continues on further pages");
  const text = pdfText(bytes);
  assert.ok(text.includes("End.") && text.includes("Approved"));
  assert.ok(/1 \/ \d+/.test(text), "page numbers");
  r = await step(owner, r, "publish");
  const withdrawn = await withdrawReport(owner, {
    id: r.id,
    version: r.version,
    reason: "Wrong player named in the summary.",
  });
  assert.equal((withdrawn as { status: string }).status, "WITHDRAWN");
  await assert.rejects(() => reportPdf(guardian, r.id), /not found/i);
  assert.ok(pdfText((await reportPdf(owner, r.id)).bytes).includes("WITHDRAWN - no longer shared with families. Do not distribute."));
});

test("a draft lists its sessions in the order they happened, whatever order they were recorded in", async () => {
  // Recorded newest first in a month of their own (the March counts above are untouched), so the order they were created in,
  // and the order the database is likely to hand them back in, is the opposite of the calendar.
  for (const date of ["2027-05-20", "2027-05-05", "2027-05-12"]) await completedSession({ "child-a": "PRESENT", "child-b": "PRESENT" }, date);
  const r = await createReport(coach, input({ title: "Order draft", periodStart: "2027-05-01", periodEnd: "2027-05-31" }));
  assert.deepEqual(
    r.data.evidence.map((e) => e.date),
    ["2027-05-05", "2027-05-12", "2027-05-20"],
    "the stored snapshot is chronological",
  );
  // A draft stored in database order by an older version is still shown chronologically.
  const shuffled = { ...r.data, evidence: [r.data.evidence[2], r.data.evidence[0], r.data.evidence[1]] };
  const sheet = buildReportSheet(shuffled, { status: r.status, version: r.version, generatedOn: "2027-05-31" });
  assert.deepEqual(sheet.sessions.map((s) => s.date), ["2027-05-05", "2027-05-12", "2027-05-20"]);
});
