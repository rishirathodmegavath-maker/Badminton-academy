"use client";
import { Activity, BookOpenText, CalendarCheck2, CheckCircle2, ClipboardList, MessageSquareText, Target, TrendingUp } from "lucide-react";
import {
  ATTENDANCE_TEXT,
  attendanceCaveat,
  attendanceLine,
  dayLabel,
  type ReportSheet,
  type SkillKey,
} from "../../reports/domain/report-sheet";
/**
 * The monthly development report as families and players see it, and as the coach sees it while writing.
 *
 * It only DRAWS a `ReportSheet` (reports/domain/report-sheet.ts): the same model the PDF is drawn from. It reads no
 * records and decides no access. In the coach audience each section carries a small tag saying where its content
 * comes from (recorded by the academy, calculated from records, or written by the coach); the player audience shows
 * the report exactly as it will be shared, with no tags and no coach-only material.
 */
export type ReportAudience = "player" | "coach";

const SOURCE: Record<"recorded" | "calculated" | "coach", string> = {
  recorded: "Recorded",
  calculated: "Calculated",
  coach: "Coach-entered",
};
function Source({ kind, show }: { kind: keyof typeof SOURCE; show: boolean }) {
  return show ? <span className={`rs-source rs-source-${kind}`}>{SOURCE[kind]}</span> : null;
}

/** Small badminton illustrations, one per recorded skill. Decorative: the label next to each carries the meaning. */
export function SkillArt({ skill }: { skill: SkillKey }) {
  const court = (
    <>
      <rect width="120" height="64" rx="6" fill="#1f7a4d" />
      <rect x="8" y="7" width="104" height="50" fill="none" stroke="#d8efe2" strokeWidth="1.4" />
      <line x1="60" y1="7" x2="60" y2="57" stroke="#d8efe2" strokeWidth="1.4" />
      <line x1="8" y1="32" x2="112" y2="32" stroke="#d8efe2" strokeWidth="0.8" strokeDasharray="3 3" />
    </>
  );
  const shuttle = (x: number, y: number, r = 0) => (
    <g transform={`translate(${x} ${y}) rotate(${r})`}>
      <circle r="3.4" fill="#fff" />
      <path d="M-3 -2 L-6 -11 M0 -3 L0 -12 M3 -2 L6 -11" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" fill="none" />
      <path d="M-6 -11 Q0 -14 6 -11" stroke="#fff" strokeWidth="1.3" fill="none" />
    </g>
  );
  const racket = (x: number, y: number, r: number) => (
    <g transform={`translate(${x} ${y}) rotate(${r})`}>
      <ellipse cx="0" cy="-9" rx="6.5" ry="9" fill="none" stroke="#fde68a" strokeWidth="1.6" />
      <path d="M-4 -9 H4 M0 -17 V-1" stroke="#fde68a" strokeWidth="0.7" />
      <line x1="0" y1="0" x2="0" y2="9" stroke="#fde68a" strokeWidth="2" strokeLinecap="round" />
    </g>
  );
  let art: React.ReactNode;
  switch (skill) {
    case "Movement":
      art = (
        <>
          <path d="M26 46 L52 22 L82 40 L98 16" stroke="#fde68a" strokeWidth="2" fill="none" strokeDasharray="4 3" strokeLinecap="round" />
          <circle cx="26" cy="46" r="3.6" fill="#fff" />
          <circle cx="52" cy="22" r="3.6" fill="#fff" />
          <circle cx="82" cy="40" r="3.6" fill="#fff" />
          <path d="M94 20 L100 14 L102 22" stroke="#fde68a" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
      break;
    case "Overhead":
      art = (
        <>
          {racket(34, 50, 28)}
          <path d="M44 34 Q70 0 98 38" stroke="#fff" strokeWidth="1.4" strokeDasharray="3 3" fill="none" />
          {shuttle(98, 40, 160)}
        </>
      );
      break;
    case "Net play":
      art = (
        <>
          <rect x="6" y="26" width="108" height="3" fill="#fff" />
          <path d="M6 29 V50 M30 29 V50 M54 29 V50 M78 29 V50 M102 29 V50" stroke="#d8efe2" strokeWidth="0.8" />
          {racket(30, 56, -20)}
          {shuttle(72, 18, 20)}
        </>
      );
      break;
    case "Serve & return":
      art = (
        <>
          {racket(28, 52, 55)}
          <path d="M42 38 Q70 14 100 36" stroke="#fff" strokeWidth="1.4" strokeDasharray="3 3" fill="none" />
          {shuttle(100, 38, 150)}
        </>
      );
      break;
    case "Defence":
      art = (
        <>
          {racket(60, 54, 0)}
          <path d="M26 20 Q42 30 52 36 M94 20 Q78 30 68 36" stroke="#fff" strokeWidth="1.4" strokeDasharray="3 3" fill="none" />
          {shuttle(24, 17, 220)}
          {shuttle(96, 17, 140)}
        </>
      );
      break;
    case "Doubles":
      art = (
        <>
          <circle cx="38" cy="22" r="6" fill="#fff" />
          <circle cx="82" cy="22" r="6" fill="#fff" />
          <circle cx="38" cy="46" r="6" fill="#fde68a" />
          <circle cx="82" cy="46" r="6" fill="#fde68a" />
          <path d="M44 25 L76 43 M76 25 L44 43" stroke="#fff" strokeWidth="1.2" strokeDasharray="3 3" />
        </>
      );
      break;
    default:
      art = shuttle(60, 40, 20);
  }
  return (
    <svg className="rs-art" viewBox="0 0 120 64" role="presentation" aria-hidden="true" focusable="false">
      {court}
      {art}
    </svg>
  );
}

export function ReportMark() {
  return (
    <svg className="rs-mark" viewBox="0 0 40 40" role="presentation" aria-hidden="true" focusable="false">
      <circle cx="20" cy="20" r="20" fill="#fff" />
      <path d="M13 31 Q20 8 29 9 Q31 20 13 31 Z" fill="#175d3a" />
      <path d="M17 27 L27 12" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const first = (name: string) => name.split(/\s+/)[0] || name;

/** The academy's own logo when it has one, otherwise the small shuttle mark. */
function Brand({ logo }: { logo?: string | null }) {
  return logo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="rs-logo" src={logo} alt="" aria-hidden="true" />
  ) : (
    <ReportMark />
  );
}

/**
 * Draws one report. The player sees it exactly as it will be shared: who, how often they came, what they practised, what
 * the coach wrote and what to work on next. The coach audience adds the source tags, the summary counts and the list of
 * recorded sessions, which are the evidence behind the report and not part of what the family receives.
 */
export function ReportSheetView({ sheet, audience, logo }: { sheet: ReportSheet; audience: ReportAudience; logo?: string | null }) {
  const coach = audience === "coach";
  const { stats, feedback: f } = sheet;
  const caveat = attendanceCaveat(sheet);
  const academy = sheet.academy || "Sportozen Academy";
  const legend: [string, number, string][] = [
    ["Present", stats.attended, "present"],
    ["Absent", stats.absent, "absent"],
    ["Excused", stats.excused, "excused"],
    ["Not marked", stats.notMarked + stats.unrecorded, "unmarked"],
  ];
  return (
    <article
      className="rs-sheet"
      aria-label={`${sheet.title}, ${sheet.player.name}, ${sheet.periodLabel}`}
      data-audience={audience}
      data-status={sheet.status}
    >
      <header className="rs-head">
        <div className="rs-brand">
          <Brand logo={logo} />
          <div>
            <strong>{academy}</strong>
            <span>{sheet.title}</span>
          </div>
        </div>
        <div className="rs-period">
          <span className="rs-pill">{sheet.periodLabel}</span>
        </div>
      </header>

      <section className="rs-player" aria-label="Player details">
        <span className="rs-avatar" aria-hidden="true">
          {sheet.player.initials || "?"}
        </span>
        <div className="rs-who">
          <h3 className="rs-name">{sheet.player.name}</h3>
          <p className="rs-meta">{sheet.player.group && <span>{sheet.player.group}</span>}</p>
          <span className={`rs-status-chip rs-status-${sheet.status.toLowerCase()}`}>{sheet.statusLabel}</span>
        </div>
        <div className="rs-attendance" aria-label="Attendance">
          <CalendarCheck2 size={24} aria-hidden="true" />
          <div>
            <strong>{stats.percent === null ? "Not recorded" : `${stats.attended} / ${stats.sessions}`}</strong>
            <span>Sessions attended</span>
            <small>{stats.percent === null ? "Attendance was not recorded" : `${stats.percent}% attendance`}</small>
          </div>
        </div>
      </section>

      <ul className="rs-legend" aria-label="Attendance this period">
        {legend.map(([text, n, kind]) => (
          <li key={kind}>
            <i className={`rs-dot rs-dot-${kind}`} aria-hidden="true" />
            {text} <b>{n}</b>
          </li>
        ))}
        <li className="rs-legend-total">
          Completed sessions <b>{stats.sessions}</b>
        </li>
      </ul>
      {caveat && <p className="rs-note rs-caveat">{caveat}</p>}

      {coach && (
        <section className="rs-section" aria-labelledby="rs-summary">
          <h4 id="rs-summary">
            <ClipboardList size={17} aria-hidden="true" /> Training summary <Source kind="calculated" show />
          </h4>
          <dl className="rs-stats">
            <div>
              <dt>Sessions conducted</dt>
              <dd>{stats.sessions}</dd>
            </div>
            <div>
              <dt>Sessions attended</dt>
              <dd>{stats.attended}</dd>
            </div>
            <div>
              <dt>Activities completed</dt>
              <dd>{stats.activities}</dd>
            </div>
            <div>
              <dt>Skill areas practised</dt>
              <dd>{stats.skillAreas}</dd>
            </div>
          </dl>
        </section>
      )}

      <section className="rs-section" aria-labelledby="rs-practised">
        <h4 id="rs-practised">
          <CheckCircle2 size={18} aria-hidden="true" /> What {first(sheet.player.name)} practised{" "}
          <Source kind="recorded" show={coach} />
        </h4>
        {sheet.practised.length ? (
          <ul className="rs-practice-grid">
            {sheet.practised.map((g) => (
              <li key={g.skill} className="rs-practice">
                <SkillArt skill={g.skill} />
                <strong>{g.label}</strong>
                <span>{g.activities.map((a) => (a.times > 1 ? `${a.title} ×${a.times}` : a.title)).join(" · ")}</span>
                <small>
                  {g.sessions} session{g.sessions === 1 ? "" : "s"}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rs-empty">No training activity was recorded for this player in this period.</p>
        )}
        {sheet.practised.length > 0 && <p className="rs-fine">Court illustrations are generic. They show the skill practised, not this player.</p>}
      </section>

      {sheet.progress && (
        <section className="rs-section" aria-labelledby="rs-progress" data-testid="rs-progress">
          <h4 id="rs-progress">
            <Activity size={18} aria-hidden="true" /> Progress compared with the period before <Source kind="calculated" show={coach} />
          </h4>
          <table className="rs-progress-table">
            <caption className="rs-sr">
              {first(sheet.player.name)}: {sheet.progress.periodLabel} compared with {sheet.progress.previousLabel}
            </caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col">{sheet.progress.periodLabel}</th>
                <th scope="col">{sheet.progress.previousLabel}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Attendance</th>
                <td>{sheet.progress.attendance.now}</td>
                <td>{sheet.progress.attendance.before ?? "No sessions recorded"}</td>
              </tr>
              {sheet.progress.practice.map((r) => (
                <tr key={r.label}>
                  <th scope="row">Practice: {r.label.toLowerCase()}</th>
                  <td>{r.now} min</td>
                  <td>{r.before === null ? "—" : `${r.before} min`}</td>
                </tr>
              ))}
              {sheet.progress.practice.length > 0 && (
                <tr>
                  <th scope="row">Practice time in total</th>
                  <td>{sheet.progress.practiceTotal.now} min</td>
                  <td>{sheet.progress.practiceTotal.before === null ? "—" : `${sheet.progress.practiceTotal.before} min`}</td>
                </tr>
              )}
            </tbody>
          </table>
          {sheet.progress.attendance.change && <p className="rs-fine">Attendance rate: {sheet.progress.attendance.change}.</p>}
          {sheet.progress.observationCounts.length > 0 && (
            <p className="rs-fine">
              Reviewed coaching observations this period: {sheet.progress.observationCounts.map((c) => `${c.label} ${c.count}`).join(" · ")}.
            </p>
          )}
          {sheet.progress.notRecorded.length > 0 && (
            <div className="rs-box rs-notrecorded">
              <h5>Not recorded in this period</h5>
              <ul>
                {sheet.progress.notRecorded.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="rs-fine">Figures come from the academy’s records. They are counts and differences only.</p>
        </section>
      )}

      <section className="rs-section" aria-labelledby="rs-feedback">
        <h4 id="rs-feedback">
          <MessageSquareText size={18} aria-hidden="true" /> Coach’s feedback <Source kind="coach" show={coach} />
        </h4>
        <p className="rs-text rs-callout">{f.summary || <span className="rs-empty">No coach summary recorded.</span>}</p>
        {(f.strengths || f.improvements || coach) && (
          <div className="rs-two">
            {(f.strengths || coach) && (
              <div className="rs-box">
                <h5>Strengths shown</h5>
                <p className="rs-text">{f.strengths || <span className="rs-empty">Not written yet.</span>}</p>
              </div>
            )}
            {(f.improvements || coach) && (
              <div className="rs-box">
                <h5>Areas to improve</h5>
                <p className="rs-text">{f.improvements || <span className="rs-empty">Not written yet.</span>}</p>
              </div>
            )}
          </div>
        )}
      </section>

      {sheet.observations.length > 0 && (
        <section className="rs-section" aria-labelledby="rs-observations">
          <h4 id="rs-observations">
            <TrendingUp size={18} aria-hidden="true" /> What the coach observed <Source kind="recorded" show={coach} />
          </h4>
          <ul className="rs-observations">
            {sheet.observations.map((o, i) => (
              <li key={i}>
                {o.text}
                <small>
                  {o.category ? `${o.category} · ` : ""}
                  {dayLabel(o.date)} · {o.title}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(f.priorities.length > 0 || coach) && (
        <section className="rs-section" aria-labelledby="rs-priorities">
          <h4 id="rs-priorities">
            <Target size={18} aria-hidden="true" /> Development focus <Source kind="coach" show={coach} />
          </h4>
          {f.priorities.length ? (
            <ol className="rs-priorities">
              {f.priorities.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ol>
          ) : (
            <p className="rs-empty">No priorities added yet.</p>
          )}
        </section>
      )}

      {(f.closingNote || coach) && (
        <section className="rs-section rs-closing" aria-labelledby="rs-closing">
          <h4 id="rs-closing">
            <BookOpenText size={18} aria-hidden="true" /> Coach’s closing note {coach && <Source kind="coach" show />}
          </h4>
          <p className="rs-text rs-callout">{f.closingNote || <span className="rs-empty">No closing note.</span>}</p>
          <p className="rs-fine">Recorded coach guidance. No video or AI assessment.</p>
        </section>
      )}

      {coach && (
        <section className="rs-section" aria-labelledby="rs-sessions">
          <h4 id="rs-sessions">
            Recorded sessions <Source kind="recorded" show />
          </h4>
          <ul className="rs-sessions">
            {sheet.sessions.map((s) => (
              <li key={s.id}>
                <span>{dayLabel(s.date)}</span>
                <span>{s.title}</span>
                <span className={`rs-att rs-att-${s.attendance.toLowerCase()}`}>{ATTENDANCE_TEXT[s.attendance]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="rs-foot">
        <span className="rs-foot-brand">
          <Brand logo={logo} />
          <span>
            <strong>{academy}</strong>
            <small>Private player development report</small>
          </span>
        </span>
        <span className="rs-foot-powered">Powered by Sportozen</span>
        <span className="rs-foot-note">
          Generated on {dayLabel(sheet.generatedOn)} ·{" "}
          {sheet.reviewer ? `Approved by ${sheet.reviewer}${sheet.approvedOn ? ` · ${dayLabel(sheet.approvedOn)}` : ""}` : "Awaiting coach approval"}
        </span>
      </footer>
    </article>
  );
}
