import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The environment of a DISPOSABLE application server for browser tests (scripts/e2e-server.ts).
 *
 * Why this exists: `next start` loads `.env.local` from the project folder, so a browser test server silently inherited the
 * developer's real settings (real Google credentials, a mail provider, an MFA rollout, trusted proxies...) and a spec such as
 * tests/e2e/auth-no-email.spec.ts, which asserts "Google is not set up", passed or failed depending on whose machine it ran on.
 *
 * Next's environment loader never overrides a variable that is already present in the process environment, and an
 * explicitly EMPTY value counts as present (verified against the real loader in tests/e2e-server-env.test.ts). So the
 * launcher builds the child's environment from scratch: a small allow-list from the parent (so Node can run) plus explicit
 * values, with every optional external-service variable set to the empty string. Nothing is read from `.env.local` and
 * nothing is written to it; no secret from the parent environment is forwarded.
 *
 * This is test tooling only. It does not change how the application reads its configuration, and production never uses it.
 */
export type Env = Readonly<Record<string, string | undefined>>;
export type Profile =
  /** No Google credentials and no mail provider: the intended "no email OTP" launch configuration. */
  | "plain"
  /** Obviously fake Google credentials (nothing talks to Google; the redirect is intercepted by the test). */
  | "fake-google";

/** Settings that change authentication behaviour or reach an external service. Always forced to a known value. */
export const CONTROLLED_VARIABLES = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "EMAIL_PROVIDER",
  "RESEND_API_KEY",
  "ZEPTOMAIL_TOKEN",
  "ZEPTOMAIL_API_URL",
  "EMAIL_FROM",
  "MFA_ENFORCEMENT",
  "MFA_REQUIRED_ROLES",
  "TRUSTED_PROXIES",
  "TRUSTED_CLIENT_IP_HEADER",
  "MIGRATION_CONFIRM_TARGET",
  "MIGRATION_STATEMENT_TIMEOUT_MS",
  "LOCAL_DATABASE_PATH",
  "ALLOW_DEV_SEED",
  "DEV_SEED_PASSWORD",
  "ERASURE_LEDGER_PATH",
  // Test-only switches: present-but-empty unless a profile turns them on, so a local `.env.local` can never enable them.
  "E2E_DISPOSABLE",
  "AUTH_EMAIL_CAPTURE_FILE",
  "DISPATCH_EMAIL_PROVIDER",
  "DISPATCH_WHATSAPP_PROVIDER",
  "DISPATCH_TEST_OUTBOX_FILE",
  "OUTBOUND_GUARD_LOG",
] as const;

/** What a Node process needs from its parent to start at all (never a credential). */
const PASS_THROUGH = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramData", "LANG", "TZ",
] as const;

export const FAKE_GOOGLE = {
  GOOGLE_CLIENT_ID: "fake-browser-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fake-browser-test-secret-not-a-credential",
} as const;

/** An absolute path: a drive letter or a leading slash. */
const ABSOLUTE_PATH = new RegExp("^(?:[A-Za-z]:[" + "\\\\" + "/]|/)");
/** NUL, CR, LF: a path with any of these could break out of an environment value. */
const CONTROL_CHARACTER = new RegExp("[" + String.fromCharCode(0) + String.fromCharCode(13) + String.fromCharCode(10) + "]");
/** NODE_OPTIONS is split on spaces and has its own quoting, so a path with either cannot be carried in it. */
const UNSAFE_IN_NODE_OPTIONS = /[\s"']/;
const LOOPBACK_E2E_DATABASE =
  /^postgres(ql)?:\/\/[^@/]*@(127\.0\.0\.1|localhost|\[::1\]):\d+\/sportozen_e2e(\?.*)?$/;

export type Mode = "production" | "development";

export type ServerOptions = {
  profile: Profile;
  /** "production" (default): `next start` on a built app. "development": `next dev`, for the profiles whose test adapters refuse production. */
  mode?: Mode;
  /** Development only. Dispatch (reports to families) uses the test adapters, which record what would be sent in this file. */
  deliveryTest?: { outboxFile: string };
  /** Development only. Authentication email uses the capture-to-file test provider. */
  emailTest?: { captureFile: string };
  /** Refuses (and records) every outbound call to a non-loopback address; the script is scripts/lib/outbound-guard.cjs. */
  outboundGuard?: { script: string; logFile: string };
  /** postgres://...@127.0.0.1:PORT/sportozen_e2e */
  databaseUrl: string;
  port: number;
  /** Optional. A fresh random secret is generated for each launch otherwise. */
  authSecret?: string;
  /** Where the disposable server keeps private media (production mode refuses uploads without one). Default: a temp folder. */
  mediaPath?: string;
};

export class E2eServerRefusal extends Error {}

/** True for a loopback PostgreSQL database named exactly sportozen_e2e: the only kind a browser-test server or seed may use. */
export const isDisposableDatabaseUrl = (url: string) => LOOPBACK_E2E_DATABASE.test(url);

/** The few variables a child process needs to run at all (never a credential), copied from `parent`. */
export function passThroughEnv(parent: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASS_THROUGH) {
    const value = parent[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function buildServerEnv(parent: Env, options: ServerOptions): NodeJS.ProcessEnv & Record<string, string> {
  const { profile, databaseUrl, port } = options;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new E2eServerRefusal(`Refusing port ${port}: use an unprivileged port.`);
  if (port === 3100)
    throw new E2eServerRefusal("Refusing port 3100: that is the development server. Use a different port.");
  if (!LOOPBACK_E2E_DATABASE.test(databaseUrl))
    throw new E2eServerRefusal(
      "Refusing the database: it must be a loopback PostgreSQL database named exactly sportozen_e2e (a disposable one).",
    );
  if (!["plain", "fake-google"].includes(profile)) throw new E2eServerRefusal(`Unknown profile ${profile}.`);
  const mode: Mode = options.mode ?? "production";
  if (!["production", "development"].includes(mode)) throw new E2eServerRefusal(`Unknown mode ${mode}.`);
  if (mode === "production" && (options.deliveryTest || options.emailTest))
    throw new E2eServerRefusal("Refusing: the test delivery adapters and the test email provider never run in production mode.");
  if (profile === "fake-google" && (options.deliveryTest || options.emailTest))
    throw new E2eServerRefusal("Refusing: fake Google credentials are not combined with the delivery test adapters.");
  const absolute = (name: string, value: string | undefined) => {
    if (value === undefined) return;
    if (!ABSOLUTE_PATH.test(value) || CONTROL_CHARACTER.test(value))
      throw new E2eServerRefusal(`Refusing ${name}: it must be an absolute path.`);
  };
  absolute("the dispatch outbox file", options.deliveryTest?.outboxFile);
  absolute("the email capture file", options.emailTest?.captureFile);
  absolute("the outbound guard script", options.outboundGuard?.script);
  absolute("the outbound guard log", options.outboundGuard?.logFile);
  if (options.outboundGuard && UNSAFE_IN_NODE_OPTIONS.test(options.outboundGuard.script))
    throw new E2eServerRefusal("Refusing the outbound guard script: its path must not contain spaces or quotes (NODE_OPTIONS cannot carry them).");
  const secret = options.authSecret ?? randomBytes(36).toString("base64url");
  if (secret.length < 32) throw new E2eServerRefusal("authSecret must be at least 32 characters.");

  const env = {} as NodeJS.ProcessEnv & Record<string, string>;
  for (const key of PASS_THROUGH) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of CONTROLLED_VARIABLES) env[key] = ""; // present-but-empty beats anything in `.env.local`
  Object.assign(env, {
    NODE_ENV: mode,
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    BETTER_AUTH_SECRET: secret,
    DATABASE_URL: databaseUrl,
    NEXT_TELEMETRY_DISABLED: "1",
    PRIVATE_MEDIA_PATH: options.mediaPath ?? join(tmpdir(), "sportozen-e2e-private-media"),
  });
  if (profile === "fake-google") Object.assign(env, FAKE_GOOGLE);
  if (options.deliveryTest)
    Object.assign(env, {
      DISPATCH_EMAIL_PROVIDER: "test",
      DISPATCH_WHATSAPP_PROVIDER: "test",
      DISPATCH_TEST_OUTBOX_FILE: options.deliveryTest.outboxFile,
    });
  if (options.emailTest)
    Object.assign(env, {
      EMAIL_PROVIDER: "test",
      E2E_DISPOSABLE: "true",
      AUTH_EMAIL_CAPTURE_FILE: options.emailTest.captureFile,
    });
  if (options.outboundGuard)
    Object.assign(env, {
      NODE_OPTIONS: `--require=${options.outboundGuard.script.split(String.fromCharCode(92)).join("/")}`,
      OUTBOUND_GUARD_LOG: options.outboundGuard.logFile,
    });
  return env;
}
