import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { googleConfig } from "../src/modules/identity/google";
import { emailProviderConfig } from "../src/infrastructure/email/provider";
import { buildServerEnv, CONTROLLED_VARIABLES, E2eServerRefusal, FAKE_GOOGLE } from "../scripts/lib/e2e-server-env";

const DB = "postgres://postgres:pw@127.0.0.1:55432/sportozen_e2e";
const parent = {
  PATH: process.env.PATH,
  GOOGLE_CLIENT_ID: "parent-google-id",
  GOOGLE_CLIENT_SECRET: "parent-google-secret",
  RESEND_API_KEY: "parent-resend",
  EMAIL_PROVIDER: "resend",
  EMAIL_FROM: "x@example.test",
  BETTER_AUTH_SECRET: "parent-secret-parent-secret-parent-secret",
  DATABASE_URL: "postgres://prod:prod@db.example.com:5432/prod",
  TRUSTED_PROXIES: "10.0.0.1",
  MFA_ENFORCEMENT: "enforce",
  UNRELATED_SECRET: "must-not-travel",
};

test("the disposable server environment forwards no credential from the parent and forces every controlled setting empty", () => {
  const env = buildServerEnv(parent, { profile: "plain", databaseUrl: DB, port: 3481 });
  for (const key of CONTROLLED_VARIABLES) assert.equal(env[key], "", `${key} must be present and empty`);
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.notEqual(env.BETTER_AUTH_SECRET, parent.BETTER_AUTH_SECRET);
  assert.ok(env.BETTER_AUTH_SECRET.length >= 32);
  assert.equal(env.DATABASE_URL, DB);
  assert.equal(env.BETTER_AUTH_URL, "http://127.0.0.1:3481");
  assert.equal(env.NODE_ENV, "production");
  assert.equal(googleConfig(env).enabled, false);
  assert.equal(emailProviderConfig(env).provider, "disabled");
  assert.notEqual(buildServerEnv(parent, { profile: "plain", databaseUrl: DB, port: 3481 }).BETTER_AUTH_SECRET, env.BETTER_AUTH_SECRET, "a fresh secret per launch");
});

test("the fake-google profile turns Google on with obviously fake credentials and nothing else", () => {
  const env = buildServerEnv(parent, { profile: "fake-google", databaseUrl: DB, port: 3481 });
  assert.deepEqual(googleConfig(env), { enabled: true, clientId: FAKE_GOOGLE.GOOGLE_CLIENT_ID, clientSecret: FAKE_GOOGLE.GOOGLE_CLIENT_SECRET });
  assert.equal(env.RESEND_API_KEY, "");
});

test("the launcher refuses the development port, an unprivileged-port violation, and any database that is not a loopback sportozen_e2e", () => {
  const bad = (o: Partial<Parameters<typeof buildServerEnv>[1]>) =>
    assert.throws(() => buildServerEnv(parent, { profile: "plain", databaseUrl: DB, port: 3481, ...o }), E2eServerRefusal);
  bad({ port: 3100 });
  bad({ port: 80 });
  bad({ port: Number.NaN });
  bad({ databaseUrl: parent.DATABASE_URL });
  bad({ databaseUrl: "postgres://u:p@127.0.0.1:5432/sportozen" });
  bad({ databaseUrl: "postgres://u:p@db.example.com:5432/sportozen_e2e" });
  bad({ databaseUrl: "postgres://u:p@127.0.0.1.evil.example:5432/sportozen_e2e" });
  bad({ authSecret: "short" });
});

// The real mechanism: Next's own environment loader, run against a project folder whose `.env.local` holds "real" credentials.
test("Next's real env loader does not let `.env.local` re-enable Google, mail, or an MFA rollout for the disposable server", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-env-"));
  try {
    writeFileSync(
      join(dir, ".env.local"),
      "GOOGLE_CLIENT_ID=leaked-id\nGOOGLE_CLIENT_SECRET=leaked-secret\nEMAIL_PROVIDER=resend\nRESEND_API_KEY=leaked\nMFA_ENFORCEMENT=enforce\nSOMETHING_NEW=allowed\n",
    );
    const env = buildServerEnv(parent, { profile: "plain", databaseUrl: DB, port: 3481 });
    const probe = `
      const { loadEnvConfig } = require(${JSON.stringify(join(process.cwd(), "node_modules/@next/env"))});
      loadEnvConfig(${JSON.stringify(dir)}, false, { info() {}, error() {} });
      const pick = (k) => (process.env[k] === undefined ? "<unset>" : process.env[k] === "" ? "<empty>" : "<value>");
      console.log(JSON.stringify(Object.fromEntries(["GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","EMAIL_PROVIDER","RESEND_API_KEY","MFA_ENFORCEMENT","SOMETHING_NEW"].map((k) => [k, pick(k)]))));
    `;
    const run = spawnSync(process.execPath, ["-e", probe], { env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const seen = JSON.parse(run.stdout.trim().split("\n").pop() as string);
    // Controlled settings stay empty (Next treats them as absent), so `.env.local` cannot turn them on...
    for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "EMAIL_PROVIDER", "RESEND_API_KEY", "MFA_ENFORCEMENT"])
      assert.notEqual(seen[k], "<value>", `${k} must not come from .env.local`);
    // ...while the same file still supplies a variable the launcher does not control, proving the file WAS read.
    assert.equal(seen.SOMETHING_NEW, "<value>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Round 4: development mode and the test-only capabilities used by the browser-test profiles ---
const ROUND4 = {
  outbox: "/tmp/e2e/outbox.jsonl",
  capture: "/tmp/e2e/capture.jsonl",
  guard: "D:\\repo\\scripts\\lib\\outbound-guard.cjs",
  guardLog: "/tmp/e2e/guard.jsonl",
};

test("development mode carries the test adapters and the test email provider, each with an explicit file; nothing is inherited", () => {
  const env = buildServerEnv(
    { ...parent, NODE_OPTIONS: "--require=parent-hook.js" },
    {
      profile: "plain",
      mode: "development",
      databaseUrl: DB,
      port: 3482,
      deliveryTest: { outboxFile: ROUND4.outbox },
      emailTest: { captureFile: ROUND4.capture },
      outboundGuard: { script: ROUND4.guard, logFile: ROUND4.guardLog },
    },
  );
  assert.equal(env.NODE_ENV, "development");
  assert.equal(env.DISPATCH_EMAIL_PROVIDER, "test");
  assert.equal(env.DISPATCH_TEST_OUTBOX_FILE, ROUND4.outbox);
  assert.equal(env.EMAIL_PROVIDER, "test");
  assert.equal(env.AUTH_EMAIL_CAPTURE_FILE, ROUND4.capture);
  assert.equal(env.E2E_DISPOSABLE, "true");
  assert.equal(emailProviderConfig(env).provider, "test");
  assert.equal(env.RESEND_API_KEY, "", "the mail credential of the parent is not forwarded");
  assert.equal(env.NODE_OPTIONS, "--require=D:/repo/scripts/lib/outbound-guard.cjs", "backslashes become slashes and the NODE_OPTIONS of the parent is not forwarded");
});

test("the test adapters and the test email provider are refused in production mode, with Google, and with relative or unsafe paths", () => {
  const refuse = (o: Partial<Parameters<typeof buildServerEnv>[1]>) =>
    assert.throws(() => buildServerEnv(parent, { profile: "plain", mode: "development", databaseUrl: DB, port: 3482, ...o }), E2eServerRefusal);
  refuse({ mode: "production", deliveryTest: { outboxFile: ROUND4.outbox } });
  refuse({ mode: "production", emailTest: { captureFile: ROUND4.capture } });
  refuse({ profile: "fake-google", emailTest: { captureFile: ROUND4.capture } });
  refuse({ profile: "fake-google", deliveryTest: { outboxFile: ROUND4.outbox } });
  refuse({ emailTest: { captureFile: "capture.jsonl" } });
  refuse({ deliveryTest: { outboxFile: "../outbox.jsonl" } });
  refuse({ emailTest: { captureFile: `${ROUND4.capture}\nINJECTED=1` } });
  refuse({ outboundGuard: { script: "C:/with space/guard.cjs", logFile: ROUND4.guardLog } });
  refuse({ outboundGuard: { script: "relative/guard.cjs", logFile: ROUND4.guardLog } });
  refuse({ mode: "staging" as never });
  // and the production-mode default is unchanged
  assert.equal(buildServerEnv(parent, { profile: "plain", databaseUrl: DB, port: 3482 }).NODE_ENV, "production");
});
