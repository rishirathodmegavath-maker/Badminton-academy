"use client";
import { useEffect, useRef, useState } from "react";
import {
  Video,
  Upload,
  MessageSquare,
  Clock,
  Bot,
  Target,
  Activity,
  ShieldCheck,
  Play,
} from "lucide-react";
import type { WorkspaceProps } from "../context";
import { Status, Tabs, academyRequest } from "../shared";
import { Pane, Blank, Person, ContextNote, Toolbar } from "../workbench";
import { formatDate } from "../labels";
export function MediaView(p: WorkspaceProps) {
  const d = p.data;
  const [selectedId, setSelectedId] = useState(
    p.focusId ?? d.media.at(-1)?.id ?? "",
  );
  const [tab, setTab] = useState("Manual video review");
  const [uploadOpen, setUploadOpen] = useState(false);
  const media = d.media.find((m) => m.id === selectedId) ?? d.media.at(-1);
  return (
    <div className="reference-view">
      <Toolbar>
        <Tabs
          items={["Manual video review", "AI Analysis"]}
          value={tab}
          onChange={setTab}
        />
        {d.permissions.coaching && (
          <button
            className="primary"
            onClick={() => setUploadOpen(!uploadOpen)}
          >
            <Upload size={16} />
            Upload private media
          </button>
        )}
      </Toolbar>
      {uploadOpen && (
        <UploadForm
          {...p}
          close={() => setUploadOpen(false)}
          uploaded={() => {
            setUploadOpen(false);
            setSelectedId("");
          }}
        />
      )}
      {tab === "AI Analysis" ? (
        <Pane>
          <AIUnavailable />
        </Pane>
      ) : (
        <div className="media-workbench">
          <Pane title="Training media" className="media-viewer-pane">
            <label>
              Choose authorised media
              <select
                aria-label="Choose media"
                value={media?.id ?? ""}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {!d.media.length && (
                  <option value="">No private media yet</option>
                )}
                {d.media.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ·{" "}
                    {d.players.find((pl) => pl.id === m.playerId)?.name}
                  </option>
                ))}
              </select>
            </label>
            {media ? (
              <PrivateViewer key={media.id} {...p} mediaId={media.id} />
            ) : (
              <div className="wb-video-empty">
                <Video size={48} />
                <h3>No video selected</h3>
                <p>
                  Upload an authorised video for manual coach review. No
                  demonstration or analysis is fabricated.
                </p>
                <Status value="PRIVATE_STORAGE" />
              </div>
            )}
            <ContextNote>
              Files use short-lived, authenticated links. Linked families see
              only explicitly shared feedback and media.
            </ContextNote>
          </Pane>
          <Pane title="Player & session details">
            {media ? (
              <MediaReview key={media.id} {...p} mediaId={media.id} />
            ) : (
              <Blank
                title="Select private media"
                text="Player context, timestamp notes and coach feedback appear here."
                icon={MessageSquare}
              />
            )}
          </Pane>
          <aside className="ai-coming-soon">
            <AIUnavailable />
          </aside>
        </div>
      )}
    </div>
  );
}
function AIUnavailable() {
  return (
    <div className="wb-ai-content">
      <Bot size={47} />
      <h2>
        AI ANALYSIS
        <br />
        COMING SOON
      </h2>
      <p>
        Automated video analysis is not available. Manual coaching review works
        independently.
      </p>
      {[
        [Target, "Rally breakdown"],
        [Activity, "Shot patterns"],
        [Video, "Movement analysis"],
      ].map(([Icon, label]) => {
        const I = Icon as typeof Target;
        return (
          <div className="wb-ai-feature" key={label as string}>
            <span>
              <I size={20} />
            </span>
            <div>
              <strong>{label as string}</strong>
              <small>Planned · not an analysis result</small>
            </div>
          </div>
        );
      })}
      <span className="unavailable-label">Not available yet</span>
    </div>
  );
}
function UploadForm(
  p: WorkspaceProps & { close: () => void; uploaded: () => void },
) {
  const [playerId, setPlayerId] = useState(p.data.players[0]?.id ?? "");
  const [sessionId, setSessionId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  return (
    <Pane title="Upload for private manual review">
      <form
        className="wb-upload-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!file) return;
          const form = new FormData();
          form.set("file", file);
          form.set("playerId", playerId);
          form.set("sessionId", sessionId);
          if (await p.mutate("/media/upload", form)) p.uploaded();
        }}
      >
        <fieldset disabled={p.busy}>
          <div className="wb-two-panels">
            <label>
              Player
              <select
                value={playerId}
                onChange={(e) => {
                  setPlayerId(e.target.value);
                  setSessionId("");
                }}
                required
              >
                {p.data.players.map((pl) => (
                  <option key={pl.id} value={pl.id}>
                    {pl.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Session context (optional)
              <select
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
              >
                <option value="">Player-level review</option>
                {p.data.sessions
                  .filter(
                    (s) =>
                      s.data.roster.some((r) => r.id === playerId) ||
                      s.batchId ===
                        p.data.players.find((pl) => pl.id === playerId)
                          ?.batchId,
                  )
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.data.title || "Untitled draft"} ·{" "}
                      {formatDate(s.data.localDate) || "Unscheduled"}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <label>
            PNG, JPEG, MP4 or WebM · maximum 25 MB
            <input
              aria-label="Private media file"
              type="file"
              accept="image/png,image/jpeg,video/mp4,video/webm"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <ContextNote>
            Retention: {p.data.settings.data.retentionDays} days. Upload
            original or authorised media only.
          </ContextNote>
          <div className="wb-bottom-actions">
            <button className="secondary" type="button" onClick={p.close}>
              Cancel upload
            </button>
            <button className="primary">
              {p.busy ? "Uploading…" : "Upload private file"}
            </button>
          </div>
        </fieldset>
      </form>
    </Pane>
  );
}
function PrivateViewer(p: WorkspaceProps & { mediaId: string }) {
  const m = p.data.media.find((m) => m.id === p.mediaId)!;
  const video = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  async function load() {
    try {
      setError("");
      setUrl(
        (await academyRequest<{ url: string }>(`/media/${m.id}/link`)).url,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    let active = true;
    academyRequest<{ url: string }>(`/media/${m.id}/link`)
      .then((result) => {
        if (active) {
          setUrl(result.url);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [m.id]);
  useEffect(() => {
    const seek = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; seconds: number }>)
        .detail;
      if (detail.id === m.id && video.current) {
        video.current.currentTime = detail.seconds;
        video.current.focus();
      }
    };
    window.addEventListener("sportozen-media-seek", seek);
    return () => window.removeEventListener("sportozen-media-seek", seek);
  }, [m.id]);
  return (
    <>
      <div className="private-media-surface">
        {error ? (
          <Blank
            title="Private media unavailable"
            text={error}
            icon={ShieldCheck}
          />
        ) : url ? (
          m.mime.startsWith("video/") ? (
            <video
              ref={video}
              src={url}
              controls
              preload="metadata"
              aria-label={`Private coaching video ${m.name}`}
              onError={() =>
                setError(
                  "This video cannot be played, or its private link has expired. Refresh the authorised link and try again.",
                )
              }
              onTimeUpdate={() =>
                window.dispatchEvent(
                  new CustomEvent("sportozen-media-time", {
                    detail: {
                      id: m.id,
                      seconds: video.current?.currentTime ?? 0,
                    },
                  }),
                )
              }
            />
          ) : (
            <img
              src={url}
              alt={`Authorised training image: ${m.name}`}
              onError={() =>
                setError("Private image could not be loaded. Refresh the link.")
              }
            />
          )
        ) : (
          <p role="status">Loading private media…</p>
        )}
      </div>
      <div className="wb-media-caption">
        <strong>{m.name}</strong>
        <Status value={m.status} />
        <button className="text-button" onClick={load}>
          Refresh private link
        </button>
      </div>
      {m.mime.startsWith("video/") && (
        <div className="wb-timeline-notes">
          {m.timestampNotes.map((note) => (
            <button
              key={note.id}
              className="secondary"
              onClick={() => {
                if (video.current) video.current.currentTime = note.seconds;
              }}
            >
              <Clock size={13} />
              {timeLabel(note.seconds)}
            </button>
          ))}
        </div>
      )}
      <p className="muted">
        {m.feedback || "No reviewed coach feedback has been recorded."}
      </p>
    </>
  );
}
function MediaReview(p: WorkspaceProps & { mediaId: string }) {
  const m = p.data.media.find((m) => m.id === p.mediaId)!;
  const [feedback, setFeedback] = useState(m.feedback);
  const [seconds, setSeconds] = useState(0);
  const [current, setCurrent] = useState(0);
  const [text, setText] = useState("");
  const [noteId, setNoteId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    const listener = (e: Event) => {
      const v = (e as CustomEvent<{ id: string; seconds: number }>).detail;
      if (v.id === m.id) setCurrent(v.seconds);
    };
    window.addEventListener("sportozen-media-time", listener);
    return () => window.removeEventListener("sportozen-media-time", listener);
  }, [m.id]);
  async function saveReview(share: boolean) {
    if (
      await p.mutate("/media/review", {
        id: m.id,
        version: m.version,
        feedback,
        share,
      })
    ) {
      /* Form stays on the selected media. */
    }
  }
  return (
    <>
      <Person
        name={
          p.data.players.find((pl) => pl.id === m.playerId)?.name ??
          "Authorised player"
        }
        subtitle={
          p.data.batches.find(
            (b) =>
              b.id ===
              p.data.players.find((pl) => pl.id === m.playerId)?.batchId,
          )?.name
        }
      />
      <div className="wb-inset">
        <strong>Session</strong>
        <p>
          {m.sessionId
            ? (p.data.sessions.find((s) => s.id === m.sessionId)?.data.title ??
              "Historical training session")
            : "Player-level review"}
        </p>
      </div>
      <label>
        Coach feedback
        <textarea
          aria-label="Coach media feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          maxLength={3000}
          rows={5}
          readOnly={!p.data.permissions.coaching}
        />
      </label>
      {m.mime.startsWith("video/") ? (
        <>
          <h3>Add timestamp note</h3>
          {p.data.permissions.coaching && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await p.mutate("/media/note", {
                    id: m.id,
                    version: m.version,
                    noteId,
                    seconds,
                    text,
                  })
                ) {
                  setText("");
                  setNoteId(crypto.randomUUID());
                }
              }}
            >
              <label>
                Timestamp (seconds)
                <input
                  aria-label="Timestamp seconds"
                  type="number"
                  min="0"
                  max="86400"
                  step="0.1"
                  value={seconds}
                  onChange={(e) => setSeconds(Number(e.target.value))}
                />
              </label>
              <button
                type="button"
                className="text-button"
                onClick={() => setSeconds(Math.round(current * 10) / 10)}
              >
                Use current time · {timeLabel(current)}
              </button>
              <label>
                Timestamp feedback
                <input
                  aria-label="Timestamp feedback"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  required
                  maxLength={1000}
                />
              </label>
              <button className="secondary" disabled={p.busy}>
                Add timestamp note
              </button>
            </form>
          )}
          <div className="wb-timestamp-list">
            {m.timestampNotes.map((note) => (
              <article key={note.id}>
                <button
                  className="text-button"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("sportozen-media-seek", {
                        detail: { id: m.id, seconds: note.seconds },
                      }),
                    )
                  }
                >
                  <Play size={13} />
                  {timeLabel(note.seconds)}
                </button>
                <p>{note.text}</p>
                <small>
                  {note.authorName} · {note.at.slice(0, 10)}
                </small>
              </article>
            ))}
          </div>
        </>
      ) : (
        <ContextNote>
          Timestamp notes require a real video. This upload is an image.
        </ContextNote>
      )}
      {p.data.permissions.coaching && (
        <div className="wb-stacked-actions">
          <button
            className="secondary"
            disabled={p.busy || feedback.trim().length < 3}
            onClick={() => saveReview(false)}
          >
            Save private feedback
          </button>
          <button
            className="primary"
            disabled={p.busy || feedback.trim().length < 3}
            onClick={() => saveReview(true)}
          >
            Share approved feedback
          </button>
        </div>
      )}
      <ContextNote>
        Adding timestamp evidence revokes sharing until explicitly reviewed
        again. Expires {formatDate(m.expiresAt)}.
      </ContextNote>
    </>
  );
}
const timeLabel = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
