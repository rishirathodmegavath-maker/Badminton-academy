import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReportData } from "../src/modules/academy/domain/types";
import {
  REPORT_LIMITS,
  attendanceCaveat,
  attendanceLine,
  buildReportSheet,
  cleanPriorities,
  periodLabel,
  sheetLines,
} from "../src/modules/reports/domain/report-sheet";

/**
 * The monthly report model: a pure function of the stored report. These tests pin what it calculates, what it refuses to
 * invent, and that older reports (written before attendance and skills were snapshotted) still render honestly.
 */
const base = (over: Partial<ReportData> = {}): ReportData => ({
  playerId: "p1",
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  title: "October development",
  summary: "",
  evidence: [],
  academyName: "Sportozen Academy",
  playerName: "Aadi Sharma",
  reviewer: null,
  approvedAt: null,
  ...over,
});
const session = (
  id: string,
  attendance: "PRESENT" | "ABSENT" | "EXCUSED" | "NOT_MARKED",
  practised: { title: string; skill: string | null; status: "COMPLETED" | "MODIFIED" }[] = [],
  observations: string[] = [],
) => ({
  sessionId: id,
  title: `Session ${id}`,
  date: `2026-10-0${id}`,
  attendance,
  practised,
  observations,
  activities: practised.map((a) => `${a.title} (${a.status.toLowerCase()})`),
});
const meta = { status: "DRAFT", version: 1, generatedOn: "2026-10-31" };

test("attendance percentage is attended / recorded sessions, rounded, and never invented", () => {
  const sheet = buildReportSheet(
    base({ evidence: [session("1", "PRESENT"), session("2", "PRESENT"), session("3", "ABSENT")] }),
    meta,
  );
  assert.equal(sheet.stats.sessions, 3);
  assert.equal(sheet.stats.attended, 2);
  assert.equal(sheet.stats.percent, 67);
  assert.equal(attendanceLine(sheet), "2 of 3 sessions · 67%");
  assert.equal(attendanceCaveat(sheet), null);

  const none = buildReportSheet(base({ evidence: [session("1", "NOT_MARKED")] }), meta);
  assert.equal(none.stats.percent, null, "nothing was recorded, so there is no percentage");
  assert.match(attendanceLine(none), /attendance not recorded/);
  assert.match(attendanceCaveat(none) ?? "", /not recorded for 1 of 1 session;/);

  const empty = buildReportSheet(base(), meta);
  assert.equal(empty.stats.percent, null);
  assert.equal(empty.stats.sessions, 0);
});

test("excused and absent sessions count as not attended, and unmarked ones are excluded from the percentage but disclosed", () => {
  const sheet = buildReportSheet(
    base({ evidence: [session("1", "PRESENT"), session("2", "EXCUSED"), session("3", "ABSENT"), session("4", "NOT_MARKED")] }),
    meta,
  );
  assert.equal(sheet.stats.percent, 33, "1 present of 3 recorded");
  assert.equal(sheet.stats.excused, 1);
  assert.equal(sheet.stats.absent, 1);
  assert.equal(sheet.stats.notMarked, 1);
  assert.match(attendanceCaveat(sheet) ?? "", /1 of 4 sessions/);
});

test("practised areas come only from recorded activities of attended sessions, grouped by the drill's recorded skill", () => {
  const sheet = buildReportSheet(
    base({
      evidence: [
        session("1", "PRESENT", [
          { title: "Clear & recover", skill: "Overhead", status: "COMPLETED" },
          { title: "Net kills", skill: "Net play", status: "MODIFIED" },
          { title: "Club warm-up", skill: null, status: "COMPLETED" },
        ]),
        session("2", "PRESENT", [{ title: "Clear & recover", skill: "Overhead", status: "COMPLETED" }]),
        // An absent player never practised anything: whatever the evidence holds is not counted.
        session("3", "ABSENT", [{ title: "Smash & follow-up", skill: "Overhead", status: "COMPLETED" }]),
      ],
    }),
    meta,
  );
  assert.deepEqual(
    sheet.practised.map((g) => g.skill),
    ["Overhead", "Net play", "Other"],
  );
  const overhead = sheet.practised[0];
  assert.deepEqual(overhead.activities, [{ title: "Clear & recover", times: 2 }]);
  assert.equal(overhead.sessions, 2);
  assert.equal(sheet.stats.activities, 4, "four recorded activities in attended sessions");
  assert.equal(sheet.stats.skillAreas, 3);
  assert.ok(!sheet.practised.some((g) => g.activities.some((a) => a.title === "Smash & follow-up")));
  // No skill the library does not record is ever made up.
  const odd = buildReportSheet(base({ evidence: [session("1", "PRESENT", [{ title: "X", skill: "Archery", status: "COMPLETED" }])] }), meta);
  assert.deepEqual(odd.practised.map((g) => g.skill), ["Other"]);
});

test("older reports (no attendance or skills snapshot) still render: activities prove attendance, the rest is 'not recorded'", () => {
  const sheet = buildReportSheet(
    base({
      evidence: [
        { sessionId: "1", title: "Old", date: "2026-10-01", activities: ["Footwork ladder (completed)", "Shadow clears (modified)"], observations: [] },
        { sessionId: "2", title: "Older", date: "2026-10-02", activities: [], observations: [] },
      ],
    }),
    meta,
  );
  assert.equal(sheet.sessions[0].attendance, "PRESENT");
  assert.equal(sheet.sessions[1].attendance, "UNKNOWN");
  assert.equal(sheet.stats.attended, 1);
  assert.equal(sheet.stats.percent, 100, "only the session with a proven attendance is recorded");
  assert.match(attendanceCaveat(sheet) ?? "", /not recorded for 1 of 2/);
  assert.deepEqual(sheet.practised[0].activities.map((a) => a.title), ["Footwork ladder", "Shadow clears"]);
  assert.equal(sheet.practised[0].skill, "Other");
  // The staff screen may supply the live attendance mark for an older draft.
  const live = buildReportSheet(
    base({ evidence: [{ sessionId: "2", title: "Older", date: "2026-10-02", activities: [], observations: [] }] }),
    meta,
    { attendance: () => "ABSENT" },
  );
  assert.equal(live.sessions[0].attendance, "ABSENT");
});

test("coach-entered feedback is carried as written and blank sections stay blank", () => {
  const sheet = buildReportSheet(
    base({ summary: "Steady month.", strengths: "Footwork.", improvements: "", priorities: ["Net play", " net play ", "", "Backhand clear"], closingNote: "Keep going." }),
    meta,
  );
  assert.equal(sheet.feedback.summary, "Steady month.");
  assert.equal(sheet.feedback.improvements, "");
  assert.deepEqual(sheet.feedback.priorities, ["Net play", "Backhand clear"]);
  const bare = buildReportSheet(base(), meta);
  assert.equal(bare.feedback.summary, "");
  assert.deepEqual(bare.feedback.priorities, []);
  assert.ok(sheetLines(bare).some((l) => l.includes("No coach summary recorded.")));
});

test("priorities are trimmed, de-duplicated ignoring case, capped at five and at 80 characters", () => {
  assert.deepEqual(cleanPriorities(["  A  ", "a", "B", "C", "D", "E", "F"]), ["A", "B", "C", "D", "E"]);
  assert.equal(cleanPriorities(["x".repeat(200)])[0].length, REPORT_LIMITS.priority);
  assert.deepEqual(cleanPriorities(undefined), []);
});

test("the period reads as a month for a whole calendar month and as a range otherwise", () => {
  assert.equal(periodLabel("2026-10-01", "2026-10-31"), "October 2026");
  assert.equal(periodLabel("2028-02-01", "2028-02-29"), "February 2028");
  assert.equal(periodLabel("2026-10-03", "2026-10-19"), "3 Oct 2026 – 19 Oct 2026");
  assert.equal(periodLabel("2026-10-01", "2026-11-30"), "1 Oct 2026 – 30 Nov 2026");
});

test("the model carries status, approver and the plain-text lines the PDF falls back to", () => {
  const sheet = buildReportSheet(
    base({ summary: "Good.", reviewer: "Head Coach", approvedAt: "2026-10-30T10:00:00.000Z", group: "U13", evidence: [session("1", "PRESENT")] }),
    { status: "PUBLISHED", version: 4, generatedOn: "2026-10-31" },
  );
  assert.equal(sheet.statusLabel, "Published");
  assert.equal(sheet.approvedOn, "2026-10-30");
  assert.equal(sheet.player.group, "U13");
  assert.equal(sheet.player.initials, "AS");
  const lines = sheetLines(sheet);
  assert.ok(lines.includes("Player: Aadi Sharma (U13)"));
  assert.ok(lines.some((l) => l.startsWith("Status: PUBLISHED | Revision 4")));
  assert.ok(lines.includes("Reviewed by: Head Coach"));
});
