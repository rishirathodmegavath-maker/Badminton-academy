"use client";
import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Trash2,
  Plus,
  Save,
  Send,
  ClipboardList,
  Eye,
  Check,
  ChevronRight,
} from "lucide-react";
import type { Bootstrap, TrainingSession, SessionData } from "../domain/types";
import { publishBlockers, totalMinutes } from "../domain/rules";
import { Modal, type RunMutation } from "./common";
import { formatDate } from "../../academy/ui/labels";
export default function Builder({
  session,
  context,
  onChange,
  mutate,
  busy,
  onLibrary,
  dirty,
  onDiscard,
}: {
  session: TrainingSession;
  context: Bootstrap;
  onChange: (data: SessionData) => void;
  mutate: RunMutation;
  busy: boolean;
  onLibrary: () => void;
  dirty: boolean;
  /** Explicitly throw away the unsaved edits (and the recovery copy kept for them). */
  onDiscard: () => void;
}) {
  const d = session.data;
  const minutes = totalMinutes(d.activities);
  const [preview, setPreview] = useState(false);
  const [focusPlayer, setFocusPlayer] = useState("");
  const [focus, setFocus] = useState("");
  const [metadataOpen, setMetadataOpen] = useState(!d.title || !d.batchId);
  const change = (values: Partial<SessionData>) =>
    onChange({ ...d, ...values });
  const batchPlayers = context.players.filter((p) => p.batchId === d.batchId);
  const blockers = publishBlockers(d);
  async function publish() {
    const saved = dirty
      ? await mutate(session.id, session.version, "save", d)
      : session;
    if (saved) await mutate(saved.id, saved.version, "publish");
  }
  function move(index: number, delta: number) {
    const list = [...d.activities];
    [list[index], list[index + delta]] = [list[index + delta], list[index]];
    change({ activities: list });
  }
  return (
    <aside className="builder">
      <div className="builder-title">
        <span className="eyebrow">Session builder</span>
        <span className="draft-indicator">
          {dirty ? "Unsaved changes" : "Saved draft"}
        </span>
        {dirty && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={onDiscard}
          >
            Discard edits
          </button>
        )}
      </div>
      <h2>Today’s session</h2>
      <p className="muted">
        {context.batches.find((b) => b.id === d.batchId)?.name ??
          "Choose a batch"}{" "}
        · {d.duration} minutes
      </p>
      <fieldset disabled={busy}>
        <details
          className="session-metadata"
          open={metadataOpen}
          onToggle={(e) => setMetadataOpen(e.currentTarget.open)}
        >
          <summary>Session details & schedule</summary>
          <label>
            Session title
            <input
              value={d.title}
              onChange={(e) => change({ title: e.target.value })}
              placeholder="e.g. Overhead technique & recovery"
              maxLength={120}
            />
          </label>
          <div className="form-grid">
            <label>
              Batch
              <select
                value={d.batchId}
                onChange={(e) => {
                  const b = context.batches.find(
                    (b) => b.id === e.target.value,
                  );
                  change({
                    batchId: e.target.value,
                    branchId: b?.branchId ?? "",
                    coachId: b?.coachId ?? context.actor.id,
                    adjustments: [],
                  });
                }}
              >
                <option value="">Choose batch</option>
                {context.batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Duration (min)
              <input
                type="number"
                min="1"
                max="480"
                value={d.duration}
                onChange={(e) => change({ duration: Number(e.target.value) })}
              />
            </label>
            <label>
              Branch
              <select
                value={d.branchId}
                onChange={(e) => change({ branchId: e.target.value })}
              >
                <option value="">Choose branch</option>
                {context.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Coach
              <select
                value={d.coachId}
                onChange={(e) => change({ coachId: e.target.value })}
              >
                {context.coaches.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Local date
              <input
                type="date"
                value={d.localDate}
                onChange={(e) => change({ localDate: e.target.value })}
              />
            </label>
            <label>
              Local time
              <input
                type="time"
                value={d.localTime}
                onChange={(e) => change({ localTime: e.target.value })}
              />
            </label>
          </div>
          <small className="timezone">
            All session times: {context.academy.timezone}
          </small>
          <label>
            Session objective
            <textarea
              value={d.objective}
              onChange={(e) => change({ objective: e.target.value })}
              placeholder="What should players take away today?"
              maxLength={2000}
              rows={2}
            />
          </label>
        </details>
        <div className="activities-heading">
          <h3>
            Session activities <span>{d.activities.length}</span>
          </h3>
          <strong className={minutes === d.duration ? "green" : "amber"}>
            {minutes} / {d.duration} <small>min</small>
          </strong>
        </div>
        <div className="duration-track">
          <span
            style={{
              width: `${Math.min(100, (minutes / d.duration) * 100) || 0}%`,
            }}
          />
        </div>
        {minutes !== d.duration && d.activities.length > 0 && (
          <div className="duration-warning">
            {minutes < d.duration
              ? `${d.duration - minutes} minutes left to plan.`
              : `${minutes - d.duration} minutes over the session duration.`}{" "}
            <button
              className="text-button"
              onClick={() => change({ duration: minutes })}
            >
              Use {minutes} min
            </button>
          </div>
        )}
        <div className="activity-list">
          {d.activities.map((a, i) => (
            <article className="activity-editor" key={a.id}>
              <div className="activity-top">
                <span className="number">{String(i + 1).padStart(2, "0")}</span>
                <strong>{a.title}</strong>
                <div className="reorder">
                  <button
                    className="icon-button"
                    disabled={i === 0}
                    aria-label={`Move ${a.title} up`}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    className="icon-button"
                    disabled={i === d.activities.length - 1}
                    aria-label={`Move ${a.title} down`}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                </div>
                <button
                  className="icon-button danger"
                  aria-label={`Remove ${a.title}`}
                  onClick={() =>
                    change({
                      activities: d.activities.filter((x) => x.id !== a.id),
                    })
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="activity-fields">
                <label>
                  Cues
                  <input
                    aria-label={`${a.title} cues`}
                    placeholder="A focus cue…"
                    value={a.cues}
                    onChange={(e) =>
                      change({
                        activities: d.activities.map((x) =>
                          x.id === a.id ? { ...x, cues: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  Minutes
                  <input
                    aria-label={`${a.title} minutes`}
                    type="number"
                    min="1"
                    max="180"
                    value={a.minutes}
                    onChange={(e) =>
                      change({
                        activities: d.activities.map((x) =>
                          x.id === a.id
                            ? { ...x, minutes: Number(e.target.value) }
                            : x,
                        ),
                      })
                    }
                  />
                </label>
              </div>
            </article>
          ))}
        </div>
        {!d.activities.length && (
          <div className="builder-empty">
            <ClipboardList size={30} />
            <h3>A little structure goes a long way.</h3>
            <p>
              Add drills from the library, then fine-tune the order and timing.
            </p>
            <button className="text-button" onClick={onLibrary}>
              Explore drills
              <ChevronRight size={14} />
            </button>
          </div>
        )}
        <button
          className="dashed full"
          onClick={() =>
            change({
              activities: [
                ...d.activities,
                {
                  id: crypto.randomUUID(),
                  drillId: null,
                  drillVersion: null,
                  title: "Warm-up / rest",
                  minutes: 5,
                  cues: "",
                  snapshot: null,
                },
              ],
            })
          }
        >
          <Plus size={16} />
          Add custom activity or rest
        </button>
        {d.activities
          .filter((a) => !a.drillId)
          .map((a) => (
            <label key={a.id}>
              Custom activity name
              <input
                aria-label={`Custom activity ${a.id} name`}
                value={a.title}
                onChange={(e) =>
                  change({
                    activities: d.activities.map((x) =>
                      x.id === a.id ? { ...x, title: e.target.value } : x,
                    ),
                  })
                }
              />
            </label>
          ))}
        <details className="focus-section">
          <summary>
            Individual focus{" "}
            <span>
              Optional
              <ChevronRight size={14} />
            </span>
          </summary>
          <p className="muted">
            Everyone follows the shared plan unless a focus is added.
          </p>
          {d.adjustments.map((a, i) => (
            <div className="focus-item" key={`${a.playerId}-${i}`}>
              <div>
                <strong>
                  {context.players.find((p) => p.id === a.playerId)?.name}
                </strong>
                <p>{a.focus}</p>
              </div>
              <button
                className="icon-button"
                aria-label="Remove focus"
                onClick={() =>
                  change({
                    adjustments: d.adjustments.filter((_, n) => n !== i),
                  })
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <label>
            Player
            <select
              value={focusPlayer}
              onChange={(e) => setFocusPlayer(e.target.value)}
            >
              <option value="">Choose player</option>
              {batchPlayers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Use an active goal
            <select
              defaultValue=""
              onChange={(e) => {
                const g = context.goals.find((g) => g.id === e.target.value);
                if (g) {
                  change({
                    adjustments: [
                      ...d.adjustments,
                      { playerId: g.playerId, focus: g.title, goalId: g.id },
                    ],
                  });
                  e.target.value = "";
                }
              }}
            >
              <option value="">Choose goal</option>
              {context.goals
                .filter(
                  (g) =>
                    g.status === "ACTIVE" &&
                    batchPlayers.some((p) => p.id === g.playerId),
                )
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {context.players.find((p) => p.id === g.playerId)?.name}:{" "}
                    {g.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Or add a session focus
            <input
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="One useful coaching reminder"
              maxLength={500}
            />
          </label>
          <button
            className="secondary"
            disabled={!focusPlayer || !focus.trim()}
            onClick={() => {
              change({
                adjustments: [
                  ...d.adjustments,
                  { playerId: focusPlayer, focus: focus.trim() },
                ],
              });
              setFocus("");
            }}
          >
            Add focus
          </button>
        </details>
        <div className="builder-actions">
          <button
            className="secondary"
            disabled={!dirty}
            onClick={() => mutate(session.id, session.version, "save", d)}
          >
            <Save size={16} />
            Save draft
          </button>
          <button
            className="secondary"
            aria-label="Preview session"
            onClick={() => setPreview(true)}
          >
            <Eye size={17} />
          </button>
          <button className="primary" onClick={publish}>
            <Send size={16} />
            Publish
          </button>
        </div>
      </fieldset>
      {blockers.length > 0 && (
        <p className="builder-note" role="note">
          <strong>Still a draft.</strong> To publish: {blockers.join(", ")}.
        </p>
      )}
      <p className="builder-note">
        <Check size={13} />
        Plans stay private to your academy. Publishing does not send a parent
        update.
      </p>
      {preview && (
        <Modal title="Session preview" onClose={() => setPreview(false)}>
          <p className="muted">
            Unsaved preview · {formatDate(d.localDate) || "Date not set"} ·{" "}
            {d.localTime || "Time not set"} · {d.timezone}
          </p>
          <h3>{d.title || "Untitled session"}</h3>
          <p>{d.objective || "Add an objective before publishing."}</p>
          <ol className="preview-list">
            {d.activities.map((a) => (
              <li key={a.id}>
                <strong>{a.title}</strong>
                <span>{a.minutes} min</span>
                <p>{a.cues}</p>
              </li>
            ))}
          </ol>
          <p>
            {minutes} minutes planned / {d.duration} minute session
          </p>
          <div className="notice">
            Staff preview only. Attendance, private notes and individual focus
            are never automatically sent to families.
          </div>
        </Modal>
      )}
    </aside>
  );
}
