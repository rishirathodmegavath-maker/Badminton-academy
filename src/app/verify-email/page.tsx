"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Info,
  Loader2,
  RotateCw,
} from "lucide-react";
import {
  EMAIL_COOLDOWN_MS,
  ONBOARDING_MESSAGES,
} from "@/modules/identity/onboarding-policy";
import { AuthShell } from "@/modules/identity/ui/auth-shell";
import {
  passwordRequirements,
  passwordStrength,
  validateConfirmPassword,
  validateEmail,
  validateSignupPassword,
  validateVerificationCode,
} from "@/modules/identity/ui/auth-validation";
import { PasswordField } from "@/modules/identity/ui/password-field";
import {
  PasswordRequirementsList,
  PasswordStrengthMeter,
} from "@/modules/identity/ui/password-strength";
import {
  forgetPendingEmail,
  readPendingEmail,
} from "@/modules/identity/ui/pending-email";
import { useHydrated } from "@/modules/identity/ui/use-hydrated";

const CODE_LENGTH = 6;
const EMPTY_DIGITS = Array.from({ length: CODE_LENGTH }, () => "");

export default function VerifyEmailPage() {
  const [digits, setDigits] = useState<string[]>(EMPTY_DIGITS);
  const [emailHint, setEmailHint] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [formError, setFormError] = useState("");
  const [resendNotice, setResendNotice] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const hydrated = useHydrated();

  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    // The address comes from this tab's session storage (set by sign-up / sign-in), never from the URL.
    const remembered = readPendingEmail();
    if (remembered) setEmailHint(remembered);
  }, []);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const address = emailHint || emailInput.trim().toLowerCase();
  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  const joinedCode = digits.join("");
  const strength = passwordStrength(password, { email: address });
  const reqs = passwordRequirements(password, { email: address });

  function updateDigit(index: number, raw: string) {
    const clean = raw.replace(/\D/g, "");
    if (!clean) {
      const next = [...digits];
      next[index] = "";
      setDigits(next);
      if (codeError) setCodeError(validateVerificationCode(next.join("")));
      return;
    }

    const next = [...digits];
    if (clean.length > 1) {
      for (let offset = 0; offset < clean.length && index + offset < CODE_LENGTH; offset++) {
        next[index + offset] = clean[offset];
      }
      setDigits(next);
      const focusIdx = Math.min(index + clean.length, CODE_LENGTH - 1);
      inputRefs.current[focusIdx]?.focus();
    } else {
      next[index] = clean;
      setDigits(next);
      if (index < CODE_LENGTH - 1) {
        inputRefs.current[index + 1]?.focus();
      }
    }

    if (codeError) {
      setCodeError(validateVerificationCode(next.join("")));
    }
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      event.preventDefault();
      const next = [...digits];
      next[index - 1] = "";
      setDigits(next);
      inputRefs.current[index - 1]?.focus();
      return;
    }
    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      inputRefs.current[index - 1]?.focus();
      return;
    }
    if (event.key === "ArrowRight" && index < CODE_LENGTH - 1) {
      event.preventDefault();
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "");
    if (!pasted) return;
    event.preventDefault();
    const next = Array.from({ length: CODE_LENGTH }, (_, idx) => pasted[idx] ?? "");
    setDigits(next);
    const focusIdx = Math.min(pasted.length, CODE_LENGTH - 1);
    inputRefs.current[focusIdx]?.focus();
    if (codeError) {
      setCodeError(validateVerificationCode(next.join("")));
    }
  }

  function addressProblem() {
    if (emailHint) return null;
    const problem = validateEmail(emailInput);
    setEmailError(problem);
    return problem;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setResendNotice("");

    const err = validateVerificationCode(joinedCode);
    setCodeError(err);
    const nextPasswordError = validateSignupPassword(password, { email: address });
    const nextConfirmError = validateConfirmPassword(password, confirmPassword);
    setPasswordError(nextPasswordError);
    setConfirmError(nextConfirmError);
    if (addressProblem() || err || nextPasswordError || nextConfirmError) {
      if (err) {
        const firstEmpty = digits.findIndex((d) => !d);
        inputRefs.current[firstEmpty === -1 ? 0 : firstEmpty]?.focus();
      }
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/auth/onboarding/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: address,
          code: joinedCode,
          password,
          confirmPassword,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // A refused password does not spend the code: say what is wrong with it and let them choose another.
        if (body?.code === "WEAK_PASSWORD") {
          setPasswordError(body?.message ?? ONBOARDING_MESSAGES.WEAK_PASSWORD);
          return;
        }
        if (body?.code === "PASSWORD_MISMATCH") {
          setConfirmError(ONBOARDING_MESSAGES.PASSWORD_MISMATCH);
          return;
        }
        setDigits(EMPTY_DIGITS);
        inputRefs.current[0]?.focus();
        setFormError(
          response.status === 429
            ? ONBOARDING_MESSAGES.TOO_MANY_ATTEMPTS
            : body?.code === "INVALID_CODE"
              ? ONBOARDING_MESSAGES.INVALID_CODE
              : "We could not verify that code. Please try again.",
        );
        return;
      }
      // Verifying does not sign anyone in: the person signs in next.
      forgetPendingEmail();
      window.location.assign("/login?verified=1");
    } catch {
      setFormError("The server is unavailable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    setFormError("");
    setResendNotice("");
    setCodeError(null);
    if (addressProblem()) return;
    setResending(true);
    try {
      const response = await fetch("/api/auth/onboarding/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address }),
      });
      if (response.status === 429) {
        setFormError(ONBOARDING_MESSAGES.TOO_MANY_ATTEMPTS);
        return;
      }
      if (!response.ok) {
        setFormError(
          response.status === 503
            ? ONBOARDING_MESSAGES.SIGNUP_UNAVAILABLE
            : "We could not send a new code. Please try again.",
        );
        return;
      }
      setDigits(EMPTY_DIGITS);
      setCooldownUntil(Date.now() + EMAIL_COOLDOWN_MS);
      setNow(Date.now());
      setResendNotice(
        "If this address has an account waiting for verification, a new code is on its way. The previous code no longer works.",
      );
    } catch {
      setFormError("The server is unavailable. Please try again.");
    } finally {
      setResending(false);
    }
  }

  const locked = busy || resending;

  return (
    <AuthShell
      eyebrow="EMAIL VERIFICATION"
      storyTitle={
        <>
          Confirm your{" "}
          <br />
          academy <em>email.</em>
        </>
      }
      storyBody="Verify your address to activate account recovery and receive guardian or coach invitations."
    >
      <Link href="/signup" className="auth-back-link">
        <ArrowLeft size={15} aria-hidden="true" />
        <span>Back to create account</span>
      </Link>

      <div className="auth-header">
        <span className="auth-eyebrow">Check your inbox</span>
        <h2>Verify your email</h2>
        <p className="auth-subtitle">
          {emailHint ? (
            <>
              Enter the 6-digit verification code sent to{" "}
              <strong className="auth-inline-strong">{emailHint}</strong>.
            </>
          ) : (
            "Enter the 6-digit verification code sent to your email address."
          )}{" "}
          Then choose the password you will sign in with.
        </p>
      </div>

      <form
        className="auth-form"
        method="post"
        onSubmit={submit}
        noValidate
      >
        {!emailHint && (
          <div className="auth-field">
            <label className="auth-label" htmlFor="verify-email-address">
              Email address
            </label>
            <input
              id="verify-email-address"
              name="email"
              type="email"
              className={`auth-input${emailError ? " is-invalid" : ""}`}
              autoComplete="email"
              placeholder="name@academy.com"
              value={emailInput}
              onChange={(e) => {
                setEmailInput(e.target.value);
                if (emailError) setEmailError(validateEmail(e.target.value));
              }}
              disabled={locked}
              aria-invalid={emailError ? "true" : undefined}
              aria-describedby={emailError ? "verify-email-address-error" : undefined}
              required
            />
            {emailError && (
              <p id="verify-email-address-error" className="auth-field-error" role="alert">
                {emailError}
              </p>
            )}
          </div>
        )}
        <fieldset className="auth-otp-fieldset">
          <legend className="auth-label">6-digit verification code</legend>
          <div className="auth-otp-row" role="group" aria-label="Verification code">
            {digits.map((digit, index) => (
              <input
                key={index}
                ref={(el) => {
                  inputRefs.current[index] = el;
                }}
                id={`verify-digit-${index + 1}`}
                name={`digit-${index + 1}`}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoComplete={index === 0 ? "one-time-code" : "off"}
                aria-label={`Verification code digit ${index + 1} of ${CODE_LENGTH}`}
                aria-invalid={codeError ? "true" : undefined}
                aria-describedby={codeError ? "verify-code-error" : "verify-code-hint"}
                className={`auth-otp-input${codeError ? " is-invalid" : ""}`}
                value={digit}
                disabled={locked}
                onChange={(e) => updateDigit(index, e.target.value)}
                onKeyDown={(e) => handleKeyDown(index, e)}
                onPaste={handlePaste}
              />
            ))}
          </div>
          <p id="verify-code-hint" className="auth-field-hint">
            Tip: you can paste all 6 digits directly into the first box.
          </p>
          {codeError && (
            <p id="verify-code-error" className="auth-field-error" role="alert">
              {codeError}
            </p>
          )}
        </fieldset>

        <div className="auth-field">
          <PasswordField
            id="verify-password"
            name="password"
            label="Password"
            value={password}
            onChange={(next) => {
              setPassword(next);
              if (passwordError) setPasswordError(validateSignupPassword(next, { email: address }));
              if (confirmPassword && confirmError) {
                setConfirmError(validateConfirmPassword(next, confirmPassword));
              }
            }}
            onBlur={() => {
              if (password) setPasswordError(validateSignupPassword(password, { email: address }));
            }}
            autoComplete="new-password"
            placeholder="At least 12 characters"
            hint="Re-enter your password here. This one replaces the password typed when the account was created, so only someone with access to this inbox can set it."
            error={passwordError}
            disabled={locked}
            describedBy="verify-password-strength verify-password-reqs"
            required
          />
          <PasswordStrengthMeter id="verify-password-strength" strength={strength} />
          <PasswordRequirementsList id="verify-password-reqs" requirements={reqs} />
        </div>

        <PasswordField
          id="verify-confirm-password"
          name="confirmPassword"
          label="Confirm password"
          value={confirmPassword}
          onChange={(next) => {
            setConfirmPassword(next);
            if (confirmError) setConfirmError(validateConfirmPassword(password, next));
          }}
          onBlur={() => {
            if (confirmPassword || confirmError) {
              setConfirmError(validateConfirmPassword(password, confirmPassword));
            }
          }}
          autoComplete="new-password"
          placeholder="Re-enter your password"
          error={confirmError}
          disabled={locked}
          required
        />

        {formError && (
          <p role="alert" className="auth-banner auth-banner-error">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{formError}</span>
          </p>
        )}

        {resendNotice && (
          <p role="status" className="auth-banner auth-banner-info">
            <Info size={16} aria-hidden="true" />
            <span>{resendNotice}</span>
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
              <span>Verifying code…</span>
            </>
          ) : (
            <>
              <span>Verify email</span>
              <ArrowRight size={16} aria-hidden="true" />
            </>
          )}
        </button>

        <button
          type="button"
          className="secondary auth-secondary-btn auth-resend-btn"
          disabled={locked || !hydrated || cooldownSeconds > 0}
          aria-busy={resending ? "true" : undefined}
          onClick={() => void handleResend()}
        >
          <RotateCw
            size={15}
            className={resending ? "auth-spin" : undefined}
            aria-hidden="true"
          />
          <span>
            {resending
              ? "Sending new code…"
              : cooldownSeconds > 0
                ? `Resend available in ${cooldownSeconds}s`
                : "Resend verification code"}
          </span>
        </button>
      </form>

      <p className="auth-footer-switch">
        Already verified?{" "}
        <Link href="/login" className="auth-link">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
