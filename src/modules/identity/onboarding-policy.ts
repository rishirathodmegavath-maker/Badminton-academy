/**
 * Public onboarding policy: one place for the numbers and words that the onboarding endpoints
 * (onboarding.ts) and the screens (signup, verify-email, forgot/reset password) must agree on.
 * Pure data, no server imports, so client components may import it.
 */
/** The terms a person accepted at signup. Bump when the Terms of Service or Privacy Policy change materially. */
export const TERMS_VERSION = "2026-11-12";
export const OTP_LENGTH = 6;
/** An emailed verification code is valid this long. */
export const OTP_TTL_MS = 10 * 60 * 1000;
/** A password-reset link is valid this long. */
export const RESET_TTL_MS = 30 * 60 * 1000;
/** Minimum gap between two emails of the same kind to the same person (resend / repeat request). */
export const EMAIL_COOLDOWN_MS = 60 * 1000;
/** Wrong codes allowed per 15-minute window before the code is withdrawn and a new one is needed. */
export const VERIFY_MAX_ATTEMPTS = 5;
/** Signups, resends and reset requests allowed per address per 15-minute window. */
export const SEND_MAX_PER_WINDOW = 5;

export const NAME_MIN = 2;
export const NAME_MAX = 100;
export const EMAIL_MAX = 254;

/** Stable codes the onboarding endpoints answer with, and what the screens say for them. */
export const ONBOARDING_MESSAGES = {
  // Only the optional "send me a verification code" step needs email; creating an account never does.
  SIGNUP_UNAVAILABLE:
    "Sending a verification code is not available right now because email delivery is not set up.",
  EMAIL_IN_USE:
    "An account with this email address already exists. Sign in, or use Forgot password if you cannot remember it.",
  RESET_UNAVAILABLE:
    "Password reset by email is not available right now. Contact your academy owner to issue a temporary password.",
  WEAK_PASSWORD: "Choose a stronger password.",
  PASSWORD_MISMATCH: "The two passwords do not match.",
  TERMS_REQUIRED: "Accept the Terms of Service and Privacy Policy to continue.",
  TERMS_VERSION_CHANGED:
    "The Terms of Service were updated. Reload this page and accept the current terms.",
  INVALID_CODE: "That code is invalid or has expired. Request a new code and try again.",
  INVALID_RESET_TOKEN:
    "This reset link is invalid or has expired. Request a new one from the sign-in page.",
  MFA_CODE_REQUIRED:
    "This account uses an authenticator app. Enter a current code (or one recovery code) to reset the password.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Wait a few minutes and try again.",
  EMAIL_NOT_VERIFIED:
    "Verify your email address to sign in. We can send you a new code.",
} as const;
export type OnboardingCode = keyof typeof ONBOARDING_MESSAGES;

/** A password signup needs no email: the account exists at once, unverified, and the person signs in next. */
export const SIGNUP_CREATED_RESPONSE = {
  status: true,
  next: "SIGN_IN",
} as const;

/** Same answer whether or not the address has an account, so the endpoints cannot be used to find accounts. */
export const GENERIC_SIGNUP_RESPONSE = {
  status: true,
  next: "VERIFY_EMAIL",
} as const;
export const GENERIC_RESET_RESPONSE = {
  status: true,
  next: "CHECK_EMAIL",
} as const;
