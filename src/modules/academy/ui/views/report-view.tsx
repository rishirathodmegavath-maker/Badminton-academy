"use client";
import { ReportShare } from "../sharing";
import { BatchReports } from "./batch-reports";
import { useEffect, useState } from "react";
import { FileText, Plus, X, CheckCircle2, AlertTriangle } from "lucide-react";
import type { WorkspaceProps } from "../context";
import { Tabs, Status } from "../shared";
import { formatDate } from "../labels";
import { publicationState, withdrawalOf } from "../../domain/withdrawal";
import { Pane, SearchBox, Blank, ContextNote, Toolbar } from "../workbench";
import { ReportSheetView, type ReportAudience } from "../report-sheet-view";
import { attendanceLine, practiceLine, reportWarnings } from "../../../reports/domain/report-analysis";
import {
  ATTENDANCE_TEXT,
  REPORT_LIMITS,
  attendanceCaveat,
  buildReportSheet,
  cleanPriorities,
  dayLabel,
  periodLabel,
  type ReportSheet,
} from "../../../reports/domain/report-sheet";
type Report = WorkspaceProps["data"]["reports"][number];
type Draft = { summary: string; strengths: string; improvements: string; priorities: string[]; closingNote: string };

const draftOf = (r: Report): Draft => ({
  summary: r.data.summary ?? "",
  strengths: r.data.strengths ?? "",
  improvements: r.data.improvements ?? "",
  priorities: cleanPriorities(r.data.priorities),
  closingNote: r.data.closingNote ?? "",
});
const sameDraft = (a: Draft, b: Draft) =>
  a.summary === b.summary &&
  a.strengths.trim() === b.strengths.trim() &&
  a.improvements.trim() === b.improvements.trim() &&
  a.closingNote.trim() === b.closingNote.trim() &&
  cleanPriorities(a.priorities).join("\n") === cleanPriorities(b.priorities).join("\n");
/** Where the academy logo is served (the version in the address makes a changed logo show at once), or null without one. */
const logoOf = (d: WorkspaceProps["data"]) => (d.settings.data.hasLogo ? `/api/academy/logo?v=${d.settings.version}` : null);
const reportName = (r: Report) => `${periodLabel(r.data.periodStart, r.data.periodEnd)} · ${r.data.title}`;

export function ReportsView(
  p: WorkspaceProps & {
    create: () => void;
    update: (id: string, action: string) => void;
  },
) {
  const d = p.data;
  const [query, setQuery] = useState("");
  const [reviewOnly, setReviewOnly] = useState(!!p.focusId?.startsWith("filter:review"));
  const [tab, setTab] = useState("Reports");
  const focused = d.reports.find((r) => r.id === p.focusId);
  const [playerId, setPlayerId] = useState(focused?.playerId ?? d.players[0]?.id ?? "");
  const [reportId, setReportId] = useState(focused?.id ?? "");
  const staff = d.permissions.coaching || d.permissions.ops;
  const rows = d.players.filter(
    (pl) =>
      (!p.focusId?.split("|")[1] ||
        d.batches.some((b) => b.id === pl.batchId && b.branchId === p.focusId?.split("|")[1])) &&
      pl.name.toLowerCase().includes(query.toLowerCase()) &&
      (!reviewOnly || d.reports.some((r) => r.playerId === pl.id && r.status === "IN_REVIEW")),
  );
  const player = rows.find((pl) => pl.id === playerId) ?? rows[0];
  const reports = d.reports.filter((r) => r.playerId === player?.id && (!reviewOnly || r.status === "IN_REVIEW"));
  const report = reports.find((r) => r.id === reportId) ?? reports[0];
  const unreviewed = d.sessions.flatMap((s) =>
    s.data.observations
      .filter((n) => !d.reviews.some((r) => r.observationId === n.id && r.sessionId === s.id))
      .map((n) => ({ ...n, sessionId: s.id, sessionTitle: s.data.title })),
  );

  /** Step 1: which player and which month. Shared by the coach's workflow and the family's read-only view. */
  const selector = (
    <>
      {rows.length > 6 && (
        <SearchBox label="Search report players" placeholder="Search players…" value={query} onChange={setQuery} />
      )}
      <div className="rs-select-row">
        <label>
          Player
          <select
            aria-label="Player"
            value={player?.id ?? ""}
            onChange={(e) => {
              setPlayerId(e.target.value);
              setReportId("");
            }}
          >
            {rows.length === 0 && <option value="">No players match</option>}
            {rows.map((pl) => (
              <option key={pl.id} value={pl.id}>
                {pl.name}
                {d.batches.find((b) => b.id === pl.batchId) ? ` (${d.batches.find((b) => b.id === pl.batchId)!.name})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reporting month
          <select
            aria-label="Reporting month"
            value={report?.id ?? ""}
            disabled={!reports.length}
            onChange={(e) => setReportId(e.target.value)}
          >
            {!reports.length && <option value="">No report yet</option>}
            {reports.map((r) => (
              <option key={r.id} value={r.id}>
                {reportName(r)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );

  return (
    <div className="reference-view">
      <Toolbar>
        {staff && (
          <label className="wb-check">
            <input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} /> Awaiting review only
          </label>
        )}
        <Tabs
          items={["Reports", ...(d.permissions.coaching ? ["Batch reports"] : []), ...(d.permissions.coaching ? ["Evidence review"] : [])]}
          value={tab}
          onChange={setTab}
        />
        {d.permissions.coaching && (
          <button className="primary" onClick={p.create}>
            ＋ Create report
          </button>
        )}
      </Toolbar>
      {tab === "Batch reports" && d.permissions.coaching ? (
        <BatchReports
          {...p}
          openReport={(id) => {
            const r = d.reports.find((x) => x.id === id);
            if (r) setPlayerId(r.playerId);
            setReportId(id);
            setReviewOnly(false);
            setTab("Reports");
          }}
        />
      ) : tab === "Evidence review" ? (
        <div className="wb-evidence-grid">
          {unreviewed.map((n) => (
            <Pane key={n.id} title={d.players.find((pl) => pl.id === n.playerId)?.name ?? "Historical roster player"}>
              <p>
                {n.sessionTitle} · {n.at.slice(0, 10)}
              </p>
              <blockquote>{n.text}</blockquote>
              <Status value="PRIVATE_DRAFT" />
              <button
                className="secondary"
                onClick={() =>
                  p.open({
                    title: "Review observation for reporting",
                    initial: { approvedText: n.text, category: "" },
                    fields: [
                      {
                        name: "approvedText",
                        label: "Reviewed wording for report evidence",
                        kind: "textarea",
                        required: true,
                        max: 2000,
                      },
                      {
                        name: "category",
                        label: "Which area is this about? (optional)",
                        kind: "select",
                        options: [
                          { value: "", label: "Not tagged" },
                          { value: "TECHNICAL", label: "Technical" },
                          { value: "TACTICAL", label: "Tactical" },
                          { value: "PHYSICAL", label: "Physical" },
                          { value: "BEHAVIOUR", label: "Behaviour and discipline" },
                        ],
                        help: "Used only to count what the records hold for each area. Untagged notes are still kept.",
                      },
                    ],
                    notice:
                      "The original private note is preserved. Only this explicitly reviewed wording is used in future report drafts.",
                    submit: (v) =>
                      p.mutate("/reports/review", {
                        sessionId: n.sessionId,
                        observationId: n.id,
                        approvedText: String(v.approvedText),
                        category: String(v.category ?? "") || null,
                      }),
                  })
                }
              >
                Review wording
              </button>
            </Pane>
          ))}
          {!unreviewed.length && (
            <Pane>
              <Blank
                title="No private observations awaiting review"
                text="Record contextual evidence in Training. Missing observations are not poor performance."
              />
            </Pane>
          )}
        </div>
      ) : report && staff ? (
        <ReportStudio
          key={`${report.id}:${report.version}`}
          {...p}
          report={report}
          selector={selector}
          onReviewEvidence={() => setTab("Evidence review")}
        />
      ) : report ? (
        <FamilyReport key={`${report.id}:${report.version}`} {...p} report={report} selector={selector} />
      ) : (
        <div className="report-studio">
          <div className="rs-left">
            <Step n={1} title="Select player and month">
              {selector}
            </Step>
          </div>
          <Pane title="Live report preview" className="rs-preview">
            <Blank
              title={player ? `No report for ${player.name}` : "Select a player"}
              text="Create an evidence-based draft from completed sessions and reviewed observations. No invented progress or scores are inserted."
              icon={FileText}
            />
          </Pane>
        </div>
      )}
    </div>
  );
}

function Step({ n, title, children, hint }: { n: number; title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="wb-pane rs-step" aria-labelledby={`rs-step-${n}`}>
      <header className="wb-pane-heading">
        <h2 id={`rs-step-${n}`}>
          <span className="rs-step-no" aria-hidden="true">
            {n}
          </span>
          {title}
        </h2>
      </header>
      <div className="wb-pane-content">
        {hint && <p className="muted">{hint}</p>}
        {children}
      </div>
    </section>
  );
}

/** Families and players: the published report exactly as shared, plus the private PDF. No editing, no coach view. */
function FamilyReport(p: WorkspaceProps & { report: Report; selector: React.ReactNode }) {
  const r = p.report;
  const sheet = buildReportSheet(r.data, { status: r.status, version: r.version, generatedOn: p.data.currentDate });
  return (
    <div className="report-studio rs-family">
      <div className="rs-left">
        <section className="wb-pane rs-step">
          <header className="wb-pane-heading">
            <h2>Choose a report</h2>
          </header>
          <div className="wb-pane-content">
            {p.selector}
            <div className="wb-stacked-actions">
              <a className="secondary" href={`/api/academy/reports/${r.id}/pdf`} target="_blank" rel="noreferrer">
                Download PDF
              </a>
            </div>
            <ContextNote>You can see published revisions only. Nothing is sent to you when a report is published.</ContextNote>
          </div>
        </section>
      </div>
      <Pane title="Report" className="rs-preview">
        <ReportSheetView sheet={sheet} audience="player" logo={logoOf(p.data)} />
      </Pane>
    </div>
  );
}

/**
 * The coach's workflow. The four numbered steps edit a DRAFT held in this component; the preview on the right is built
 * from that draft on every keystroke, so it always shows what saving would produce. Saving, submitting and approving
 * are the existing server actions: every one is re-authorised on the server, and the buttons here only reflect what
 * the server already told this screen the person may do.
 */
function ReportStudio(
  p: WorkspaceProps & {
    report: Report;
    selector: React.ReactNode;
    update: (id: string, action: string) => void;
    onReviewEvidence: () => void;
  },
) {
  const d = p.data;
  const r = p.report;
  const editable = r.status === "DRAFT" && d.permissions.coaching;
  const stored = draftOf(r);
  const [draft, setDraft] = useState<Draft>(stored);
  const [entry, setEntry] = useState("");
  const [entryHint, setEntryHint] = useState("");
  const [audience, setAudience] = useState<ReportAudience>("player");
  const [reviewed, setReviewed] = useState(false);
  /** Phone and tablet: one panel at a time, switched here. On a wide screen both are always shown. */
  const [mobile, setMobile] = useState<"edit" | "preview">("edit");
  const live = editable ? draft : stored;
  const dirty = editable && !sameDraft(draft, stored);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const sheet = buildReportSheet(
    { ...r.data, ...live, priorities: live.priorities },
    { status: r.status, version: r.version, generatedOn: d.currentDate },
    { attendance: (id) => d.sessions.find((s) => s.id === id)?.data.attendance[r.playerId] },
  );
  const pending = d.sessions
    .filter((s) => s.data.localDate >= r.data.periodStart && s.data.localDate <= r.data.periodEnd)
    .flatMap((s) =>
      s.data.observations.filter(
        (n) => n.playerId === r.playerId && !d.reviews.some((v) => v.sessionId === s.id && v.observationId === n.id),
      ),
    ).length;

  const reportState = publicationState(
    d.versions.filter((v) => v.entityId === r.id),
    "report",
  );
  const familyLive = r.status === "PUBLISHED" ? null : reportState.live;

  /** Runs the named server actions in order; each bumps the revision by one, and the first refusal stops the chain. */
  async function advance(actions: ("save" | "submit" | "approve")[]) {
    let version = r.version;
    for (const action of actions) {
      const ok = await p.mutate("/reports/update", {
        id: r.id,
        version,
        action,
        summary: live.summary,
        reason: "",
        ...(action === "save"
          ? {
              strengths: draft.strengths,
              improvements: draft.improvements,
              priorities: cleanPriorities(draft.priorities),
              closingNote: draft.closingNote,
            }
          : {}),
      });
      if (!ok) return false;
      version += 1;
    }
    return true;
  }
  function addPriority() {
    const before = draft.priorities.length;
    const next = cleanPriorities([...draft.priorities, entry]);
    if (!entry.trim()) return;
    if (before >= REPORT_LIMITS.priorities) setEntryHint(`A report holds at most ${REPORT_LIMITS.priorities} priorities.`);
    else if (next.length === before) setEntryHint("That priority is already listed.");
    else {
      setDraft({ ...draft, priorities: next });
      setEntry("");
      setEntryHint("");
    }
  }
  const counter = (value: string, max: number, id: string) => (
    <small id={id} className="rs-count">
      {value.length}/{max}
    </small>
  );
  const ro = !editable;

  return (
    <div className="report-studio" data-mobile={mobile}>
      <div className="rs-mobile-switch" role="group" aria-label="Show">
        {(["edit", "preview"] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mobile === m} className={mobile === m ? "active" : ""} onClick={() => setMobile(m)}>
            {m === "edit" ? "Edit report" : "Preview report"}
            {m === "edit" && dirty ? " •" : ""}
          </button>
        ))}
      </div>
      <div className="rs-left">
        <Step n={1} title="Select player and month">
          {p.selector}
          <p className="rs-ready" role="status">
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>
              <strong>{r.status === "DRAFT" ? "Report draft ready" : `Report ${sheet.statusLabel.toLowerCase()}`}</strong>
              <small>
                {sheet.stats.sessions} session{sheet.stats.sessions === 1 ? "" : "s"} completed · {sheet.stats.attended} attended
              </small>
            </span>
            <span className="muted">Revision {r.version}</span>
          </p>
        </Step>

        <Step n={2} title="Review training evidence">
          <dl className="rs-evidence-stats">
            <div>
              <dt>Sessions</dt>
              <dd>{sheet.stats.sessions}</dd>
            </div>
            <div>
              <dt>Attended</dt>
              <dd>
                {sheet.stats.attended}
                <small>{sheet.stats.percent === null ? "not recorded" : `${sheet.stats.percent}% attendance`}</small>
              </dd>
            </div>
            <div>
              <dt>Activities</dt>
              <dd>
                {sheet.stats.activities}
                <small>
                  {sheet.stats.skillAreas} skill area{sheet.stats.skillAreas === 1 ? "" : "s"}
                </small>
              </dd>
            </div>
            <div>
              <dt>Reviewed notes</dt>
              <dd>
                {sheet.stats.observations}
                <small>in this report</small>
              </dd>
            </div>
          </dl>
          {attendanceCaveat(sheet) && <p className="rs-note">{attendanceCaveat(sheet)}</p>}
          {r.data.analysis && (
            <div className="rs-analysis" data-testid="report-analysis">
              <strong>From the records</strong>
              <p>{attendanceLine(r.data.analysis)}</p>
              {practiceLine(r.data.analysis) && <p>{practiceLine(r.data.analysis)}</p>}
              {reportWarnings(r.data.analysis).length > 0 && (
                <details>
                  <summary>Not in the records ({reportWarnings(r.data.analysis).length})</summary>
                  <ul>
                    {reportWarnings(r.data.analysis).map((w) => (
                      <li key={w.code}>{w.text}</li>
                    ))}
                  </ul>
                </details>
              )}
              <small className="muted">Counts only. Nothing here says a player improved or struggled: that is for you to write.</small>
            </div>
          )}
          {pending > 0 && (
            <p className="rs-note rs-warn">
              <AlertTriangle size={15} aria-hidden="true" /> {pending} private observation{pending === 1 ? " is" : "s are"} not
              reviewed yet, so {pending === 1 ? "it is" : "they are"} not in this report.{" "}
              {d.permissions.coaching && (
                <button type="button" className="text-button" onClick={p.onReviewEvidence}>
                  Review wording
                </button>
              )}
            </p>
          )}
          <div className="rs-table-wrap">
            <table className="rs-table">
              <caption className="sr-only">Recorded sessions in this report</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Session focus</th>
                  <th scope="col">Attendance</th>
                  <th scope="col">Reviewed coach notes</th>
                </tr>
              </thead>
              <tbody>
                {sheet.sessions.map((s) => (
                  <tr key={s.id}>
                    <td data-label="Date">{dayLabel(s.date)}</td>
                    <td data-label="Session focus">{s.title}</td>
                    <td data-label="Attendance">
                      <span className={`rs-att rs-att-${s.attendance.toLowerCase()}`}>{ATTENDANCE_TEXT[s.attendance]}</span>
                    </td>
                    <td data-label="Reviewed coach notes">{s.observations.join(" · ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Step>

        <Step
          n={3}
          title="Coach feedback"
          hint={
            ro
              ? "This report is no longer a draft, so its feedback is read-only. Create a revision to change it."
              : "Written by you for the player and family. Nothing here is generated or scored."
          }
        >
          <label className="rs-field">
            <span>Coach report summary</span>
            <small>Overall progress this month</small>
            <textarea
              id="report-summary"
              aria-label="Coach report summary"
              aria-describedby="rs-summary-count"
              value={live.summary}
              readOnly={ro}
              maxLength={REPORT_LIMITS.summary}
              rows={4}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            />
            {counter(live.summary, REPORT_LIMITS.summary, "rs-summary-count")}
            {!ro && r.data.facts && !live.summary.trim() && (
              <span className="rs-facts">
                <small>From the records: {r.data.facts}</small>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setDraft({ ...draft, summary: (r.data.facts ?? "").slice(0, REPORT_LIMITS.summary) })}
                >
                  Use this as the summary
                </button>
              </span>
            )}
          </label>
          <label className="rs-field">
            <span>Strengths shown</span>
            <textarea
              aria-describedby="rs-strengths-count"
              value={live.strengths}
              readOnly={ro}
              maxLength={REPORT_LIMITS.strengths}
              rows={3}
              onChange={(e) => setDraft({ ...draft, strengths: e.target.value })}
            />
            {counter(live.strengths, REPORT_LIMITS.strengths, "rs-strengths-count")}
          </label>
          <label className="rs-field">
            <span>Areas to improve</span>
            <textarea
              aria-describedby="rs-improve-count"
              value={live.improvements}
              readOnly={ro}
              maxLength={REPORT_LIMITS.improvements}
              rows={3}
              onChange={(e) => setDraft({ ...draft, improvements: e.target.value })}
            />
            {counter(live.improvements, REPORT_LIMITS.improvements, "rs-improve-count")}
          </label>
          <div className="rs-field" role="group" aria-labelledby="rs-priorities-label">
            <span id="rs-priorities-label">Next development priorities</span>
            <small>Up to {REPORT_LIMITS.priorities}, each a short phrase</small>
            <ul className="rs-chips" aria-label="Development priorities">
              {live.priorities.map((x) => (
                <li key={x}>
                  {x}
                  {!ro && (
                    <button
                      type="button"
                      aria-label={`Remove priority ${x}`}
                      onClick={() => setDraft({ ...draft, priorities: draft.priorities.filter((y) => y !== x) })}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  )}
                </li>
              ))}
              {!live.priorities.length && <li className="rs-chip-empty">None added</li>}
            </ul>
            {!ro && (
              <div className="rs-add">
                <input
                  aria-label="Add a development priority"
                  value={entry}
                  maxLength={REPORT_LIMITS.priority}
                  placeholder="e.g. Net play consistency"
                  onChange={(e) => {
                    setEntry(e.target.value);
                    setEntryHint("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addPriority();
                    }
                  }}
                />
                <button type="button" className="secondary" onClick={addPriority}>
                  <Plus size={14} aria-hidden="true" /> Add priority
                </button>
              </div>
            )}
            {entryHint && (
              <p className="rs-note" role="status">
                {entryHint}
              </p>
            )}
          </div>
          <label className="rs-field">
            <span>Closing note (optional)</span>
            <input
              aria-describedby="rs-closing-count"
              value={live.closingNote}
              readOnly={ro}
              maxLength={REPORT_LIMITS.closingNote}
              onChange={(e) => setDraft({ ...draft, closingNote: e.target.value })}
            />
            {counter(live.closingNote, REPORT_LIMITS.closingNote, "rs-closing-count")}
          </label>
        </Step>

        <Step n={4} title="Review and approve">
          <div className="wb-inset">
            <Status value={r.status} />
            {dirty && <span className="rs-unsaved"> · Unsaved changes</span>}
            <p className="muted">
              {r.status === "PUBLISHED"
                ? "This approved revision is available privately to authorised families."
                : familyLive
                  ? `Revision v${familyLive.version} is still available to authorised families while this revision is prepared.`
                  : r.status === "WITHDRAWN" || reportState.withdrawn
                    ? "Withdrawn: families cannot see or download this report. The history is kept."
                    : "Not shared with families until explicitly published."}
            </p>
          </div>
          {(r.status === "DRAFT" || r.status === "IN_REVIEW") && (
            <label className="checkbox">
              <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
              <span>I have reviewed the player, attendance, sessions and coaching feedback for this period.</span>
            </label>
          )}
          <div className="wb-stacked-actions rs-actions">
            {editable && (
              <button className="secondary" disabled={!dirty || p.busy} onClick={() => void advance(["save"])}>
                Save draft
              </button>
            )}
            {editable && !d.permissions.ops && (
              <button
                className="primary"
                disabled={!reviewed || p.busy}
                onClick={() => void advance(dirty ? ["save", "submit"] : ["submit"])}
              >
                Submit for review
              </button>
            )}
            {d.permissions.ops && (r.status === "DRAFT" || r.status === "IN_REVIEW") && (
              <button
                className="primary"
                disabled={!reviewed || p.busy}
                onClick={() =>
                  void advance(
                    r.status === "IN_REVIEW"
                      ? ["approve"]
                      : dirty
                        ? ["save", "submit", "approve"]
                        : ["submit", "approve"],
                  )
                }
              >
                Approve and finalise
              </button>
            )}
            {!d.permissions.ops && r.status === "IN_REVIEW" && (
              <p className="muted">Waiting for an owner, admin or head coach to approve this report.</p>
            )}
            {d.permissions.ops && r.status === "APPROVED" && (
              <button className="primary" disabled={p.busy} onClick={() => p.update(r.id, "publish")}>
                Publish approved report
              </button>
            )}
            {d.permissions.ops && ["APPROVED", "PUBLISHED", "WITHDRAWN"].includes(r.status) && (
              <button className="secondary" onClick={() => p.update(r.id, "revise")}>
                Create revision
              </button>
            )}
            {d.permissions.ops && (r.status === "PUBLISHED" || familyLive) && (
              <button className="secondary danger" disabled={p.busy} onClick={() => p.update(r.id, "withdraw")}>
                Withdraw from families
              </button>
            )}
            <a className="secondary" href={`/api/academy/reports/${r.id}/pdf`} target="_blank" rel="noreferrer">
              Preview private PDF
            </a>
          </div>
          {d.permissions.coaching && r.status === "PUBLISHED" && <ReportShare id={r.id} />}
          {d.permissions.ops && (r.status === "DRAFT" || r.status === "IN_REVIEW") && (
            <ContextNote>
              Approving finalises the wording. Sharing with families is a separate step, and no message is sent by approval or
              publication. The PDF shows the last saved revision.
            </ContextNote>
          )}
          <details className="wb-revision-list">
            <summary>Revision history</summary>
            {d.versions
              .filter((v) => v.entityId === r.id && v.kind === "report")
              .map((v) => {
                const w = withdrawalOf(v);
                return (
                  <p key={v.id}>
                    v{v.version} ·{" "}
                    {w
                      ? `withdrawn from families (v${w.withdrawnVersion} · ${w.actorRole.toLowerCase().replaceAll("_", " ")}) — ${w.reason}`
                      : (v.data as { status?: string }).status}
                    <small>{formatDate(v.createdAt)}</small>
                  </p>
                );
              })}
          </details>
        </Step>
      </div>

      <Pane
        title="Live report preview"
        className="rs-preview"
        action={
          <div className="rs-toggle" role="group" aria-label="Preview as">
            {(["player", "coach"] as const).map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={audience === a}
                className={audience === a ? "active" : ""}
                onClick={() => setAudience(a)}
              >
                {a === "player" ? "Player view" : "Coach view"}
              </button>
            ))}
          </div>
        }
      >
        <p className="muted rs-preview-hint">
          {audience === "player"
            ? "This is how the report will look to the player and their family."
            : "Coach view tags where each part comes from. Nothing in this view is shared."}
          {dirty && " Showing your unsaved changes."}
        </p>
        {audience === "coach" && <CoachChecks sheet={sheet} pending={pending} />}
        <ReportSheetView sheet={sheet} audience={audience} logo={logoOf(p.data)} />
      </Pane>
    </div>
  );
}

/** What the coach should look at before approving. Counts only: no private note text appears here or in the report. */
function CoachChecks({ sheet, pending }: { sheet: ReportSheet; pending: number }) {
  const f = sheet.feedback;
  const items: { ok: boolean; text: string }[] = [
    {
      ok: sheet.stats.unrecorded === 0,
      text:
        sheet.stats.unrecorded === 0
          ? "Attendance is recorded for every session."
          : `Attendance is not recorded for ${sheet.stats.unrecorded} session${sheet.stats.unrecorded === 1 ? "" : "s"}.`,
    },
    {
      ok: pending === 0,
      text: pending === 0 ? "No private observations are waiting for review." : `${pending} private observation${pending === 1 ? "" : "s"} excluded until reviewed.`,
    },
    { ok: !!f.summary.trim(), text: f.summary.trim() ? "Monthly summary written." : "Monthly summary is empty." },
    { ok: f.priorities.length > 0, text: f.priorities.length ? `${f.priorities.length} development priorit${f.priorities.length === 1 ? "y" : "ies"} set.` : "No development priorities set yet." },
  ];
  return (
    <ul className="rs-checks" aria-label="Coach checks">
      {items.map((i) => (
        <li key={i.text} className={i.ok ? "ok" : "warn"}>
          {i.ok ? <CheckCircle2 size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
          <span className="sr-only">{i.ok ? "Done: " : "Check: "}</span>
          {i.text}
        </li>
      ))}
    </ul>
  );
}
