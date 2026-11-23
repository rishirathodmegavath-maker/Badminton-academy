"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { AlertCircle, ArrowRight, Info, Loader2 } from "lucide-react";
import {
  GOOGLE_REFUSAL_MESSAGES,
  refusalFrom,
} from "@/modules/identity/google-messages";
import {
  ONBOARDING_MESSAGES,
  TERMS_VERSION,
} from "@/modules/identity/onboarding-policy";
import { useHydrated } from "@/modules/identity/ui/use-hydrated";
import { AuthShell } from "@/modules/identity/ui/auth-shell";
import { GoogleAuthButton } from "@/modules/identity/ui/google-auth-button";
import { PasswordField } from "@/modules/identity/ui/password-field";
import {
  PasswordRequirementsList,
  PasswordStrengthMeter,
} from "@/modules/identity/ui/password-strength";
import {
  passwordRequirements,
  passwordStrength,
  validateConfirmPassword,
  validateEmail,
  validateFullName,
  validateSignupPassword,
} from "@/modules/identity/ui/auth-validation";

export default function SignupPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [termsError, setTermsError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [formError, setFormError] = useState("");
  const [googleNotice, setGoogleNotice] = useState("");
  const hydrated = useHydrated();

  useEffect(() => {
    fetch("/api/auth/account/sign-in-methods", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setGoogleEnabled(!!j?.google?.enabled))
      .catch(() => undefined);
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) setFormError(GOOGLE_REFUSAL_MESSAGES[refusalFrom(code)]);
  }, []);

  const strength = passwordStrength(password, {
    name: fullName,
    email,
  });

  const reqs = passwordRequirements(password, {
    name: fullName,
    email,
  });

  async function handleGoogleClick() {
    setFormError("");
    setGoogleNotice("");

    if (!acceptedTerms) {
      setTermsError(ONBOARDING_MESSAGES.TERMS_REQUIRED);
      return;
    }
    setGoogleBusy(true);

    if (!googleEnabled) {
      setGoogleBusy(false);
      setGoogleNotice(
        "Continue with Google is not set up for this deployment. Create your account with an email and password instead.",
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
          errorCallbackURL: "/signup",
          requestSignUp: true,
          // Recorded server-side when the account is created; without it Google creates nothing.
          additionalData: { termsAccepted: true, termsVersion: TERMS_VERSION },
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setGoogleNotice("");

    const nextNameError = validateFullName(fullName);
    const nextEmailError = validateEmail(email);
    const nextPasswordError = validateSignupPassword(password, {
      name: fullName,
      email,
    });
    const nextConfirmError = validateConfirmPassword(password, confirmPassword);
    const nextTermsError = acceptedTerms
      ? null
      : "Accept the Terms of Service and Privacy Policy to continue.";

    setNameError(nextNameError);
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    setConfirmError(nextConfirmError);
    setTermsError(nextTermsError);

    if (
      nextNameError ||
      nextEmailError ||
      nextPasswordError ||
      nextConfirmError ||
      nextTermsError
    ) {
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/auth/onboarding/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fullName.trim(),
          email: email.trim(),
          password,
          acceptTerms: true,
          termsVersion: TERMS_VERSION,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (body?.code === "WEAK_PASSWORD")
          setPasswordError(body?.message ?? ONBOARDING_MESSAGES.WEAK_PASSWORD);
        else if (body?.code === "EMAIL_IN_USE")
          setEmailError(ONBOARDING_MESSAGES.EMAIL_IN_USE);
        else
          setFormError(
            response.status === 429
              ? ONBOARDING_MESSAGES.TOO_MANY_ATTEMPTS
              : typeof body?.message === "string" &&
                  ["TERMS_VERSION_CHANGED", "TERMS_REQUIRED"].includes(body?.code)
                ? body.message
                : "We could not create your account. Check your details and try again.",
          );
        return;
      }
      // The account exists (unverified, no academy). No session was started: the person signs in next.
      window.location.assign("/login?created=1");
    } catch {
      setFormError("The server is unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const locked = busy || googleBusy;

  return (
    <AuthShell
      eyebrow="GET STARTED"
      showcaseImage="/images/signup-badminton-action.jpg"
      storyTitle={
        <>
          Set up your{" "}
          <br />
          academy <em>profile.</em>
        </>
      }
      storyBody="Join your academy's coaching team or family portal with clean permissions and clear progress records."
    >
      <div className="auth-header">
        <span className="auth-eyebrow">Create account</span>
        <h2>Join Sportozen Academy</h2>
        <p className="auth-subtitle">
          Enter your details to get started with a personal account.
        </p>
      </div>

      <form
        className="auth-form"
        method="post"
        onSubmit={submit}
        noValidate
      >
        <div className="auth-field">
          <label className="auth-label" htmlFor="signup-name">
            Full name
          </label>
          <input
            id="signup-name"
            name="name"
            type="text"
            className={`auth-input${nameError ? " is-invalid" : ""}`}
            autoComplete="name"
            placeholder="Priya Mehta"
            value={fullName}
            onChange={(e) => {
              const next = e.target.value;
              setFullName(next);
              if (nameError) setNameError(validateFullName(next));
            }}
            onBlur={() => setNameError(validateFullName(fullName))}
            disabled={locked}
            aria-invalid={nameError ? "true" : undefined}
            aria-describedby={nameError ? "signup-name-error" : undefined}
            required
          />
          {nameError && (
            <p id="signup-name-error" className="auth-field-error" role="alert">
              {nameError}
            </p>
          )}
        </div>

        <div className="auth-field">
          <label className="auth-label" htmlFor="signup-email">
            Email address
          </label>
          <input
            id="signup-email"
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
            disabled={locked}
            aria-invalid={emailError ? "true" : undefined}
            aria-describedby={emailError ? "signup-email-error" : undefined}
            required
          />
          {emailError && (
            <p
              id="signup-email-error"
              className="auth-field-error"
              role="alert"
            >
              {emailError}
            </p>
          )}
        </div>

        <div className="auth-field">
          <PasswordField
            id="signup-password"
            name="password"
            label="Password"
            value={password}
            onChange={(next) => {
              setPassword(next);
              if (passwordError) {
                setPasswordError(
                  validateSignupPassword(next, { name: fullName, email }),
                );
              }
              if (confirmPassword && confirmError) {
                setConfirmError(validateConfirmPassword(next, confirmPassword));
              }
            }}
            onBlur={() =>
              setPasswordError(
                validateSignupPassword(password, { name: fullName, email }),
              )
            }
            autoComplete="new-password"
            placeholder="At least 12 characters"
            error={passwordError}
            disabled={locked}
            describedBy="signup-password-strength signup-password-reqs"
            required
          />
          <PasswordStrengthMeter
            id="signup-password-strength"
            strength={strength}
          />
          <PasswordRequirementsList
            id="signup-password-reqs"
            requirements={reqs}
          />
        </div>

        <PasswordField
          id="signup-confirm"
          name="confirmPassword"
          label="Confirm password"
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
          placeholder="Re-enter your password"
          error={confirmError}
          disabled={locked}
          required
        />

        <div className="auth-field">
          <div className="auth-checkbox-row">
            <input
              id="signup-terms"
              name="terms"
              type="checkbox"
              className="auth-checkbox"
              checked={acceptedTerms}
              onChange={(e) => {
                setAcceptedTerms(e.target.checked);
                if (e.target.checked) setTermsError(null);
              }}
              disabled={locked}
              aria-invalid={termsError ? "true" : undefined}
              aria-describedby={termsError ? "signup-terms-error" : undefined}
              required
            />
            <label className="auth-checkbox-label" htmlFor="signup-terms">
              I agree to the{" "}
              <Link href="/terms">Terms of Service</Link> and{" "}
              <Link href="/privacy">Privacy Policy</Link>.
            </label>
          </div>
          {termsError && (
            <p
              id="signup-terms-error"
              className="auth-field-error"
              role="alert"
            >
              {termsError}
            </p>
          )}
        </div>

        {formError && (
          <p role="alert" className="auth-banner auth-banner-error">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{formError}</span>
          </p>
        )}

        {googleNotice && (
          <p role="status" className="auth-banner auth-banner-info">
            <Info size={16} aria-hidden="true" />
            <span>{googleNotice}</span>
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
              <span>Creating account…</span>
            </>
          ) : (
            <>
              <span>Create account</span>
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
        Already have an account?{" "}
        <Link href="/login" className="auth-link">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
