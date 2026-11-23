"use client";
import { useEffect, useState } from "react";
import {
  Play,
  Pause,
  ArrowRight,
  Clock,
  Users,
  Target,
  CheckCircle2,
  ClipboardCheck,
  StickyNote,
  Copy,
  XCircle,
  Flag,
  LockKeyhole,
} from "lucide-react";
import type {
  Bootstrap,
  TrainingSession,
  AttendanceStatus,
  SessionData,
} from "../domain/types";
import { elapsedSeconds } from "../domain/rules";
import { Badge, Court, Modal, type RunMutation } from "./common";
import { DrillDetails } from "./library";
import { formatDate, label as formatLabel } from "../../academy/ui/labels";
export default function SessionView({
  session: s,
  context,
  mutate,
  busy,
  onEdit,
}: {
  session: TrainingSession;
  context: Bootstrap;
  mutate: RunMutation;
  busy: boolean;
  onEdit: () => void;
}) {
  const d = s.data;
  const [panel, setPanel] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [detail, setDetail] = useState<number | null>(null);
  useEffect(() => {
    if (s.status !== "IN_PROGRESS") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [s.id, s.status]);
  const current = d.activities[d.progress.index];
  const seconds = elapsedSeconds(d.progress, now || Date.now());
  const timer = `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  return (
    <section className="session-view">
      <div className="session-banner">
        <div>
          <span className="eyebrow">
            {context.batches.find((b) => b.id === d.batchId)?.name ||
              "Unassigned batch"}
          </span>
          <h2>{d.title || "Untitled session"}</h2>
          <div className="session-meta">
            <span>
              <Clock size={15} />
              {formatDate(d.localDate) || "Unscheduled"} · {d.localTime} · {d.duration} min
            </span>
            <span>
              <Users size={15} />
              {d.roster.length} players
            </span>
            <span>{context.coaches.find((c) => c.id === d.coachId)?.name}</span>
          </div>
        </div>
        <Badge status={s.status} />
      </div>
      <div className="session-columns">
        <div className="session-main">
          {s.status === "IN_PROGRESS" && current ? (
            <div className="live-card">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">
                    Activity {d.progress.index + 1} of {d.activities.length}
                  </span>
                  <h2>{current.title}</h2>
                </div>
                <div className="timer" aria-label="Elapsed activity time">
                  {timer}
                  <small>/ {current.minutes}:00</small>
                </div>
              </div>
              <div className="duration-track">
                <span
                  style={{
                    width: `${Math.min(100, (seconds / (current.minutes * 60)) * 100)}%`,
                  }}
                />
              </div>
              <Court skill={current.snapshot?.skill} large />
              <div className="media-unavailable">
                Illustration · Demonstration not available
              </div>
              <div className="live-cues">
                <span className="eyebrow">Coaching focus</span>
                <p>
                  {current.cues ||
                    current.snapshot?.cues.join(" · ") ||
                    "Follow the shared session objective."}
                </p>
              </div>
              <div className="live-actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    mutate(s.id, s.version, "progress", {
                      operation: d.progress.runningSince ? "pause" : "resume",
                    })
                  }
                >
                  {d.progress.runningSince ? (
                    <Pause size={17} />
                  ) : (
                    <Play size={17} />
                  )}{" "}
                  {d.progress.runningSince ? "Pause" : "Resume"}
                </button>
                {d.progress.index < d.activities.length - 1 ? (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      mutate(s.id, s.version, "progress", { operation: "next" })
                    }
                  >
                    Next activity
                    <ArrowRight size={17} />
                  </button>
                ) : (
                  <button
                    className="primary"
                    onClick={() => setPanel("complete")}
                  >
                    Review & finish
                    <Flag size={17} />
                  </button>
                )}
              </div>
              <small className="muted">
                Timer progress is saved. It is a coaching aid, not evidence of
                participation or performance.
              </small>
            </div>
          ) : (
            <div className="panel session-objective">
              <h3>
                <Target size={18} />
                Session objective
              </h3>
              <p>{d.objective || "No objective added yet."}</p>
              {s.status === "COMPLETED" && (
                <>
                  <h3>Coach recap</h3>
                  <p>{d.recap || "No recap recorded."}</p>
                </>
              )}
            </div>
          )}
          <div className="panel">
            <h3>Planned activities</h3>
            <div className="plan-list">
              {d.activities.map((a, i) => (
                <article
                  key={a.id}
                  className={
                    s.status === "IN_PROGRESS" && i === d.progress.index
                      ? "current"
                      : ""
                  }
                >
                  <span className="number">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <strong>{a.title}</strong>
                    <p>
                      {a.cues || a.snapshot?.objective || "Custom activity"}
                    </p>
                    {a.snapshot && (
                      <button
                        className="text-button"
                        onClick={() => setDetail(i)}
                      >
                        View drill
                        <ArrowRight size={13} />
                      </button>
                    )}
                    {s.status === "COMPLETED" && (
                      <span className="tag">
                        Actual:{" "}
                        {d.actuals[a.id]?.toLowerCase().replaceAll("_", " ")}
                      </span>
                    )}
                  </div>
                  <span className="minute-pill">{a.minutes} min</span>
                </article>
              ))}
            </div>
            {!d.activities.length && (
              <p className="muted">This draft has no activities.</p>
            )}
          </div>
        </div>
        <aside className="session-side">
          <div className="panel">
            <h3>
              <Users size={17} />
              Attendance
            </h3>
            <div className="attendance-summary">
              {(["PRESENT", "ABSENT", "EXCUSED", "NOT_MARKED"] as const).map(
                (status) => (
                  <div key={status}>
                    <strong>
                      {
                        d.roster.filter(
                          (p) =>
                            (d.attendance[p.id] ?? "NOT_MARKED") === status,
                        ).length
                      }
                    </strong>
                    <span>{formatLabel(status)}</span>
                  </div>
                ),
              )}
            </div>
            {["PUBLISHED", "IN_PROGRESS"].includes(s.status) && (
              <button
                className="secondary full"
                onClick={() => setPanel("attendance")}
              >
                <ClipboardCheck size={16} />
                Mark attendance
              </button>
            )}
          </div>
          <div className="panel">
            <h3>
              <Target size={17} />
              Individual focus
            </h3>
            {d.adjustments.map((a, i) => (
              <div className="focus-item" key={i}>
                <span className="avatar">
                  {d.roster.find((p) => p.id === a.playerId)?.name.charAt(0) ||
                    "P"}
                </span>
                <div>
                  <strong>
                    {d.roster.find((p) => p.id === a.playerId)?.name ||
                      context.players.find((p) => p.id === a.playerId)?.name}
                  </strong>
                  <p>{a.focus}</p>
                  {a.goalId && (
                    <small>Active goal reused · no performance inferred</small>
                  )}
                </div>
              </div>
            ))}
            {!d.adjustments.length && (
              <p className="muted">Everyone follows the shared plan.</p>
            )}
          </div>
          <div className="panel">
            <h3>
              <StickyNote size={17} />
              Private observations{" "}
              <span className="count">{d.observations.length}</span>
            </h3>
            {d.observations.map((n) => (
              <article className="observation" key={n.id}>
                <strong>
                  {d.roster.find((p) => p.id === n.playerId)?.name}
                </strong>
                <p>{n.text}</p>
                <small>
                  {n.author} ·{" "}
                  {new Date(n.at).toLocaleString("en-IN", {
                    timeZone: d.timezone,
                  })}
                </small>
                <span>
                  <LockKeyhole size={11} />
                  Private draft
                </span>
              </article>
            ))}
            {!d.observations.length && (
              <p className="muted">
                Optional evidence, recorded in context. Missing notes do not
                mean poor performance.
              </p>
            )}
            {["PUBLISHED", "IN_PROGRESS"].includes(s.status) && (
              <button className="text-button" onClick={() => setPanel("note")}>
                <PlusIcon />
                Add observation
              </button>
            )}
          </div>
          <div className="panel">
            <h3>Parent update</h3>
            <p className="muted">
              Parent preview and approval will be added in the next stage. No
              updates are sent from this module.
            </p>
            <span className="tag">Not connected</span>
          </div>
        </aside>
      </div>
      <div className="session-footer">
        <div>
          <span className="status-dot" />
          <div>
            <strong>
              {s.status === "PUBLISHED"
                ? "Ready to step on court"
                : s.status === "IN_PROGRESS"
                  ? "Coach the moment"
                  : s.status === "COMPLETED"
                    ? "Session recorded"
                    : s.status === "CANCELLED"
                      ? "Session cancelled"
                      : "Your plan is taking shape"}
            </strong>
            <small>
              {s.status === "PUBLISHED"
                ? "Starting does not mark attendance or completion."
                : `Saved version ${s.version} · ${d.timezone}`}
            </small>
          </div>
        </div>
        <div className="button-row">
          <button className="secondary" onClick={() => setPanel("duplicate")}>
            <Copy size={16} />
            Duplicate
          </button>
          {["DRAFT", "PUBLISHED"].includes(s.status) && (
            <button
              className="icon-button danger"
              aria-label="Cancel session"
              onClick={() => setPanel("cancel")}
            >
              <XCircle size={18} />
            </button>
          )}
          {s.status === "DRAFT" && (
            <button className="primary" onClick={onEdit}>
              Edit draft
              <ArrowRight size={16} />
            </button>
          )}
          {s.status === "PUBLISHED" && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => mutate(s.id, s.version, "start")}
            >
              <Play size={17} />
              Start session
            </button>
          )}
          {s.status === "IN_PROGRESS" && (
            <button className="primary" onClick={() => setPanel("complete")}>
              <CheckCircle2 size={17} />
              Finish session
            </button>
          )}
        </div>
      </div>
      {panel && (
        <SessionDialog
          panel={panel}
          session={s}
          mutate={mutate}
          busy={busy}
          close={() => setPanel(null)}
        />
      )}
      {detail !== null && d.activities[detail]?.snapshot && (
        <DrillDetails
          drill={d.activities[detail].snapshot!}
          onClose={() => setDetail(null)}
        />
      )}
    </section>
  );
}
function PlusIcon() {
  return <span aria-hidden="true">＋</span>;
}
function SessionDialog({
  panel,
  session: s,
  mutate,
  busy,
  close,
}: {
  panel: string;
  session: TrainingSession;
  mutate: RunMutation;
  busy: boolean;
  close: () => void;
}) {
  const d = s.data;
  const [attendance, setAttendance] = useState<
    Record<string, AttendanceStatus>
  >(() => ({ ...d.attendance }));
  const [player, setPlayer] = useState(d.roster[0]?.id ?? "");
  const [activity, setActivity] = useState(
    d.activities[d.progress.index]?.id ?? "",
  );
  const [text, setText] = useState("");
  const [noteId] = useState(() => crypto.randomUUID());
  const [actuals, setActuals] = useState<SessionData["actuals"]>({});
  const [ack, setAck] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState(d.localTime || "17:00");
  const titles: Record<string, string> = {
    attendance: "Session attendance",
    note: "Add private observation",
    complete: "Review & complete session",
    duplicate: "Duplicate session plan",
    cancel: "Cancel session",
  };
  async function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    let payload: unknown;
    let action = panel;
    if (panel === "attendance") payload = attendance;
    if (panel === "note")
      payload = {
        id: noteId,
        playerId: player,
        activityId: activity || null,
        text,
      };
    if (panel === "complete")
      payload = { actuals, recap: text, acknowledgeAttendance: ack };
    if (panel === "duplicate") payload = { localDate: date, localTime: time };
    if (panel === "cancel") payload = { reason: text };
    const result = await mutate(s.id, s.version, action, payload);
    if (result) close();
  }
  return (
    <Modal title={titles[panel]} onClose={close}>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          {panel === "attendance" ? (
            <>
              <p className="muted">
                Published roster snapshot · {d.roster.length} players. Changes
                are saved with an audit trail.
              </p>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  setAttendance(
                    Object.fromEntries(
                      d.roster.map((p) => [
                        p.id,
                        attendance[p.id] && attendance[p.id] !== "NOT_MARKED"
                          ? attendance[p.id]
                          : "PRESENT",
                      ]),
                    ),
                  )
                }
              >
                Mark unmarked players present
              </button>
              <div className="roster-list">
                {d.roster.map((p) => (
                  <label className="roster-row" key={p.id}>
                    <span>
                      <span className="avatar">{p.name.charAt(0)}</span>
                      {p.name}
                    </span>
                    <select
                      aria-label={`Attendance for ${p.name}`}
                      value={attendance[p.id] ?? "NOT_MARKED"}
                      onChange={(e) =>
                        setAttendance({
                          ...attendance,
                          [p.id]: e.target.value as AttendanceStatus,
                        })
                      }
                    >
                      {["NOT_MARKED", "PRESENT", "ABSENT", "EXCUSED"].map(
                        (status) => (
                          <option key={status} value={status}>
                            {formatLabel(status)}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                ))}
              </div>
            </>
          ) : panel === "note" ? (
            <>
              <div className="notice">
                Private draft · visible only to authorised academy coaching
                staff. Not shared with guardians.
              </div>
              <label>
                Player
                <select
                  value={player}
                  onChange={(e) => setPlayer(e.target.value)}
                  required
                >
                  {d.roster.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Activity context
                <select
                  value={activity}
                  onChange={(e) => setActivity(e.target.value)}
                >
                  <option value="">Whole session</option>
                  {d.activities.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Observation & conditions
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  required
                  maxLength={2000}
                  rows={5}
                  placeholder="What did you observe? Include feed, task or conditions that give this note context."
                />
              </label>
              <small className="muted">
                Author and timestamp are recorded automatically. Attachments and
                measured assessments are not available in this slice.
              </small>
            </>
          ) : panel === "complete" ? (
            <>
              <p className="muted">
                Keep the original plan. Record what actually happened, without
                inferring goal improvement.
              </p>
              <div className="completion-list">
                {d.activities.map((a) => (
                  <label key={a.id}>
                    <strong>
                      {a.title}
                      <small>{a.minutes} min planned</small>
                    </strong>
                    <select
                      required
                      aria-label={`Actual outcome for ${a.title}`}
                      value={actuals[a.id] ?? ""}
                      onChange={(e) =>
                        setActuals({
                          ...actuals,
                          [a.id]: e.target
                            .value as SessionData["actuals"][string],
                        })
                      }
                    >
                      <option value="">Record outcome</option>
                      <option value="COMPLETED">Completed</option>
                      <option value="MODIFIED">Modified</option>
                      <option value="NOT_COMPLETED">Not completed</option>
                    </select>
                  </label>
                ))}
              </div>
              <label>
                Coach recap (optional)
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={2000}
                  rows={3}
                />
              </label>
              <div className="notice">
                {
                  d.roster.filter((p) => d.attendance[p.id] !== "PRESENT")
                    .length
                }{" "}
                players have attendance exceptions or are not marked. Active
                goals remain available for future sessions.
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                  required
                />
                I reviewed attendance exceptions and the actual activities.
              </label>
            </>
          ) : panel === "duplicate" ? (
            <>
              <p className="muted">
                Reuse activities and individual goals. Attendance, observations,
                timer progress and outcomes are cleared.
              </p>
              <label>
                New local date
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </label>
              <label>
                New local time
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  required
                />
              </label>
              <p className="muted">
                {d.timezone} · The copy starts as a draft.
              </p>
            </>
          ) : (
            <>
              <p className="muted">
                The plan and audit history will be retained.
              </p>
              <label>
                Cancellation reason
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  required
                  minLength={3}
                  maxLength={500}
                />
              </label>
            </>
          )}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={close}>
              Back
            </button>
            <button type="submit" className="primary">
              {busy
                ? "Saving…"
                : panel === "complete"
                  ? "Complete session"
                  : panel === "attendance"
                    ? "Save attendance"
                    : panel === "note"
                      ? "Save private observation"
                      : panel === "duplicate"
                        ? "Create draft copy"
                        : "Confirm cancellation"}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
