"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, ArrowRight, Info, Loader2 } from "lucide-react";
import {
  GOOGLE_REFUSAL_MESSAGES,
  refusalFrom,
} from "@/modules/identity/google-messages";
import { AuthShell } from "@/modules/identity/ui/auth-shell";
import { rememberPendingEmail } from "@/modules/identity/ui/pending-email";
import { useHydrated } from "@/modules/identity/ui/use-hydrated";
import { GoogleAuthButton } from "@/modules/identity/ui/google-auth-button";
import { pendingInvite } from "@/modules/invitations/ui/pending-invite";
import { pendingReportLink } from "@/modules/dispatch/ui/pending-report-link";
import { PasswordField } from "@/modules/identity/ui/password-field";
import {
  validateEmail,
  validateLoginPassword,
} from "@/modules/identity/ui/auth-validation";

type Step = "password" | "code" | "recovery";

async function finish() {
  try {
    const response = await fetch("/api/auth/account/security-state", {
      cache: "no-store",
    });
    const state = response.ok ? await response.json() : null;
    // Somebody who opened an invitation link and had to sign in goes back to it to accept; otherwise to the workspace.
    window.location.assign(state?.gate ? "/account" : pendingInvite() ? "/invite" : pendingReportLink() ? "/report-link" : "/");
  } catch {
    window.location.assign("/");
  }
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [infoNotice, setInfoNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [step, setStep] = useState<Step>("password");
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const hydrated = useHydrated();

  useEffect(() => {
    fetch("/api/auth/account/sign-in-methods", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setGoogleEnabled(!!j?.google?.enabled))
      .catch(() => undefined);

    const params = new URLSearchParams(window.location.search);
    const code = params.get("error");
    if (code) setFormError(GOOGLE_REFUSAL_MESSAGES[refusalFrom(code)]);
    // Flags set by the screens that send people here; they carry no account information.
    if (params.get("created"))
      setInfoNotice("Your account was created. Sign in to continue.");
    else if (params.get("verified"))
      setInfoNotice("Your email is verified. Sign in to continue.");
    else if (params.get("reset"))
      setInfoNotice("Your password was updated. Sign in with the new password.");
  }, []);

  async function handleGoogleClick() {
    setFormError("");
    setInfoNotice("");
    setGoogleBusy(true);

    if (!googleEnabled) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      setGoogleBusy(false);
      setInfoNotice(
        "Continue with Google is not set up for this deployment. Sign in with your email and password below.",
      );
      return;
    }

    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "/",
          errorCallbackURL: "/login",
          requestSignUp: false,
        }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && typeof body?.url === "string") {
        window.location.assign(body.url);
        return;
      }
      setFormError(
        response.status === 429
          ? "Too many attempts. Wait a few minutes and try again."
          : GOOGLE_REFUSAL_MESSAGES.other,
      );
    } catch {
      setFormError("The server is unavailable. Please try again.");
    } finally {
      setGoogleBusy(false);
    }
  }

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setInfoNotice("");

    const nextEmailError = validateEmail(email);
    const nextPasswordError = validateLoginPassword(password);
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    if (nextEmailError || nextPasswordError) return;

    setBusy(true);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (body?.code === "EMAIL_NOT_VERIFIED") {
          // Correct password, address not verified yet: carry on to the verification screen.
          rememberPendingEmail(email);
          window.location.assign("/verify-email");
          return;
        }
        setFormError(
          body?.code === "TEMPORARY_PASSWORD_EXPIRED"
            ? "This temporary password has expired. Ask your academy owner to issue a new one."
            : response.status === 429
              ? "Too many attempts. Wait a few minutes and try again."
              : "Unable to sign in. Check your email and password, or try again shortly.",
        );
        return;
      }
      if (body?.twoFactorRedirect) {
        setCodeInput("");
        setStep("code");
        return;
      }
      await finish();
    } catch {
      setFormError("The server is unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitTwoFactor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    const trimmed = codeInput.trim();
    if (!trimmed) {
      setFormError(
        step === "code"
          ? "Enter your authenticator verification code."
          : "Enter one of your recovery codes.",
      );
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(
        step === "code"
          ? "/api/auth/two-factor/verify-totp"
          : "/api/auth/two-factor/verify-backup-code",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: trimmed }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setFormError(
          response.status === 429
            ? "Too many attempts. Wait a few minutes and try again."
            : body?.code === "INVALID_TWO_FACTOR_COOKIE" ||
                body?.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"
              ? "That sign-in attempt has expired. Start again with your password."
              : "That code was not accepted.",
        );
        if (
          body?.code === "INVALID_TWO_FACTOR_COOKIE" ||
          body?.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"
        ) {
          setStep("password");
        }
        return;
      }
      await finish();
    } catch {
      setFormError("The server is unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const locked = busy || googleBusy;

  return (
    <AuthShell
      eyebrow="SPORTOZEN ACADEMY"
      storyTitle={
        <>
          Great sessions{" "}
          <br />
          start with <em>a clear plan.</em>
        </>
      }
      storyBody="Your training schedules, player progress reports, fees and private family updates in one calm workspace."
    >
      <div className="auth-header">
        <span className="auth-eyebrow">
          {step === "password" ? "Sign in" : "Two-factor verification"}
        </span>
        <h2>
          {step === "password"
            ? "Welcome back"
            : step === "code"
              ? "Verify your identity"
              : "Enter a recovery code"}
        </h2>
        <p className="auth-subtitle">
          {step === "password"
            ? "Sign in to access your Sportozen Academy account."
            : step === "code"
              ? "Enter the 6-digit code from your authenticator app."
              : "Use a single-use backup recovery code to finish signing in."}
        </p>
      </div>

      {step !== "password" ? (
        <form
          className="auth-form"
          method="post"
          onSubmit={submitTwoFactor}
          noValidate
        >
          <div className="auth-field">
            <label className="auth-label" htmlFor="login-code">
              {step === "code" ? "Authenticator code" : "Recovery code"}
            </label>
            <input
              id="login-code"
              name="code"
              type="text"
              className="auth-input"
              inputMode={step === "code" ? "numeric" : "text"}
              autoComplete="one-time-code"
              placeholder={step === "code" ? "123456" : "xxxxx-xxxxx"}
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              disabled={locked}
              required
            />
          </div>

          {formError && (
            <p role="alert" className="auth-banner auth-banner-error">
              <AlertCircle size={16} aria-hidden="true" />
              <span>{formError}</span>
            </p>
          )}

          <button
            type="submit"
            className="primary auth-primary-btn"
            disabled={locked || !hydrated}
          >
            {busy ? (
              <>
                <Loader2 size={16} className="auth-spin" aria-hidden="true" />
                <span>Verifying…</span>
              </>
            ) : (
              <>
                <span>Continue</span>
                <ArrowRight size={16} aria-hidden="true" />
              </>
            )}
          </button>

          <button
            type="button"
            className="secondary auth-secondary-btn"
            disabled={locked}
            onClick={() => {
              setFormError("");
              setCodeInput("");
              setStep(step === "code" ? "recovery" : "code");
            }}
          >
            {step === "code"
              ? "Use a recovery code instead"
              : "Use my authenticator app"}
          </button>
        </form>
      ) : (
        <>
          <form
            className="auth-form"
            method="post"
            onSubmit={submitCredentials}
            noValidate
          >
            <div className="auth-field">
              <label className="auth-label" htmlFor="login-email">
                Email address
              </label>
              <input
                id="login-email"
                name="email"
                type="email"
                className={`auth-input${emailError ? " is-invalid" : ""}`}
                autoComplete="username"
                placeholder="name@academy.com"
                value={email}
                onChange={(e) => {
                  const next = e.target.value;
                  setEmail(next);
                  if (emailError) setEmailError(validateEmail(next));
                }}
                onBlur={() => setEmailError(validateEmail(email))}
                disabled={locked}
                aria-invalid={emailError ? "true" : undefined}
                aria-describedby={emailError ? "login-email-error" : undefined}
                required
              />
              {emailError && (
                <p
                  id="login-email-error"
                  className="auth-field-error"
                  role="alert"
                >
                  {emailError}
                </p>
              )}
            </div>

            <PasswordField
              id="login-password"
              name="password"
              label="Password"
              value={password}
              onChange={(next) => {
                setPassword(next);
                if (passwordError) setPasswordError(validateLoginPassword(next));
              }}
              onBlur={() => setPasswordError(validateLoginPassword(password))}
              autoComplete="current-password"
              placeholder="Enter your password"
              error={passwordError}
              disabled={locked}
              required
              labelAside={
                <Link href="/forgot-password" className="auth-inline-link">
                  Forgot password?
                </Link>
              }
            />

            {formError && (
              <p role="alert" className="auth-banner auth-banner-error">
                <AlertCircle size={16} aria-hidden="true" />
                <span>{formError}</span>
              </p>
            )}

            {infoNotice && (
              <p role="status" className="auth-banner auth-banner-info">
                <Info size={16} aria-hidden="true" />
                <span>{infoNotice}</span>
              </p>
            )}

            <button
              type="submit"
              className="primary auth-primary-btn"
              disabled={locked || !hydrated}
              aria-busy={busy ? "true" : undefined}
            >
              {busy ? (
                <>
                  <Loader2 size={16} className="auth-spin" aria-hidden="true" />
                  <span>Signing in…</span>
                </>
              ) : (
                <>
                  <span>Sign in</span>
                  <ArrowRight size={16} aria-hidden="true" />
                </>
              )}
            </button>
          </form>

          <div className="auth-divider" role="separator">
            <span>or</span>
          </div>

          <GoogleAuthButton
            busy={googleBusy}
            disabled={busy || !hydrated}
            onClick={() => void handleGoogleClick()}
          />

          <p className="auth-footer-switch">
            New to Sportozen Academy?{" "}
            <Link href="/signup" className="auth-link">
              Create an account
            </Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}
