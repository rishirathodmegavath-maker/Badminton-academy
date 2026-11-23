"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { ONBOARDING_MESSAGES } from "@/modules/identity/onboarding-policy";
import { AuthShell } from "@/modules/identity/ui/auth-shell";
import { PasswordField } from "@/modules/identity/ui/password-field";
import {
  PasswordRequirementsList,
  PasswordStrengthMeter,
} from "@/modules/identity/ui/password-strength";
import {
  passwordRequirements,
  passwordStrength,
  validateConfirmPassword,
  validateSignupPassword,
} from "@/modules/identity/ui/auth-validation";
import { useHydrated } from "@/modules/identity/ui/use-hydrated";

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();

  // Read once and kept: the fragment is removed below, and React may run this effect twice in development.
  const taken = useRef<string | null>(null);
  useEffect(() => {
    // The token travels in the URL fragment (never sent to a server, log or Referer). Take it, then remove it
    // from the address bar and history so it is not left lying around.
    if (taken.current === null) {
      const match = /(?:^|[#&])token=([^&]+)/.exec(window.location.hash);
      taken.current = match ? decodeURIComponent(match[1]) : "";
      if (match) window.history.replaceState(null, "", window.location.pathname);
    }
    setToken(taken.current);
  }, []);

  const strength = passwordStrength(password);
  const reqs = passwordRequirements(password);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");

    const nextPasswordError = validateSignupPassword(password);
    const nextConfirmError = validateConfirmPassword(password, confirmPassword);
    setPasswordError(nextPasswordError);
    setConfirmError(nextConfirmError);
    if (nextPasswordError || nextConfirmError || !token) return;

    setBusy(true);
    try {
      const response = await fetch("/api/auth/onboarding/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          password,
          ...(needsCode && mfaCode.trim() ? { mfaCode: mfaCode.trim() } : {}),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (body?.code === "MFA_CODE_REQUIRED") {
          setNeedsCode(true);
          setFormError(ONBOARDING_MESSAGES.MFA_CODE_REQUIRED);
        } else if (body?.code === "WEAK_PASSWORD") {
          setPasswordError(body?.message ?? ONBOARDING_MESSAGES.WEAK_PASSWORD);
        } else if (body?.code === "INVALID_RESET_TOKEN") {
          setToken("");
        } else {
          setFormError(
            response.status === 429
              ? ONBOARDING_MESSAGES.TOO_MANY_ATTEMPTS
              : body?.code === "INVALID_CODE"
                ? "That authenticator or recovery code was not accepted."
                : "We could not reset the password. Please try again.",
          );
        }
        return;
      }
      // No session is created: sign in with the new password (and the authenticator, if the account has one).
      window.location.assign("/login?reset=1");
    } catch {
      setFormError("The server is unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const linkMissing = token === "";

  return (
    <AuthShell
      eyebrow="ACCOUNT RECOVERY"
      storyTitle={
        <>
          Set a strong{" "}
          <br />
          new <em>password.</em>
        </>
      }
      storyBody="Choose a unique passphrase you do not use anywhere else to protect your academy records."
    >
      <Link href="/login" className="auth-back-link">
        <ArrowLeft size={15} aria-hidden="true" />
        <span>Back to sign in</span>
      </Link>

      <div className="auth-header">
        <span className="auth-eyebrow">New credentials</span>
        <h2>Create a new password</h2>
        <p className="auth-subtitle">
          Enter and confirm your replacement password below.
        </p>
      </div>

      {linkMissing ? (
        <div className="auth-banner auth-banner-error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <div>
            <span>{ONBOARDING_MESSAGES.INVALID_RESET_TOKEN}</span>{" "}
            <Link href="/forgot-password" className="auth-inline-link">
              Request a new link
            </Link>
          </div>
        </div>
      ) : (
        <form className="auth-form" method="post" onSubmit={submit} noValidate>
          <div className="auth-field">
            <PasswordField
              id="reset-new-password"
              name="password"
              label="New password"
              value={password}
              onChange={(next) => {
                setPassword(next);
                if (passwordError) setPasswordError(validateSignupPassword(next));
                if (confirmPassword && confirmError) {
                  setConfirmError(validateConfirmPassword(next, confirmPassword));
                }
              }}
              onBlur={() => setPasswordError(validateSignupPassword(password))}
              autoComplete="new-password"
              placeholder="At least 12 characters"
              error={passwordError}
              disabled={busy}
              describedBy="reset-password-strength reset-password-reqs"
              required
            />
            <PasswordStrengthMeter
              id="reset-password-strength"
              strength={strength}
            />
            <PasswordRequirementsList
              id="reset-password-reqs"
              requirements={reqs}
            />
          </div>

          <PasswordField
            id="reset-confirm-password"
            name="confirmPassword"
            label="Confirm new password"
            value={confirmPassword}
            onChange={(next) => {
              setConfirmPassword(next);
              if (confirmError) {
                setConfirmError(validateConfirmPassword(password, next));
              }
            }}
            onBlur={() => {
              if (confirmPassword || confirmError) {
                setConfirmError(
                  validateConfirmPassword(password, confirmPassword),
                );
              }
            }}
            autoComplete="new-password"
            placeholder="Re-enter your new password"
            error={confirmError}
            disabled={busy}
            required
          />

          {needsCode && (
            <div className="auth-field">
              <label className="auth-label" htmlFor="reset-mfa-code">
                Authenticator or recovery code
              </label>
              <input
                id="reset-mfa-code"
                name="code"
                type="text"
                className="auth-input"
                inputMode="text"
                autoComplete="one-time-code"
                placeholder="123456 or xxxxx-xxxxx"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                disabled={busy}
                required
              />
            </div>
          )}

          {formError && (
            <p role="alert" className="auth-banner auth-banner-error">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{formError}</span>
            </p>
          )}

          <button
            type="submit"
            className="primary auth-primary-btn"
            disabled={busy || !hydrated || token === null}
            aria-busy={busy ? "true" : undefined}
          >
            {busy ? (
              <>
                <Loader2 size={16} className="auth-spin" aria-hidden="true" />
                <span>Updating password…</span>
              </>
            ) : (
              <>
                <span>Update password</span>
                <ArrowRight size={16} aria-hidden="true" />
              </>
            )}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
