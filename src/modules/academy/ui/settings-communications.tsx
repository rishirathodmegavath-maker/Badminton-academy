"use client";
import { SettingsView } from "./views/settings-view";
import { TemporaryPasswordCard } from "../../identity/ui/temporary-password";
import { CommunicationsView } from "./views/communications-view";

import type { WorkspaceProps } from "./context";
import { options, text, flag, list, academyRequest } from "./shared";
import { AudienceNote, type AudienceSummary, type PreviewRecipient } from "./audience-note";
import { PLAYER_LOGIN_ROLE, STORED_ROLES, can } from "../../identity/authority";
import { accountLabel } from "./navigation";
/** Who may be named as a coach or a replacement coach: the server's rule (`sessions.coach`, canCoach). */
const canCoach = (m: { role: string }) => can(m, "sessions.coach");
export function Settings(p: WorkspaceProps) {
  const d = p.data;

  function branch(id?: string) {
    const b = d.branches.find((b) => b.id === id);
    p.open({
      title: b ? "Edit branch" : "Create branch",
      initial: { name: b?.name ?? "" },
      fields: [{ name: "name", label: "Branch name", required: true }],
      submit: (v) =>
        p.mutate("/settings/branch", { id: b?.id, name: text(v, "name") }),
    });
  }
  function batch(id?: string) {
    const b = d.batches.find((b) => b.id === id);
    p.open({
      title: b ? "Edit batch assignment" : "Create batch",
      initial: {
        name: b?.name ?? "",
        branchId: b?.branchId ?? "",
        coachId: b?.coachId ?? "",
      },
      fields: [
        { name: "name", label: "Batch name", required: true },
        {
          name: "branchId",
          label: "Branch",
          kind: "select",
          options: options(d.branches),
          required: true,
        },
        {
          name: "coachId",
          label: "Assigned coach",
          kind: "select",
          options: options(
            d.members.filter((m) => m.active && canCoach(m)),
          ),
          required: true,
        },
      ],
      notice:
        "Changes affect future planning. Published rosters and historical coaching records retain their snapshots.",
      submit: (v) =>
        p.mutate("/settings/batch", {
          id: b?.id,
          name: text(v, "name"),
          branchId: text(v, "branchId"),
          coachId: text(v, "coachId"),
        }),
    });
  }
  function member(id?: string) {
    const m = d.members.find((m) => m.id === id);
    // Only someone who can coach today can have batches, upcoming sessions or events to hand over.
    const replacements =
      m && m.active && canCoach(m)
        ? d.members.filter((c) => c.id !== m.id && c.active && canCoach(c))
        : [];
    p.open({
      title: m ? "Update academy access" : "Create staff / family login",
      initial: {
        name: m?.name ?? "",
        email: m?.email ?? "",
        role: m?.role ?? "COACH",
        active: m?.active ?? true,
        initialPassword: "",
        professionalAttestation: "",
        replacementCoachId: "",
        ownerPassword: "",
        mfaCode: "",
      },
      fields: [
        { name: "name", label: "Name", required: true },
        ...(!m
          ? [
              {
                name: "email",
                label: "Login email",
                kind: "email" as const,
                required: true,
              },
              {
                name: "initialPassword",
                label: "Temporary password (optional)",
                kind: "password" as const,
                help: "Leave blank to generate a secure random one, shown once after saving. Either way it expires in 72 hours and must be replaced at first sign-in.",
              },
            ]
          : []),
        {
          name: "role",
          label: "Academy role",
          kind: "select",
          // RC-5: one entry per stored role, labelled with its account type and (for Staff) its single
          // designation. The value sent is the stored role itself; the server validates it (D2).
          options: STORED_ROLES.filter((role) => role !== PLAYER_LOGIN_ROLE).map((role) => ({ value: role, label: accountLabel(role) })),
          help: "Staff accounts carry exactly one designation. Administrator is Staff, not Owner.",
        },
        { name: "active", label: "Academy access is active", kind: "check" },
        ...(m && m.active && canCoach(m)
          ? [
              {
                name: "replacementCoachId",
                label: "Replacement coach (when removing coaching access)",
                kind: "select" as const,
                options: options(replacements),
                help: "Required if this person still has batches, upcoming sessions or upcoming events. They move to the replacement; completed sessions keep their original coach.",
              },
            ]
          : []),
        {
          name: "professionalAttestation",
          label:
            "Professional authorisation record (required for Nutrition professional)",
          kind: "textarea",
          max: 500,
        },
        // RC-2 (TD-1): granting or removing Owner access is confirmed with the acting owner's
        // password and a second factor. The server decides when they are required.
        {
          name: "ownerPassword",
          label: "Your password (only to grant or remove Owner access)",
          kind: "password",
          help: "Needed only when this change makes someone an owner or removes an owner. Confirms it is you; not stored.",
        },
        {
          name: "mfaCode",
          label: "Authenticator code or recovery code (only to grant or remove Owner access)",
          help: "The 6-digit code from your authenticator app, or one unused recovery code. Owner changes need two-factor authentication to be set up on your account.",
        },
      ],
      notice:
        "Owner-only provisioning. No invitation email is sent. Deliver initial credentials privately. Clinical review access requires an explicit authorisation record.",
      submit: (v) =>
        p.mutate("/settings/member", {
          id: m?.id,
          name: text(v, "name"),
          email: m?.email ?? text(v, "email"),
          role: text(v, "role"),
          active: flag(v, "active"),
          initialPassword: text(v, "initialPassword"),
          professionalAttestation: text(v, "professionalAttestation"),
          replacementCoachId: text(v, "replacementCoachId") || null,
          ...(text(v, "ownerPassword") ? { ownerPassword: text(v, "ownerPassword") } : {}),
          ...(text(v, "mfaCode") ? { mfaCode: text(v, "mfaCode") } : {}),
        }),
    });
  }
  function assignPlayers(id: string) {
    const m = d.members.find((m) => m.id === id);
    if (!m) return;
    const current = d.assignments
      .filter((r) => r.professionalId === id && r.active)
      .map((r) => r.playerId);
    p.open({
      title: `Players assigned to ${m.name}`,
      initial: { players: current },
      fields: [
        {
          name: "players",
          label: "Players this nutrition professional may see",
          kind: "multi",
          options: d.players.map((pl) => ({ value: pl.id, label: pl.name })),
          help: "Until a player is assigned, this professional sees nothing about them.",
        },
      ],
      notice:
        "Assignments take effect immediately. Removing one ends their access to that player's nutrition records.",
      submit: async (v) => {
        const wanted = list(v, "players");
        for (const playerId of [...new Set([...current, ...wanted])]) {
          const active = wanted.includes(playerId);
          if (active === current.includes(playerId)) continue;
          if (
            !(await p.mutate("/nutrition/assign", {
              playerId,
              professionalId: id,
              active,
            }))
          )
            return false;
        }
        return true;
      },
    });
  }
  function resetPassword(id: string) {
    const m = d.members.find((m) => m.id === id);
    if (!m) return;
    p.open({
      title: `Reset password for ${m.name}`,
      initial: { reason: "", ownerPassword: "", resetAuthenticator: false },
      fields: [
        {
          name: "reason",
          label: "Reason (recorded in the security log)",
          kind: "textarea",
          required: true,
          min: 10,
          max: 500,
        },
        {
          name: "ownerPassword",
          label: "Your password",
          kind: "password",
          required: true,
          help: "Confirms it is you. Not shared with anyone.",
        },
        {
          name: "resetAuthenticator",
          label:
            "Also remove their authenticator (lost phone and recovery codes)",
          kind: "check",
        },
      ],
      notice:
        "This ends all of their sessions and issues a one-time temporary password valid for 72 hours. They must replace it at their next sign-in. Owners cannot be reset here.",
      button: "Reset password",
      submit: async (v) => {
        try {
          const response = await fetch("/api/auth/account/admin/reset-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: m.id,
              reason: text(v, "reason"),
              ownerPassword: text(v, "ownerPassword"),
              resetAuthenticator: flag(v, "resetAuthenticator"),
            }),
          });
          const body = await response.json();
          if (!response.ok) {
            p.error(body.message ?? "The reset was not accepted.");
            return false;
          }
          p.detail(
            "Temporary password",
            <TemporaryPasswordCard
              password={body.temporaryPassword}
              expiresAt={body.expiresAt}
              person={m.name}
              authenticatorRemoved={body.authenticatorRemoved}
            />,
          );
          return true;
        } catch {
          p.error("The server is unavailable. Please try again.");
          return false;
        }
      },
    });
  }
  return (
    <SettingsView
      {...p}
      branch={branch}
      batch={batch}
      member={member}
      resetPassword={resetPassword}
      assignPlayers={assignPlayers}
    />
  );
}
export function Communications(p: WorkspaceProps) {
  const d = p.data;
  if (!d.enabled.communications)
    return (
      <div className="notice">
        Communications is disabled by academy settings or subscription access.
      </div>
    );
  async function message(id?: string, action = "save") {
    const m = d.messages.find((m) => m.id === id);
    // Approving is decided on what the server says this message would actually reach, shown BEFORE the button, not after.
    let approveNote: React.ReactNode = null;
    if (m && action === "approve") {
      try {
        const r = await academyRequest<{ recipients: PreviewRecipient[]; audience: AudienceSummary }>(
          "/communications/preview",
          m.data,
        );
        if (!r.recipients.length) {
          p.detail(
            "Cannot approve yet",
            <>
              <AudienceNote audience={r.audience} recipients={r.recipients} channels={m.data.channels} />
              <p className="muted">Use “Edit” on this draft to change who it goes to or which channels it uses, then approve.</p>
            </>,
          );
          return;
        }
        approveNote = (
          <AudienceNote audience={r.audience} recipients={r.recipients} channels={m.data.channels} showPeople />
        );
      } catch (e) {
        p.error((e as Error).message);
        return;
      }
    }
    p.open({
      title: !m
        ? "Create announcement"
        : action === "save"
          ? "Edit announcement"
          : `${action} announcement`,
      initial: {
        subject: m?.data.subject ?? "",
        body: m?.data.body ?? "",
        playerIds: m?.data.playerIds ?? [],
        batchIds: m?.data.batchIds ?? [],
        audience: !m || m.data.allBatches ? "ALL" : "SELECTED",
        portal: m?.data.channels.includes("PORTAL") ?? true,
        email: m?.data.channels.includes("EMAIL") ?? false,
        whatsapp: m?.data.channels.includes("WHATSAPP") ?? false,
        templateId: m?.data.templateId ?? "",
        localDate: d.currentDate,
        localTime: "17:00",
      },
      fields:
        action === "save"
          ? [
              {
                name: "templateId",
                label: "Saved template (optional)",
                kind: "select",
                options: options(d.templates),
              },
              { name: "subject", label: "Subject", required: true },
              {
                name: "body",
                label: "Message",
                kind: "textarea",
                required: true,
                max: 5000,
              },
              {
                name: "audience",
                label: "Who should get it?",
                kind: "select",
                options: [
                  { value: "ALL", label: "All families (every player I am allowed to message)" },
                  { value: "SELECTED", label: "Only the batches / players I tick below" },
                ],
              },
              {
                name: "batchIds",
                label: "Only these batches (used when “Only the batches / players I tick” is chosen)",
                kind: "multi",
                options: options(d.batches).filter((o) => o.value),
              },
              {
                name: "playerIds",
                label: "Only these players’ parents (used when “Only the batches / players I tick” is chosen)",
                kind: "multi",
                options: options(d.players).filter((o) => o.value),
              },
              { name: "portal", label: "Private family portal", kind: "check" },
              { name: "email", label: "Email · you send it from your mail app (free)", kind: "check" },
              {
                name: "whatsapp",
                label: "WhatsApp · you send it from your WhatsApp (free)",
                kind: "check",
              },
            ]
          : action === "schedule"
            ? [
                {
                  name: "localDate",
                  label: "Delivery date",
                  kind: "date",
                  required: true,
                },
                {
                  name: "localTime",
                  label: "Delivery time",
                  kind: "time",
                  required: true,
                },
              ]
            : [],
      derive: (v, name) => {
        if (name === "templateId") {
          const template = d.templates.find(
            (t) => t.id === text(v, "templateId"),
          );
          return template
            ? { ...v, subject: template.subject, body: template.body }
            : v;
        }
        return v;
      },
      notice:
        action === "approve" ? (
          <>
            <p>Approval snapshots the exact message and the families below. Check the list, then approve.</p>
            {approveNote}
          </>
        ) : action === "schedule"
            ? `Scheduled times use ${d.academy.timezone}. The outbox processor rechecks that each parent is still linked. Email and WhatsApp then appear under “Ready to send” with a button that opens your own mail app or WhatsApp (free).`
            : "Recipients are deduplicated by guardian. Editing a pending approved message requires a revision and fresh approval. Email and WhatsApp are sent by you, from your own apps, with one button per family.",
      button:
        action === "save"
          ? "Save draft"
          : action === "approve"
            ? "Approve exact message & recipients"
            : action === "schedule"
              ? "Schedule approved message"
              : "Revise and invalidate approval",
      submit: async (v) => {
        try {
          let scheduledAt = null;
          if (action === "schedule") {
            const { Temporal } = await import("@js-temporal/polyfill");
            scheduledAt = Temporal.PlainDateTime.from(
              `${text(v, "localDate")}T${text(v, "localTime")}`,
            )
              .toZonedDateTime(d.academy.timezone, { disambiguation: "reject" })
              .toInstant()
              .toString();
          }
          return p.mutate("/communications/save", {
            id: m?.id,
            version: m?.version,
            action,
            scheduledAt,
            data: {
              subject: text(v, "subject"),
              body: text(v, "body"),
              // "All families" ignores the ticked lists; "Only selected" uses them (a draft keeps both, nothing is lost).
              playerIds: text(v, "audience") === "ALL" ? [] : list(v, "playerIds"),
              batchIds: text(v, "audience") === "ALL" ? [] : list(v, "batchIds"),
              allBatches: text(v, "audience") === "ALL",
              channels: [
                ...(flag(v, "portal") ? ["PORTAL"] : []),
                ...(flag(v, "email") ? ["EMAIL"] : []),
                ...(flag(v, "whatsapp") ? ["WHATSAPP"] : []),
              ],
              templateId: text(v, "templateId") || null,
            },
          });
        } catch {
          p.error("Choose a valid, unambiguous local delivery time.");
          return false;
        }
      },
    });
  }
  async function preview(id: string) {
    const m = d.messages.find((m) => m.id === id)!;
    try {
      const result = await academyRequest<{
        recipients: {
          userId: string;
          name: string;
          playerIds: string[];
          channels: string[];
        }[];
        audience: AudienceSummary;
      }>("/communications/preview", m.data);
      p.detail(
        "Recipient & message preview",
        <>
          <h3>{m.data.subject}</h3>
          <p className="preserve-lines">{m.data.body}</p>
          <AudienceNote audience={result.audience} recipients={result.recipients} channels={m.data.channels} />
          <h3>{result.recipients.length} unique authorised recipients</h3>
          {result.recipients.map((r) => (
            <article className="observation" key={r.userId}>
              <strong>{r.name}</strong>
              <p>
                {r.channels.join(", ")} · {r.playerIds.length} linked player(s)
              </p>
            </article>
          ))}
          <div className="notice">
            Email / WhatsApp: free, sent by you from your own mail app or WhatsApp (see “Ready to send”). Portal availability does not
            establish that a message was read. No internal notes, rosters or
            report content are automatically appended.
          </div>
        </>,
      );
    } catch (e) {
      p.error((e as Error).message);
    }
  }
  function conversation(id?: string) {
    const old = d.conversations.find((c) => c.id === id);
    const entryId = crypto.randomUUID();
    p.open({
      title: old ? "Reply privately" : "New private conversation",
      initial: {
        guardianId: old?.guardianId ?? "",
        playerId: old?.playerId ?? "",
        subject: old?.subject ?? "",
        text: "",
      },
      fields: [
        ...(!old
          ? [
              {
                name: "playerId",
                label: "Player context",
                kind: "select" as const,
                options: options(d.players),
                required: true,
              },
              {
                name: "guardianId",
                label: "Authorised guardian",
                kind: "select" as const,
                options: options(
                  d.members.filter((m) => m.role === "GUARDIAN" && m.active),
                ),
                required: true,
              },
              {
                name: "subject",
                label: "Conversation subject",
                required: true,
              },
            ]
          : []),
        {
          name: "text",
          label: "Private portal message",
          kind: "textarea",
          required: true,
          max: 5000,
        },
      ],
      notice:
        "This conversation stays in the private portal, scoped to an authorised guardian and a player. No external delivery is attempted.",
      submit: (v) =>
        p.mutate("/communications/conversation", {
          id: old?.id,
          version: old?.version,
          playerId: old?.playerId ?? text(v, "playerId"),
          guardianId: old?.guardianId ?? text(v, "guardianId"),
          subject: old?.subject ?? text(v, "subject"),
          text: text(v, "text"),
          entryId,
        }),
    });
  }
  function template() {
    p.open({
      title: "Create communication template",
      initial: { name: "", subject: "", body: "" },
      fields: [
        { name: "name", label: "Template name", required: true },
        { name: "subject", label: "Subject", required: true },
        {
          name: "body",
          label: "Template message",
          kind: "textarea",
          required: true,
          max: 5000,
        },
      ],
      submit: (v) =>
        p.mutate("/communications/template", {
          name: text(v, "name"),
          subject: text(v, "subject"),
          body: text(v, "body"),
        }),
    });
  }
  return (
    <CommunicationsView
      {...p}
      message={message}
      preview={preview}
      conversation={conversation}
      template={template}
    />
  );
}
