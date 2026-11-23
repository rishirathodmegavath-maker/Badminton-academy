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
import { CATEGORY_LABEL, OBSERVATION_CATEGORIES, practiceLine, type ReportAnalysis } from "./report-analysis";

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

type WrittenEvidence = {
  date: string;
  title: string;
  attendance?: "PRESENT" | "ABSENT" | "EXCUSED" | "NOT_MARKED";
  practised?: { title: string; skill: string | null }[];
  observationDetails?: { text: string; category: string | null }[];
};
const list = (items: string[]) => items.join("; ");
/**
 * The wording of a report written from the records alone, for the one-click batch report. Everything here is a count, a name
 * or a sentence a coach already recorded and the owner reviewed. It never praises, scores, compares players or predicts, so
 * the coach can still change any of it before the owner approves. Returns the summary, strengths and areas to improve.
 */
export function writeFromRecords(input: {
  playerName: string;
  periodStart: string;
  periodEnd: string;
  evidence: WrittenEvidence[];
  analysis?: ReportAnalysis | null;
}): { summary: string; strengths: string; improvements: string } {
  const ev = input.evidence;
  const first = input.playerName.trim().split(/\s+/)[0] || "The player";
  const summary = [
    factsSummary({ ...input, evidence: ev }),
    input.analysis ? practiceLine(input.analysis) : null,
  ]
    .filter(Boolean)
    .join(" ");

  const present = ev.filter((e) => e.attendance === "PRESENT");
  const observed = ev.flatMap((e) =>
    (e.observationDetails ?? []).map((o) => {
      const text = o.text.trim().replace(/[.\s]+$/, "");
      return o.category ? `${CATEGORY_LABEL[o.category as keyof typeof CATEGORY_LABEL] ?? o.category}: ${text}` : text;
    }),
  );
  const done = new Map<string, number>();
  for (const e of present) for (const p of e.practised ?? []) done.set(p.title, (done.get(p.title) ?? 0) + 1);
  const topDone = [...done.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 5);
  const strengthLines: string[] = [];
  strengthLines.push(
    present.length
      ? `${first} was present at ${plural(present.length, "session")} of the ${plural(ev.length, "recorded session")} this period.`
      : `${first} is not recorded as present at any session this period.`,
  );
  if (topDone.length) strengthLines.push(`Activities completed: ${list(topDone.map(([title, n]) => `${title} (${n})`))}.`);
  if (observed.length) strengthLines.push(`Coach observations recorded this period: ${list(observed.slice(0, 5))}.`);

  const absent = ev.filter((e) => e.attendance === "ABSENT");
  const excused = ev.filter((e) => e.attendance === "EXCUSED");
  const unmarked = ev.filter((e) => e.attendance === "NOT_MARKED" || e.attendance === undefined);
  const improvementLines: string[] = [];
  if (absent.length || excused.length)
    improvementLines.push(
      `Sessions missed: ${[absent.length && `${absent.length} absent (${list(absent.map((e) => e.date))})`, excused.length && `${excused.length} excused (${list(excused.map((e) => e.date))})`].filter(Boolean).join(", ")}.`,
    );
  else if (present.length) improvementLines.push("No missed sessions were recorded this period.");
  if (unmarked.length) improvementLines.push(`Attendance is not marked for ${plural(unmarked.length, "session")}.`);
  if (input.analysis) {
    const none = OBSERVATION_CATEGORIES.filter((c) => !input.analysis!.observationsByCategory[c]).map((c) => CATEGORY_LABEL[c]);
    if (none.length) improvementLines.push(`No coach observation is recorded yet for: ${none.join(", ")}.`);
  }
  return { summary, strengths: strengthLines.join(" "), improvements: improvementLines.join(" ") };
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
