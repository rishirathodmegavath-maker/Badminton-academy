import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { buildServerEnv, E2eServerRefusal, isDisposableDatabaseUrl, passThroughEnv } from "./lib/e2e-server-env";
import { FORBIDDEN_PORTS, PROFILES, manifestProblems, missingSpecEnvironment, profileByName, type BrowserProfile } from "./lib/e2e-profiles";
import { applyFixture, describeFixture, fixtureIsPresent, removeFixture } from "./lib/e2e-fixtures";

/**
 * Runs the browser tests as separate PROFILES, each on its own freshly created disposable database and its own disposable server
 * (scripts/lib/e2e-profiles.ts says what each profile is). One command, one report.
 *
 *   npm run build                                   (once; or pass --build)
 *   E2E_ADMIN_URL=postgres://postgres:<pw>@127.0.0.1:<port>/postgres  npx tsx scripts/e2e-ci.ts [--profile a,b] [--build] [--out dir]
 *   npx tsx scripts/e2e-ci.ts --list
 *
 * E2E_ADMIN_URL must be a DISPOSABLE PostgreSQL on this computer (loopback). Per profile the runner drops and recreates the database
 * "sportozen_e2e" on it, migrates and seeds it, applies the profile's fixtures, starts the server on the profile's own port, runs only
 * that profile's specs with Playwright, and then - whatever happened - removes the fixtures, stops the server it started, deletes its
 * temporary files and drops the database, checking each of those steps. Nothing is read from `.env.local`; the server gets only the
 * environment scripts/lib/e2e-server-env.ts builds. It never touches ports 3100, 3200 or 3300 and never stops a process it did not start.
 *
 * It does not call the run green unless every planned test ran and passed: a failure, a skip, a test that did not run, a planned count
 * that differs from the executed one, or a teardown step that could not be verified each make the exit code non-zero.
 */
const root = process.cwd();
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

type Counts = { planned: number; passed: number; failed: number; skipped: number; flaky: number; didNotRun: number };
type ProfileResult = {
  profile: string;
  mode: string;
  port: number;
  startedAt: string;
  seconds: number;
  specs: string[];
  setup: { database: string; migrated: boolean; seeded: boolean; fixtures: string[]; serverReady: boolean };
  counts: Counts;
  failedTests: string[];
  skippedTests: string[];
  teardown: {
    fixturesRemoved: string[];
    fixturesStillPresent: string[];
    serverStopped: boolean;
    portClosed: boolean;
    databaseDropped: boolean;
    temporaryFilesRemoved: boolean;
  };
  evidence: {
    serverMailCredentialsPresent: boolean;
    serverEmailProvider: string;
    outboundAttempts: number;
    outboundHosts: Record<string, number>;
    mailOrMessagingHostAttempts: number;
    capturedMessages: number | null;
    capturedKinds: Record<string, number> | null;
    secretsFoundInServerLogs: number | null;
  };
  problems: string[];
};

const log = (line: string) => console.log(line);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Condition-based waiting: checks until the condition holds or the deadline passes. Nothing here is a fixed pause. */
async function until(check: () => Promise<boolean>, what: string, timeoutMs: number, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(intervalMs);
  }
}
const portOpen = (port: number) =>
  new Promise<boolean>((done) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1500, () => (socket.destroy(), done(false)));
    socket.once("connect", () => (socket.destroy(), done(true)));
    socket.once("error", () => done(false));
  });
const random = (bytes: number) => randomBytes(bytes).toString("base64url");

function killTree(child: ChildProcess | undefined) {
  if (!child?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}
const exited = (child: ChildProcess) => new Promise<number | null>((done) => (child.exitCode !== null ? done(child.exitCode) : child.once("exit", (code) => done(code))));

function adminConnection(): string {
  const raw = process.env.E2E_ADMIN_URL ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Set E2E_ADMIN_URL to the admin connection of a disposable PostgreSQL on this computer (postgres://user:password@127.0.0.1:PORT/postgres).");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("E2E_ADMIN_URL must point at a PostgreSQL on this computer (127.0.0.1, localhost or ::1). Refusing anything else.");
  return raw;
}
const disposableUrl = (admin: string) => {
  const url = new URL(admin);
  url.pathname = "/sportozen_e2e";
  return url.toString();
};
async function withAdmin<T>(admin: string, work: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: admin });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
async function databaseExists(admin: string) {
  return withAdmin(admin, async (c) => ((await c.query("select 1 from pg_database where datname = 'sportozen_e2e'")).rowCount ?? 0) > 0);
}
async function dropDatabase(admin: string) {
  await withAdmin(admin, async (c) => {
    await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = 'sportozen_e2e' and pid <> pg_backend_pid()");
    await c.query("drop database if exists sportozen_e2e");
  });
}
async function recreateDatabase(admin: string) {
  await dropDatabase(admin);
  await withAdmin(admin, (c) => c.query("create database sportozen_e2e"));
}
async function withDisposable<T>(dbUrl: string, work: (client: Client) => Promise<T>) {
  if (!isDisposableDatabaseUrl(dbUrl)) throw new Error("Refusing a database that is not a loopback sportozen_e2e.");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

type Reported = { title: string; file: string; status: string };
function reportedTests(path: string): Reported[] {
  if (!existsSync(path)) return [];
  type Suite = { specs?: { title: string; file: string; tests: { status: string }[] }[]; suites?: Suite[] };
  const out: Reported[] = [];
  const walk = (suite: Suite) => {
    for (const s of suite.specs ?? []) for (const t of s.tests) out.push({ title: s.title, file: s.file, status: t.status });
    for (const child of suite.suites ?? []) walk(child);
  };
  walk(JSON.parse(readFileSync(path, "utf8")) as Suite);
  return out;
}

/** Child-process environments are plain string maps; this project's typings insist on NODE_ENV, which these deliberately do not carry. */
type Env = Record<string, string | undefined>;
const asEnv = (env: Env) => env as unknown as NodeJS.ProcessEnv;

function runToFile(command: string, commandArgs: string[], env: Env, logPath: string) {
  const fd = openSync(logPath, "a");
  try {
    const result = spawnSync(command, commandArgs, { cwd: root, env: asEnv(env), stdio: ["ignore", fd, fd] });
    return result.status ?? 1;
  } finally {
    closeSync(fd);
  }
}

const MAIL_OR_MESSAGING = /(^|\.)(resend\.com|zeptomail\.[a-z.]+|zoho\.[a-z.]+|postmarkapp\.com|sendgrid\.net|amazonaws\.com|mailgun\.[a-z]+|facebook\.com|whatsapp\.[a-z]+)$/i;

let currentServer: ChildProcess | undefined;
let currentTests: ChildProcess | undefined;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
    killTree(currentTests);
    killTree(currentServer);
  });

async function runProfile(profile: BrowserProfile, admin: string, outRoot: string): Promise<ProfileResult> {
  const started = Date.now();
  const out = join(outRoot, profile.name);
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), `sportozen-e2e-${profile.name}-`));
  const dbUrl = disposableUrl(admin);
  const result: ProfileResult = {
    profile: profile.name,
    mode: profile.mode,
    port: profile.port,
    startedAt: new Date(started).toISOString(),
    seconds: 0,
    specs: profile.specs,
    setup: { database: "not created", migrated: false, seeded: false, fixtures: [], serverReady: false },
    counts: { planned: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, didNotRun: 0 },
    failedTests: [],
    skippedTests: [],
    teardown: { fixturesRemoved: [], fixturesStillPresent: [], serverStopped: false, portClosed: false, databaseDropped: false, temporaryFilesRemoved: false },
    evidence: {
      serverMailCredentialsPresent: false,
      serverEmailProvider: "",
      outboundAttempts: 0,
      outboundHosts: {},
      mailOrMessagingHostAttempts: 0,
      capturedMessages: null,
      capturedKinds: null,
      secretsFoundInServerLogs: null,
    },
    problems: [],
  };
  const problem = (text: string) => result.problems.push(text);
  log(`\n=== profile ${profile.name}: ${profile.description}`);

  const seedPassword = `Seed-${random(18)}`;
  const files = {
    serverOut: join(out, "server.out.log"),
    serverErr: join(out, "server.err.log"),
    setupLog: join(out, "setup.log"),
    pwLog: join(out, "playwright.log"),
    list: join(out, "planned.json"),
    report: join(out, "report.json"),
    outbound: join(out, "outbound-guard.jsonl"),
    capture: join(work, "auth-email-capture.jsonl"),
    outbox: join(work, "dispatch-test-outbox.jsonl"),
    authCache: join(work, "auth-cache"),
  };
  const guardScript = resolve(root, "scripts", "lib", "outbound-guard.cjs").replace(/\\/g, "/");

  let serverEnv: ReturnType<typeof buildServerEnv>;
  try {
    for (const port of [...FORBIDDEN_PORTS]) if (profile.port === port) throw new E2eServerRefusal(`Port ${port} is not available to the runner.`);
    serverEnv = buildServerEnv(process.env, {
      profile: profile.google,
      mode: profile.mode,
      port: profile.port,
      databaseUrl: dbUrl,
      deliveryTest: profile.deliveryTest ? { outboxFile: files.outbox } : undefined,
      emailTest: profile.emailTest ? { captureFile: files.capture } : undefined,
      outboundGuard: { script: guardScript, logFile: files.outbound },
      mediaPath: join(work, "private-media"),
    });
  } catch (error) {
    problem(`Could not build the server environment: ${(error as Error).message}`);
    result.seconds = Math.round((Date.now() - started) / 1000);
    rmSync(work, { recursive: true, force: true });
    return result;
  }
  result.evidence.serverMailCredentialsPresent = !!(serverEnv.RESEND_API_KEY || serverEnv.ZEPTOMAIL_TOKEN);
  result.evidence.serverEmailProvider = serverEnv.EMAIL_PROVIDER || "(none)";
  if (result.evidence.serverMailCredentialsPresent) problem("The server environment carries real mail provider credentials.");

  const baseUrl = `http://127.0.0.1:${profile.port}`;
  let applied: BrowserProfile["fixtures"] = [];
  try {
    // --- preconditions that must be true, not assumed
    if (profile.mode === "production" && !existsSync(join(root, ".next-redesign", "BUILD_ID")))
      throw new Error("No production build here (.next-redesign/BUILD_ID is missing). Run `npm run build` or pass --build.");
    if (await portOpen(profile.port)) throw new Error(`Port ${profile.port} is already in use. The runner never stops a process it did not start.`);
    const missing = missingSpecEnvironment(profile, {
      E2E_BASE_URL: baseUrl, BETTER_AUTH_URL: baseUrl, DEV_SEED_PASSWORD: seedPassword, E2E_SEED_PASSWORD: seedPassword, E2E_DISPOSABLE: "true",
      DISPATCH_TEST_OUTBOX_FILE: files.outbox, AUTH_EMAIL_CAPTURE_FILE: files.capture, E2E_DATABASE_URL: dbUrl,
    });
    if (missing.length) throw new Error(`The runner does not provide what the specs of this profile need: ${missing.join(", ")}.`);
    mkdirSync(files.authCache, { recursive: true });

    // --- disposable database: created empty, migrated, seeded
    await recreateDatabase(admin);
    result.setup.database = "created empty";
    const scriptEnv: Env = {
      ...passThroughEnv(process.env),
      DATABASE_URL: dbUrl,
      BETTER_AUTH_SECRET: random(48),
      BETTER_AUTH_URL: baseUrl,
      DEV_SEED_PASSWORD: seedPassword,
      ALLOW_DEV_SEED: "true",
      E2E_DISPOSABLE: "true",
      NEXT_TELEMETRY_DISABLED: "1",
    };
    const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
    const step = (script: string) => {
      const code = runToFile(process.execPath, [tsx, script], scriptEnv, files.setupLog);
      if (code !== 0) throw new Error(`${script} failed (exit ${code}); see ${files.setupLog}.`);
    };
    step("scripts/migrate.ts");
    result.setup.migrated = true;
    for (const script of ["scripts/seed.ts", "scripts/seed-operations.ts", "scripts/seed-e2e-roles.ts"]) step(script);
    result.setup.seeded = true;
    await withDisposable(dbUrl, async (client) => {
      for (const name of profile.fixtures) {
        await applyFixture(client, name);
        applied = [...applied, name];
        if (!(await fixtureIsPresent(client, name))) throw new Error(`Fixture ${name} did not take effect.`);
        result.setup.fixtures.push(`${name}: ${describeFixture(name)}`);
      }
    });

    // --- the server for this profile
    const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
    const serverArgs = profile.mode === "production" ? ["start"] : ["dev", "--webpack"];
    const outFd = openSync(files.serverOut, "a");
    const errFd = openSync(files.serverErr, "a");
    currentServer = spawn(process.execPath, [nextBin, ...serverArgs, "--hostname", "127.0.0.1", "--port", String(profile.port)], {
      cwd: root,
      env: serverEnv,
      stdio: ["ignore", outFd, errFd],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    closeSync(outFd);
    closeSync(errFd);
    const serverGone = exited(currentServer).then((code) => `The server exited early (code ${code}); see ${files.serverErr}.`);
    const ready = until(async () => (await fetch(`${baseUrl}/login`, { signal: AbortSignal.timeout(120_000) })).status === 200, `the ${profile.name} server on ${baseUrl}`, profile.mode === "production" ? 120_000 : 360_000);
    await Promise.race([ready, serverGone.then((message) => Promise.reject(new Error(message)))]);
    result.setup.serverReady = true;
    log(`    server ready on ${baseUrl} (${profile.mode})`);

    // --- Playwright: first what is planned, then the run
    const pwEnv: Env = {
      ...passThroughEnv(process.env),
      E2E_PROFILE: profile.name,
      E2E_BASE_URL: baseUrl,
      BETTER_AUTH_URL: baseUrl,
      E2E_DISPOSABLE: "true",
      DEV_SEED_PASSWORD: seedPassword,
      E2E_SEED_PASSWORD: seedPassword,
      E2E_DATABASE_URL: dbUrl,
      E2E_AUTH_CACHE_DIR: files.authCache,
      E2E_OUTPUT_DIR: join(out, "test-results"),
      A11Y_REPORT_DIR: join(out, "a11y"),
      NEXT_TELEMETRY_DISABLED: "1",
      ...(profile.deliveryTest ? { DISPATCH_TEST_OUTBOX_FILE: files.outbox } : {}),
      ...(profile.emailTest ? { AUTH_EMAIL_CAPTURE_FILE: files.capture } : {}),
    };
    const pw = join(root, "node_modules", "@playwright", "test", "cli.js");
    const listCode = runToFile(process.execPath, [pw, "test", "-c", "playwright.ci.config.ts", "--list", "--reporter=json"], { ...pwEnv, PLAYWRIGHT_JSON_OUTPUT_NAME: files.list }, files.pwLog);
    const planned = listCode === 0 ? reportedTests(files.list) : [];
    if (listCode !== 0 || !planned.length) problem("Playwright could not list this profile's tests (or it listed none); see playwright.log.");
    result.counts.planned = planned.length;
    log(`    ${planned.length} tests planned in ${profile.specs.length} spec file(s)`);

    const pwFd = openSync(files.pwLog, "a");
    currentTests = spawn(process.execPath, [pw, "test", "-c", "playwright.ci.config.ts"], {
      cwd: root,
      env: asEnv({ ...pwEnv, PLAYWRIGHT_JSON_OUTPUT_NAME: files.report }),
      stdio: ["ignore", pwFd, pwFd],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    closeSync(pwFd);
    const hardCap = setTimeout(() => (problem("The profile ran longer than 90 minutes and was stopped."), killTree(currentTests)), 90 * 60_000);
    const pwCode = await exited(currentTests);
    clearTimeout(hardCap);
    currentTests = undefined;
    if (interrupted) problem("Interrupted.");

    const ran = reportedTests(files.report);
    const count = (...statuses: string[]) => ran.filter((t) => statuses.includes(t.status)).length;
    result.counts.passed = count("expected");
    result.counts.failed = count("unexpected");
    result.counts.flaky = count("flaky");
    result.counts.skipped = count("skipped");
    result.counts.didNotRun = Math.max(0, planned.length - ran.length);
    result.failedTests = ran.filter((t) => t.status === "unexpected" || t.status === "flaky").map((t) => `${t.file}: ${t.title}`);
    result.skippedTests = ran.filter((t) => t.status === "skipped").map((t) => `${t.file}: ${t.title}`);
    if (pwCode !== 0 && !result.failedTests.length && !result.skippedTests.length) problem(`Playwright exited with code ${pwCode} without reporting a failing test; see playwright.log.`);
    log(`    passed ${result.counts.passed}, failed ${result.counts.failed}, skipped ${result.counts.skipped}, did not run ${result.counts.didNotRun}`);
  } catch (error) {
    problem((error as Error).message);
  } finally {
    // --- evidence first (it lives in files that teardown deletes), then teardown, each step verified
    try {
      if (existsSync(files.outbound)) {
        for (const line of readFileSync(files.outbound, "utf8").split("\n").filter(Boolean)) {
          const entry = JSON.parse(line) as { host: string };
          result.evidence.outboundAttempts++;
          result.evidence.outboundHosts[entry.host] = (result.evidence.outboundHosts[entry.host] ?? 0) + 1;
          if (MAIL_OR_MESSAGING.test(entry.host)) result.evidence.mailOrMessagingHostAttempts++;
        }
      }
      if (result.evidence.mailOrMessagingHostAttempts) problem(`The server tried to reach a mail or messaging provider ${result.evidence.mailOrMessagingHostAttempts} time(s); the guard refused every call.`);
      if (profile.emailTest) {
        const entries = existsSync(files.capture) ? readFileSync(files.capture, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; text: string }) : [];
        result.evidence.capturedMessages = entries.length;
        result.evidence.capturedKinds = {};
        for (const e of entries) result.evidence.capturedKinds[e.kind] = (result.evidence.capturedKinds[e.kind] ?? 0) + 1;
        const secrets = new Set<string>();
        for (const e of entries) {
          const code = /verification code is (\d{6})\./.exec(e.text)?.[1];
          if (code) secrets.add(code);
          const token = /#token=(\S+)/.exec(e.text)?.[1];
          if (token) secrets.add(token);
        }
        const logs = [files.serverOut, files.serverErr].map((f) => (existsSync(f) ? readFileSync(f, "utf8") : "")).join("\n");
        let found = 0;
        for (const secret of secrets) if (new RegExp(`(?<![0-9A-Za-z_-])${secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9A-Za-z_-])`).test(logs)) found++;
        result.evidence.secretsFoundInServerLogs = found;
        if (found) problem(`${found} captured code(s) or link token(s) appear in the server's own logs.`);
        if (!entries.length) problem("The email profile captured no message at all.");
      }
    } catch (error) {
      problem(`Could not read the evidence files: ${(error as Error).message}`);
    }
    killTree(currentTests);
    // fixtures
    try {
      if (applied.length && (await databaseExists(admin)))
        await withDisposable(dbUrl, async (client) => {
          for (const name of applied) {
            await removeFixture(client, name);
            if (await fixtureIsPresent(client, name)) result.teardown.fixturesStillPresent.push(name);
            else result.teardown.fixturesRemoved.push(name);
          }
        });
    } catch (error) {
      problem(`Fixture removal failed: ${(error as Error).message}`);
    }
    if (result.teardown.fixturesStillPresent.length) problem(`Fixtures still present after removal: ${result.teardown.fixturesStillPresent.join(", ")}.`);
    // server
    try {
      killTree(currentServer);
      if (currentServer) await Promise.race([exited(currentServer), sleep(15_000)]);
      await until(async () => !(await portOpen(profile.port)), `port ${profile.port} to close`, 30_000);
      result.teardown.serverStopped = true;
      result.teardown.portClosed = true;
    } catch (error) {
      problem(`Server teardown could not be verified: ${(error as Error).message}`);
    }
    currentServer = undefined;
    // temporary files (capture file, outbox file, session cache, private media)
    try {
      rmSync(work, { recursive: true, force: true });
      result.teardown.temporaryFilesRemoved = !existsSync(work);
    } catch {
      result.teardown.temporaryFilesRemoved = false;
    }
    if (!result.teardown.temporaryFilesRemoved) problem("Temporary files could not be removed.");
    // database
    try {
      await dropDatabase(admin);
      result.teardown.databaseDropped = !(await databaseExists(admin));
    } catch (error) {
      problem(`Dropping the database failed: ${(error as Error).message}`);
    }
    if (!result.teardown.databaseDropped) problem("The disposable database still exists.");
  }

  const c = result.counts;
  if (c.failed || c.flaky) problem(`${c.failed + c.flaky} test(s) failed.`);
  if (c.skipped) problem(`${c.skipped} test(s) were skipped; a profile must run everything it plans.`);
  if (c.didNotRun) problem(`${c.didNotRun} planned test(s) did not run.`);
  if (c.planned && c.passed !== c.planned) problem(`Planned ${c.planned} but ${c.passed} passed.`);
  result.seconds = Math.round((Date.now() - started) / 1000);
  return result;
}

async function buildApp() {
  const admin = adminConnection();
  const env = buildServerEnv(process.env, {
    profile: "plain",
    mode: "production",
    port: PROFILES[0].port,
    databaseUrl: disposableUrl(admin),
  });
  env.NODE_OPTIONS = "--max-old-space-size=3072";
  log("Building the production app (next build)...");
  const code = runToFile(process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "build"], env, join(tmpdir(), "sportozen-e2e-ci-build.log"));
  if (code !== 0) throw new Error(`next build failed (exit ${code}); see ${join(tmpdir(), "sportozen-e2e-ci-build.log")}.`);
}

async function main() {
  const manifest = manifestProblems();
  if (manifest.length) throw new Error(`The profile manifest is unsound:\n  ${manifest.join("\n  ")}`);
  if (has("list")) {
    for (const p of PROFILES) log(`${p.name.padEnd(14)} ${p.mode.padEnd(12)} port ${p.port}  ${p.specs.length} spec file(s)  fixtures: ${p.fixtures.join(", ") || "none"}\n               ${p.description}`);
    return 0;
  }
  if (!existsSync(join(root, "playwright.ci.config.ts"))) throw new Error("Run this from the project folder (playwright.ci.config.ts not found).");
  const chosen = (flag("profile") ?? PROFILES.map((p) => p.name).join(",")).split(",").map((s) => s.trim()).filter(Boolean).map(profileByName);
  const admin = adminConnection();
  if (has("build")) await buildApp();
  const outRoot = resolve(flag("out") ?? join(root, "test-results", "e2e-ci", new Date().toISOString().replace(/[:.]/g, "-")));
  mkdirSync(outRoot, { recursive: true });
  log(`Results folder: ${outRoot}`);
  const results: ProfileResult[] = [];
  for (const profile of chosen) {
    if (interrupted) break;
    results.push(await runProfile(profile, admin, outRoot));
  }
  const total = results.reduce(
    (a, r) => ({ planned: a.planned + r.counts.planned, passed: a.passed + r.counts.passed, failed: a.failed + r.counts.failed + r.counts.flaky, skipped: a.skipped + r.counts.skipped, didNotRun: a.didNotRun + r.counts.didNotRun }),
    { planned: 0, passed: 0, failed: 0, skipped: 0, didNotRun: 0 },
  );
  const ok = results.length === chosen.length && results.every((r) => !r.problems.length);
  writeFileSync(join(outRoot, "results.json"), JSON.stringify({ finishedAt: new Date().toISOString(), ok, total, profiles: results }, null, 2));
  log("\nprofile          mode         planned  passed  failed  skipped  not-run  seconds  teardown");
  for (const r of results) {
    const td = r.teardown;
    const tidy = td.serverStopped && td.portClosed && td.databaseDropped && td.temporaryFilesRemoved && !td.fixturesStillPresent.length;
    log(`${r.profile.padEnd(16)} ${r.mode.padEnd(12)} ${String(r.counts.planned).padStart(7)} ${String(r.counts.passed).padStart(7)} ${String(r.counts.failed + r.counts.flaky).padStart(7)} ${String(r.counts.skipped).padStart(8)} ${String(r.counts.didNotRun).padStart(8)} ${String(r.seconds).padStart(8)}  ${tidy ? "verified" : "NOT VERIFIED"}`);
  }
  log(`${"TOTAL".padEnd(29)} ${String(total.planned).padStart(7)} ${String(total.passed).padStart(7)} ${String(total.failed).padStart(7)} ${String(total.skipped).padStart(8)} ${String(total.didNotRun).padStart(8)}`);
  for (const r of results) for (const p of r.problems) log(`PROBLEM [${r.profile}] ${p}`);
  log(ok ? "\nAll profiles ran every planned test and all passed; teardown verified." : "\nNOT GREEN: see the problems above and results.json.");
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[e2e-ci] ${(error as Error).message}`);
    process.exit(2);
  },
);
