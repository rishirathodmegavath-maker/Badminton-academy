/**
 * Report automation, pure rules. No database, no clock, no I/O, so the same rules can be read, tested and (later) mirrored
 * by the football app: both apps assemble a draft from RECORDED sessions and attendance only, flag a draft that is not ready,
 * and let the owner approve a batch while excluding the flagged ones.
 *
 *  - factsSummary   one factual sentence (or two) built only from the recorded evidence. It never praises, scores or infers.
 *                   It is stored beside the draft as `facts`; it only becomes the summary when the coach chooses it.
 *  - reportIssues   why a draft is NOT ready for batch approval. Every issue blocks; an empty list means ready.
 *  - previousMonth  the calendar month before a given date, as the default reporting period.
 */
import { CATEGORY_LABEL, OBSERVATION_CATEGORIES, type ReportAnalysis } from "./report-analysis";

export type EvidenceRow = {
  attendance?: "PRESENT" | "ABSENT" | "EXCUSED" | "NOT_MARKED";
  practised?: { skill: string | null }[];
};
export type DraftLike = {
  summary?: string;
  strengths?: string;
  improvements?: string;
  evidence: EvidenceRow[];
  /** Counts snapshotted when the draft was made (absent on older drafts). */
  analysis?: ReportAnalysis | null;
};
export type ReportIssueCode =
  | "NO_PRESENT_SESSION"
  | "ATTENDANCE_NOT_MARKED"
  | "SUMMARY_EMPTY"
  | "STRENGTHS_EMPTY"
  | "IMPROVEMENTS_EMPTY"
  | "CATEGORY_MISSING";
export type ReportIssue = { code: ReportIssueCode; text: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Why this draft cannot be approved in a batch. The owner can still open and approve it by hand after fixing it. */
export function reportIssues(d: DraftLike, opts: { requiredCategories?: readonly string[] } = {}): ReportIssue[] {
  const issues: ReportIssue[] = [];
  const known = d.evidence.filter((e) => e.attendance !== undefined);
  // Older drafts carry no attendance snapshot: they are not judged on attendance, only on what the coach wrote.
  if (known.length === d.evidence.length && d.evidence.length > 0 && !known.some((e) => e.attendance === "PRESENT"))
    issues.push({ code: "NO_PRESENT_SESSION", text: "Not recorded as present in any session this period." });
  const unmarked = d.evidence.filter((e) => e.attendance === "NOT_MARKED").length;
  if (unmarked)
    issues.push({
      code: "ATTENDANCE_NOT_MARKED",
      text: `Attendance is not marked for ${plural(unmarked, "session")}. Mark it first so the report is correct.`,
    });
  if (!(d.summary ?? "").trim()) issues.push({ code: "SUMMARY_EMPTY", text: "The monthly summary is empty." });
  if (!(d.strengths ?? "").trim()) issues.push({ code: "STRENGTHS_EMPTY", text: "Strengths are not written." });
  if (!(d.improvements ?? "").trim()) issues.push({ code: "IMPROVEMENTS_EMPTY", text: "Areas to improve are not written." });
  // A category the academy REQUIRES must have at least one reviewed observation; otherwise it is only a warning (report-analysis).
  for (const c of OBSERVATION_CATEGORIES)
    if ((opts.requiredCategories ?? []).includes(c) && d.analysis && !d.analysis.observationsByCategory[c])
      issues.push({ code: "CATEGORY_MISSING", text: `No reviewed ${CATEGORY_LABEL[c]} observation is recorded, and this academy requires one.` });
  return issues;
}

/** What the records show, in plain words. Counts only: no judgement is made and nothing is guessed. */
export function factsSummary(input: { playerName: string; periodStart: string; periodEnd: string; evidence: EvidenceRow[] }): string {
  const first = input.playerName.trim().split(/\s+/)[0] || "The player";
  const total = input.evidence.length;
  const count = (s: NonNullable<EvidenceRow["attendance"]>) => input.evidence.filter((e) => e.attendance === s).length;
  const present = count("PRESENT");
  const away = [count("ABSENT") && `${count("ABSENT")} absent`, count("EXCUSED") && `${count("EXCUSED")} excused`].filter(Boolean);
  let text = `${first} attended ${present} of ${plural(total, "recorded session")} between ${input.periodStart} and ${input.periodEnd}${
    away.length ? ` (${away.join(", ")})` : ""
  }.`;
  const skills = new Map<string, number>();
  for (const e of input.evidence)
    for (const p of e.practised ?? []) {
      const skill = (p.skill ?? "").trim();
      if (skill) skills.set(skill, (skills.get(skill) ?? 0) + 1);
    }
  if (skills.size)
    text += ` Skills practised: ${[...skills.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .slice(0, 6)
      .map(([skill, n]) => `${skill} (${n})`)
      .join(", ")}.`;
  return text;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** The whole calendar month before `today` (YYYY-MM-DD), with a plain title. Used as the default reporting period. */
export function previousMonth(today: string): { start: string; end: string; title: string } {
  const [y, m] = today.split("-").map(Number);
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" });
  return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(last)}`, title: `${name} ${year} report` };
}

/** The month a YYYY-MM value names: first day, last day and a plain title. */
export function monthRange(value: string): { start: string; end: string; title: string } | null {
  const hit = /^(\d{4})-(\d{2})$/.exec(value);
  if (!hit) return null;
  const year = Number(hit[1]);
  const month = Number(hit[2]);
  if (month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const name = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" });
  return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(last)}`, title: `${name} ${year} report` };
}
