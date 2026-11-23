"use client";
import { useState } from "react";
import { academyRequest } from "../../academy/ui/shared";
import { COUNTRY_CALLING_CODE, gmailLink, invitationText, mailtoLink, whatsappLink } from "../../communications/share-links";

type BulkResult = {
  line: number;
  ok: boolean;
  email: string;
  playerName: string | null;
  who: string;
  phone: string;
  error?: string;
  link?: string;
};

/**
 * Invite many parents at once. One line per child: player name, parent e-mail, relationship and, if known, the parent's name
 * and WhatsApp number (the last two only to open WhatsApp from this screen; they are not stored). A parent of two children has
 * two lines and ends with one account. A line that fails does not stop the others. Nothing is sent for the owner.
 */
export function BulkInvite({ academy, onDone }: { academy: { name: string; country: string }; onDone: () => Promise<void> }) {
  const callingCode = COUNTRY_CALLING_CODE[academy.country] ?? null;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<BulkResult[] | null>(null);
  async function send() {
    setError("");
    setResults(null);
    const rows = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [playerName = "", email = "", relationship = "", who = "", phone = ""] = line.split(/\t|,|;/).map((x) => x.trim());
        return { playerName, email, relationship: relationship || "Parent", who, phone };
      });
    if (!rows.length) return setError("Add at least one line.");
    setBusy(true);
    try {
      const out = await academyRequest<{ rows: BulkResult[] }>("/invitations/bulk", { rows });
      setResults(out.rows);
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const created = results?.filter((r) => r.ok).length ?? 0;
  return (
    <details className="ss-box">
      <summary>Invite many parents at once</summary>
      <p>
        One line per child: <strong>player name, parent e-mail, relationship, parent name, WhatsApp number</strong>. The last two are
        optional. A parent with two children has two lines and still ends with one account.
      </p>
      <textarea
        aria-label="Parents to invite"
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Aarav Mehta, priya@example.com, Mother, Priya, +91 98765 43210\nDiya Sharma, priya@example.com, Mother"}
      />
      <div className="button-row">
        <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? "Creating…" : "Create the invitations"}
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {results && (
        <div role="status" className="notice">
          <strong>
            {created} of {results.length} invitations created.
          </strong>
          <p className="muted">The links are shown once. Press a button to send each from your own WhatsApp or mail app. Nothing was sent for you.</p>
          <table className="grid-table">
            <tbody>
              {results.map((r) => (
                <tr key={r.line}>
                  <td>{r.playerName ?? "—"}</td>
                  <td>{r.email}</td>
                  <td>
                    {r.ok && r.link ? (
                      <span className="button-row">
                        <a
                          className="secondary button-link"
                          target="_blank"
                          rel="noopener noreferrer"
                          href={whatsappLink(r.phone, invitationText(academy.name, r.who, r.link), callingCode)}
                        >
                          WhatsApp
                        </a>
                        <a
                          className="secondary button-link"
                          href={mailtoLink(r.email, `Your invitation to ${academy.name}`, invitationText(academy.name, r.who, r.link))}
                        >
                          Mail app
                        </a>
                        <a
                          className="secondary button-link"
                          target="_blank"
                          rel="noopener noreferrer"
                          href={gmailLink(r.email, `Your invitation to ${academy.name}`, invitationText(academy.name, r.who, r.link))}
                        >
                          Gmail
                        </a>
                      </span>
                    ) : (
                      <span className="error">{r.error}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
