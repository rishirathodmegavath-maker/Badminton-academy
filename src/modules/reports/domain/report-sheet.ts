import type { ReportData } from "../../academy/domain/types";
import { AREAS, AREA_LABEL, CATEGORY_LABEL, OBSERVATION_CATEGORIES, previousRange, type PeriodStats } from "./report-analysis";
/**
 * The monthly development report as a PRESENTATION model.
 *
 * One pure function turns the stored `ReportData` into everything the report shows: the live preview on the
 * Reports screen, the family's published copy and the PDF are all drawn from this same model, so the three can never
 * disagree. Nothing here reads a database, decides authority or invents a value:
 *   - recorded evidence   = sessions, attendance and activities the academy recorded (snapshotted at drafting),
 *   - calculated          = counts and the attendance percentage, derived only from that evidence,
 *   - coach-entered       = summary, strengths, improvements, priorities and the closing note.
 * A figure that cannot be derived is `null` (shown as "not recorded"), never a guess.
 */
export const REPORT_LIMITS = {
  summary: 3000,
  strengths: 1500,
  improvements: 1500,
  closingNote: 500,
  priorities: 5,
  priority: 80,
} as const;

/** The skills the training library records on a drill, in display order. Anything else is grouped as "Other". */
export const SKILL_GROUPS = [
  { skill: "Movement", label: "Footwork & court movement", detail: "Moving to the shuttle and recovering to base" },
  { skill: "Overhead", label: "Overhead shots", detail: "Clears, drop shots and smashes" },
  { skill: "Net play", label: "Net play", detail: "Net shots, lifts and control at the front court" },
  { skill: "Serve & return", label: "Serve & return", detail: "Serving techniques and receiving" },
  { skill: "Defence", label: "Defence", detail: "Blocks, drives and defensive positioning" },
  { skill: "Doubles", label: "Doubles play", detail: "Rotation, positioning and partner play" },
  { skill: "Fitness", label: "Strength & conditioning", detail: "Off-court strength, power and stamina" },
] as const;
export type SkillKey = (typeof SKILL_GROUPS)[number]["skill"] | "Other";
const OTHER = { skill: "Other" as const, label: "Other training", detail: "Activities without a recorded skill" };

export type AttendanceStatus = "PRESENT" | "ABSENT" | "EXCUSED" | "NOT_MARKED" | "UNKNOWN";
export const ATTENDANCE_TEXT: Readonly<Record<AttendanceStatus, string>> = {
  PRESENT: "Present",
  ABSENT: "Absent",
  EXCUSED: "Excused",
  NOT_MARKED: "Not marked",
  UNKNOWN: "Not recorded",
};
export const STATUS_TEXT: Readonly<Record<string, string>> = {
  DRAFT: "Draft · not shared",
  IN_REVIEW: "In review",
  APPROVED: "Approved · not yet shared",
  PUBLISHED: "Published",
  WITHDRAWN: "Withdrawn",
};

export type SheetSession = {
  id: string;
  title: string;
  date: string;
  attendance: AttendanceStatus;
  activities: { title: string; status: "completed" | "modified"; skill: SkillKey }[];
  observations: string[];
};
export type SheetPractice = {
  skill: SkillKey;
  label: string;
  detail: string;
  /** Distinct activity titles recorded for this skill, with how many times each was recorded. */
  activities: { title: string; times: number }[];
  sessions: number;
};
/**
 * "Progress against the period before", drawn from the analysis snapshotted when the draft was made (so it is covered by the
 * report's approval and version protection). It states counts and differences only: never "improved", "struggled" or a score.
 * Everything the records did not contain is listed in `notRecorded` instead of being left out silently.
 */
export type SheetProgress = {
  periodLabel: string;
  previousLabel: string;
  /** False when no session was recorded in the period before, so there are no "before" figures. */
  hasPrevious: boolean;
  attendance: { now: string; before: string | null; change: string | null };
  /** Minutes of recorded practice by area, only the areas with any minutes in either period. */
  practice: { label: string; now: number; before: number | null }[];
  practiceTotal: { now: number; before: number | null };
  /** Reviewed observations per category in this period, only categories with at least one. */
  observationCounts: { label: string; count: number }[];
  notRecorded: string[];
};
export type ReportSheet = {
  academy: string;
  title: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  player: { name: string; initials: string; group: string | null };
  stats: {
    sessions: number;
    attended: number;
    absent: number;
    excused: number;
    notMarked: number;
    /** Sessions whose attendance the academy never recorded (older reports, or sessions left unmarked). */
    unrecorded: number;
    /** attended / sessions with a recorded status; null when nothing was recorded. */
    percent: number | null;
    activities: number;
    skillAreas: number;
    observations: number;
  };
  sessions: SheetSession[];
  practised: SheetPractice[];
  /** Reviewed observations only (the coach approved each wording). `category` is null for an observation with no category. */
  observations: { text: string; date: string; title: string; category: string | null }[];
  /** Comparison with the period before, in numbers; null for a report written before the comparison existed. */
  progress: SheetProgress | null;
  feedback: { summary: string; strengths: string; improvements: string; priorities: string[]; closingNote: string };
  status: string;
  statusLabel: string;
  revision: number;
  reviewer: string | null;
  approvedOn: string | null;
  generatedOn: string;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const parts = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
};
/** "2026-10-03" -> "3 Oct 2026". Text only, no timezone arithmetic. */
export function dayLabel(iso: string) {
  const p = parts(iso);
  return p ? `${p.d} ${MONTHS[p.m - 1].slice(0, 3)} ${p.y}` : iso;
}
/** A whole calendar month reads "October 2026"; any other period reads "3 Oct 2026 – 19 Oct 2026". */
export function periodLabel(start: string, end: string) {
  const a = parts(start);
  const b = parts(end);
  if (!a || !b) return `${start} – ${end}`;
  const last = new Date(Date.UTC(a.y, a.m, 0)).getUTCDate();
  if (a.y === b.y && a.m === b.m && a.d === 1 && b.d === last) return `${MONTHS[a.m - 1]} ${a.y}`;
  return `${dayLabel(start)} – ${dayLabel(end)}`;
}
export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

/** Trimmed, non-empty, de-duplicated (ignoring case), at most 5 priorities of at most 80 characters. */
export function cleanPriorities(list: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list ?? []) {
    const v = raw.replace(/\s+/g, " ").trim().slice(0, REPORT_LIMITS.priority);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
    if (out.length === REPORT_LIMITS.priorities) break;
  }
  return out;
}

const skillOf = (value: string | null | undefined): SkillKey =>
  SKILL_GROUPS.find((g) => g.skill === value)?.skill ?? "Other";
const LEGACY = /^(.*) \((completed|modified)\)$/;

function sessionsOf(
  data: ReportData,
  live?: { attendance?: (sessionId: string) => string | undefined },
): SheetSession[] {
  // Older drafts were snapshotted in database order; the sheet always lists sessions chronologically (a stable sort).
  return [...data.evidence].sort((x, y) => x.date.localeCompare(y.date)).map((e) => {
    const activities = e.practised
      ? e.practised.map((a) => ({
          title: a.title,
          status: (a.status === "MODIFIED" ? "modified" : "completed") as "completed" | "modified",
          skill: skillOf(a.skill),
        }))
      : e.activities.map((text) => {
          const m = LEGACY.exec(text);
          return {
            title: m ? m[1] : text,
            status: (m?.[2] === "modified" ? "modified" : "completed") as "completed" | "modified",
            skill: "Other" as SkillKey,
          };
        });
    const known = e.attendance ?? live?.attendance?.(e.sessionId);
    // An older report has no attendance snapshot; an activity recorded for the player proves they were present.
    const attendance: AttendanceStatus =
      known === "PRESENT" || known === "ABSENT" || known === "EXCUSED" || known === "NOT_MARKED"
        ? known
        : e.activities.length
          ? "PRESENT"
          : "UNKNOWN";
    return { id: e.sessionId, title: e.title, date: e.date, attendance, activities, observations: e.observations };
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capital = (t: string) => t[0].toUpperCase() + t.slice(1);
/** Attended of all, with the percentage of RECORDED sessions (the same rule as the headline attendance figure). */
function attendanceOf(p: PeriodStats) {
  const recorded = p.present + p.absent + p.excused;
  const percent = recorded ? Math.round((p.present * 100) / recorded) : null;
  return { percent, text: `${p.present} of ${plural(p.sessions, "session")}${percent === null ? " (attendance not recorded)" : ` (${percent}%)`}` };
}
function buildProgress(data: ReportData): SheetProgress | null {
  const a = data.analysis;
  if (!a) return null;
  const cur = a.current;
  const prev = a.previous;
  const range = previousRange(cur.periodStart, cur.periodEnd);
  const now = attendanceOf(cur);
  const before = prev ? attendanceOf(prev) : null;
  let change: string | null = null;
  if (before && now.percent !== null && before.percent !== null) {
    const d = now.percent - before.percent;
    change = d === 0 ? "the same attendance rate" : `${Math.abs(d)} percentage point${Math.abs(d) === 1 ? "" : "s"} ${d > 0 ? "higher" : "lower"} than before`;
  }
  const practice = AREAS.map((k) => ({ label: AREA_LABEL[k], now: cur.minutesByArea[k], before: prev ? prev.minutesByArea[k] : null })).filter(
    (r) => r.now > 0 || (r.before ?? 0) > 0,
  );
  const total = (p: PeriodStats) => AREAS.reduce((n, k) => n + p.minutesByArea[k], 0);
  const counts = OBSERVATION_CATEGORIES.map((c) => ({ label: capital(CATEGORY_LABEL[c]), count: a.observationsByCategory[c] }));
  const previousLabel = periodLabel(range.start, range.end);
  const untagged = a.observationsByCategory.UNTAGGED;
  const notRecorded: string[] = [];
  if (!prev) notRecorded.push(`No sessions were recorded in the period before (${previousLabel}), so there is nothing to compare with.`);
  if (cur.unmarked)
    notRecorded.push(
      `Attendance was not marked for ${plural(cur.unmarked, "session")} in this period; ${cur.unmarked === 1 ? "it is left out of the attendance percentage and adds" : "they are left out of the attendance percentage and add"} no practice time.`,
    );
  if (prev?.unmarked) notRecorded.push(`Attendance was not marked for ${plural(prev.unmarked, "session")} in the period before.`);
  if (!total(cur)) notRecorded.push("No practice time was recorded for this player in this period.");
  const missing = counts.filter((c) => !c.count).map((c) => c.label.toLowerCase());
  if (missing.length) notRecorded.push(`No reviewed observation is recorded for: ${missing.join(", ")}.`);
  if (untagged)
    notRecorded.push(`${plural(untagged, "reviewed observation")} ${untagged === 1 ? "has" : "have"} no category and ${untagged === 1 ? "is" : "are"} not counted in an area.`);
  return {
    periodLabel: periodLabel(cur.periodStart, cur.periodEnd),
    previousLabel,
    hasPrevious: !!prev,
    attendance: { now: now.text, before: before ? before.text : null, change },
    practice,
    practiceTotal: { now: total(cur), before: prev ? total(prev) : null },
    observationCounts: counts.filter((c) => c.count),
    notRecorded,
  };
}

export function buildReportSheet(
  data: ReportData,
  meta: { status: string; version: number; generatedOn: string },
  live?: { attendance?: (sessionId: string) => string | undefined },
): ReportSheet {
  const sessions = sessionsOf(data, live);
  const count = (s: AttendanceStatus) => sessions.filter((x) => x.attendance === s).length;
  const attended = count("PRESENT");
  const absent = count("ABSENT");
  const excused = count("EXCUSED");
  const recorded = attended + absent + excused;
  const notMarked = count("NOT_MARKED");
  // Activities only count for a session the player attended (the evidence already holds none otherwise).
  const attendedSessions = sessions.filter((s) => s.attendance === "PRESENT");
  const practised: SheetPractice[] = [...SKILL_GROUPS, OTHER]
    .map((g) => {
      const items = attendedSessions.flatMap((s) => s.activities.filter((a) => a.skill === g.skill).map((a) => ({ a, s })));
      const byTitle = new Map<string, number>();
      for (const { a } of items) byTitle.set(a.title, (byTitle.get(a.title) ?? 0) + 1);
      return {
        skill: g.skill as SkillKey,
        label: g.label,
        detail: g.detail,
        activities: [...byTitle].map(([title, times]) => ({ title, times })),
        sessions: new Set(items.map((i) => i.s.id)).size,
      };
    })
    .filter((g) => g.activities.length);
  const observations = data.evidence.flatMap((e) =>
    e.observations.map((text, i) => {
      const detail = e.observationDetails?.[i];
      const label = detail && detail.text === text && detail.category ? CATEGORY_LABEL[detail.category] : null;
      return { text, date: e.date, title: e.title, category: label ? label[0].toUpperCase() + label.slice(1) : null };
    }),
  );
  return {
    academy: data.academyName,
    title: data.title,
    periodLabel: periodLabel(data.periodStart, data.periodEnd),
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
    player: { name: data.playerName, initials: initialsOf(data.playerName), group: data.group ?? null },
    stats: {
      sessions: sessions.length,
      attended,
      absent,
      excused,
      notMarked,
      unrecorded: count("UNKNOWN") + notMarked,
      percent: recorded ? Math.round((attended * 100) / recorded) : null,
      activities: attendedSessions.reduce((n, s) => n + s.activities.length, 0),
      skillAreas: practised.length,
      observations: observations.length,
    },
    sessions,
    practised,
    observations,
    progress: buildProgress(data),
    feedback: {
      summary: data.summary ?? "",
      strengths: data.strengths ?? "",
      improvements: data.improvements ?? "",
      priorities: cleanPriorities(data.priorities),
      closingNote: data.closingNote ?? "",
    },
    status: meta.status,
    statusLabel: STATUS_TEXT[meta.status] ?? meta.status,
    revision: meta.version,
    reviewer: data.reviewer,
    approvedOn: data.approvedAt ? data.approvedAt.slice(0, 10) : null,
    generatedOn: meta.generatedOn,
  };
}

/** "5 of 6 sessions · 83%": the same sentence on the screen and in the PDF. */
export function attendanceLine(s: ReportSheet) {
  const { attended, sessions, percent } = s.stats;
  return percent === null
    ? `${attended} of ${sessions} sessions · attendance not recorded`
    : `${attended} of ${sessions} sessions · ${percent}%`;
}
/** Why the attendance figure may be incomplete, or null when every session has a recorded status. */
export function attendanceCaveat(s: ReportSheet) {
  const n = s.stats.unrecorded;
  return n
    ? `Attendance was not recorded for ${n} of ${s.stats.sessions} session${s.stats.sessions === 1 ? "" : "s"}; the percentage covers recorded sessions only.`
    : null;
}

/** The report as plain lines (the PDF's text fallback and the basis of the "preview equals PDF" check). */
export function sheetLines(s: ReportSheet): string[] {
  const out = [
    `Player: ${s.player.name}${s.player.group ? ` (${s.player.group})` : ""}`,
    `Period: ${s.periodLabel}`,
    `Status: ${s.status} | Revision ${s.revision}`,
    `Reviewed by: ${s.reviewer ?? "Not approved"}`,
    `Attendance: ${attendanceLine(s)}`,
    `Training activities completed: ${s.stats.activities}`,
    `Skill areas practised: ${s.stats.skillAreas}`,
  ];
  const caveat = attendanceCaveat(s);
  if (caveat) out.push(caveat);
  out.push("What the player practised:");
  if (!s.practised.length) out.push("No training activity was recorded for this player in this period.");
  for (const g of s.practised)
    out.push(`${g.label}: ${g.activities.map((a) => (a.times > 1 ? `${a.title} x${a.times}` : a.title)).join(", ")}`);
  const g = s.progress;
  if (g) {
    out.push(`Progress compared with the period before (${g.previousLabel}):`);
    out.push(`Attendance: ${g.attendance.now}${g.attendance.before ? `; before: ${g.attendance.before}` : ""}${g.attendance.change ? `; ${g.attendance.change}` : ""}`);
    if (g.practice.length)
      out.push(
        `Practice time by area: ${g.practice.map((r) => `${r.label} ${r.now} min${r.before === null ? "" : ` (before: ${r.before})`}`).join(", ")}; total ${g.practiceTotal.now} min${g.practiceTotal.before === null ? "" : ` (before: ${g.practiceTotal.before})`}`,
      );
    if (g.observationCounts.length) out.push(`Reviewed observations by area: ${g.observationCounts.map((c) => `${c.label} ${c.count}`).join(", ")}`);
    for (const n of g.notRecorded) out.push(`Not recorded: ${n}`);
  }
  out.push("Coach feedback:");
  out.push(`Monthly summary: ${s.feedback.summary || "No coach summary recorded."}`);
  if (s.feedback.strengths) out.push(`Strengths: ${s.feedback.strengths}`);
  if (s.feedback.improvements) out.push(`Areas to improve: ${s.feedback.improvements}`);
  if (s.feedback.priorities.length) out.push(`Next month's priorities: ${s.feedback.priorities.join("; ")}`);
  if (s.feedback.closingNote) out.push(`Coach's closing note: ${s.feedback.closingNote}`);
  for (const o of s.observations) out.push(`Reviewed observation (${o.date})${o.category ? ` - ${o.category}` : ""}: ${o.text}`);
  out.push("Recorded sessions:");
  for (const e of s.sessions) out.push(`${e.date} - ${e.title} - ${ATTENDANCE_TEXT[e.attendance]}`);
  return out;
}
