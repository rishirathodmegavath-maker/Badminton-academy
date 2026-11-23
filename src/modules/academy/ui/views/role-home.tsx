"use client";
import {
  Apple,
  ArrowRight,
  CalendarDays,
  CircleCheck,
  FileText,
  MessageCircleQuestion,
  Users,
  Wallet,
  Activity,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { WorkspaceProps } from "../context";
import { Status, money } from "../shared";
import { Pane, Blank } from "../workbench";
import { authorityOf } from "../../../identity/authority";

/**
 * Home for the roles that do not use the academy-wide Overview: a Coach, Finance and a Nutrition Pro. It only
 * summarises records the server already placed in this person's read model (no extra requests, nothing else is
 * revealed), and every action leads to a module that role is allowed to open.
 */
function Metric({
  icon: Icon,
  label,
  value,
  hint,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  hint: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="rh-icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <span className="rh-metric-text">
        <span className="rh-label">{label}</span>
        <strong>{value}</strong>
        <small>{hint}</small>
      </span>
    </>
  );
  return onClick ? (
    <button type="button" className="rh-metric" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="rh-metric">{body}</div>
  );
}

function Welcome({ p, line }: { p: WorkspaceProps; line: string }) {
  const d = p.data;
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: d.academy.timezone,
    }).format(new Date()),
  );
  const first = d.actor.name.split(" ")[0];
  const when = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const date = new Date(d.currentDate + "T12:00:00Z").toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  return (
    <header className="rh-welcome">
      <div>
        <h1>
          {when}, {first}
        </h1>
        <p>{line}</p>
      </div>
      <span className="ax-pill">
        <CalendarDays size={14} aria-hidden="true" />
        {date}
      </span>
    </header>
  );
}

export function RoleHome(p: WorkspaceProps) {
  const d = p.data;
  // The staff designation derived by the authority module (RC-5), never a role string compared here.
  const designation = authorityOf(d.actor.role)?.designation;
  if (designation === "FINANCE") return <FinanceHome {...p} />;
  if (designation === "NUTRITION_PRO") return <NutritionHome {...p} />;
  return <CoachHome {...p} />;
}

function CoachHome(p: WorkspaceProps) {
  const d = p.data;
  const today = d.sessions
    .filter((s) => s.data.localDate === d.currentDate && s.status !== "CANCELLED")
    .sort((a, b) => a.data.localTime.localeCompare(b.data.localTime));
  const unmarked = today
    .filter((s) => ["PUBLISHED", "IN_PROGRESS"].includes(s.status))
    .reduce(
      (sum, s) =>
        sum +
        s.data.roster.filter(
          (r) => !["PRESENT", "ABSENT", "EXCUSED"].includes(s.data.attendance[r.id] ?? "NOT_MARKED"),
        ).length,
      0,
    );
  const drafts = d.enabled.reports ? d.reports.filter((r) => r.status === "DRAFT").length : 0;
  return (
    <div className="rh">
      <Welcome p={p} line="Your sessions, players and the follow-ups waiting for you." />
      <div className="rh-grid">
        <Metric icon={CalendarDays} label="Sessions today" value={today.length} hint="Published, in progress or completed" onClick={() => p.nav("Training")} />
        <Metric icon={CircleCheck} label="Attendance to mark" value={unmarked} hint="Players not yet marked in today’s sessions" onClick={() => p.nav("Training")} />
        <Metric icon={Users} label="My players" value={d.players.length} hint="In the batches you coach" onClick={() => p.nav("Players")} />
        {d.enabled.reports && <Metric icon={FileText} label="Report drafts" value={drafts} hint="Waiting for your commentary" onClick={() => p.nav("Reports")} />}
      </div>
      <div className="rh-columns">
        <Pane title="Today’s sessions" action={<button type="button" className="text-button" onClick={() => p.nav("Calendar")}>Open calendar</button>}>
          {today.length ? (
            <ul className="rh-list">
              {today.map((s) => (
                <li key={s.id}>
                  <div>
                    <strong>{s.data.title || "Untitled session"}</strong>
                    <small>
                      {s.data.localTime} · {s.data.duration} min · {s.data.roster.length} players
                    </small>
                  </div>
                  <Status value={s.status} />
                  <button type="button" className="secondary" onClick={() => p.onSession(s.id)}>
                    Open<span className="sr-only"> {s.data.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Blank title="No training scheduled today" text="Plan a session in Training Studio or open the calendar for upcoming dates." icon={CalendarDays} />
          )}
        </Pane>
        <Pane title="Quick actions">
          <div className="rh-actions">
            <button type="button" className="primary" onClick={() => p.nav("Training", "new-session")}>
              <Activity size={17} aria-hidden="true" /> New session
            </button>
            <button type="button" className="secondary" onClick={() => p.nav("Players")}>
              <Users size={17} aria-hidden="true" /> Players
            </button>
            {d.enabled.reports && (
              <button type="button" className="secondary" onClick={() => p.nav("Reports")}>
                <FileText size={17} aria-hidden="true" /> Reports
              </button>
            )}
            {d.enabled.communications && (
              <button type="button" className="secondary" onClick={() => p.nav("Communications")}>
                <ArrowRight size={17} aria-hidden="true" /> Message families
              </button>
            )}
          </div>
        </Pane>
      </div>
    </div>
  );
}

function FinanceHome(p: WorkspaceProps) {
  const d = p.data;
  const currency = d.settings.data.currency;
  const submitted = d.payments.filter((pay) => pay.status === "SUBMITTED");
  return (
    <div className="rh">
      <Welcome p={p} line="Money owed, money waiting to be verified and the records behind both." />
      <div className="rh-grid">
        <Metric icon={Wallet} label="Outstanding" value={money(d.summary.outstanding, currency)} hint="Overdue is included" onClick={() => p.nav("Fees")} />
        <Metric icon={CalendarDays} label="Overdue" value={money(d.summary.overdue, currency)} hint="Past the due date" onClick={() => p.nav("Fees")} />
        <Metric icon={CircleCheck} label="To verify" value={d.summary.pendingPayments} hint="Payment references awaiting independent verification" onClick={() => p.nav("Fees")} />
      </div>
      <Pane title="Payments waiting for verification" action={<button type="button" className="text-button" onClick={() => p.nav("Fees")}>Open fees</button>}>
        {submitted.length ? (
          <ul className="rh-list">
            {submitted.map((pay) => (
              <li key={pay.id}>
                <div>
                  <strong>{d.invoices.find((i) => i.id === pay.invoiceId)?.data.number ?? "Invoice"}</strong>
                  <small>
                    {money(pay.data.amount, pay.data.currency)} · reference {pay.data.reference}
                  </small>
                </div>
                <Status value={pay.status} />
              </li>
            ))}
          </ul>
        ) : (
          <Blank title="Nothing to verify" text="Submitted payment references appear here until someone other than the submitter verifies them." icon={CircleCheck} />
        )}
      </Pane>
    </div>
  );
}

function NutritionHome(p: WorkspaceProps) {
  const d = p.data;
  const open = d.questions.filter((q) => !q.answer);
  const review = d.nutrition.filter((n) => n.status === "IN_REVIEW");
  return (
    <div className="rh">
      <Welcome p={p} line="The players assigned to you, their plans and the questions families have asked." />
      <div className="rh-grid">
        <Metric icon={Users} label="Assigned players" value={d.players.length} hint="Only players assigned to you appear" onClick={() => p.nav("Nutrition")} />
        <Metric icon={Apple} label="Plans in review" value={review.length} hint="Waiting for your professional approval" onClick={() => p.nav("Nutrition")} />
        <Metric icon={MessageCircleQuestion} label="Open questions" value={open.length} hint="Family questions without an answer" onClick={() => p.nav("Nutrition")} />
      </div>
      <Pane title="Questions from families" action={<button type="button" className="text-button" onClick={() => p.nav("Nutrition")}>Open nutrition</button>}>
        {open.length ? (
          <ul className="rh-list">
            {open.slice(0, 6).map((q) => (
              <li key={q.id}>
                <div>
                  <strong>{d.players.find((pl) => pl.id === q.playerId)?.name ?? "Player"}</strong>
                  <small>{q.question}</small>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Blank title="No open questions" text="Private questions from a player’s family appear here until you answer them." icon={MessageCircleQuestion} />
        )}
      </Pane>
    </div>
  );
}
