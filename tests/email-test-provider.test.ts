import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "../src/infrastructure/database/schema";
import { runMigrations } from "../src/infrastructure/database/migrations";
import { HOOK_TIMEOUT } from "./helpers/paths";
import {
  createConfiguredEmailProvider,
  dispatchAuthEmailOutbox,
  emailProviderConfig,
  enqueueAuthEmail,
  TestAuthEmailProvider,
  type CapturedEmail,
} from "../src/infrastructure/email";
import { checkSecurityConfig, hasErrors } from "../src/modules/identity/security-config";
import { emailDeliveryConfigured } from "../src/modules/identity/email-delivery";
import { verificationEmail, passwordResetEmail } from "../src/modules/identity/auth-emails";

/**
 * The test-only authentication email provider (browser tests). What is pinned here:
 *   - it can be switched on ONLY outside production, on an instance that declared itself disposable, with an explicit capture file
 *     and no real provider credentials; production refuses it at configuration, at start-up and again in the class itself;
 *   - a message goes to the capture file and nowhere else (not the console, not a log), and the answer is deterministic;
 *   - it plugs into the real outbox: the sealed payload is opened, handed over, and wiped once sent.
 */
const SECRET = "V9nK2pL6xR8wQ4mT7zB5cF1hJ3dG0sY2aE8uP4vN6kM=";
const dir = mkdtempSync(join(tmpdir(), "sportozen-email-stub-"));
const cleanups: (() => Promise<void> | void)[] = [() => rmSync(dir, { recursive: true, force: true })];
after(
  async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  },
  { timeout: HOOK_TIMEOUT },
);
const FILE = join(dir, "nested", "capture.jsonl");
const OK_ENV = { NODE_ENV: "development", EMAIL_PROVIDER: "test", E2E_DISPOSABLE: "true", AUTH_EMAIL_CAPTURE_FILE: FILE };
const lines = (file = FILE) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CapturedEmail) : []);

test("the test provider is valid only outside production, on a disposable instance, with a capture file and no real credentials", () => {
  const ok = emailProviderConfig(OK_ENV);
  assert.deepEqual(ok, { provider: "test", captureFile: FILE, problem: null });
  assert.equal(emailDeliveryConfigured(OK_ENV as NodeJS.ProcessEnv), true, "sign-in methods report reset and verification as available");

  const refused = (over: Record<string, string | undefined>, variable: string) => {
    const c = emailProviderConfig({ ...OK_ENV, ...over });
    assert.equal(c.provider, "invalid", JSON.stringify(over));
    if (c.provider === "invalid") {
      assert.equal(c.variable, variable);
      // A refusal names a setting, never a value.
      for (const secretish of [FILE, "re_live_key_0123456789", "zepto-token-0123456789"]) assert.ok(!c.problem.includes(secretish), "no value echoed");
    }
  };
  refused({ NODE_ENV: "production" }, "EMAIL_PROVIDER");
  refused({ NODE_ENV: "Production" }, "EMAIL_PROVIDER");
  refused({ E2E_DISPOSABLE: undefined }, "EMAIL_PROVIDER");
  refused({ E2E_DISPOSABLE: "yes" }, "EMAIL_PROVIDER");
  refused({ RESEND_API_KEY: "re_live_key_0123456789" }, "EMAIL_PROVIDER");
  refused({ ZEPTOMAIL_TOKEN: "zepto-token-0123456789" }, "EMAIL_PROVIDER");
  refused({ AUTH_EMAIL_CAPTURE_FILE: undefined }, "AUTH_EMAIL_CAPTURE_FILE");
  refused({ AUTH_EMAIL_CAPTURE_FILE: "relative/capture.jsonl" }, "AUTH_EMAIL_CAPTURE_FILE");
  refused({ AUTH_EMAIL_CAPTURE_FILE: `${FILE}\nINJECTED=1` }, "AUTH_EMAIL_CAPTURE_FILE");
  // Without the explicit provider choice nothing changes: the capture file alone enables nothing.
  assert.equal(emailProviderConfig({ NODE_ENV: "development", E2E_DISPOSABLE: "true", AUTH_EMAIL_CAPTURE_FILE: FILE }).provider, "disabled");
});

test("production refuses to start with the test provider, whatever else is set; development only warns that it is active", () => {
  const production = {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "q8Zr2mV5xT9bK3nW7yL1cF6hJ4dG0sA8uP2vN5kMeR1",
    BETTER_AUTH_URL: "https://app.example.org",
    DATABASE_URL: "postgres://u:p@db.internal:5432/app",
    PRIVATE_MEDIA_PATH: "/var/lib/sportozen/media",
    ERASURE_LEDGER_PATH: "/var/lib/sportozen/ledger.jsonl",
    TRUSTED_PROXIES: "10.0.0.1",
    EMAIL_PROVIDER: "test",
    E2E_DISPOSABLE: "true",
    AUTH_EMAIL_CAPTURE_FILE: FILE,
  };
  const findings = checkSecurityConfig(production);
  assert.ok(hasErrors(findings), "production must refuse to start");
  assert.ok(findings.some((f) => f.level === "error" && f.variable === "EMAIL_PROVIDER"));
  assert.ok(findings.every((f) => !f.message.includes(FILE)), "no value echoed");
  // The real provider factory throws too, so nothing can build the stub from a production environment.
  assert.throws(() => createConfiguredEmailProvider(production), /EMAIL_PROVIDER/);
  assert.equal(emailDeliveryConfigured(production as unknown as NodeJS.ProcessEnv), false);

  const dev = checkSecurityConfig({ ...production, NODE_ENV: "development" }, "development");
  assert.ok(!hasErrors(dev.filter((f) => f.variable === "EMAIL_PROVIDER")));
  assert.ok(dev.some((f) => f.level === "warning" && f.variable === "EMAIL_PROVIDER" && /test email provider is active/.test(f.message)));
});

test("the class refuses to exist in production or on an instance that is not disposable, by itself", () => {
  assert.throws(() => new TestAuthEmailProvider({ captureFile: FILE, env: { ...OK_ENV, NODE_ENV: "production" } }), /not available in production/);
  assert.throws(() => new TestAuthEmailProvider({ captureFile: FILE, env: { ...OK_ENV, E2E_DISPOSABLE: undefined } }), /disposable/);
  assert.throws(() => new TestAuthEmailProvider({ captureFile: "capture.jsonl", env: OK_ENV }), /absolute/);
  const previous = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  try {
    // Even a caller that passes a friendlier environment is stopped by the real one.
    assert.throws(() => new TestAuthEmailProvider({ captureFile: FILE, env: OK_ENV }), /not available in production/);
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = previous;
  }
});

test("a message goes to the capture file and nowhere else; the answer is deterministic and nothing reaches the console", async () => {
  const provider = createConfiguredEmailProvider(OK_ENV);
  assert.ok(provider instanceof TestAuthEmailProvider);
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const realErrWrite = process.stderr.write.bind(process.stderr);
  const spies = ["log", "info", "warn", "error", "debug"] as const;
  const originals = spies.map((name) => console[name]);
  for (const name of spies) console[name] = ((...args: unknown[]) => void written.push(args.join(" "))) as never;
  (process.stdout as { write: unknown }).write = ((chunk: unknown) => (written.push(String(chunk)), true)) as never;
  (process.stderr as { write: unknown }).write = ((chunk: unknown) => (written.push(String(chunk)), true)) as never;
  let first, second;
  try {
    const message = { ...verificationEmail({ to: "stub.person@example.test", name: "Stub Person", code: "482910" }), idempotencyKey: "email-otp:abc", kind: "EMAIL_VERIFICATION_OTP" as const };
    first = await provider!.send(message);
    second = await provider!.send(message);
  } finally {
    (process.stdout as { write: unknown }).write = realWrite;
    (process.stderr as { write: unknown }).write = realErrWrite;
    spies.forEach((name, i) => (console[name] = originals[i]));
  }
  assert.deepEqual(written, [], "nothing printed: no address, code or link in any log");
  assert.deepEqual(first, second, "deterministic: the same message gets the same answer");
  assert.equal(first.ok, true);
  if (first.ok) assert.match(first.providerMessageId, /^test-[0-9a-f]{16}$/);
  const captured = lines();
  assert.equal(captured.length, 2);
  assert.equal(captured[0].to, "stub.person@example.test");
  assert.equal(captured[0].kind, "EMAIL_VERIFICATION_OTP");
  assert.match(captured[0].text, /482910/);

  const link = "http://127.0.0.1:3499/reset-password#token=11111111-1111-4111-8111-111111111111.AAAA";
  await provider!.send({ ...passwordResetEmail({ to: "stub.person@example.test", name: "Stub Person", link }), idempotencyKey: "password-reset:xyz", kind: "PASSWORD_RESET_LINK" });
  const reset = lines().at(-1)!;
  assert.equal(reset.kind, "PASSWORD_RESET_LINK");
  assert.ok(reset.text.includes(link), "the reset link reaches the test intact, fragment included");
});

test("through the real outbox: the sealed message is opened, captured, marked sent and wiped", async () => {
  const path = join(dir, "db");
  await runMigrations({ target: { kind: "pglite", path } });
  const client = new PGlite(path);
  cleanups.push(() => client.close());
  const db = drizzle(client, { schema });
  const file = join(dir, "outbox-capture.jsonl");
  const env = { ...OK_ENV, AUTH_EMAIL_CAPTURE_FILE: file };
  const now = new Date();
  await db.insert(schema.user).values({ id: "u-stub", name: "Outbox Person", email: "outbox.person@example.test" });
  const queued = await enqueueAuthEmail(db, {
    kind: "EMAIL_VERIFICATION_OTP",
    userId: "u-stub",
    idempotencyKey: "email-otp:stub-1",
    payload: verificationEmail({ to: "outbox.person@example.test", name: "Outbox Person", code: "135790" }),
    expiresAt: new Date(now.getTime() + 600_000),
    nextAttemptAt: now,
    authSecret: SECRET,
  });
  const summary = await dispatchAuthEmailOutbox(db, createConfiguredEmailProvider(env)!, { now, authSecret: SECRET });
  assert.deepEqual(summary, { claimed: 1, sent: 1, retried: 0, failedPermanent: 0, expiredBeforeSend: 0 });
  const [row] = await db.select().from(schema.authEmailOutbox).where(eq(schema.authEmailOutbox.id, queued.id));
  assert.equal(row.status, "SENT");
  assert.equal(row.sealedPayload, null, "the secret is wiped from the database once handed over");
  const captured = lines(file);
  assert.equal(captured.length, 1);
  assert.match(captured[0].text, /135790/);
  assert.equal(captured[0].idempotencyKey, "email-otp:stub-1");
});
