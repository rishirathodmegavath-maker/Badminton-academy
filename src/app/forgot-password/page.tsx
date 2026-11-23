"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Info, Loader2 } from "lucide-react";
import { ONBOARDING_MESSAGES } from "@/modules/identity/onboarding-policy";
import { AuthShell } from "@/modules/identity/ui/auth-shell";
import { validateEmail } from "@/modules/identity/ui/auth-validation";
import { useHydrated } from "@/modules/identity/ui/use-hydrated";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");
  const [resetEnabled, setResetEnabled] = useState(true);
  const hydrated = useHydrated();

  useEffect(() => {
    fetch("/api/auth/account/sign-in-methods", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j) setResetEnabled(j?.passwordReset?.enabled === true);
      })
      .catch(() => undefined);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    setFormError("");
    const err = validateEmail(email);
    setEmailError(err);
    if (err) return;

    setBusy(true);
    try {
      const response = await fetch("/api/auth/onboarding/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok) {
        // The same words whether or not the address has an account.
        setNotice(
          `If an account with a verified email address exists for ${email.trim()}, we have sent a link to reset its password. The link works once and expires in 30 minutes.`,
        );
        return;
      }
      setFormError(
        response.status === 429
          ? ONBOARDING_MESSAGES.TOO_MANY_ATTEMPTS
          : body?.code === "RESET_UNAVAILABLE"
            ? ONBOARDING_MESSAGES.RESET_UNAVAILABLE
            : "We could not process that request. Please try again.",
      );
    } catch {
      setFormError("The server is unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      eyebrow="ACCOUNT RECOVERY"
      storyTitle={
        <>
          Regain access{" "}
          <br />
          with <em>confidence.</em>
        </>
      }
      storyBody="Academy credentials are safeguarded with temporary-password controls and owner-approved resets."
    >
      <Link href="/login" className="auth-back-link">
        <ArrowLeft size={15} aria-hidden="true" />
        <span>Back to sign in</span>
      </Link>

      <div className="auth-header">
        <span className="auth-eyebrow">Password reset</span>
        <h2>Reset your password</h2>
        <p className="auth-subtitle">
          Enter your email address and we will send a reset link if the account can be recovered by email.
        </p>
      </div>

      <form className="auth-form" method="post" onSubmit={submit} noValidate>
        <div className="auth-field">
          <label className="auth-label" htmlFor="reset-email">
            Email address
          </label>
          <input
            id="reset-email"
            name="email"
            type="email"
            className={`auth-input${emailError ? " is-invalid" : ""}`}
            autoComplete="email"
            placeholder="name@academy.com"
            value={email}
            onChange={(e) => {
              const next = e.target.value;
              setEmail(next);
              if (emailError) setEmailError(validateEmail(next));
            }}
            onBlur={() => setEmailError(validateEmail(email))}
            disabled={busy}
            aria-invalid={emailError ? "true" : undefined}
            aria-describedby={emailError ? "reset-email-error" : undefined}
            required
          />
          {emailError && (
            <p id="reset-email-error" className="auth-field-error" role="alert">
              {emailError}
            </p>
          )}
        </div>

        {!resetEnabled && (
          <p role="status" className="auth-banner auth-banner-info">
            <Info size={16} aria-hidden="true" />
            <span>{ONBOARDING_MESSAGES.RESET_UNAVAILABLE}</span>
          </p>
        )}

        {formError && (
          <p role="alert" className="auth-banner auth-banner-error">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{formError}</span>
          </p>
        )}

        {notice && (
          <div role="status" className="auth-banner auth-banner-info">
            <Info size={16} aria-hidden="true" />
            <div>
              <span>{notice}</span>
              <p className="auth-field-hint">
                Accounts that your academy owner set up for you are reset by the owner, who can issue a temporary password.
                Owner accounts are recovered by the server operator.
              </p>
            </div>
          </div>
        )}

        <button
          type="submit"
          className="primary auth-primary-btn"
          disabled={busy || !hydrated || !resetEnabled}
          aria-busy={busy ? "true" : undefined}
        >
          {busy ? (
            <>
              <Loader2 size={16} className="auth-spin" aria-hidden="true" />
              <span>Sending…</span>
            </>
          ) : (
            <>
              <span>Send reset link</span>
              <ArrowRight size={16} aria-hidden="true" />
            </>
          )}
        </button>
      </form>
    </AuthShell>
  );
}
