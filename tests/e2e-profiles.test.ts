import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { googleConfig } from "../src/modules/identity/google";
import { emailProviderConfig } from "../src/infrastructure/email/provider";
import { channelStates } from "../src/modules/dispatch/providers/registry";
import { buildServerEnv, CONTROLLED_VARIABLES } from "../scripts/lib/e2e-server-env";
import { FORBIDDEN_PORTS, PROFILES, manifestProblems, missingSpecEnvironment, profileByName, type BrowserProfile } from "../scripts/lib/e2e-profiles";

/**
 * The browser-test profiles (scripts/lib/e2e-profiles.ts). What is pinned: the manifest is sound; every spec file belongs to exactly
 * one profile, so a new spec cannot be left out of the run unnoticed; a profile that turns on a test-only capability can never run in
 * production mode; and each profile's server really is configured the way it says.
 */
const DB = "postgres://postgres:pw@127.0.0.1:55432/sportozen_e2e";
const parent = {
  PATH: process.env.PATH,
  EMAIL_PROVIDER: "test",
  E2E_DISPOSABLE: "true",
  DISPATCH_EMAIL_PROVIDER: "test",
  RESEND_API_KEY: "parent-key",
  GOOGLE_CLIENT_ID: "parent-id",
  NODE_OPTIONS: "--require=parent-hook.js",
};
const FILES = { outbox: "/tmp/e2e/outbox.jsonl", capture: "/tmp/e2e/capture.jsonl", guard: "/repo/scripts/lib/outbound-guard.cjs", guardLog: "/tmp/e2e/guard.jsonl" };
const envFor = (p: BrowserProfile) =>
  buildServerEnv(parent, {
    profile: p.google,
    mode: p.mode,
    port: p.port,
    databaseUrl: DB,
    deliveryTest: p.deliveryTest ? { outboxFile: FILES.outbox } : undefined,
    emailTest: p.emailTest ? { captureFile: FILES.capture } : undefined,
    outboundGuard: { script: FILES.guard, logFile: FILES.guardLog },
  });

test("the manifest is sound", () => {
  assert.deepEqual(manifestProblems(), []);
  assert.deepEqual(
    PROFILES.map((p) => p.name),
    ["standard", "dispatch", "multi-academy", "google", "email"],
  );
  for (const p of PROFILES) assert.ok(!(FORBIDDEN_PORTS as readonly number[]).includes(p.port), `${p.name}: ${p.port}`);
});

test("every spec file belongs to exactly one profile, and every listed spec exists", () => {
  const onDisk = readdirSync(join(process.cwd(), "tests", "e2e"))
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => `tests/e2e/${f}`)
    .sort();
  const listed = PROFILES.flatMap((p) => p.specs).sort();
  assert.deepEqual(listed, onDisk, "a spec file that no profile lists would never run in CI; a listed file that is gone would hide a gap");
  assert.equal(new Set(listed).size, listed.length);
  for (const s of listed) assert.ok(existsSync(join(process.cwd(), s)), s);
});

test("a profile that needs a special server says so, and only a development-mode profile may carry a test adapter", () => {
  const byName = Object.fromEntries(PROFILES.map((p) => [p.name, p]));
  assert.deepEqual(byName.dispatch.specs, ["tests/e2e/dispatch-reports.spec.ts"]);
  assert.deepEqual(byName["multi-academy"].fixtures, ["owner-at-bluebird"]);
  assert.equal(byName.google.google, "fake-google");
  assert.deepEqual(byName.email.specs, ["tests/e2e/auth-email-flows.spec.ts"]);
  for (const p of PROFILES) if (p.deliveryTest || p.emailTest) assert.equal(p.mode, "development", p.name);
  assert.equal(byName.standard.mode, "production");
  assert.deepEqual([byName.standard.deliveryTest, byName.standard.emailTest, byName.standard.fixtures.length, byName.standard.google], [false, false, 0, "plain"]);
});

test("the manifest checks catch a bad manifest", () => {
  const ok = profileByName("standard");
  const bad = (over: Partial<BrowserProfile>, expect: RegExp, others: BrowserProfile[] = []) =>
    assert.match(manifestProblems([{ ...ok, ...over }, ...others]).join("\n"), expect);
  bad({ port: 3300 }, /must not be touched/);
  bad({ port: 3200 }, /must not be touched/);
  bad({ port: 3100 }, /must not be touched/);
  bad({ port: 80 }, /unprivileged/);
  bad({ deliveryTest: true }, /development mode only/);
  bad({ emailTest: true }, /development mode only/);
  bad({ specs: [] }, /no specs/);
  bad({}, /port \d+ is used by another profile/, [{ ...ok, name: "dispatch", specs: ["tests/e2e/other.spec.ts"] }]);
  bad({}, /listed in both/, [{ ...ok, name: "dispatch", port: ok.port + 1 }]);
  bad({ mode: "development", emailTest: true, specEnvironment: ["E2E_BASE_URL"] }, /capture file/);
  bad({ mode: "development", deliveryTest: true, specEnvironment: ["E2E_BASE_URL"] }, /outbox file/);
  bad({ mode: "development", emailTest: true, google: "fake-google", specEnvironment: ["AUTH_EMAIL_CAPTURE_FILE"] }, /Google/);
});

test("each profile server is configured the way the profile says, and carries nothing from the parent", () => {
  for (const p of PROFILES) {
    const env = envFor(p);
    assert.equal(env.NODE_ENV, p.mode, p.name);
    assert.equal(env.RESEND_API_KEY, "", `${p.name}: no real mail credential`);
    assert.equal(env.ZEPTOMAIL_TOKEN, "");
    assert.equal(googleConfig(env).enabled, p.google === "fake-google", `${p.name}: google`);
    assert.equal(emailProviderConfig(env).provider, p.emailTest ? "test" : "disabled", `${p.name}: authentication email`);
    assert.equal(channelStates(env).EMAIL.mode, p.deliveryTest ? "TEST" : "NONE", `${p.name}: dispatch email`);
    assert.equal(channelStates(env).WHATSAPP.mode, p.deliveryTest ? "TEST" : "NONE", `${p.name}: dispatch WhatsApp`);
    assert.equal(env.E2E_DISPOSABLE, p.emailTest ? "true" : "", `${p.name}: only the email profile declares the instance disposable to the app`);
    assert.equal(env.NODE_OPTIONS, `--require=${FILES.guard}`, "the outbound guard, and not the hook of the parent environment");
    assert.equal(env.OUTBOUND_GUARD_LOG, FILES.guardLog);
  }
  // Production-mode profiles never carry a test switch, whatever the parent environment says.
  for (const p of PROFILES.filter((x) => x.mode === "production")) {
    const env = envFor(p);
    for (const key of ["EMAIL_PROVIDER", "AUTH_EMAIL_CAPTURE_FILE", "DISPATCH_EMAIL_PROVIDER", "DISPATCH_WHATSAPP_PROVIDER", "DISPATCH_TEST_OUTBOX_FILE"])
      assert.equal(env[key], "", `${p.name}: ${key}`);
  }
  for (const key of ["E2E_DISPOSABLE", "AUTH_EMAIL_CAPTURE_FILE", "DISPATCH_EMAIL_PROVIDER", "OUTBOUND_GUARD_LOG"])
    assert.ok((CONTROLLED_VARIABLES as readonly string[]).includes(key), key);
});

test("what the specs must be given is checked, not assumed", () => {
  const email = profileByName("email");
  const env = {
    E2E_BASE_URL: "http://127.0.0.1:3414",
    BETTER_AUTH_URL: "http://127.0.0.1:3414",
    DEV_SEED_PASSWORD: "x",
    E2E_DISPOSABLE: "true",
    AUTH_EMAIL_CAPTURE_FILE: "/tmp/c",
    E2E_DATABASE_URL: DB,
  };
  assert.deepEqual(missingSpecEnvironment(email, env), []);
  assert.deepEqual(missingSpecEnvironment(email, { ...env, AUTH_EMAIL_CAPTURE_FILE: " " }), ["AUTH_EMAIL_CAPTURE_FILE"]);
  assert.deepEqual(missingSpecEnvironment(profileByName("multi-academy"), {}), ["E2E_BASE_URL", "BETTER_AUTH_URL", "E2E_SEED_PASSWORD", "E2E_DISPOSABLE"]);
});

test("no spec still skips itself on a missing server configuration, and the profile Playwright config allows no retries", () => {
  for (const file of PROFILES.flatMap((p) => p.specs)) {
    const text = readFileSync(join(process.cwd(), file), "utf8");
    assert.ok(!/test\.skip\(\s*!methods/.test(text), `${file}: skips on the sign-in methods of the server`);
    assert.ok(!/test\.skip\(\s*!PASSWORD/.test(text), `${file}: skips on a missing seed password`);
    assert.ok(!/test\.skip\(\s*!\(await request/.test(text), `${file}: skips on a missing server`);
  }
  const config = readFileSync(join(process.cwd(), "playwright.ci.config.ts"), "utf8");
  assert.match(config, /retries:\s*0/);
  assert.match(config, /forbidOnly:\s*true/);
  assert.match(config, /workers:\s*1/);
});
