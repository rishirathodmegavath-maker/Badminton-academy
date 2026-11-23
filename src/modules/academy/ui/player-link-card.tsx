"use client";
import { useState } from "react";
import { formatDate } from "./labels";

/** The one place a player invitation link is shown. It is not stored anywhere readable, so it cannot be shown again. */
export function PlayerLinkCard({ link, expiresAt }: { link: string; expiresAt: string }) {
  const [copied, setCopied] = useState(false);
  const message = `You are invited to join the academy as a player. Open this link, sign in with any email, and fill in your details: ${link}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="player-link-card">
      <p>
        Send this to the player. It works <strong>once</strong>: whoever opens it first signs in with any email and becomes the
        player&rsquo;s own login. It is shown only now and expires on {formatDate(expiresAt)}.
      </p>
      <label>
        Invitation link
        <input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
      </label>
      <div className="button-row">
        <button type="button" className="primary" onClick={copy}>
          {copied ? "Copied" : "Copy link"}
        </button>
        <a className="secondary" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noopener noreferrer">
          Share on WhatsApp
        </a>
        <a className="secondary" href={`mailto:?subject=${encodeURIComponent("Your academy invitation")}&body=${encodeURIComponent(message)}`}>
          Share by email
        </a>
      </div>
      <p className="muted">An unused link can be withdrawn by the academy owner any time under Settings, Team, Invitations.</p>
    </div>
  );
}
