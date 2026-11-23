"use client";
import { useState } from "react";
import {
  Users,
  CalendarDays,
  IndianRupee,
  FileText,
  UserRound,
  Clock,
  ChartNoAxesColumnIncreasing,
  Target,
  Play,
  Utensils,
  MapPin,
  Plus,
  ArrowRight,
  ChevronRight,
  CreditCard,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { WorkspaceProps } from "../context";
import { Status, money } from "../shared";
import { label as displayLabel } from "../labels";
import { Pane, Blank } from "../workbench";
import { SetupChecklist } from "./setup-checklist";

export function OverviewView(p: WorkspaceProps) {
  const d = p.data;
  const [branch, setBranch] = useState("");
  const batchIds = new Set(
    d.batches.filter((b) => !branch || b.branchId === branch).map((b) => b.id),
  );
  const players = d.players.filter((pl) => !branch || batchIds.has(pl.batchId));
  const playerIds = new Set(players.map((pl) => pl.id));
  const today = d.sessions
    .filter(
      (s) =>
        s.data.localDate === d.currentDate &&
        s.status !== "CANCELLED" &&
        (!branch || s.data.branchId === branch),
    )
    .sort((a, b) => a.data.localTime.localeCompare(b.data.localTime));
  // Coming up: the next two weeks of sessions after today, plus calendar events from today on (today's events are not in the
  // training table above). Cancelled items are left out; closures are shown because they change the week.
  const horizon = addDays(d.currentDate, 14);
  const coachName = (id: string) =>
    id ? d.members.find((m) => m.id === id)?.name || "Assigned coach" : "";
  const comingSessions: Coming[] = d.sessions
    .filter(
      (s) =>
        s.data.localDate > d.currentDate &&
        s.data.localDate <= horizon &&
        s.status !== "CANCELLED" &&
        (!branch || s.data.branchId === branch),
    )
    .map((s) => ({
      key: `s${s.id}`,
      date: s.data.localDate,
      time: s.data.localTime,
      duration: s.data.duration,
      title:
        d.batches.find((b) => b.id === s.batchId)?.name ||
        s.data.title ||
        "Untitled draft",
      sub:
        s.data.title ||
        d.branches.find((b) => b.id === s.data.branchId)?.name ||
        "",
      coach: coachName(s.coachId),
      status: s.status,
      kind: "Session",
      open: () => p.onSession(s.id),
    }));
  const comingEvents: Coming[] = d.events
    .filter(
      (e) =>
        e.data.localDate >= d.currentDate &&
        e.data.localDate <= horizon &&
        e.status !== "CANCELLED" &&
        (!branch || !e.data.branchId || e.data.branchId === branch),
    )
    .map((e) => ({
      key: `e${e.id}`,
      date: e.data.localDate,
      time: e.data.localTime,
      duration: e.data.duration,
      title: e.data.title || (e.kind === "CLOSURE" ? "Academy closed" : "Event"),
      sub: d.branches.find((b) => b.id === e.data.branchId)?.name || "",
      coach: coachName(e.data.coachId),
      status: e.status,
      kind:
        e.kind === "CLOSURE" ? "Closed" : e.kind === "TRIAL" ? "Trial" : "Event",
      open: () => p.nav("Calendar", `today:${branch}`),
    }));
  const coming = [...comingSessions, ...comingEvents].sort((a, b) =>
    `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`),
  );
  const nextUp = coming[0];
  const reports =
    d.permissions.ops && d.enabled.reports
      ? d.reports.filter(
          (r) => r.status === "IN_REVIEW" && playerIds.has(r.playerId),
        )
      : [];
  const invoices = d.permissions.finance
    ? d.invoices.filter(
        (i) => !branch || i.data.playerIds.some((id) => playerIds.has(id)),
      )
    : [];
  const invoiceIds = new Set(invoices.map((i) => i.id));
  const payments = d.payments.filter(
    (pay) => invoiceIds.has(pay.invoiceId) && pay.status === "SUBMITTED",
  );
  const outstanding = invoices
    .filter((i) => i.data.currency === d.settings.data.currency)
    .reduce((sum, i) => sum + Math.max(0, i.balance), 0);
  // Enquiries do not have a branch until a trial is assigned; keep unassigned enquiries in All branches only.
  const enquiries = d.permissions.ops
    ? d.enquiries.filter(
        (e) =>
          !branch ||
          d.events.some(
            (ev) =>
              ev.id === e.data.trialEventId && ev.data.branchId === branch,
          ),
      )
    : [];
  const followUps = enquiries.filter(
    (e) =>
      !["CLOSED", "ENROLLED"].includes(e.status) &&
      e.data.followUpDate &&
      e.data.followUpDate <= d.currentDate,
  );
  const trials = enquiries.filter((e) => e.status === "TRIAL");
  const messages = d.enabled.communications
    ? d.messages
        .filter(
          (m) =>
            !branch ||
            m.data.playerIds.some((id) => playerIds.has(id)) ||
            m.data.batchIds.some((id) => batchIds.has(id)) ||
            m.data.allBatches,
        )
        .slice()
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        .slice(0, 2)
    : [];
  const nutrition =
    d.enabled.nutrition &&
    (d.permissions.professional || d.permissions.coaching)
      ? d.nutrition.filter(
          (n) => n.status === "IN_REVIEW" && playerIds.has(n.playerId),
        )
      : [];
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: d.academy.timezone,
    }).format(new Date()),
  );
  const date = new Date(d.currentDate + "T12:00:00Z").toLocaleDateString(
    "en-GB",
    { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" },
  );
  const review = () => p.nav("Reports", `filter:review|${branch}`);
  const admissions = (filter = "") =>
    p.nav("Admissions", `filter:${filter || "All"}|${branch}`);
  const calendar = () => p.nav("Calendar", `today:${branch}`);
  return (
    <div className="reference-view overview-view ov-dashboard">
      <header className="ov-header">
        <div>
          <h1>
            Good {hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"},{" "}
            {d.actor.name.split(" ")[0]}
          </h1>
          <p>Here’s what’s happening at your academy today.</p>
        </div>
        <div className="ov-header-actions">
          <label className="ov-branch">
            <MapPin size={19} />
            <select
              aria-label="Overview branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              disabled={!d.branches.length}
            >
              <option value="">
                {d.branches.length ? "All branches" : "No branches available"}
              </option>
              {d.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <span className="ov-date">
            <CalendarDays size={19} />
            {date}
          </span>
          <button
            className="primary"
            disabled={!d.permissions.coaching || p.busy}
            title={
              !d.permissions.coaching
                ? "Session creation requires coaching access"
                : undefined
            }
            onClick={() => p.nav("Training", "new-session")}
          >
            <Plus size={22} />
            Create session
          </button>
        </div>
      </header>
      <SetupChecklist {...p} />
      <div className="ov-metrics">
        <Metric
          icon={Users}
          label="Active players"
          value={players.filter((pl) => pl.profile.status === "ACTIVE").length}
          onClick={() => p.nav("Players", `filter:active|${branch}`)}
          help="Current active enrolments"
        />
        <Metric
          icon={CalendarDays}
          tone="blue"
          label="Sessions today"
          value={today.length}
          onClick={calendar}
          help="All non-cancelled sessions on the academy’s local date"
        />
        <Metric
          icon={IndianRupee}
          tone="amber"
          label="Outstanding fees"
          value={
            d.permissions.finance
              ? money(outstanding, d.settings.data.currency)
              : "Restricted"
          }
          onClick={
            d.permissions.finance
              ? () => p.nav("Fees", `filter:outstanding|${branch}`)
              : undefined
          }
          help="Unpaid balances, including overdue; family invoices may span branches"
        />
        <Metric
          icon={FileText}
          tone="purple"
          label="Reports to review"
          value={
            d.permissions.ops && d.enabled.reports
              ? reports.length
              : "Unavailable"
          }
          onClick={d.permissions.ops && d.enabled.reports ? review : undefined}
          help="Reports submitted for coach review"
        />
      </div>
      <div className="ov-main-grid">
        <Pane
          title="Today’s training"
          className="ov-training"
          action={
            <button className="text-button" onClick={calendar}>
              View calendar <ArrowRight size={17} />
            </button>
          }
        >
          {today.length ? (
            <div className="ov-training-table">
              <div className="ov-training-head">
                <span>Session</span>
                <span>Time</span>
                <span>Coach</span>
                <span>Players</span>
                <span>Status</span>
              </div>
              {today.map((s, i) => {
                const batch = d.batches.find((b) => b.id === s.batchId);
                const coach =
                  d.members.find((m) => m.id === s.coachId)?.name ||
                  "Assigned coach";
                const count =
                  s.status === "DRAFT"
                    ? d.players.filter(
                        (pl) =>
                          pl.batchId === s.batchId &&
                          pl.profile.status === "ACTIVE",
                      ).length
                    : s.data.roster.length;
                return (
                  <button
                    key={s.id}
                    className={`ov-training-row accent-${i % 3}`}
                    onClick={() => p.onSession(s.id)}
                  >
                    <span className="ov-session-name">
                      <strong>
                        {batch?.name || s.data.title || "Untitled draft"}
                      </strong>
                      <small>
                        {s.data.title ||
                          d.branches.find((b) => b.id === s.data.branchId)
                            ?.name}
                      </small>
                    </span>
                    <span data-label="Time">
                      {timeRange(s.data.localTime, s.data.duration)}
                    </span>
                    <span data-label="Coach" className="ov-coach">
                      <i>{coach[0]}</i>
                      {coach}
                    </span>
                    <span
                      data-label="Players"
                      title={
                        s.status === "DRAFT"
                          ? "Active batch players; roster is fixed on publication"
                          : "Published roster"
                      }
                    >
                      {count}
                    </span>
                    <span data-label="Status">
                      <Status value={s.status} />
                    </span>
                    <ChevronRight size={16} />
                  </button>
                );
              })}
            </div>
          ) : (
            <Blank
              title="No training scheduled today"
              text={
                nextUp
                  ? `Next up: ${nextUp.title} · ${dayLabel(nextUp.date, d.currentDate)}${nextUp.time ? `, ${timeRange(nextUp.time, nextUp.duration)}` : ""}. See “Coming up” below.`
                  : "View the calendar or create a session to plan your next training."
              }
              icon={CalendarDays}
            />
          )}
        </Pane>
        <Pane
          title="Coming up"
          className="ov-upcoming"
          action={
            <button className="text-button" onClick={calendar}>
              Open calendar <ArrowRight size={17} />
            </button>
          }
        >
          {coming.length ? (
            <div className="ov-up-list">
              {coming.slice(0, 8).map((c) => (
                <button key={c.key} className="ov-up-row" onClick={c.open}>
                  <span className="ov-up-date">
                    <strong>{dayLabel(c.date, d.currentDate)}</strong>
                    <small>{c.time ? timeRange(c.time, c.duration) : "All day"}</small>
                  </span>
                  <span className="ov-session-name">
                    <strong>{c.title}</strong>
                    <small>
                      {[c.kind, c.sub, c.coach].filter(Boolean).join(" · ")}
                    </small>
                  </span>
                  <span>
                    <Status value={c.status} />
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}
              {coming.length > 8 && (
                <button className="text-button ov-up-more" onClick={calendar}>
                  +{coming.length - 8} more in the next 2 weeks
                </button>
              )}
            </div>
          ) : (
            <Blank
              title="Nothing scheduled in the next 2 weeks"
              text="Create a session or add a calendar event to see it here."
              icon={CalendarDays}
            />
          )}
        </Pane>
        <Pane title="Needs your attention" className="ov-attention">
          {d.permissions.ops && (
            <Attention
              icon={UserRound}
              tone="rose"
              label={`${followUps.length} admission follow-ups due`}
              detail="Due today or earlier; awaiting a response."
              action="View trials"
              onClick={() => admissions("follow-up")}
            />
          )}
          {d.permissions.finance && (
            <Attention
              icon={CreditCard}
              tone="amber"
              label={`${payments.length} payments awaiting verification`}
              detail="Submitted references remain unverified."
              action="Review payments"
              onClick={() => p.nav("Fees", `filter:submitted|${branch}`)}
            />
          )}
          {d.permissions.ops && d.enabled.reports && (
            <Attention
              icon={FileText}
              tone="blue"
              label={`${reports.length} reports awaiting review`}
              detail={
                reports.length
                  ? "Player reports are ready for your feedback."
                  : "No reports are waiting for review."
              }
              action="View reports"
              onClick={review}
            />
          )}
          {!d.permissions.ops && !d.permissions.finance && (
            <p className="muted">No review actions available for your role.</p>
          )}
        </Pane>
      </div>
      <div className="ov-lower-grid">
        <Pane title="Admissions & trials" action={<ChevronRight size={18} />}>
          {d.permissions.ops ? (
            <>
              <div className="ov-mini-grid">
                <Mini
                  icon={UserRound}
                  label="New enquiries"
                  value={enquiries.filter((e) => e.status === "ENQUIRY").length}
                  help="Current enquiries"
                  onClick={() => admissions("ENQUIRY")}
                />
                <Mini
                  icon={CalendarDays}
                  tone="blue"
                  label="Trials booked"
                  value={trials.length}
                  help="Current trial stage"
                  onClick={() => admissions("TRIAL")}
                />
                <Mini
                  icon={Clock}
                  tone="rose"
                  label="Follow-ups due"
                  value={followUps.length}
                  help="Due today or earlier"
                  onClick={() => admissions("follow-up")}
                />
              </div>
              <button className="primary ov-full" onClick={() => admissions()}>
                Open admissions <ArrowRight size={17} />
              </button>
              {branch && (
                <small className="ov-scope-note">
                  Assigned trials only. Unassigned enquiries appear in All
                  branches.
                </small>
              )}
            </>
          ) : (
            <p className="ov-restricted">
              Admissions requires operations access.
            </p>
          )}
        </Pane>
        <Pane title="Player development" action={<ChevronRight size={18} />}>
          <div className="ov-development-grid">
            <Mini
              icon={ChartNoAxesColumnIncreasing}
              label="Reports ready to review"
              value={
                d.permissions.ops && d.enabled.reports ? reports.length : "—"
              }
              help="Submitted for review"
              onClick={
                d.permissions.ops && d.enabled.reports ? review : undefined
              }
            />
            <Mini
              icon={Target}
              label="Individual goals"
              value={
                d.permissions.coaching
                  ? d.goals.filter(
                      (g) =>
                        playerIds.has(g.playerId) && g.data.status === "ACTIVE",
                    ).length
                  : "—"
              }
              help="Active · no review dates recorded"
              onClick={
                d.permissions.coaching
                  ? () =>
                      p.nav("Training", "development:" + (players[0]?.id || ""))
                  : undefined
              }
            />
          </div>
          <button
            className="secondary ov-full"
            disabled={!d.permissions.ops || !d.enabled.reports}
            onClick={review}
          >
            View reports <ArrowRight size={17} />
          </button>
        </Pane>
        <Pane title="Recent parent updates" action={<ChevronRight size={18} />}>
          <div className="ov-updates">
            {messages.length ? (
              messages.map((m) => (
                <button
                  key={m.id}
                  onClick={() => p.nav("Communications", m.id)}
                >
                  <Bubble
                    icon={FileText}
                    tone={m.status === "DRAFT" ? "blue" : "green"}
                  />
                  <span>
                    <strong>{m.data.subject}</strong>
                    <small>{displayLabel(m.status)}</small>
                  </span>
                  <time>
                    {m.updatedAt
                      ? new Date(m.updatedAt).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          timeZone: d.academy.timezone,
                        })
                      : ""}
                  </time>
                  <ChevronRight size={15} />
                </button>
              ))
            ) : (
              <p className="muted">
                {d.enabled.communications
                  ? "No parent updates recorded for this selection."
                  : "Communications is unavailable."}
              </p>
            )}
          </div>
          <button
            className="secondary ov-full"
            disabled={!d.enabled.communications}
            onClick={() => p.nav("Communications")}
          >
            View communications <ArrowRight size={17} />
          </button>
        </Pane>
      </div>
      <div className="ov-bottom">
        <div>
          <Bubble icon={Play} />
          <span>
            <strong>
              AI Analysis <span>· Coming Soon</span>
            </strong>
            <small>
              Video analysis and AI insights will be available soon.
            </small>
          </span>
        </div>
        {d.enabled.nutrition &&
          (d.permissions.professional || d.permissions.coaching) && (
            <div>
              <Bubble icon={Utensils} />
              <span>
                <strong>
                  Nutrition plans{" "}
                  <span>· {nutrition.length} awaiting review</span>
                </strong>
                <small>
                  {d.permissions.professional
                    ? "Review pending nutrition plans from your coaches."
                    : "Awaiting professional review before sharing."}
                </small>
              </span>
              <button className="secondary" onClick={() => p.nav("Nutrition")}>
                View nutrition <ArrowRight size={16} />
              </button>
            </div>
          )}
      </div>
    </div>
  );
}
function Bubble({
  icon: Icon,
  tone = "green",
}: {
  icon: LucideIcon;
  tone?: string;
}) {
  return (
    <span className={`ov-bubble ${tone}`}>
      <Icon size={25} />
    </span>
  );
}
function Metric({
  icon,
  label,
  value,
  tone,
  onClick,
  help,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  tone?: string;
  onClick?: () => void;
  help: string;
}) {
  return (
    <button
      className="ov-metric"
      onClick={onClick}
      disabled={!onClick}
      title={help}
    >
      <Bubble icon={icon} tone={tone} />
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
      {onClick && <ChevronRight size={18} />}
    </button>
  );
}
function Mini({
  icon,
  label,
  value,
  tone,
  help,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  tone?: string;
  help: string;
  onClick?: () => void;
}) {
  return (
    <button className="ov-mini" disabled={!onClick} onClick={onClick}>
      <Bubble icon={icon} tone={tone} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{help}</small>
    </button>
  );
}
function Attention({
  icon,
  tone,
  label,
  detail,
  action,
  onClick,
}: {
  icon: LucideIcon;
  tone: string;
  label: string;
  detail: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <div className="ov-attention-row">
      <Bubble icon={icon} tone={tone} />
      <div>
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
      <button className="secondary" onClick={onClick}>
        {action}
        <ArrowRight size={16} />
      </button>
    </div>
  );
}
type Coming = {
  key: string;
  date: string;
  time: string;
  duration: number;
  title: string;
  sub: string;
  coach: string;
  status: string;
  kind: string;
  open: () => void;
};
/** YYYY-MM-DD plus a number of days (calendar arithmetic in UTC, so no daylight-saving drift). */
function addDays(date: string, days: number) {
  const x = new Date(`${date}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + days);
  return x.toISOString().slice(0, 10);
}
/** "Tomorrow", or a short weekday and date such as "Thu 19 Nov". */
function dayLabel(date: string, today: string) {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
function timeRange(time: string, minutes: number) {
  if (!time) return "Time not set";
  const [h, m] = time.split(":").map(Number);
  const fmt = (n: number) =>
    `${Math.floor((n % 1440) / 60) % 12 || 12}:${String(n % 60).padStart(2, "0")} ${n % 1440 < 720 ? "AM" : "PM"}`;
  return `${fmt(h * 60 + m)} – ${fmt(h * 60 + m + minutes)}`;
}
