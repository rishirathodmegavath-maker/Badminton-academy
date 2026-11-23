"use client";
import { CalendarLinkCard, SessionShare } from "../sharing";
import { AgeReviewPanel } from "../age-review-panel";
import { useState } from "react";
import {
  Users,
  CalendarDays,
  Clock,
  ChevronRight,
  ChevronLeft,
  UserPlus,
  CheckCircle2,
  Bell,
  Target,
  Mail,
  Phone,
  MapPin,
  Save,
} from "lucide-react";
import type { WorkspaceProps } from "../context";
import { Status, Tabs, money } from "../shared";
import { label as displayLabel, formatDate } from "../labels";
import { ConsentPanel } from "../../../consent/ui/consent-panel";
import { can } from "../../../identity/authority";
import {
  Pane,
  Metrics,
  SearchBox,
  Roster,
  Person,
  Info,
  Blank,
  Toolbar,
  ContextNote,
} from "../workbench";
type Enquiry = WorkspaceProps["data"]["enquiries"][number];
export { OverviewView } from "./overview-view";
export function AdmissionsView(
  p: WorkspaceProps & {
    edit: (id?: string) => void;
    trial: (id: string) => void;
  },
) {
  const d = p.data;
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState(
    p.focusId?.startsWith("filter:") ? p.focusId.slice(7).split("|")[0] : "All",
  );
  const scopeBranch = p.focusId?.split("|")[1] || "";
  const [source, setSource] = useState("");
  const [selectedId, setSelectedId] = useState(
    p.focusId ?? d.enquiries[0]?.id ?? "",
  );
  const rows = d.enquiries.filter(
    (e) =>
      (stage === "All" ||
        (stage === "follow-up"
          ? !["ENROLLED", "CLOSED"].includes(e.status) &&
            !!e.data.followUpDate &&
            e.data.followUpDate <= d.currentDate
          : e.status === stage)) &&
      (!scopeBranch ||
        d.events.some(
          (ev) =>
            ev.id === e.data.trialEventId && ev.data.branchId === scopeBranch,
        )) &&
      (!source || e.data.source === source) &&
      `${e.data.name} ${e.data.email} ${e.data.phone}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const e = rows.find((e) => e.id === selectedId) ?? rows[0];
  return (
    <div className="reference-view">
      <div className="wb-screen-toolbar">
        <p>Manage enquiries from first interest to enrolment.</p>
        {d.permissions.ops && (
          <button className="primary" onClick={() => p.edit()}>
            ＋ Add enquiry
          </button>
        )}
      </div>
      {!d.permissions.ops ? (
        <ContextNote>
          Admissions requires owner, administrator or head coach access.
        </ContextNote>
      ) : (
        <>
          <Metrics
            items={[
              {
                label: "New enquiries",
                value: d.enquiries.filter((e) => e.status === "ENQUIRY").length,
                icon: UserPlus,
                tone: "blue",
                onClick: () => setStage("ENQUIRY"),
              },
              {
                label: "Trials booked",
                value: d.enquiries.filter((e) => e.status === "TRIAL").length,
                icon: CalendarDays,
                tone: "purple",
                onClick: () => setStage("TRIAL"),
              },
              {
                label: "Follow-up due",
                value: d.enquiries.filter(
                  (e) =>
                    !["ENROLLED", "CLOSED"].includes(e.status) &&
                    e.data.followUpDate &&
                    e.data.followUpDate <= d.currentDate,
                ).length,
                icon: Clock,
                tone: "amber",
                onClick: () => {
                  setStage("All");
                  setQuery("");
                },
              },
              {
                label: "Enrolled",
                value: d.enquiries.filter((e) => e.status === "ENROLLED")
                  .length,
                icon: CheckCircle2,
                onClick: () => setStage("ENROLLED"),
              },
            ]}
          />
          <Tabs
            items={[
              "All",
              { value: "follow-up", label: "Follow-up due" },
              ...["ENQUIRY", "TRIAL", "WAITLIST", "ENROLLED", "CLOSED"].map(
                (s) => ({ value: s, label: displayLabel(s) }),
              ),
            ]}
            value={stage}
            onChange={setStage}
          />
          <div className="wb-master-detail admission-layout">
            <Pane
              title={`Enquiries (${rows.length})`}
              action={
                <select
                  aria-label="Enquiry source filter"
                  value={source}
                  onChange={(ev) => setSource(ev.target.value)}
                >
                  <option value="">All sources</option>
                  {[
                    ...new Set(
                      d.enquiries.map((e) => e.data.source).filter(Boolean),
                    ),
                  ].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              }
            >
              <SearchBox
                label="Search enquiries"
                placeholder="Search name, contact or email…"
                value={query}
                onChange={setQuery}
              />
              <Roster
                rows={rows}
                selectedId={e?.id}
                onSelect={setSelectedId}
                title={(e) => e.data.name}
                subtitle={(e) =>
                  `${e.data.adult ? "Adult" : "Junior"} · ${e.data.source || "Source not recorded"}`
                }
                status={(e) => e.status}
              />
            </Pane>
            <Pane
              title="Enquiry details"
              action={e && <Status value={e.status} />}
            >
              {e ? (
                <>
                  <div className="wb-detail-identity">
                    <Person
                      name={e.data.name}
                      subtitle={`${e.data.adult ? "Adult player" : "Junior prospect"} · ${e.data.source || "Enquiry"}`}
                      large
                    />
                    <small>Enquiry ID · {e.id.slice(0, 8)}</small>
                  </div>
                  <EnquiryDetail
                    key={`${e.id}:${e.version}`}
                    enquiry={e}
                    {...p}
                  />
                  <div className="wb-bottom-actions">
                    {!e.data.trialEventId && e.status !== "ENROLLED" && (
                      <button className="primary" onClick={() => p.trial(e.id)}>
                        <CalendarDays size={16} />
                        Schedule trial
                      </button>
                    )}
                    {e.data.trialEventId && (
                      <button
                        className="secondary"
                        onClick={() => p.nav("Calendar", e.data.trialEventId!)}
                      >
                        Open scheduled trial
                      </button>
                    )}
                    {e.status !== "ENROLLED" ? (
                      <button
                        className="secondary"
                        onClick={() =>
                          p.open({
                            title: `Enrol ${e.data.name}`,
                            initial: { batchId: "", birthDate: "" },
                            fields: [
                              {
                                name: "birthDate",
                                label: "Player date of birth (must be under 18)",
                                kind: "date",
                                required: true,
                              },
                              {
                                name: "batchId",
                                label: "Training batch",
                                kind: "select",
                                required: true,
                                options: [
                                  { value: "", label: "Choose batch" },
                                  ...d.batches.map((b) => ({
                                    value: b.id,
                                    label: b.name,
                                  })),
                                ],
                              },
                            ],
                            notice:
                              "Trial attendance and feedback are required. Players must be under 18, so a date of birth is needed. Existing identity and history are preserved.",
                            button: "Convert to player",
                            submit: (v) =>
                              p.mutate("/admissions/convert", {
                                id: e.id,
                                version: e.version,
                                batchId: String(v.batchId),
                                birthDate: String(v.birthDate ?? ""),
                              }),
                          })
                        }
                      >
                        <CheckCircle2 size={16} />
                        Convert to enrolment
                      </button>
                    ) : (
                      <button
                        className="primary"
                        onClick={() =>
                          p.nav("Players", e.data.playerId ?? e.id)
                        }
                      >
                        Open enrolled player
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <Blank
                  title="Select an enquiry"
                  text="New enquiries and their connected trial history will appear here."
                />
              )}
            </Pane>
          </div>
        </>
      )}
    </div>
  );
}
function EnquiryDetail(p: WorkspaceProps & { enquiry: Enquiry }) {
  const e = p.enquiry;
  const [tab, setTab] = useState("Details");
  const [notes, setNotes] = useState(e.data.notes);
  const [feedback, setFeedback] = useState(e.data.feedback);
  const [followUpDate, setFollowUpDate] = useState(e.data.followUpDate);
  const [attendance, setAttendance] = useState(e.data.trialAttendance);
  const event = p.data.events.find((ev) => ev.id === e.data.trialEventId);
  return (
    <>
      <Tabs
        items={["Details", "Notes & feedback", "History"]}
        value={tab}
        onChange={setTab}
      />
      {tab === "Details" ? (
        <>
          <Info
            items={[
              { label: "Student", value: e.data.name, icon: Users },
              { label: "Contact email", value: e.data.email, icon: Mail },
              { label: "Contact phone", value: e.data.phone, icon: Phone },
              { label: "Enquiry source", value: e.data.source, icon: UserPlus },
              { label: "Notes", value: e.data.notes },
            ]}
          />
          <div className="wb-mini-grid">
            <div>
              <CalendarDays size={18} />
              <strong>Trial date</strong>
              <span>{event?.data.localDate ?? "Not scheduled"}</span>
              <small>
                {event
                  ? `${event.data.localTime} · ${event.data.duration} minutes`
                  : ""}
              </small>
            </div>
            <div>
              <Users size={18} />
              <strong>Assigned coach</strong>
              <span>
                {p.data.members.find((m) => m.id === event?.data.coachId)
                  ?.name ?? "Not assigned"}
              </span>
            </div>
            <div>
              <Bell size={18} />
              <strong>Next follow-up</strong>
              <span>{formatDate(e.data.followUpDate) || "Not set"}</span>
            </div>
          </div>
          <button
            className="text-button"
            onClick={() => setTab("Notes & feedback")}
          >
            Update follow-up & trial feedback →
          </button>
        </>
      ) : tab === "Notes & feedback" ? (
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            void p.mutate("/admissions/save", {
              id: e.id,
              version: e.version,
              status: e.status,
              data: {
                ...e.data,
                notes,
                feedback,
                followUpDate,
                trialAttendance: attendance,
              },
            });
          }}
        >
          <fieldset disabled={p.busy || e.status === "ENROLLED"}>
            <label>
              Next follow-up
              <input
                type="date"
                value={followUpDate}
                onChange={(ev) => setFollowUpDate(ev.target.value)}
              />
            </label>
            <label>
              Private follow-up notes
              <textarea
                value={notes}
                onChange={(ev) => setNotes(ev.target.value)}
                maxLength={2000}
              />
            </label>
            <label>
              Trial attendance
              <select
                aria-label="Trial attendance"
                value={attendance}
                onChange={(ev) =>
                  setAttendance(ev.target.value as typeof attendance)
                }
              >
                {["NOT_MARKED", "PRESENT", "ABSENT", "EXCUSED"].map((s) => (
                  <option key={s} value={s}>
                    {displayLabel(s)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Trial feedback
              <textarea
                value={feedback}
                onChange={(ev) => setFeedback(ev.target.value)}
                maxLength={2000}
              />
            </label>
            <button className="primary">
              <Save size={16} />
              Save follow-up & feedback
            </button>
          </fieldset>
        </form>
      ) : (
        <div>
          {p.data.versions
            .filter((v) => v.entityId === e.id && v.kind === "enquiry")
            .map((v) => (
              <article key={v.id} className="observation">
                <strong>
                  Revision {v.version} ·{" "}
                  {(v.data as { status?: string }).status}
                </strong>
                <small>{formatDate(v.createdAt)}</small>
              </article>
            ))}
        </div>
      )}
    </>
  );
}
export function PlayersView(
  p: WorkspaceProps & {
    edit: (id?: string) => void;
    guardian: (id: string, userId?: string) => void;
  },
) {
  const d = p.data;
  // A name typed in the header search arrives as `search:<text>` (the search never offers `|`, which `focusId` uses).
  const [query, setQuery] = useState(p.focusId?.startsWith("search:") ? p.focusId.slice(7) : "");
  const [batch, setBatch] = useState("");
  const [status, setStatus] = useState(
    p.focusId?.startsWith("filter:active") ? "ACTIVE" : "",
  );
  const [selectedId, setSelectedId] = useState(
    p.focusId ?? d.players[0]?.id ?? "",
  );
  const [tab, setTab] = useState("Profile");
  const rows = d.players.filter(
    (pl) =>
      pl.name.toLowerCase().includes(query.toLowerCase()) &&
      (!batch || pl.batchId === batch) &&
      (!status || pl.profile.status === status) &&
      (!p.focusId?.split("|")[1] ||
        d.batches.some(
          (b) => b.id === pl.batchId && b.branchId === p.focusId?.split("|")[1],
        )),
  );
  const player = rows.find((pl) => pl.id === selectedId) ?? rows[0];
  const goals = player
    ? d.goals.filter((g) => g.data.playerId === player.id)
    : [];
  const records = player
    ? d.sessions.filter((s) => s.data.roster.some((r) => r.id === player.id))
    : [];
  const present = records.filter(
    (s) => s.data.attendance[player?.id ?? ""] === "PRESENT",
  ).length;
  const marked = records.filter(
    (s) =>
      s.data.attendance[player?.id ?? ""] &&
      s.data.attendance[player?.id ?? ""] !== "NOT_MARKED",
  ).length;
  return (
    <div className="reference-view">
      <AgeReviewPanel {...p} edit={p.edit} />
      <Toolbar>
        <SearchBox
          label="Search players"
          placeholder="Search players by name…"
          value={query}
          onChange={setQuery}
        />
        <select
          aria-label="Player batch filter"
          value={batch}
          onChange={(ev) => setBatch(ev.target.value)}
        >
          <option value="">All batches</option>
          {d.batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Player status filter"
          value={status}
          onChange={(ev) => setStatus(ev.target.value)}
        >
          <option value="">All statuses</option>
          {["ACTIVE", "PAUSED", "ARCHIVED"].map((s) => (
            <option key={s} value={s}>
              {displayLabel(s)}
            </option>
          ))}
        </select>
        <button
          className="text-button"
          onClick={() => {
            setQuery("");
            setBatch("");
            setStatus("");
          }}
        >
          Clear
        </button>
        {d.permissions.ops && (
          <button className="primary" onClick={() => p.edit()}>
            ＋ Add player
          </button>
        )}
      </Toolbar>
      <div className="wb-master-detail player-layout">
        <Pane title={`Players (${rows.length})`}>
          <Roster
            rows={rows}
            selectedId={player?.id}
            onSelect={setSelectedId}
            title={(pl) => pl.name}
            subtitle={(pl) =>
              `${pl.profile.adult ? "Adult" : "Junior"} · ${d.batches.find((b) => b.id === pl.batchId)?.name ?? "Unassigned"}`
            }
            status={(pl) => pl.profile.status}
            emptyTitle={
              d.players.length ? "No players match these filters" : "No players yet"
            }
            empty={
              d.players.length
                ? "Try a different name, batch or status."
                : "Add your first player to start building the academy."
            }
            emptyAction={
              d.players.length
                ? {
                    label: "Clear filters",
                    onClick: () => {
                      setQuery("");
                      setBatch("");
                      setStatus("");
                    },
                  }
                : d.permissions.ops
                  ? { label: "Add your first player", onClick: () => p.edit() }
                  : undefined
            }
          />
        </Pane>
        <Pane>
          {player ? (
            <>
              <div className="wb-profile-header">
                <Person
                  name={player.name}
                  subtitle={`${player.profile.adult ? "Adult player" : "Junior player"} · ${d.batches.find((b) => b.id === player.batchId)?.name}`}
                  large
                />
                <div>
                  <Status value={player.profile.status} />
                  {d.permissions.ops && (
                    <button
                      className="secondary"
                      onClick={() => p.edit(player.id)}
                    >
                      Edit / transfer
                    </button>
                  )}
                </div>
              </div>
              <Tabs
                items={["Profile", "Development", "Fees", "Reports"]}
                value={tab}
                onChange={setTab}
              />
              {tab === "Profile" ? (
                <div className="wb-profile-grid">
                  <div>
                    <section className="wb-inset">
                      <h3>Guardian details</h3>
                      {d.guardianLinks
                        .filter((l) => l.playerId === player.id)
                        .map((l) => (
                          <div className="wb-guardian" key={l.userId}>
                            <strong>
                              {d.members.find((m) => m.id === l.userId)?.name ??
                                "Authorised guardian"}
                            </strong>
                            <small>
                              {l.relationship} ·{" "}
                              {l.active ? "Active" : "Revoked"}
                            </small>
                            {d.permissions.ops && (
                              <button
                                className="text-button"
                                onClick={() => p.guardian(player.id, l.userId)}
                              >
                                Manage access →
                              </button>
                            )}
                          </div>
                        ))}
                      {!d.guardianLinks.some(
                        (l) => l.playerId === player.id,
                      ) && (
                        <p className="muted">
                          No guardian relationship recorded.
                        </p>
                      )}
                      {d.permissions.ops && (
                        <button
                          className="text-button"
                          onClick={() => p.guardian(player.id)}
                        >
                          ＋ Link guardian
                        </button>
                      )}
                    </section>
                    {/* D9-a: consent records are for `consent.admin`; a Head Coach sees only the bootstrap flags. */}
                    {can(d.actor, "consent.admin") && (
                      <ConsentPanel playerId={player.id} />
                    )}
                    <section className="wb-inset">
                      <h3>Student details</h3>
                      <Info
                        items={[
                          {
                            label: "Date of birth",
                            value: player.profile.birthDate,
                            icon: CalendarDays,
                          },
                          {
                            label: "Email",
                            value: player.profile.email,
                            icon: Mail,
                          },
                          {
                            label: "Phone",
                            value: player.profile.phone,
                            icon: Phone,
                          },
                          {
                            label: "Preferences",
                            value: player.profile.preferences,
                          },
                          {
                            label: "Private staff notes",
                            value: player.profile.notes,
                          },
                        ]}
                      />
                    </section>
                  </div>
                  <div>
                    <section className="wb-inset">
                      <h3>
                        <Target size={17} />
                        Current goals
                      </h3>
                      {goals.length ? (
                        goals.map((g) => (
                          <p key={g.id} className="wb-goal">
                            <span /> {g.data.title}
                            <small>{g.data.method}</small>
                          </p>
                        ))
                      ) : (
                        <p className="muted">No active goals recorded.</p>
                      )}
                      <button
                        className="text-button"
                        onClick={() =>
                          p.nav("Training", `development:${player.id}`)
                        }
                      >
                        Open player development →
                      </button>
                    </section>
                    <section className="wb-inset">
                      <h3>Attendance summary</h3>
                      <div className="wb-attendance">
                        <div
                          className="wb-donut"
                          style={{
                            background: `conic-gradient(var(--green) ${marked ? (present / marked) * 360 : 0}deg,#e9eef0 0deg)`,
                          }}
                        >
                          <strong>
                            {marked
                              ? `${Math.round((present / marked) * 100)}%`
                              : "—"}
                          </strong>
                        </div>
                        <div>
                          <strong>{present} present</strong>
                          <p>{marked - present} absent / excused</p>
                          <small>{records.length - marked} not marked</small>
                        </div>
                      </div>
                      <ContextNote>
                        Based on saved attendance. No performance score
                        inferred.
                      </ContextNote>
                    </section>
                  </div>
                </div>
              ) : tab === "Development" ? (
                <>
                  <h3>Recorded sessions & evidence</h3>
                  {records.map((s) => (
                    <article key={s.id} className="wb-inset">
                      <button
                        className="text-button"
                        onClick={() => p.onSession(s.id)}
                      >
                        {s.data.title} →
                      </button>
                      <p>
                        {formatDate(s.data.localDate)} · {displayLabel(s.status)}
                      </p>
                      {s.data.observations
                        .filter((o) => o.playerId === player.id)
                        .map((o) => (
                          <p key={o.id}>
                            {o.text}
                            <small>Private · {o.author}</small>
                          </p>
                        ))}
                    </article>
                  ))}
                  <h3>Enrolment history</h3>
                  {d.history
                    .filter((h) => h.playerId === player.id)
                    .map((h) => (
                      <p key={h.id}>
                        {displayLabel(h.kind)} ·{" "}
                        {formatDate(h.createdAt)}
                      </p>
                    ))}
                </>
              ) : tab === "Fees" ? (
                <>
                  <h3>Player / family accounts</h3>
                  {d.permissions.finance ? (
                    d.invoices
                      .filter((i) => i.data.playerIds.includes(player.id))
                      .map((i) => (
                        <button
                          className="record-link"
                          key={i.id}
                          onClick={() => p.nav("Fees", i.id)}
                        >
                          <strong>{i.data.number}</strong>
                          <span>
                            {money(i.balance, i.data.currency)} outstanding ·{" "}
                            {formatDate(i.data.dueDate)}
                          </span>
                        </button>
                      ))
                  ) : (
                    <ContextNote>
                      Financial details are restricted to authorised accounts.
                    </ContextNote>
                  )}
                  <button className="secondary" onClick={() => p.nav("Fees")}>
                    Open fees workspace
                  </button>
                </>
              ) : (
                <>
                  <h3>Player reports</h3>
                  {d.reports
                    .filter((r) => r.playerId === player.id)
                    .map((r) => (
                      <button
                        key={r.id}
                        className="record-link"
                        onClick={() => p.nav("Reports", r.id)}
                      >
                        <strong>{r.data.title}</strong>
                        <span>
                          {displayLabel(r.status)} · {formatDate(r.data.periodStart)} –{" "}
                          {formatDate(r.data.periodEnd)}
                        </span>
                      </button>
                    ))}
                  <button
                    className="secondary"
                    onClick={() => p.nav("Reports")}
                  >
                    Open report workspace
                  </button>
                </>
              )}
            </>
          ) : (
            <Blank
              title="Select a player"
              text="Authorised profiles, guardian relationships and development records appear here."
              icon={Users}
            />
          )}
        </Pane>
      </div>
    </div>
  );
}
type CalendarRow = {
  id: string;
  title: string;
  date: string;
  time: string;
  duration: number;
  status: string;
  kind: string;
  coach: string;
  batch: string | null;
  branch: string;
  players: number;
  recurrence?: string;
  cancelReason?: string;
};
export function CalendarView(
  p: WorkspaceProps & {
    event: (id?: string) => void;
    schedule: (id: string, duplicate?: boolean) => void;
  },
) {
  const d = p.data;
  const all: CalendarRow[] = [
    ...d.sessions.map((s) => ({
      id: s.id,
      title: s.data.title || "Untitled draft",
      date: s.data.localDate,
      time: s.data.localTime,
      duration: s.data.duration,
      status: s.status,
      kind: "SESSION",
      coach: s.coachId,
      batch: s.batchId,
      branch: s.data.branchId,
      players: s.data.roster.length,
    })),
    ...d.events.map((e) => ({
      id: e.id,
      title: e.data.title,
      date: e.data.localDate,
      time: e.data.localTime,
      duration: e.data.duration,
      status: e.status,
      kind: e.kind,
      coach: e.data.coachId,
      batch: e.data.batchId,
      branch: e.data.branchId,
      players: e.data.playerIds.length,
      // Families receive events without these staff-only fields.
      recurrence: e.data.seriesId
        ? `Weekly series${"overrides" in e.data && e.data.overrides?.length ? " · changed individually" : ""}`
        : undefined,
      cancelReason: "cancellation" in e.data ? e.data.cancellation?.reason : undefined,
    })),
  ];
  const [date, setDate] = useState(
    all.find((r) => r.id === p.focusId)?.date || d.currentDate,
  );
  const [mode, setMode] = useState("Week");
  const [coach, setCoach] = useState("");
  const [batch, setBatch] = useState("");
  const [branch, setBranch] = useState(
    p.focusId?.startsWith("today:") ? p.focusId.slice(6) : "",
  );
  const [selectedId, setSelectedId] = useState(p.focusId ?? "");
  const start = new Date(date + "T12:00:00Z");
  if (mode === "Month") start.setUTCDate(1);
  else if (mode !== "Agenda") start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  // Agenda (UX W9): a plain list of what is coming, starting on the chosen date, so "what is on this fortnight" needs no grid.
  const count =
    mode === "Month"
      ? new Date(start.getUTCFullYear(), start.getUTCMonth() + 1, 0).getDate()
      : mode === "Agenda"
        ? 14
        : 7;
  const days = Array.from({ length: count }, (_, i) =>
    new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10),
  );
  const rows = all.filter(
    (r) =>
      days.includes(r.date) &&
      (!branch || r.branch === branch) &&
      (!coach || r.coach === coach) &&
      (!batch || r.batch === batch),
  );
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0];
  const minute = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    return Number.isFinite(h + m) ? h * 60 + m : 7 * 60;
  };
  const firstHour = Math.min(
    7,
    ...rows.map((r) => Math.floor(minute(r.time) / 60)),
  );
  const lastHour = Math.max(
    21,
    ...rows.map((r) => Math.ceil((minute(r.time) + r.duration) / 60)),
  );
  const hours = Array.from(
    { length: lastHour - firstHour },
    (_, i) => firstHour + i,
  );
  function placement(row: CalendarRow) {
    const same = rows
      .filter((r) => r.date === row.date)
      .sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
    const ends: number[] = [];
    let lane = 0;
    for (const r of same) {
      const m = minute(r.time);
      lane = ends.findIndex((end) => end <= m);
      if (lane < 0) lane = ends.length;
      ends[lane] = m + r.duration;
      if (r.id === row.id) break;
    }
    return {
      gridRow:
        Math.floor((minute(row.time) - firstHour * 60) / 15) +
        1 +
        " / span " +
        Math.max(4, Math.ceil(row.duration / 15)),
      gridColumn: lane + 1,
    };
  }

  function shift(delta: number) {
    const next = new Date(date + "T12:00:00Z");
    if (mode === "Month") {
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + delta);
    } else next.setUTCDate(next.getUTCDate() + delta * (mode === "Agenda" ? 14 : 7));
    setDate(next.toISOString().slice(0, 10));
  }
  return (
    <div className="reference-view">
      <Toolbar>
        <div className="button-row">
          <button
            className="secondary icon-button"
            aria-label="Previous calendar period"
            onClick={() => shift(-1)}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="secondary icon-button"
            aria-label="Next calendar period"
            onClick={() => shift(1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <label className="wb-date-control">
          Calendar date
          <input
            aria-label="Calendar date"
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </label>
        <Tabs items={["Week", "Month", "Agenda"]} value={mode} onChange={setMode} />
        <select
          aria-label="Calendar branch filter"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        >
          <option value="">All branches</option>
          {d.branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Calendar coach filter"
          value={coach}
          onChange={(e) => setCoach(e.target.value)}
        >
          <option value="">All coaches</option>
          {d.members
            .filter((m) => can(m, "sessions.coach"))
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
        </select>
        <select
          aria-label="Calendar batch filter"
          value={batch}
          onChange={(e) => setBatch(e.target.value)}
        >
          <option value="">All batches</option>
          {d.batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        {d.permissions.ops && (
          <button className="primary" onClick={() => p.event()}>
            ＋ Add event / closure
          </button>
        )}
      </Toolbar>
      <div className="calendar-workbench">
        <Pane className="wb-calendar-pane">
          {mode === "Agenda" ? (
            <div className="wb-agenda">
              {rows.length ? (
                days
                  .filter((day) => rows.some((r) => r.date === day))
                  .map((day) => (
                    <section key={day} aria-label={formatDate(day)}>
                      <h3>{formatDate(day)}{day === d.currentDate ? " · Today" : ""}</h3>
                      <ul>
                        {rows
                          .filter((r) => r.date === day)
                          .sort((a, b) => a.time.localeCompare(b.time))
                          .map((r) => (
                            <li key={r.id}>
                              <button
                                type="button"
                                className={`wb-agenda-item ${r.kind.toLowerCase()} ${selected?.id === r.id ? "selected" : ""}`}
                                aria-pressed={selected?.id === r.id}
                                onClick={() => setSelectedId(r.id)}
                              >
                                <span className="wb-agenda-time">{r.time}</span>
                                <strong>{d.batches.find((b) => b.id === r.batch)?.name ?? r.title}</strong>
                                <small>
                                  {r.duration} min · {r.kind === "SESSION" ? displayLabel(r.status) : displayLabel(r.kind)}
                                </small>
                              </button>
                            </li>
                          ))}
                      </ul>
                    </section>
                  ))
              ) : (
                <Blank
                  title="Nothing scheduled in these two weeks"
                  text={
                    branch || coach || batch
                      ? "No session or event matches the filters for these dates. Clear a filter or move to another period."
                      : "Sessions and events you add appear here, in date order."
                  }
                  icon={CalendarDays}
                  action={
                    d.permissions.ops
                      ? { label: "Add event or closure", onClick: () => p.event() }
                      : undefined
                  }
                />
              )}
            </div>
          ) : (
          <div
            className={`wb-calendar ${mode.toLowerCase()}`}
            style={
              { "--calendar-slots": hours.length * 4 } as React.CSSProperties
            }
          >
            {mode === "Week" && (
              <div className="wb-time-axis">
                <h3>Time</h3>
                {hours.map((h) => (
                  <span key={h}>{String(h).padStart(2, "0")}:00</span>
                ))}
              </div>
            )}
            {days.map((day) => (
              <div
                key={day}
                className={`wb-calendar-day ${day === d.currentDate ? "today" : ""}`}
                style={
                  mode === "Month" && day === days[0]
                    ? ({
                        "--month-start": ((start.getUTCDay() + 6) % 7) + 1,
                      } as React.CSSProperties)
                    : undefined
                }
              >
                <h3>
                  {new Date(day + "T12:00:00Z").toLocaleDateString("en-IN", {
                    weekday: "short",
                    day: "numeric",
                    month: mode === "Month" ? undefined : "short",
                    timeZone: "UTC",
                  })}
                </h3>
                <div>
                  {rows
                    .filter((r) => r.date === day)
                    .sort((a, b) => a.time.localeCompare(b.time))
                    .map((r) => (
                      <button
                        key={r.id}
                        className={`wb-calendar-event ${r.kind.toLowerCase()} ${selected?.id === r.id ? "selected" : ""}`}
                        style={mode === "Week" ? placement(r) : undefined}
                        onClick={() => setSelectedId(r.id)}
                      >
                        <strong>
                          {d.batches.find((b) => b.id === r.batch)?.name ??
                            r.title}
                        </strong>
                        <span>
                          {r.time} · {r.duration} min
                        </span>
                        <small>
                          {r.kind === "SESSION"
                            ? displayLabel(r.status)
                            : displayLabel(r.kind)}
                        </small>
                      </button>
                    ))}
                  {!rows.some((r) => r.date === day) && (
                    <span className="wb-day-empty">No sessions</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          )}
          <div className="wb-calendar-legend">
            {["SESSION", "TRIAL", "EVENT", "CLOSURE"].map((k) => (
              <span key={k}>
                <i className={k.toLowerCase()} />
                {k === "SESSION" ? "Training session" : k.toLowerCase()}
              </span>
            ))}
          </div>
        </Pane>
        <Pane title="Session details">
          {selected ? (
            <>
              <div className="wb-selected-session">
                <h3>{selected.title}</h3>
                <p>
                  {formatDate(selected.date)} · {selected.time}
                </p>
                <Status value={selected.status} />
              </div>
              <Info
                items={[
                  {
                    label: "Branch",
                    value: d.branches.find((b) => b.id === selected.branch)
                      ?.name,
                    icon: MapPin,
                  },
                  {
                    label: "Batch",
                    value: d.batches.find((b) => b.id === selected.batch)?.name,
                    icon: Users,
                  },
                  {
                    label: "Coach",
                    value: d.members.find((m) => m.id === selected.coach)?.name,
                    icon: Users,
                  },
                  {
                    label: "Participants",
                    value: `${selected.players} ${selected.kind === "SESSION" ? "published roster" : "assigned players"}`,
                    icon: Users,
                  },
                  {
                    label: "Duration",
                    value: `${selected.duration} minutes`,
                    icon: Clock,
                  },
                  ...(selected.recurrence
                    ? [{ label: "Repeats", value: selected.recurrence, icon: Clock }]
                    : []),
                  ...(selected.cancelReason
                    ? [{ label: "Cancellation reason", value: selected.cancelReason, icon: Clock }]
                    : []),
                ]}
              />
              <div className="wb-stacked-actions">
                {selected.kind === "SESSION" ? (
                  <>
                    <button
                      className="primary"
                      onClick={() => p.onSession(selected.id)}
                    >
                      Open in Training
                    </button>
                    {d.permissions.coaching &&
                      ["DRAFT", "PUBLISHED"].includes(selected.status) && (
                        <button
                          className="secondary"
                          onClick={() => p.schedule(selected.id)}
                        >
                          Edit session schedule
                        </button>
                      )}
                    {d.permissions.coaching && (
                      <button
                        className="secondary"
                        onClick={() => p.schedule(selected.id, true)}
                      >
                        Repeat weekly plan
                      </button>
                    )}
                  </>
                ) : (
                  d.permissions.ops && (
                    <button
                      className="primary"
                      onClick={() => p.event(selected.id)}
                    >
                      Edit / cancel event
                    </button>
                  )
                )}
                {d.permissions.coaching &&
                  selected.status !== "DRAFT" &&
                  (selected.kind === "SESSION" || selected.kind === "EVENT" || selected.kind === "TRIAL") && (
                    <button
                      className="secondary"
                      onClick={() =>
                        p.detail(
                          "Tell the coach and families",
                          <SessionShare kind={selected.kind === "SESSION" ? "SESSION" : "EVENT"} id={selected.id} />,
                        )
                      }
                    >
                      Tell the coach and families
                    </button>
                  )}
                {d.permissions.coaching && (
                  <button
                    className="secondary"
                    onClick={() => p.nav("Communications")}
                  >
                    Prepare family update
                  </button>
                )}
              </div>
            </>
          ) : (
            <Blank
              title="Select a session or event"
              text="Details and schedule actions appear alongside the calendar."
              icon={CalendarDays}
            />
          )}
          <CalendarLinkCard />
          <ContextNote>
            {d.academy.timezone}. Coach, player and closure conflicts are
            checked server-side. No court allocation.
          </ContextNote>
        </Pane>
      </div>
    </div>
  );
}
