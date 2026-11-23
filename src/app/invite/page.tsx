"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Info, Loader2 } from "lucide-react";
import { redirectIfGated } from "@/modules/identity/ui/gate";
import { AuthShell } from "@/modules/identity/ui/auth-shell";
import { useHydrated } from "@/modules/identity/ui/use-hydrated";
import { INVITATION_MESSAGES, type InvitationCode } from "@/modules/invitations/messages";
import { forgetInvite, pendingInvite, rememberInvite } from "@/modules/invitations/ui/pending-invite";

type Preview = {
  status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
  academyName: string;
  kind: "STAFF" | "GUARDIAN" | "ADULT_PLAYER";
  role: string;
  relationship: string | null;
  emailHint: string;
  invitedBy: string;
  expiresAt: string;
};
type Session = { user: { email: string } } | null;
const words = (value: string) => value.replaceAll("_", " ").toLowerCase();
const WHAT: Record<Preview["kind"], (p: Preview) => string> = {
  STAFF: (p) => `join ${p.academyName} as ${words(p.role)}`,
  GUARDIAN: (p) => `be linked to a player at ${p.academyName} as their ${p.relationship ? p.relationship.toLowerCase() : "guardian"}`,
  ADULT_PLAYER: (p) => `join ${p.academyName} as a player`,
};

/**
 * Review and accept an invitation to an academy. The token is read from the URL fragment (never sent to a server in a URL),
 * removed from the address bar, and used only in request bodies. Nothing here grants anything: acceptance is an explicit click
 * by a signed-in person, and the server decides (it checks the invitation, the address it was sent to and who sent it).
 */
export default function InvitePage() {
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [done, setDone] = useState<{ academyName: string; role: string; already: boolean } | null>(null);
  const hydrated = useHydrated();
  const read = useRef(false);

  useEffect(() => {
    // React runs effects twice in development: the fragment must be consumed only once.
    if (read.current) return;
    read.current = true;
    const fragment = window.location.hash.slice(1);
    if (fragment) window.history.replaceState(null, "", window.location.pathname);
    const found = /^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : pendingInvite();
    if (!found) {
      setError("This page needs an invitation link. Open the link the academy sent you.");
      return;
    }
    rememberInvite(found);
    setToken(found);
    void (async () => {
      try {
        const [p, s] = await Promise.all([
          fetch("/api/auth/invitations/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: found }),
            cache: "no-store",
          }),
          fetch("/api/auth/get-session", { cache: "no-store" }),
        ]);
        const body = await p.json().catch(() => null);
        if (!p.ok) {
          forgetInvite();
          setError(INVITATION_MESSAGES[(body?.code as InvitationCode) ?? "INVALID_INVITATION"] ?? INVITATION_MESSAGES.INVALID_INVITATION);
          return;
        }
        setPreview(body as Preview);
        setSession(s.ok ? ((await s.json().catch(() => null)) as Session) : null);
      } catch {
        setError("The server is unavailable. Please try again.");
      }
    })();
  }, []);

  useEffect(() => {
    // Opening another invitation link in this tab only changes the fragment, which does not reload the page: start over for it.
    const onHash = () => {
      if (/^[A-Za-z0-9_-]{43}$/.test(window.location.hash.slice(1))) window.location.reload();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  async function accept() {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, ...(phone.trim() ? { phone: phone.trim() } : {}), ...(optIn ? { whatsappOptIn: true } : {}) }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok) {
        forgetInvite();
        setDone({ academyName: body.academyName, role: body.role, already: !!body.alreadyAccepted });
        return;
      }
      if (redirectIfGated(response.status, body)) return;
      if (response.status === 401) {
        setSession(null);
        return;
      }
      const code = body?.code as InvitationCode | undefined;
      if ((body?.code as string | undefined) === "INVALID_PHONE") {
        // Nothing was joined; the invitation is still open. Let the person fix the number.
        setError(String(body?.message ?? "Check the WhatsApp number."));
        return;
      }
      if (code && code !== "WRONG_ACCOUNT") forgetInvite();
      setError(
        response.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : ((code && INVITATION_MESSAGES[code]) ?? "The invitation could not be accepted. Please try again."),
      );
    } catch {
      setError("The server is unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function useAnotherAccount() {
    await fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    window.location.assign("/login");
  }

  const usable = preview?.status === "PENDING";
  return (
    <AuthShell
      eyebrow="ACADEMY INVITATION"
      storyTitle={
        <>
          You have been
          <br />
          <em>invited.</em>
        </>
      }
      storyBody="An academy added your address. Nothing is shared until you choose to accept, and you can decline by simply closing this page."
    >
      <div className="auth-header">
        <span className="auth-eyebrow">Invitation</span>
        <h2>{done ? "You have joined" : preview ? preview.academyName : "Your invitation"}</h2>
        {preview && !done && (
          <p className="auth-subtitle">
            {preview.invitedBy} has invited you to {WHAT[preview.kind](preview)}.
          </p>
        )}
      </div>

      {!preview && !error && (
        <p role="status" className="auth-banner auth-banner-info">
          <Loader2 size={16} className="auth-spin" aria-hidden="true" />
          <span>Opening your invitation…</span>
        </p>
      )}

      {error && (
        <p role="alert" className="auth-banner auth-banner-error">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      {preview && !usable && !done && (
        <p role="status" className="auth-banner auth-banner-info">
          <Info size={16} aria-hidden="true" />
          <span>
            {preview.status === "EXPIRED"
              ? INVITATION_MESSAGES.INVITATION_EXPIRED
              : preview.status === "REVOKED"
                ? INVITATION_MESSAGES.INVITATION_REVOKED
                : session
                  ? "This invitation has already been accepted. Open the academy from your account."
                  : INVITATION_MESSAGES.INVITATION_ALREADY_USED}
          </span>
        </p>
      )}

      {preview && usable && !done && (
        <>
          <dl className="auth-invite-facts">
            <div>
              <dt>Academy</dt>
              <dd>{preview.academyName}</dd>
            </div>
            <div>
              <dt>Your role</dt>
              <dd>{preview.kind === "GUARDIAN" ? `Guardian (${preview.relationship ?? "guardian"})` : preview.kind === "ADULT_PLAYER" ? "Player" : words(preview.role)}</dd>
            </div>
            <div>
              <dt>{preview.kind === "ADULT_PLAYER" ? "Open to" : "Sent to"}</dt>
              <dd>{preview.emailHint}</dd>
            </div>
            <div>
              <dt>Valid until</dt>
              <dd>{new Date(preview.expiresAt).toLocaleDateString()}</dd>
            </div>
          </dl>
          {preview.kind === "GUARDIAN" && (
            <p className="auth-field-hint">
              Once you accept, the academy can send you messages about training and reports, and you can see your child's schedule
              and reports in your own account.
            </p>
          )}
          {session === undefined ? null : session ? (
            <>
              <p className="auth-field-hint">
                Signed in as <strong>{session.user.email}</strong>.{" "}
                {preview.kind === "ADULT_PLAYER"
                  ? "This link works once, for the first person who accepts it."
                  : "The invitation only works for the address it was sent to."}
              </p>
              {preview.kind !== "ADULT_PLAYER" && (
              <>
              <div className="auth-field">
                <label className="auth-label" htmlFor="invite-phone">
                  Your WhatsApp number (optional)
                </label>
                <input
                  id="invite-phone"
                  className="auth-input"
                  type="tel"
                  name="phone"
                  autoComplete="tel"
                  maxLength={40}
                  placeholder="+91 98765 43210"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
                <p className="auth-field-hint">
                  Saved to your account so the academy can WhatsApp you. You will not be asked again, and you can change it later.
                </p>
              </div>
              <label className="auth-field-hint" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} style={{ width: 18, height: 18, marginTop: 2 }} />
                <span>The academy may also message me on WhatsApp at this number. Optional; I can change this later.</span>
              </label>
              </>
              )}
              <button type="button" className="primary auth-primary-btn" onClick={() => void accept()} disabled={busy || !hydrated}>
                {busy ? (
                  <>
                    <Loader2 size={16} className="auth-spin" aria-hidden="true" />
                    <span>Joining…</span>
                  </>
                ) : (
                  <>
                    <span>Accept invitation</span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </>
                )}
              </button>
              <p className="auth-footer-switch">
                Not the right account?{" "}
                <button type="button" className="auth-link" onClick={() => void useAnotherAccount()}>
                  Sign in with a different one
                </button>
              </p>
            </>
          ) : (
            <>
              <p className="auth-field-hint">
                {preview.kind === "ADULT_PLAYER"
                  ? "Sign in with any email account, or create one. You will come back here to accept. This link works once."
                  : `Sign in with the account for ${preview.emailHint}, or create one. You will come back here to accept.`}
              </p>
              <div className="auth-invite-actions">
                <Link href="/login" className="primary auth-primary-btn">
                  <span>Sign in</span>
                  <ArrowRight size={16} aria-hidden="true" />
                </Link>
                <Link href="/signup" className="secondary auth-secondary-btn">
                  <span>Create an account</span>
                </Link>
              </div>
            </>
          )}
        </>
      )}

      {done && (
        <>
          <p role="status" className="auth-banner auth-banner-success">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>
              {done.already ? "You are already part of " : "You are now part of "}
              <strong>{done.academyName}</strong> as {words(done.role).replace("adult player", "player")}.
            </span>
          </p>
          <button type="button" className="primary auth-primary-btn" onClick={() => window.location.assign("/")}>
            <span>Open the academy</span>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </>
      )}
    </AuthShell>
  );
}
