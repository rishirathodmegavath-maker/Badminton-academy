import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  type PasswordContext,
} from "../password-policy";

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateFullName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter your full name.";
  if (trimmed.length < 2) return "Full name must be at least 2 characters.";
  return null;
}

export function validateEmail(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter your email address.";
  if (!EMAIL_PATTERN.test(trimmed))
    return "Enter a valid email address, such as name@academy.com.";
  return null;
}

export function validateLoginPassword(value: string): string | null {
  if (!value) return "Enter your password.";
  return null;
}

export type PasswordRequirement = {
  id: "length" | "strength" | "personal";
  label: string;
  met: boolean;
};

/** Live requirement checklist aligned with Sportozen's real server password policy. */
export function passwordRequirements(
  password: string,
  context: PasswordContext = {},
): PasswordRequirement[] {
  const problem = password ? passwordProblem(password, context) : null;
  const lengthMet =
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH;
  const personalFailure =
    problem?.includes("email address") || problem?.includes("your name");
  const strengthFailure =
    !!problem &&
    !personalFailure &&
    !problem.includes("at least") &&
    !problem.includes("at most");

  const local = context.email
    ?.split("@")[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const plain = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hasPersonalMatch =
    !!password &&
    ((!!local && local.length >= 4 && plain.includes(local)) ||
      (context.name ?? "")
        .toLowerCase()
        .split(/\s+/)
        .some((part) => {
          const clean = part.replace(/[^a-z0-9]/g, "");
          return clean.length >= 4 && plain.includes(clean);
        }));

  return [
    {
      id: "length",
      label: `At least ${PASSWORD_MIN_LENGTH} characters`,
      met: lengthMet,
    },
    {
      id: "strength",
      label: "Avoid common words or sequences (e.g. 123456)",
      met: password.length > 0 && lengthMet && !strengthFailure,
    },
    {
      id: "personal",
      label: "Does not contain your name or email",
      met: password.length > 0 && !personalFailure && !hasPersonalMatch,
    },
  ];
}

export function validateSignupPassword(
  password: string,
  context: PasswordContext = {},
): string | null {
  if (!password) return "Create a password.";
  return passwordProblem(password, context);
}

export function validateConfirmPassword(
  password: string,
  confirmPassword: string,
): string | null {
  if (!confirmPassword) return "Confirm your password.";
  if (password !== confirmPassword) return "Passwords do not match.";
  return null;
}

export type PasswordStrengthLevel =
  | "empty"
  | "weak"
  | "fair"
  | "good"
  | "strong";

export type PasswordStrength = {
  level: PasswordStrengthLevel;
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
};

/** Evaluates password strength consistently with Sportozen's NIST-aligned policy. */
export function passwordStrength(
  password: string,
  context: PasswordContext = {},
): PasswordStrength {
  if (!password) {
    return { level: "empty", score: 0, label: "" };
  }

  const problem = passwordProblem(password, context);
  const uniqueChars = new Set(password).size;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9\s]/].filter((re) =>
    re.test(password),
  ).length;
  const words = password.trim().split(/\s+/).filter(Boolean).length;

  if (problem !== null) {
    if (
      problem.startsWith("Use at least") &&
      password.length >= 8 &&
      uniqueChars >= 5 &&
      classes >= 2
    ) {
      return { level: "fair", score: 2, label: "Fair" };
    }
    return { level: "weak", score: 1, label: "Weak" };
  }

  const isStrong =
    (password.length >= 16 && uniqueChars >= 10) ||
    (password.length >= 14 && classes >= 3 && uniqueChars >= 9) ||
    (words >= 3 && password.length >= 16);

  if (isStrong) {
    return { level: "strong", score: 4, label: "Strong" };
  }

  return { level: "good", score: 3, label: "Good" };
}

export function validateVerificationCode(value: string): string | null {
  const digits = value.trim();
  if (!digits) return "Enter the 6-digit verification code.";
  if (!/^\d{6}$/.test(digits))
    return "Enter all 6 digits from your verification email.";
  return null;
}
