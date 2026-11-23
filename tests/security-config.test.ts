import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  assertSecurityConfig,
  checkSecurityConfig,
  formatFindings,
  hasErrors,
  type Env,
} from "../src/modules/identity/security-config";
import {
  ClientIpConfigError,
  clientIpConfig,
  parseTrustedProxies,
} from "../src/modules/identity/client-ip";
import { REPO_ROOT } from "./helpers/paths";
/**
 * Phase 3: start-up review of the security settings. Pure functions plus the CLI and the Next.js
 * start-up hook. The recurring assertion is that no message ever contains a value from the
 * environment.
 */
const GOOD_SECRET = "k8Vq2mZr7LxNt4YwB9cDfHj3SgPa6UeQ1oIyTbMn5RvX";
const production: Env = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: GOOD_SECRET,
  BETTER_AUTH_URL: "https://academy.example.org",
  DATABASE_URL: "postgres://app:pw-should-never-print@db.internal:5432/academy",
  TRUSTED_PROXIES: "10.0.0.5",
  PRIVATE_MEDIA_PATH: "/var/lib/sportozen/private-media",
  ERASURE_LEDGER_PATH: "/var/lib/sportozen/erasure-ledger.jsonl",
};
const by = (findings: ReturnType<typeof checkSecurityConfig>, level: string, variable?: string) =>
  findings.filter((f) => f.level === level && (!variable || f.variable === variable));
test("production without its storage locations is warned about by name (it would otherwise fail on first upload), development is not", () => {
  const missing = checkSecurityConfig({ ...production, PRIVATE_MEDIA_PATH: undefined, ERASURE_LEDGER_PATH: "" });
  assert.equal(by(missing, "warning", "PRIVATE_MEDIA_PATH").length, 1);
  assert.equal(by(missing, "warning", "ERASURE_LEDGER_PATH").length, 1);
  assert.deepEqual(by(missing, "error"), [], "a warning, not a refusal: a deployment that never stores media still starts");
  const dev = checkSecurityConfig({ ...production, PRIVATE_MEDIA_PATH: undefined, ERASURE_LEDGER_PATH: undefined }, "development");
  assert.equal(by(dev, "warning", "PRIVATE_MEDIA_PATH").length + by(dev, "warning", "ERASURE_LEDGER_PATH").length, 0);
  assert.ok(!JSON.stringify(missing).includes("/var/lib/sportozen"), "no value from the environment is repeated");
});
test("a correctly configured production environment has no errors or warnings", () => {
  const findings = checkSecurityConfig(production);
  assert.deepEqual(by(findings, "error"), []);
  assert.deepEqual(by(findings, "warning"), []);
  assert.ok(by(findings, "info", "BETTER_AUTH_SECRET").length === 1, "the rotation consequence is stated");
  assert.match(by(findings, "info", "BETTER_AUTH_SECRET")[0].message, /authenticator/i);
});
test("BETTER_AUTH_SECRET: missing, short, low-variety and placeholder values", () => {
  const one = (secret: string | undefined, mode: "production" | "development" = "production") =>
    checkSecurityConfig({ ...production, BETTER_AUTH_SECRET: secret }, mode);
  assert.equal(hasErrors(one(undefined)), true);
  assert.equal(hasErrors(one("")), true);
  assert.equal(hasErrors(one("a".repeat(31))), true, "31 characters is too short");
  // Long but trivial: error in production, only a warning on a laptop.
  assert.equal(hasErrors(one("a".repeat(40))), true);
  assert.equal(hasErrors(one("a".repeat(40), "development")), false);
  assert.equal(by(one("a".repeat(40), "development"), "warning", "BETTER_AUTH_SECRET").length, 1);
  assert.equal(hasErrors(one("please-change-me-please-change-me-0123456789abc")), true);
  assert.equal(hasErrors(one("please-change-me-please-change-me-0123456789abc", "development")), false);
  assert.equal(hasErrors(one(GOOD_SECRET)), false);
});
test("no finding ever contains a value from the environment", () => {
  const secrets = ["SuperSecretValue-9f8e7d6c5b4a39281706f5e4d3c2b1a0", "pw-should-never-print", "10.0.0.5", "bad header!"];
  const env: Env = {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: secrets[0],
    BETTER_AUTH_URL: "http://insecure.example.org",
    DATABASE_URL: `postgres://u:${secrets[1]}@h:5432/d`,
    TRUSTED_PROXIES: "300.1.1.1",
    TRUSTED_CLIENT_IP_HEADER: secrets[3],
    MFA_ENFORCEMENT: "enforce-ish-" + secrets[0],
    MFA_REQUIRED_ROLES: "OWNER,WIZARD",
    MIGRATION_CONFIRM_TARGET: secrets[0],
    ALLOW_DEV_SEED: "true",
  };
  const text = formatFindings(checkSecurityConfig(env)).join("\n");
  assert.ok(text.length > 100);
  for (const secret of [secrets[0], secrets[1]])
    assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), secret);
  // Names of variables and what is wrong are reported.
  for (const variable of ["MFA_ENFORCEMENT", "BETTER_AUTH_URL", "ALLOW_DEV_SEED", "MIGRATION_CONFIRM_TARGET"])
    assert.ok(text.includes(variable), variable);
  const clean = checkSecurityConfig({ ...production, MFA_ENFORCEMENT: `nope-${secrets[0]}` });
  assert.ok(!formatFindings(clean).join("\n").toLowerCase().includes(secrets[0].toLowerCase()), "a misspelt MFA mode is not echoed");
});
test("BETTER_AUTH_URL and DATABASE_URL", () => {
  assert.equal(hasErrors(checkSecurityConfig({ ...production, BETTER_AUTH_URL: undefined })), true);
  assert.equal(hasErrors(checkSecurityConfig({ ...production, BETTER_AUTH_URL: "not a url" })), true);
  assert.equal(by(checkSecurityConfig({ ...production, BETTER_AUTH_URL: "http://academy.example.org" }), "warning", "BETTER_AUTH_URL").length, 1);
  assert.equal(by(checkSecurityConfig({ ...production, BETTER_AUTH_URL: "http://127.0.0.1:3100" }, "development"), "warning", "BETTER_AUTH_URL").length, 0);
  assert.equal(hasErrors(checkSecurityConfig({ ...production, DATABASE_URL: undefined })), true);
  assert.equal(hasErrors(checkSecurityConfig({ ...production, DATABASE_URL: undefined }, "development")), false);
});
test("trusted proxies: invalid, match-everything and missing configurations", () => {
  for (const bad of ["not-an-ip", "10.0.0.0/33", "10.0.0.1, nope", "*"]) {
    const findings = checkSecurityConfig({ ...production, TRUSTED_PROXIES: bad });
    assert.equal(by(findings, "error", "TRUSTED_PROXIES").length, 1, bad);
  }
  // A zero-length prefix would let any client forge its address.
  for (const everyone of ["0.0.0.0/0", "::/0", "10.0.0.1,0.0.0.0/0", "0.0.0.0/00"]) {
    assert.throws(() => parseTrustedProxies(everyone), ClientIpConfigError, everyone);
    assert.throws(() => clientIpConfig({ TRUSTED_PROXIES: everyone }), /not every address/, everyone);
    assert.equal(by(checkSecurityConfig({ ...production, TRUSTED_PROXIES: everyone }), "error", "TRUSTED_PROXIES").length, 1, everyone);
  }
  assert.deepEqual(parseTrustedProxies("10.0.0.0/8, 2001:db8::/32"), ["10.0.0.0/8", "2001:db8::/32"], "ordinary ranges stay valid");
  // Production without a declared proxy: a warning, not an error (shared bucket is the safe failure).
  const none = checkSecurityConfig({ ...production, TRUSTED_PROXIES: undefined });
  assert.equal(by(none, "warning", "TRUSTED_PROXIES").length, 1);
  assert.equal(hasErrors(none), false);
  assert.equal(by(checkSecurityConfig({ ...production, TRUSTED_PROXIES: undefined }, "development"), "warning", "TRUSTED_PROXIES").length, 0);
  // A header name without proxies is ignored, and the operator is told so.
  const header = checkSecurityConfig({ ...production, TRUSTED_PROXIES: "", TRUSTED_CLIENT_IP_HEADER: "x-real-ip" });
  assert.equal(by(header, "warning", "TRUSTED_CLIENT_IP_HEADER").length, 1);
  assert.deepEqual(clientIpConfig({ TRUSTED_CLIENT_IP_HEADER: "x-real-ip" }), { ipAddressHeaders: [] }, "ignored without proxies");
  assert.equal(by(checkSecurityConfig({ ...production, TRUSTED_CLIENT_IP_HEADER: "bad header!" }), "error", "TRUSTED_CLIENT_IP_HEADER").length, 1);
});
test("MFA rollout settings: misspelt values fail closed with the variable named; unused values are called out", () => {
  const f = (extra: Env) => checkSecurityConfig({ ...production, ...extra });
  assert.equal(by(f({ MFA_ENFORCEMENT: "enforced" }), "error", "MFA_ENFORCEMENT").length, 1);
  assert.equal(by(f({ MFA_ENFORCEMENT: "warn", MFA_REQUIRED_ROLES: "OWNER,WIZARD" }), "error", "MFA_REQUIRED_ROLES").length, 1);
  assert.equal(hasErrors(f({ MFA_ENFORCEMENT: "" })), false, "empty means off (as in a copied .env.example)");
  assert.equal(hasErrors(f({ MFA_ENFORCEMENT: "OFF" })), false);
  assert.equal(by(f({ MFA_ENFORCEMENT: "off", MFA_REQUIRED_ROLES: "OWNER" }), "warning", "MFA_REQUIRED_ROLES").length, 1);
  assert.equal(by(f({ MFA_ENFORCEMENT: "warn" }), "info", "MFA_ENFORCEMENT").length, 1);
  assert.match(by(f({ MFA_ENFORCEMENT: "enforce" }), "info", "MFA_ENFORCEMENT")[0].message, /OWNER, ADMIN, HEAD_COACH, COACH, FINANCE, NUTRITION_PRO .*only to enrol/);
  // Raising the mode never turns a role on that was not asked for.
  assert.match(by(f({ MFA_ENFORCEMENT: "enforce", MFA_REQUIRED_ROLES: "OWNER" }), "info", "MFA_ENFORCEMENT")[0].message, /^Enforce mode: OWNER without/);
});
test("migration confirmation and seed helpers", () => {
  const f = (extra: Env) => checkSecurityConfig({ ...production, ...extra });
  assert.equal(by(f({ MIGRATION_CONFIRM_TARGET: "db.internal:5432/academy" }), "warning", "MIGRATION_CONFIRM_TARGET").length, 0);
  assert.equal(by(f({ MIGRATION_CONFIRM_TARGET: "postgres://x" }), "warning", "MIGRATION_CONFIRM_TARGET").length, 1);
  assert.equal(by(f({ ALLOW_DEV_SEED: "true" }), "warning", "ALLOW_DEV_SEED").length, 1);
  assert.equal(by(checkSecurityConfig({ ...production, NODE_ENV: "development", ALLOW_DEV_SEED: "true" }), "warning", "ALLOW_DEV_SEED").length, 0);
});
test("assertSecurityConfig: production refuses to start on errors; development only warns", () => {
  const lines: string[] = [];
  const log = { warn: (m: string) => lines.push(`warn ${m}`), error: (m: string) => lines.push(`error ${m}`), info: (m: string) => lines.push(`info ${m}`) };
  assert.throws(
    () => assertSecurityConfig({ ...production, TRUSTED_PROXIES: "0.0.0.0/0", MFA_ENFORCEMENT: "oops" }, log),
    /will not start/,
  );
  assert.ok(lines.some((l) => l.startsWith("error [security:error] TRUSTED_PROXIES")));
  assert.ok(lines.some((l) => l.startsWith("error [security:error] MFA_ENFORCEMENT")));
  lines.length = 0;
  const dev = assertSecurityConfig({ ...production, NODE_ENV: "development", TRUSTED_PROXIES: "0.0.0.0/0" }, log);
  assert.equal(hasErrors(dev), true, "the problem is still reported");
  assert.ok(lines.some((l) => l.startsWith("error")));
  lines.length = 0;
  assert.doesNotThrow(() => assertSecurityConfig(production, log));
  assert.ok(lines.every((l) => l.startsWith("info")), "a good production configuration logs notes only");
});
test("the start-up hook only reviews on a running Node server, never during the build", async () => {
  const { register } = await import("../src/instrumentation");
  const env = process.env as Record<string, string | undefined>;
  const saved = { ...env };
  try {
    // Edge runtime and build phase: nothing happens even with an unsafe configuration.
    Object.assign(env, { NODE_ENV: "production", BETTER_AUTH_SECRET: "short", TRUSTED_PROXIES: "0.0.0.0/0" });
    env.NEXT_RUNTIME = "edge";
    await register();
    env.NEXT_RUNTIME = "nodejs";
    env.NEXT_PHASE = "phase-production-build";
    await register();
    // A running production server with an unsafe configuration refuses to start.
    delete env.NEXT_PHASE;
    // ...and it ENDS the process (exit code 1) instead of throwing: Next leaves a process whose start-up hook threw alive and
    // not listening, which a supervisor would never restart (overnight audit; src/modules/identity/startup-guard.ts).
    const originalError = console.error;
    const originalExit = process.exit;
    const exits: (number | undefined)[] = [];
    console.error = () => {};
    process.exit = ((code?: number) => {
      exits.push(code);
    }) as typeof process.exit;
    try {
      await register();
      assert.deepEqual(exits, [1]);
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  } finally {
    for (const key of Object.keys(env)) if (!(key in saved)) delete env[key];
    Object.assign(env, saved);
  }
});
test("the check-config command exits non-zero on errors and prints no secret values", () => {
  const run = (env: Record<string, string>, args: string[] = []) =>
    spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts/check-security-config.ts"), ...args], {
      cwd: REPO_ROOT,
      env: ({
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        NODE_ENV: "test",
        ...env,
      } as unknown as NodeJS.ProcessEnv),
      encoding: "utf8",
      timeout: 120_000,
    });
  const secret = "Zq8wX3nVb6Rt1YpLk9HsDc4FgJm2AeUo7IiTyPlO";
  const bad = run({ BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: "https://a.example.org", DATABASE_URL: "postgres://u:hunter2@h/d", TRUSTED_PROXIES: "0.0.0.0/0" }, ["--production"]);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stdout, /\[security:error\] TRUSTED_PROXIES/);
  assert.match(bad.stdout, /Result: errors found/);
  for (const text of [bad.stdout, bad.stderr]) assert.ok(!text.includes(secret) && !text.includes("hunter2"));
  const good = run({ BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: "https://a.example.org", DATABASE_URL: "postgres://u:hunter2@h/d", TRUSTED_PROXIES: "10.0.0.5" }, ["--production"]);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /Result: no errors/);
  assert.ok(!good.stdout.includes(secret));
});

test("transactional email configuration: complete resend passes, half-configured fails closed without echoing secrets", () => {
  const f = (extra: Env) => checkSecurityConfig({ ...production, ...extra });
  const apiSecret = "re_test_secret_value_should_never_echo";
  assert.equal(by(f({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: apiSecret, EMAIL_FROM: "Sportozen <no-reply@example.org>" }), "error").length, 0);
  assert.equal(by(f({ EMAIL_PROVIDER: "resend" }), "error", "RESEND_API_KEY").length, 1);
  assert.equal(by(f({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: apiSecret }), "error", "EMAIL_FROM").length, 1);
  assert.equal(by(f({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: apiSecret, EMAIL_FROM: "bad\r\nheader" }), "error", "EMAIL_FROM").length, 1);
  assert.equal(by(f({ RESEND_API_KEY: apiSecret }), "error", "EMAIL_PROVIDER").length, 1);
  assert.equal(by(f({ EMAIL_PROVIDER: "smtp" }), "error", "EMAIL_PROVIDER").length, 1);

  const output = formatFindings(
    checkSecurityConfig({
      ...production,
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: apiSecret,
      EMAIL_FROM: "not-valid-sender",
    }),
  ).join("\n");
  assert.ok(!output.includes(apiSecret), "RESEND_API_KEY is never echoed");
});
