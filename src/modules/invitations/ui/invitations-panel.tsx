"use client";
import { useCallback, useEffect, useState } from "react";
import { academyRequest } from "../../academy/ui/shared";
import { BulkInvite } from "./bulk-invite";
import { COUNTRY_CALLING_CODE, canonicalPhone, gmailLink, invitationText, mailtoLink, whatsappLink } from "../../communications/share-links";
import {
  INVITATION_DEFAULT_DAYS,
  INVITATION_KIND as KIND,
  INVITATION_MAX_DAYS,
  PLAYER_LINK_LABEL,
  STAFF_INVITATION_ROLES,
  grantsOwnership,
  needsAttestation,
  type InvitationKind,
  type InvitationStatus,
} from "../messages";

/**
 * Settings -> Invitations. An owner invites people into THIS academy: staff by role, a guardian for a player, or an adult
 * player. The server decides everything (who may invite, the second-factor step-up for an owner, the player, duplicates,
 * expiry); this panel shows its answers and its refusal messages. The invitation link is shown once, when it is made: only a
 * keyed hash is stored, and nothing is emailed, so the owner hands the link to the person.
 */
type Row = {
  id: string;
  email: string;
  kind: InvitationKind;
  role: string;
  relationship: string | null;
  playerName: string | null;
  status: InvitationStatus;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
};
type Made = { id: string; email: string; role: string; link: string; expiresAt: string; phone: string; who: string };
const words = (value: string) => value.replaceAll("_", " ").toLowerCase();
const STATUS_LABEL: Record<InvitationStatus, string> = { PENDING: "Pending", ACCEPTED: "Accepted", REVOKED: "Withdrawn", EXPIRED: "Expired" };
const day = (iso: string) => new Date(iso).toLocaleDateString();

export function InvitationsPanel({
  players,
  academy = { name: "our academy", country: "IN" },
}: {
  players: { id: string; name: string }[];
  academy?: { name: string; country: string };
}) {
  const callingCode = COUNTRY_CALLING_CODE[academy.country] ?? null;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<InvitationKind>(KIND.STAFF);
  const [role, setRole] = useState<string>(STAFF_INVITATION_ROLES[0]);
  const [made, setMade] = useState<Made | null>(null);
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState<"ALL" | InvitationStatus>("ALL");

  const load = useCallback(async () => {
    try {
      setRows((await academyRequest<{ invitations: Row[] }>("/invitations")).invitations);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const v = new FormData(form);
    const text = (k: string) => String(v.get(k) ?? "").trim();
    setBusy(true);
    setError("");
    setMade(null);
    setCopied(false);
    try {
      const body: Record<string, unknown> = {
        email: text("email"),
        kind,
        expiresInDays: Number(text("days")) || INVITATION_DEFAULT_DAYS,
        ...(kind === KIND.STAFF ? { role } : {}),
        ...(kind === KIND.GUARDIAN ? { playerId: text("player"), relationship: text("relationship") } : {}),
        ...(kind === KIND.STAFF && needsAttestation(role) ? { professionalAttestation: text("attestation") } : {}),
        ...(kind === KIND.STAFF && grantsOwnership(role) ? { ownerPassword: text("ownerPassword"), mfaCode: text("mfaCode") } : {}),
      };
      const typedPhone = text("phone");
      if (typedPhone && !canonicalPhone(typedPhone, callingCode))
        throw new Error("Enter the WhatsApp number with its country code, for example +91 98765 43210, or leave it empty.");
      const result = await academyRequest<Omit<Made, "phone" | "who">>("/invitations/create", body);
      // The number is used only to open WhatsApp in this browser. It is not sent to or stored by the server.
      setMade({ ...result, phone: typedPhone, who: text("who") });
      form.reset();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(row: Row) {
    if (!window.confirm(`Withdraw the invitation for ${row.email}? The link stops working immediately.`)) return;
    setError("");
    try {
      await academyRequest("/invitations/revoke", { id: row.id });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function resend(row: Row) {
    setError("");
    setBusy(true);
    setCopied(false);
    try {
      const result = await academyRequest<Omit<Made, "phone" | "who">>("/invitations/resend", { id: row.id });
      // The old link stopped working in the same step. The new one is shown once, like any new invitation.
      setMade({ ...result, phone: "", who: "" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError("Copying was blocked by the browser. Select the link and copy it by hand.");
    }
  }

  const shown = (rows ?? []).filter((r) => filter === "ALL" || r.status === filter);
  const pending = (rows ?? []).filter((r) => r.status === "PENDING").length;

  return (
    <div className="invitations-panel">
      <p>
        An invitation lets one person join this academy. Nobody gains access from an email address alone: the person opens the link,
        signs in with the account it was sent to, and accepts it themselves.
      </p>

      <form className="form-grid" method="post" onSubmit={create} aria-label="Invite someone">
        <fieldset disabled={busy}>
          <legend>Invite someone</legend>
          <label>
            Kind of invitation
            <select value={kind} onChange={(e) => setKind(e.target.value as InvitationKind)}>
              <option value={KIND.STAFF}>Staff member (a role in this academy)</option>
              <option value={KIND.GUARDIAN}>Parent or guardian of a player</option>
            </select>
          </label>
          <label>
            Their name (used in the message)
            <input name="who" maxLength={60} autoComplete="off" placeholder="Optional" />
          </label>
          <label>
            Their email address
            <input name="email" type="email" required maxLength={254} autoComplete="off" placeholder="name@example.com" />
            <small>The person signs in with this address (a Google account on it works) to accept.</small>
          </label>
          <label>
            Their WhatsApp number (optional)
            <input name="phone" type="tel" maxLength={40} autoComplete="off" placeholder="+91 98765 43210" />
            <small>Only used to open WhatsApp on your device with the link ready; it is not stored here. The person adds their own number when they accept, and it is kept on their account.</small>
          </label>
          {kind === KIND.STAFF && (
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {STAFF_INVITATION_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {words(r)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind === KIND.STAFF && needsAttestation(role) && (
            <label>
              Professional authorisation (recorded)
              <textarea name="attestation" rows={2} minLength={10} maxLength={500} required />
            </label>
          )}
          {kind === KIND.STAFF && grantsOwnership(role) && (
            <fieldset>
              <legend>Confirm it is you (owners only)</legend>
              <small>Inviting an owner needs your password and a current code from your authenticator app.</small>
              <label>
                Your password
                <input name="ownerPassword" type="password" autoComplete="current-password" required />
              </label>
              <label>
                Authenticator or recovery code
                <input name="mfaCode" inputMode="text" autoComplete="one-time-code" required />
              </label>
            </fieldset>
          )}
          {kind === KIND.GUARDIAN && (
            <>
              <label>
                Player
                <select name="player" required defaultValue="">
                  <option value="" disabled>
                    Choose a player
                  </option>
                  {players.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Relationship
                <input name="relationship" required minLength={2} maxLength={50} placeholder="Mother, Father, Guardian…" />
              </label>
              <small>
                Linking shares nothing by itself: consent is recorded separately, and a guardian of an adult sees nothing until the adult
                grants it.
              </small>
            </>
          )}
          <label>
            Valid for (days)
            <input name="days" type="number" min={1} max={INVITATION_MAX_DAYS} defaultValue={INVITATION_DEFAULT_DAYS} />
          </label>
          <button className="primary" disabled={busy}>
            Create invitation
          </button>
        </fieldset>
      </form>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {made && (
        <div role="status" className="notice invitation-made">
          <strong>Invitation created for {made.email}.</strong>
          <p>
            Give them this link. It is shown only now and cannot be recovered; if it is lost, withdraw this invitation and create a new
            one. Nothing was sent for you: use a button below to send it from your own WhatsApp or mail app, for free.
          </p>
          <input readOnly value={made.link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
          <div className="button-row">
            <a
              className="primary button-link"
              target="_blank"
              rel="noopener noreferrer"
              href={whatsappLink(made.phone, invitationText(academy.name, made.who, made.link), callingCode)}
            >
              {made.phone ? "Send on WhatsApp" : "Share on WhatsApp"}
            </a>
            <a
              className="secondary button-link"
              href={mailtoLink(made.email, `Your invitation to ${academy.name}`, invitationText(academy.name, made.who, made.link))}
            >
              Send by email
            </a>
            <a
              className="secondary button-link"
              target="_blank"
              rel="noopener noreferrer"
              href={gmailLink(made.email, `Your invitation to ${academy.name}`, invitationText(academy.name, made.who, made.link))}
            >
              Send with Gmail
            </a>
            <button type="button" className="secondary" onClick={() => void copy(made.link)}>
              {copied ? "Copied" : "Copy link"}
            </button>
            <small>Valid until {day(made.expiresAt)}.</small>
          </div>
        </div>
      )}

      <BulkInvite academy={academy} onDone={load} />

      <h3>
        Invitations <small>({pending} pending)</small>
      </h3>
      <label>
        Show
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="ALL">All</option>
          <option value="PENDING">Pending</option>
          <option value="ACCEPTED">Accepted</option>
          <option value="EXPIRED">Expired</option>
          <option value="REVOKED">Withdrawn</option>
        </select>
      </label>
      {!rows ? (
        <p role="status">{error ? "" : "Loading…"}</p>
      ) : shown.length === 0 ? (
        <p>No invitations to show.</p>
      ) : (
        <table className="grid-table">
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Invited by</th>
              <th scope="col">Sent</th>
              <th scope="col">Expires</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td>{r.email}</td>
                <td>
                  {r.email === PLAYER_LINK_LABEL ? "Player" : words(r.role)}
                  {r.kind === KIND.GUARDIAN && r.playerName ? ` · ${r.relationship ?? ""} of ${r.playerName}` : ""}
                </td>
                <td>
                  <span className={`status status-${r.status.toLowerCase()}`}>{STATUS_LABEL[r.status]}</span>
                  {r.status === "ACCEPTED" && r.acceptedAt ? ` ${day(r.acceptedAt)}` : ""}
                  {r.status === "REVOKED" && r.revokedAt ? ` ${day(r.revokedAt)}` : ""}
                </td>
                <td>{r.invitedBy}</td>
                <td>{day(r.createdAt)}</td>
                <td>{r.status === "PENDING" ? day(r.expiresAt) : "—"}</td>
                <td>
                  {r.status !== "ACCEPTED" && !grantsOwnership(r.role) && r.email !== PLAYER_LINK_LABEL && (
                    <button type="button" className="secondary" disabled={busy} onClick={() => void resend(r)}>
                      Resend
                    </button>
                  )}{" "}
                  {r.status === "PENDING" && (
                    <button type="button" className="secondary" onClick={() => void withdraw(r)}>
                      Withdraw
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
