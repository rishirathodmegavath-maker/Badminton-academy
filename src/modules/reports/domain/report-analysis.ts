/**
 * Report analysis and triggers, pure. No database, no clock, no I/O.
 *
 *  - `analyse`      attendance, practice time by area and reviewed-observation counts for a period AND for the period before
 *                   it, so a report can show numbers side by side. It states counts and differences only. It never says a
 *                   player "improved" or "struggled": that is a judgement, and judgements are written by the coach.
 *  - `reportWarnings`  what is missing from a draft (no earlier period to compare with, no reviewed observation in an area...).
 *  - `computeDue`   which drafts are due under the academy's policy (monthly, and after N completed sessions). Automated
 *                   preparation only ever makes DRAFTS from this list, never an approval and never a delivery.
 *
 * Practice-area mapping (drill skill → area) is a documented convention for grouping practice TIME, not an assessment:
 * Technical = Overhead, Net play, Serve & return; Tactical = Doubles, Defence; Physical = Movement, Fitness; anything else
 * (including an activity with no recorded skill) = Other.
 */
export type Area = "TECHNICAL" | "TACTICAL" | "PHYSICAL" | "OTHER";
export const AREAS: readonly Area[] = ["TECHNICAL", "TACTICAL", "PHYSICAL", "OTHER"];
export const AREA_LABEL: Record<Area, string> = { TECHNICAL: "Technical", TACTICAL: "Tactical", PHYSICAL: "Physical", OTHER: "Other" };
export type ObservationCategory = "TECHNICAL" | "TACTICAL" | "PHYSICAL" | "BEHAVIOUR";
export const OBSERVATION_CATEGORIES: readonly ObservationCategory[] = ["TECHNICAL", "TACTICAL", "PHYSICAL", "BEHAVIOUR"];
export const CATEGORY_LABEL: Record<ObservationCategory | "UNTAGGED", string> = {
  TECHNICAL: "technical",
  TACTICAL: "tactical",
  PHYSICAL: "physical",
  BEHAVIOUR: "behaviour and discipline",
  UNTAGGED: "untagged",
};
export const SKILL_AREA: Readonly<Record<string, Area>> = {
  Overhead: "TECHNICAL",
  "Net play": "TECHNICAL",
  "Serve & return": "TECHNICAL",
  Doubles: "TACTICAL",
  Defence: "TACTICAL",
  Movement: "PHYSICAL",
  Fitness: "PHYSICAL",
};
export const areaOf = (skill: string | null | undefined): Area => SKILL_AREA[(skill ?? "").trim()] ?? "OTHER";

export type Attendance = "PRESENT" | "ABSENT" | "EXCUSED" | "NOT_MARKED";
export type SessionFact = {
  date: string; // YYYY-MM-DD, the academy's local date
  attendance: Attendance;
  practised: { skill: string | null; minutes: number }[];
  /** The category of each REVIEWED observation about this player in this session (null = reviewed but untagged). */
  categories: (ObservationCategory | null)[];
};
export type PeriodStats = {
  periodStart: string;
  periodEnd: string;
  sessions: number;
  present: number;
  absent: number;
  excused: number;
  unmarked: number;
  /** Whole percent of sessions with a recorded status (present, absent or excused) that were attended; null when none was recorded. */
  percent: number | null;
  minutesByArea: Record<Area, number>;
};
export type ReportAnalysis = {
  current: PeriodStats;
  /** The period of the same length ending the day before; null when it had no recorded sessions. */
  previous: PeriodStats | null;
  observationsByCategory: Record<ObservationCategory | "UNTAGGED", number>;
};

const DAY = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => toDay(toMs(d) + n * DAY);
export const daysInclusive = (start: string, end: string) => Math.round((toMs(end) - toMs(start)) / DAY) + 1;
/** The period of the same length that ends the day before `start`. */
export function previousRange(start: string, end: string) {
  const length = daysInclusive(start, end);
  return { start: addDays(start, -length), end: addDays(start, -1) };
}

export function periodStats(facts: SessionFact[], start: string, end: string): PeriodStats {
  const inside = facts.filter((f) => f.date >= start && f.date <= end);
  const count = (a: Attendance) => inside.filter((f) => f.attendance === a).length;
  // The same rule as the report's headline figure: a session whose attendance was never marked is not counted for or against.
  const recorded = count("PRESENT") + count("ABSENT") + count("EXCUSED");
  const minutesByArea: Record<Area, number> = { TECHNICAL: 0, TACTICAL: 0, PHYSICAL: 0, OTHER: 0 };
  for (const f of inside)
    if (f.attendance === "PRESENT") for (const p of f.practised) minutesByArea[areaOf(p.skill)] += Math.max(0, Math.round(p.minutes));
  return {
    periodStart: start,
    periodEnd: end,
    sessions: inside.length,
    present: count("PRESENT"),
    absent: count("ABSENT"),
    excused: count("EXCUSED"),
    unmarked: count("NOT_MARKED"),
    percent: recorded ? Math.round((count("PRESENT") / recorded) * 100) : null,
    minutesByArea,
  };
}

export function analyse(facts: SessionFact[], start: string, end: string): ReportAnalysis {
  const current = periodStats(facts, start, end);
  const before = previousRange(start, end);
  const previous = periodStats(facts, before.start, before.end);
  const observationsByCategory: ReportAnalysis["observationsByCategory"] = { TECHNICAL: 0, TACTICAL: 0, PHYSICAL: 0, BEHAVIOUR: 0, UNTAGGED: 0 };
  for (const f of facts)
    if (f.date >= start && f.date <= end) for (const c of f.categories) observationsByCategory[c ?? "UNTAGGED"]++;
  return { current, previous: previous.sessions ? previous : null, observationsByCategory };
}

export type Warning = { code: string; text: string };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/**
 * What the records do NOT contain for this draft. A warning never blocks; the same gap becomes a blocking issue when the
 * academy's policy lists that category as required (see batch-rules.reportIssues). Older drafts without an analysis get none.
 */
export function reportWarnings(analysis: ReportAnalysis | undefined | null, required: readonly string[] = []): Warning[] {
  if (!analysis) return [];
  const out: Warning[] = [];
  if (!analysis.previous) out.push({ code: "NO_COMPARISON", text: "No sessions were recorded in the period before, so there is nothing to compare with." });
  for (const c of OBSERVATION_CATEGORIES)
    if (!analysis.observationsByCategory[c] && !required.includes(c))
      out.push({ code: `NO_OBSERVATION_${c}`, text: `No reviewed ${CATEGORY_LABEL[c]} observation is recorded for this period.` });
  if (analysis.observationsByCategory.UNTAGGED)
    out.push({
      code: "UNTAGGED_OBSERVATIONS",
      text: `${plural(analysis.observationsByCategory.UNTAGGED, "reviewed observation")} ${analysis.observationsByCategory.UNTAGGED === 1 ? "has" : "have"} no category, so ${analysis.observationsByCategory.UNTAGGED === 1 ? "it is" : "they are"} not counted in an area.`,
    });
  return out;
}

/** "Attendance 8 of 10 (80%), up from 6 of 10 (60%)" — numbers only; the direction is arithmetic, not a verdict. */
export function attendanceLine(a: ReportAnalysis): string {
  const c = a.current;
  const pct = (p: PeriodStats) => (p.percent === null ? "" : ` (${p.percent}%${p.unmarked ? `, of the ${p.present + p.absent + p.excused} with attendance marked` : ""})`);
  const now = `${c.present} of ${plural(c.sessions, "session")}${pct(c)}`;
  if (!a.previous || a.previous.percent === null || c.percent === null) return `Attendance ${now}.`;
  const diff = c.percent - a.previous.percent;
  const before = `${a.previous.present} of ${plural(a.previous.sessions, "session")}${pct(a.previous)}`;
  return `Attendance ${now}; the period before: ${before}${diff === 0 ? ", the same" : `, ${Math.abs(diff)} percentage points ${diff > 0 ? "higher" : "lower"} now`}.`;
}
export function practiceLine(a: ReportAnalysis): string | null {
  const total = AREAS.reduce((n, k) => n + a.current.minutesByArea[k], 0);
  if (!total) return null;
  const parts = AREAS.filter((k) => a.current.minutesByArea[k]).map((k) => {
    const prev = a.previous?.minutesByArea[k];
    return `${AREA_LABEL[k].toLowerCase()} ${a.current.minutesByArea[k]} min${prev === undefined ? "" : ` (before: ${prev})`}`;
  });
  return `Practice time by area: ${parts.join(", ")}.`;
}

// ------------------------------------------------------------------------------------------------------------------
// Triggers
// ------------------------------------------------------------------------------------------------------------------
export type Policy = { monthlyEnabled: boolean; sessionsEnabled: boolean; sessionsN: number; requiredCategories: string[] };
export const DEFAULT_POLICY: Policy = { monthlyEnabled: false, sessionsEnabled: false, sessionsN: 8, requiredCategories: [] };
export type DuePlayer = {
  id: string;
  name: string;
  active: boolean;
  /** Dates of completed sessions the player was on the roster of (any attendance). */
  rosterDates: string[];
  /** Dates of completed sessions the player was recorded PRESENT at. */
  presentDates: string[];
};
export type ExistingReport = { playerId: string; periodStart: string; periodEnd: string; status: string };
export type DueDraft = { playerId: string; playerName: string; kind: "MONTHLY" | "SESSIONS"; periodStart: string; periodEnd: string; title: string };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function monthBefore(today: string) {
  const [y, m] = today.split("-").map(Number);
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, "0");
  return { start: `${year}-${p(month)}-01`, end: `${year}-${p(month)}-${p(last)}`, title: `${MONTHS[month - 1]} ${year} report` };
}
const overlaps = (aStart: string, aEnd: string, bStart: string, bEnd: string) => aStart <= bEnd && bStart <= aEnd;

/**
 * The drafts due today. Rules, in one place:
 *  - A withdrawn report does not count; every other report (draft, in review, approved, published) is history to preserve.
 *  - A draft is never due for a period that overlaps an existing report of the same player, so nothing is duplicated and no
 *    approved report is ever replaced.
 *  - MONTHLY: the whole previous calendar month, for an active player who was on the roster of at least one completed session in it.
 *  - SESSIONS: after N completed sessions the player was PRESENT at, counted from the day after the player's latest report
 *    (or from the beginning). The period runs from the first of those sessions to the day of the Nth (all sessions on that day).
 */
export function computeDue(input: { today: string; policy: Policy; players: DuePlayer[]; reports: ExistingReport[] }): DueDraft[] {
  const out: DueDraft[] = [];
  const month = monthBefore(input.today);
  for (const p of input.players) {
    if (!p.active) continue;
    const mine = input.reports.filter((r) => r.playerId === p.id && r.status !== "WITHDRAWN");
    const taken = (s: string, e: string) => mine.some((r) => overlaps(s, e, r.periodStart, r.periodEnd));
    if (input.policy.monthlyEnabled && p.rosterDates.some((d) => d >= month.start && d <= month.end) && !taken(month.start, month.end))
      out.push({ playerId: p.id, playerName: p.name, kind: "MONTHLY", periodStart: month.start, periodEnd: month.end, title: month.title });
    if (input.policy.sessionsEnabled) {
      const lastEnd = mine.reduce((m, r) => (r.periodEnd > m ? r.periodEnd : m), "");
      const after = [...new Set(p.presentDates)].sort().filter((d) => d > lastEnd);
      const all = p.presentDates.filter((d) => d > lastEnd).sort();
      if (all.length >= input.policy.sessionsN) {
        const nth = all[input.policy.sessionsN - 1];
        const start = after[0];
        if (!taken(start, nth) && !out.some((d) => d.playerId === p.id && overlaps(d.periodStart, d.periodEnd, start, nth)))
          out.push({
            playerId: p.id,
            playerName: p.name,
            kind: "SESSIONS",
            periodStart: start,
            periodEnd: nth,
            title: `After ${input.policy.sessionsN} sessions (${start} to ${nth})`,
          });
      }
    }
  }
  return out.sort((x, y) => x.playerName.localeCompare(y.playerName) || x.periodStart.localeCompare(y.periodStart));
}
