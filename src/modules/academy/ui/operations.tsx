"use client";
import {
  OverviewView,
  AdmissionsView,
  PlayersView,
  CalendarView,
} from "./views/operations-view";
import { RoleHome } from "./views/role-home";
import { can } from "../../identity/authority";
import { seesAcademyOverview } from "./navigation";

import type { WorkspaceProps } from "./context";
import { options, choices, text, number, flag, list, Field, academyRequest, type Values } from "./shared";
import { formatDate } from "./labels";
import { PlayerLinkCard } from "./player-link-card";
/** DEC-3: the server's preview of cancelling the following / all occurrences of a series. */
type CancellationPreview = {
  cancel: { id: string; localDate: string; localTime: string }[];
  cancelCount: number;
  skipped: { id: string; localDate: string; localTime: string; fields: string[] }[];
  skippedCount: number;
  overwriteExceptions: boolean;
  previewToken: string;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
function CancellationSummary({ preview }: { preview: CancellationPreview }) {
  return (
    <div className="cancellation-preview">
      <p>
        <strong>{plural(preview.cancelCount, "occurrence")} will be cancelled</strong>
        {preview.cancelCount ? `: ${preview.cancel.map((o) => formatDate(o.localDate)).join(", ")}.` : "."}
      </p>
      {preview.skippedCount ? (
        <>
          <p>
            <strong>
              {plural(preview.skippedCount, "occurrence")} changed individually will stay scheduled
            </strong>{" "}
            unless you go back and tick “Also overwrite occurrences that were changed individually”:
          </p>
          <ul>
            {preview.skipped.map((o) => (
              <li key={o.id}>
                {formatDate(o.localDate)} at {o.localTime} (changed: {o.fields.join(", ")})
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>
          {preview.overwriteExceptions
            ? "Occurrences changed individually are cancelled too."
            : "No occurrence changed individually is affected."}
        </p>
      )}
      <p className="muted">Occurrences that have already started are never changed.</p>
    </div>
  );
}
const coachOptions = (p: WorkspaceProps) =>
  options(
    // Who may be assigned as coach: the same rule the server applies (`sessions.coach`, canCoach).
    p.data.members.filter((m) => m.active && can(m, "sessions.coach")),
  );
const playerOptions = (p: WorkspaceProps) => options(p.data.players);
/** The owner's age-review decision is not part of the player form: only the age review can change it. */
const withoutAgeDecision = <T extends object>(profile: T): Omit<T, "ageDecision"> => {
  const { ageDecision: _ignored, ...rest } = profile as T & { ageDecision?: unknown };
  void _ignored;
  return rest;
};
export function Overview(p: WorkspaceProps) {
  // The academy-wide overview is for staff whose player scope is the whole academy (Owner, Administrator, Head
  // Coach); Coach, Finance and Nutrition Pro have their own home.
  return seesAcademyOverview(p.data.actor.role) ? (
    <OverviewView {...p} />
  ) : (
    <RoleHome {...p} />
  );
}
const enquiryFields: Field[] = [
  { name: "name", label: "Player / prospect name", required: true },
  { name: "email", label: "Contact email", kind: "email" },
  { name: "phone", label: "Contact phone" },
  { name: "source", label: "Enquiry source" },
  { name: "followUpDate", label: "Follow-up date", kind: "date" },
  {
    name: "notes",
    label: "Private follow-up notes",
    kind: "textarea",
    max: 2000,
  },
];
export function Admissions(p: WorkspaceProps) {
  const blank = {
    name: "",
    email: "",
    phone: "",
    adult: false,
    source: "",
    followUpDate: "",
    notes: "",
    trialAttendance: "NOT_MARKED",
    feedback: "",
  };
  function edit(id?: string) {
    const e = p.data.enquiries.find((e) => e.id === id);
    p.open({
      title: e ? "Update enquiry" : "New enquiry",
      initial: { ...(e?.data ?? blank), status: e?.status ?? "ENQUIRY" },
      fields: [
        ...enquiryFields,
        ...(e
          ? [
              {
                name: "status",
                label: "Enquiry status",
                kind: "select" as const,
                options: choices(["ENQUIRY", "TRIAL", "WAITLIST", "CLOSED"]),
              },
              {
                name: "trialAttendance",
                label: "Trial attendance",
                kind: "select" as const,
                options: choices([
                  "NOT_MARKED",
                  "PRESENT",
                  "ABSENT",
                  "EXCUSED",
                ]),
              },
              {
                name: "feedback",
                label: "Trial feedback",
                kind: "textarea" as const,
                max: 2000,
              },
            ]
          : []),
      ],
      submit: (v) =>
        p.mutate("/admissions/save", {
          id: e?.id,
          version: e?.version,
          status: text(v, "status"),
          data: {
            ...blank,
            name: text(v, "name"),
            email: text(v, "email"),
            phone: text(v, "phone"),
            adult: false,
            source: text(v, "source"),
            followUpDate: text(v, "followUpDate"),
            notes: text(v, "notes"),
            trialAttendance: text(v, "trialAttendance"),
            feedback: text(v, "feedback"),
          },
        }),
    });
  }
  function trial(id: string) {
    const e = p.data.enquiries.find((e) => e.id === id)!;
    p.open({
      title: `Schedule trial · ${e.data.name}`,
      initial: {
        localDate: p.data.currentDate,
        localTime: "17:00",
        duration: "30",
        branchId: p.data.branches[0]?.id ?? "",
        coachId: p.data.members.find((m) => m.role === "COACH")?.id ?? "",
      },
      fields: [
        {
          name: "localDate",
          label: "Trial date",
          kind: "date",
          required: true,
        },
        {
          name: "localTime",
          label: "Trial time",
          kind: "time",
          required: true,
        },
        {
          name: "duration",
          label: "Trial duration (minutes)",
          kind: "number",
          required: true,
          min: 1,
          max: 180,
        },
        {
          name: "branchId",
          label: "Branch",
          kind: "select",
          options: options(p.data.branches),
          required: true,
        },
        {
          name: "coachId",
          label: "Coach",
          kind: "select",
          options: coachOptions(p),
          required: true,
        },
      ],
      notice: `All times use ${p.data.academy.timezone}. Coach and closure conflicts are checked on the server.`,
      submit: (v) =>
        p.mutate("/admissions/trial", {
          id: e.id,
          version: e.version,
          event: {
            kind: "TRIAL",
            title: `Trial · ${e.data.name}`,
            localDate: text(v, "localDate"),
            localTime: text(v, "localTime"),
            duration: number(v, "duration"),
            branchId: text(v, "branchId"),
            coachId: text(v, "coachId"),
            batchId: "",
            playerIds: [],
            enquiryId: e.id,
            repeatWeeks: 1,
          },
        }),
    });
  }
  return <AdmissionsView {...p} edit={edit} trial={trial} />;
}
export function Players(p: WorkspaceProps) {
  /** "Add player" by invitation link: staff choose the batch; the player signs in through the link and fills in their own details. */
  function playerLink() {
    p.open({
      title: "Invite a player with a link",
      initial: { batchId: "", expiresInDays: "3" },
      fields: [
        {
          name: "batchId",
          label: "Batch / training placement",
          kind: "select",
          options: options(p.data.batches),
          required: true,
          help: "The player is placed in this batch when they save their details.",
        },
        {
          name: "expiresInDays",
          label: "Link works for",
          kind: "select",
          options: [
            { value: "1", label: "1 day" },
            { value: "3", label: "3 days" },
            { value: "7", label: "7 days" },
          ],
        },
      ],
      notice:
        "Whoever opens the link first signs in with any email and becomes this player's own login. The link works once and is shown only on the next screen. The player then fills in their own details; parents are linked afterwards in the usual way.",
      button: "Create link",
      submit: async (v) => {
        try {
          const made = await academyRequest<{ link: string; expiresAt: string }>("/invitations/player-link", {
            batchId: text(v, "batchId"),
            expiresInDays: Number(text(v, "expiresInDays")),
          });
          p.detail("Player invitation link", <PlayerLinkCard link={made.link} expiresAt={made.expiresAt} />);
          return true;
        } catch (e) {
          p.error((e as Error).message);
          return false;
        }
      },
    });
  }
  function edit(id?: string) {
    const player = p.data.players.find((pl) => pl.id === id);
    p.open({
      title: player ? `Edit ${player.name}` : "Add player",
      initial: {
        name: player?.name ?? "",
        batchId: player?.batchId ?? "",
        ...withoutAgeDecision(player?.profile ?? {
          adult: false,
          birthDate: "",
          email: "",
          phone: "",
          notes: "",
          status: "ACTIVE",
          selfUserId: "",
          preferences: "",
        }),
        selfUserId: "",
      },
      fields: [
        { name: "name", label: "Player name", required: true },
        {
          name: "batchId",
          label: "Batch / training placement",
          kind: "select",
          options: options(p.data.batches),
          required: true,
        },
        {
          name: "birthDate",
          label: "Date of birth (players must be under 18)",
          kind: "date",
          required: true,
        },
        { name: "email", label: "Player email", kind: "email" },
        { name: "phone", label: "Player phone" },
        {
          name: "status",
          label: "Enrolment status",
          kind: "select",
          options: choices(["ACTIVE", "PAUSED", "ARCHIVED"]),
        },
        {
          name: "preferences",
          label: "Player preferences",
          kind: "textarea",
          max: 2000,
        },
        {
          name: "notes",
          label: "Private staff notes",
          kind: "textarea",
          max: 2000,
        },
      ],
      notice: player ? undefined : (
        <span>
          Prefer the player to fill this in themselves?{" "}
          <button type="button" className="text-button" onClick={playerLink}>
            Send an invitation link instead
          </button>
        </span>
      ),
      submit: (v) =>
        p.mutate("/players/save", {
          id: player?.id,
          version: player?.version,
          name: text(v, "name"),
          batchId: text(v, "batchId"),
          profile: {
            adult: false,
            birthDate: text(v, "birthDate"),
            email: text(v, "email"),
            phone: text(v, "phone"),
            notes: text(v, "notes"),
            status: text(v, "status"),
            selfUserId: null,
            preferences: text(v, "preferences"),
          },
        }),
    });
  }
  function guardian(playerId: string, userId?: string) {
    const old = p.data.guardianLinks.find(
      (l) => l.playerId === playerId && l.userId === userId,
    );
    p.open({
      title: old ? "Update guardian access" : "Link guardian",
      initial: {
        userId: old?.userId ?? "",
        relationship: old?.relationship ?? "Parent",
        active: old?.active ?? true,
      },
      fields: [
        {
          name: "userId",
          label: "Guardian account",
          kind: "select",
          options: options(
            p.data.members.filter((m) => m.role === "GUARDIAN" && m.active),
          ),
          required: true,
        },
        { name: "relationship", label: "Relationship", required: true },
        { name: "active", label: "Authorised access is active", kind: "check" },
      ],
      notice:
        "Create guardian accounts in Settings first. Every child link is authorised separately. Revocation immediately stops private access.",
      submit: (v) =>
        p.mutate("/players/guardian", {
          playerId,
          userId: text(v, "userId"),
          relationship: text(v, "relationship"),
          active: flag(v, "active"),
        }),
    });
  }
  return <PlayersView {...p} edit={edit} guardian={guardian} />;
}
export function Calendar(p: WorkspaceProps) {
  function event(id?: string) {
    const e = p.data.events.find((e) => e.id === id);
    // Stage 5E: occurrences of a recurring series can be changed alone, with the later ones, or all together.
    const seriesId = e?.data.seriesId ?? null;
    const series = p.data.calendarSeries.find((s) => s.id === seriesId);
    // One id per dialog: a resubmission after a lost response returns the first result instead of a copy.
    const requestId = e ? undefined : crypto.randomUUID();
    p.open({
      title: e ? "Edit calendar event" : "New calendar event",
      initial: {
        title: e?.data.title ?? "",
        kind: e?.kind ?? "EVENT",
        localDate: e?.data.localDate ?? p.data.currentDate,
        localTime: e?.data.localTime ?? "17:00",
        duration: String(e?.data.duration ?? 60),
        branchId: e?.data.branchId ?? p.data.branches[0]?.id ?? "",
        coachId: e?.data.coachId ?? "",
        batchId: e?.data.batchId ?? "",
        playerIds: e?.data.playerIds ?? [],
        repeatWeeks: "1",
        cancel: e?.status === "CANCELLED",
        scope: "THIS",
        overwriteExceptions: false,
        reason: "",
      },
      fields: [
        {
          name: "kind",
          label: "Event kind",
          kind: "select",
          options: choices([
            "EVENT",
            "CLOSURE",
            ...(e?.kind === "TRIAL" ? ["TRIAL"] : []),
          ]),
        },
        { name: "title", label: "Event title", required: true },
        {
          name: "localDate",
          label: "Event date",
          kind: "date",
          required: true,
        },
        {
          name: "localTime",
          label: "Event time",
          kind: "time",
          required: true,
        },
        {
          name: "duration",
          label: "Duration (minutes)",
          kind: "number",
          min: 1,
          max: 1440,
          required: true,
        },
        {
          name: "branchId",
          label: "Branch",
          kind: "select",
          options: options(p.data.branches),
          required: true,
        },
        {
          name: "coachId",
          label: "Coach (not required for closures)",
          kind: "select",
          options: coachOptions(p),
        },
        {
          name: "batchId",
          label: "Batch (optional)",
          kind: "select",
          options: options(p.data.batches, "No batch"),
        },
        {
          name: "playerIds",
          label: "Participating players",
          kind: "multi",
          options: playerOptions(p).filter((o) => o.value),
        },
        {
          name: "repeatWeeks",
          label: "Weekly occurrences",
          kind: "number",
          min: 1,
          max: e ? 1 : 12,
          required: true,
        },
        ...(seriesId
          ? [
              {
                name: "scope",
                label: "Apply to",
                kind: "select" as const,
                options: [
                  { value: "THIS", label: "This occurrence only" },
                  { value: "FOLLOWING", label: "This and following occurrences" },
                  { value: "SERIES", label: "All upcoming occurrences in the series" },
                ],
              },
              {
                name: "overwriteExceptions",
                label: "Also overwrite occurrences that were changed individually",
                kind: "check" as const,
              },
            ]
          : []),
        ...(e
          ? [
              {
                name: "cancel",
                label: "Cancelled",
                kind: "check" as const,
              },
              {
                name: "reason",
                label: "Cancellation reason (required when cancelling)",
                kind: "textarea" as const,
                max: 500,
              },
            ]
          : []),
      ],
      notice: seriesId
        ? `Times are local to ${p.data.academy.timezone}. This event repeats weekly. Occurrences that have already started are never changed. Changes to the following or all occurrences keep individually changed occurrences as they are unless you tick overwrite; changing the following occurrences starts a new series from this date.`
        : e && Date.parse(e.data.startsAt) <= Date.now()
          ? `Times are local to ${p.data.academy.timezone}. This event has already started: it can be corrected or cancelled, but it keeps its coach, branch and batch.`
          : `Times are local to ${p.data.academy.timezone}. No court allocation is used. Set explicit participants to check player conflicts.`,
      // DEC-3: cancelling the following / all occurrences of a series is confirmed against the server's preview of
      // exactly which occurrences are cancelled and which individually changed ones stay scheduled.
      confirm: async (v) => {
        if (!seriesId || !flag(v, "cancel") || text(v, "scope") === "THIS") return null;
        const preview = await academyRequest<CancellationPreview>("/calendar/preview", body(v));
        return {
          title: "Confirm cancellation",
          content: <CancellationSummary preview={preview} />,
          values: { ...v, previewToken: preview.previewToken },
          button: preview.cancelCount ? `Cancel ${plural(preview.cancelCount, "occurrence")}` : "Confirm",
        };
      },
      submit: (v) => p.mutate("/calendar/event", body(v)),
    });
    function body(v: Values) {
      return {
        id: e?.id,
        version: e?.version,
        kind: text(v, "kind"),
        title: text(v, "title"),
        localDate: text(v, "localDate"),
        localTime: text(v, "localTime"),
        duration: number(v, "duration"),
        branchId: text(v, "branchId"),
        coachId: text(v, "coachId"),
        batchId: text(v, "batchId"),
        playerIds: list(v, "playerIds"),
        enquiryId: e?.data.enquiryId ?? null,
        repeatWeeks: number(v, "repeatWeeks"),
        cancel: flag(v, "cancel"),
        scope: seriesId ? text(v, "scope") : "THIS",
        seriesVersion: series?.version,
        overwriteExceptions: seriesId ? flag(v, "overwriteExceptions") : false,
        reason: text(v, "reason"),
        requestId,
        previewToken: text(v, "previewToken") || undefined,
      };
    }
  }
  function schedule(id: string, duplicate = false) {
    const s = p.data.sessions.find((s) => s.id === id)!;
    p.open({
      title: duplicate ? "Repeat training plan" : "Reschedule training session",
      initial: {
        localDate: s.data.localDate,
        localTime: s.data.localTime,
        repeatWeeks: "1",
      },
      fields: [
        {
          name: "localDate",
          label: "New local date",
          kind: "date",
          required: true,
        },
        {
          name: "localTime",
          label: "New local time",
          kind: "time",
          required: true,
        },
        {
          name: "repeatWeeks",
          label: "Weekly occurrences",
          kind: "number",
          min: 1,
          max: duplicate ? 12 : 1,
          required: true,
        },
      ],
      notice: duplicate
        ? "Copies are drafts with new dates and cleared attendance, observations and outcomes. Publish each in Training after reviewing its current roster."
        : "This updates the original Training session and keeps its audit history. In-progress and completed sessions cannot be rescheduled.",
      submit: (v) =>
        p.mutate("/calendar/session", {
          id: s.id,
          version: s.version,
          localDate: text(v, "localDate"),
          localTime: text(v, "localTime"),
          repeatWeeks: number(v, "repeatWeeks"),
          duplicate,
        }),
    });
  }

  return <CalendarView {...p} event={event} schedule={schedule} />;
}
