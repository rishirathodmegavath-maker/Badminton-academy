import { ClientIpConfigError, clientIpConfig } from "./client-ip";
import { MfaPolicyError, mfaPolicy } from "./mfa-policy";
import { googleConfig } from "./google";
import { emailProviderConfig } from "../../infrastructure/email/provider";
/**
 * Start-up review of the settings that decide whether account security actually holds.
 *
 * `checkSecurityConfig` is pure: it reads the environment it is given, never touches the network
 * or the database, and NEVER puts a value from the environment into a message (only variable
 * names and what is wrong with them), so its output is safe to log and to paste into a ticket.
 *
 *  - error    the setting is invalid or unsafe; production refuses to start (development warns).
 *  - warning  the application works but a protection is reduced; a human should look.
 *  - info     a consequence worth knowing, not a problem.
 */
export type Env = Readonly<Record<string, string | undefined>>;
export type Finding = {
  level: "error" | "warning" | "info";
  variable: string;
  message: string;
};
const PLACEHOLDER =
  /change.?me|replace.?me|your.?secret|example|placeholder|default|password|secret.?here|dummy/i;
const MIGRATION_TARGET = /^[^\s/:]+:\d{1,5}\/[^\s/]+$/;
const set = (v: string | undefined) => !!v && v.trim().length > 0;
export function checkSecurityConfig(
  env: Env,
  mode: "production" | "development" = env.NODE_ENV === "production"
    ? "production"
    : "development",
): Finding[] {
  const production = mode === "production";
  const out: Finding[] = [];
  const add = (level: Finding["level"], variable: string, message: string) =>
    out.push({ level, variable, message });
  // --- BETTER_AUTH_SECRET: signs sessions and encrypts authenticator secrets / recovery codes.
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (!set(secret))
    add("error", "BETTER_AUTH_SECRET", "Is not set.");
  else {
    if (secret.length < 32)
      add(
        "error",
        "BETTER_AUTH_SECRET",
        "Is shorter than 32 characters. Generate one with a cryptographic random source.",
      );
    if (new Set(secret).size < 10)
      add(
        production ? "error" : "warning",
        "BETTER_AUTH_SECRET",
        "Uses very few distinct characters, so it is easy to guess. Generate one with a cryptographic random source.",
      );
    if (PLACEHOLDER.test(secret))
      add(
        production ? "error" : "warning",
        "BETTER_AUTH_SECRET",
        "Looks like a placeholder or example value.",
      );
    add(
      "info",
      "BETTER_AUTH_SECRET",
      "It also encrypts authenticator secrets and recovery codes: changing it after people enrol makes those unreadable (they need an authenticator reset) and signs everyone out.",
    );
  }
  // --- BETTER_AUTH_URL: cookie scope and the origin the write APIs accept.
  const urlText = env.BETTER_AUTH_URL ?? "";
  if (!set(urlText)) add("error", "BETTER_AUTH_URL", "Is not set.");
  else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(urlText);
    } catch {
      add("error", "BETTER_AUTH_URL", "Is not a valid URL.");
    }
    if (parsed && production && parsed.protocol !== "https:")
      add(
        "warning",
        "BETTER_AUTH_URL",
        "Is not https. Production session cookies are marked Secure, so sign-in only works over https (or on localhost).",
      );
  }
  if (production && !set(env.DATABASE_URL))
    add("error", "DATABASE_URL", "Is required in production.");
  // --- Client address trust (rate limiting).
  let proxiesDeclared = false;
  try {
    proxiesDeclared = clientIpConfig(env).ipAddressHeaders.length > 0;
  } catch (error) {
    if (!(error instanceof ClientIpConfigError)) throw error;
    // The messages name entries from TRUSTED_PROXIES (addresses, not secrets); keep the variable only.
    add(
      "error",
      error.message.startsWith("TRUSTED_CLIENT_IP_HEADER")
        ? "TRUSTED_CLIENT_IP_HEADER"
        : "TRUSTED_PROXIES",
      error.message,
    );
  }
  if (!proxiesDeclared && !out.some((f) => f.variable.startsWith("TRUSTED_"))) {
    if (set(env.TRUSTED_CLIENT_IP_HEADER))
      add(
        "warning",
        "TRUSTED_CLIENT_IP_HEADER",
        "Is set but ignored because TRUSTED_PROXIES is empty. Forwarding headers are never believed without a declared proxy.",
      );
    if (production)
      add(
        "warning",
        "TRUSTED_PROXIES",
        "Is not set: client addresses cannot be verified, so every client shares one rate-limit bucket per endpoint (safe, but one attacker can throttle everyone). Set it to the proxy addresses in front of this app.",
      );
  }
  // --- Two-factor rollout.
  try {
    const policy = mfaPolicy(env);
    if (policy.mode === "off" && set(env.MFA_REQUIRED_ROLES))
      add(
        "warning",
        "MFA_REQUIRED_ROLES",
        "Is set but ignored because MFA_ENFORCEMENT is off.",
      );
    if (policy.mode === "warn")
      add(
        "info",
        "MFA_ENFORCEMENT",
        `Warn mode: ${policy.roles.join(", ")} are told to enrol and keep full access.`,
      );
    if (policy.mode === "enforce")
      add(
        "info",
        "MFA_ENFORCEMENT",
        `Enforce mode: ${policy.roles.join(", ")} without an authenticator can sign in only to enrol. Confirm each affected person can complete enrolment first. Academy owners can raise this per academy but never lower it.`,
      );
  } catch (error) {
    if (!(error instanceof MfaPolicyError)) throw error;
    add(
      "error",
      error.message.startsWith("MFA_REQUIRED_ROLES")
        ? "MFA_REQUIRED_ROLES"
        : "MFA_ENFORCEMENT",
      error.message.replace(/ \(got ".*"\)/, ""),
    );
  }
  // --- Google sign-in (optional; see GOOGLE_SIGN_IN.md).
  const google = googleConfig(env);
  if (!google.enabled && google.problem)
    add("error", "GOOGLE_CLIENT_ID", google.problem);
  if (google.enabled) {
    add(
      "info",
      "GOOGLE_CLIENT_ID",
      "Google sign-in is enabled. Register BETTER_AUTH_URL + /api/auth/callback/google as an authorised redirect URI in the Google Cloud console. Accounts are never created or linked from Google; each person links it themselves in Account security.",
    );
    if (production && !/^https:/i.test(env.BETTER_AUTH_URL ?? ""))
      add(
        "warning",
        "BETTER_AUTH_URL",
        "Google only accepts https redirect URIs for a production client, so Google sign-in will fail until BETTER_AUTH_URL is https.",
      );
  }
  // --- Transactional email delivery (optional until configured; must be complete when enabled).
  const email = emailProviderConfig(env);
  if (email.provider === "invalid") add("error", email.variable, email.problem);
  else if (email.provider === "test")
    add(
      "warning",
      "EMAIL_PROVIDER",
      "The test email provider is active: authentication emails are written to a local capture file and nothing is sent. Disposable test instances only.",
    );
  else if (email.provider === "resend" || email.provider === "zeptomail")
    add(
      "info",
      "EMAIL_PROVIDER",
      `Transactional authentication email delivery is enabled via ${email.provider === "resend" ? "Resend" : "Zoho ZeptoMail"}.`,
    );
  else if (production)
    add(
      "info",
      "EMAIL_PROVIDER",
      "Transactional authentication email delivery is disabled. Set EMAIL_PROVIDER=resend (RESEND_API_KEY) or EMAIL_PROVIDER=zeptomail (ZEPTOMAIL_TOKEN) with EMAIL_FROM to deliver verification and reset emails.",
    );
  // --- Storage that production must provide (the application starts without them and fails on first use).
  if (production && !set(env.PRIVATE_MEDIA_PATH))
    add(
      "warning",
      "PRIVATE_MEDIA_PATH",
      "Is not set: uploading and playing private media (training video, photos) answers 503 until a persistent, backed-up directory is configured.",
    );
  if (production && !set(env.ERASURE_LEDGER_PATH))
    add(
      "warning",
      "ERASURE_LEDGER_PATH",
      "Is not set: processed erasure requests cannot be recorded in the tamper-evident ledger file, so the privacy worker has nowhere to write its evidence.",
    );
  // --- Migration safety and development helpers.
  if (set(env.MIGRATION_CONFIRM_TARGET) && !MIGRATION_TARGET.test(env.MIGRATION_CONFIRM_TARGET!))
    add(
      "warning",
      "MIGRATION_CONFIRM_TARGET",
      "Is not in the form host:port/database, so it can never confirm a remote migration.",
    );
  if (production && env.ALLOW_DEV_SEED === "true")
    add(
      "warning",
      "ALLOW_DEV_SEED",
      "Is enabled in production. The fictional seed script must never run against real data.",
    );
  return out;
}
export const hasErrors = (findings: readonly Finding[]) =>
  findings.some((f) => f.level === "error");
/** One line per finding, no values. */
export const formatFindings = (findings: readonly Finding[]) =>
  findings.map(
    (f) => `[security:${f.level}] ${f.variable}: ${f.message}`,
  );
/**
 * Called once when the server starts. In production an unsafe or invalid setting stops start-up
 * with the reason (otherwise it would surface later, on the first sign-in); in development the
 * same findings are printed as warnings so a half-configured laptop still runs.
 */
export function assertSecurityConfig(
  env: Env = process.env,
  log: Pick<Console, "warn" | "error" | "info"> = console,
) {
  const findings = checkSecurityConfig(env);
  const production = env.NODE_ENV === "production";
  for (const f of findings) {
    const line = formatFindings([f])[0];
    if (f.level === "error") log.error(line);
    else if (f.level === "warning") log.warn(line);
    else if (production) log.info(line);
  }
  if (production && hasErrors(findings))
    throw new Error(
      "Unsafe or invalid security configuration; see the [security:error] lines above. The application will not start.",
    );
  return findings;
}
