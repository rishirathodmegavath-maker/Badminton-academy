import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { runMigrations } from "../src/infrastructure/database/migrations";
import { HOOK_TIMEOUT, REPO_ROOT } from "./helpers/paths";
/**
 * The operator recovery command, run as a real process against a throw-away embedded database.
 * It is the way back in when the only owner is locked out, so its safety rails matter as much as
 * its success path.
 */
const dirs: string[] = [];
after(
  () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  },
  { timeout: HOOK_TIMEOUT },
);
const OLD_PASSWORD = "Previous-Owner-Passphrase-77";
const SECRET = "recovery-cli-secret-0123456789abcdef0123456789";
async function database() {
  const dir = mkdtempSync(join(tmpdir(), "sportozen-recovery-"));
  dirs.push(dir);
  const path = join(dir, "db");
  await runMigrations({ target: { kind: "pglite", path } });
  const client = new PGlite(path);
  await client.exec(`
    insert into academy (id, name, timezone) values ('a1', 'Recovery Academy', 'UTC');
    insert into app_user (id, name, email, two_factor_enabled) values ('o1', 'Only Owner', 'owner@recovery.example', true);
    insert into auth_session (id, expires_at, token, user_id) values ('s1', now() + interval '1 hour', 'tok-1', 'o1');
    insert into membership (user_id, academy_id, role) values ('o1', 'a1', 'OWNER');
    insert into two_factor (id, secret, backup_codes, user_id) values ('tf1', 'enc', 'enc', 'o1');
    insert into sign_in_throttle (key, failures, window_started_at, locked_until) values ('k', 10, now(), now() + interval '10 minutes');
  `);
  await client.query(
    `insert into auth_account (id, account_id, provider_id, user_id, password) values ('acc1', 'o1', 'credential', 'o1', $1)`,
    [await hashPassword(OLD_PASSWORD)],
  );
  await client.close();
  return path;
}
async function read<T>(path: string, sql: string) {
  const client = new PGlite(path);
  try {
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.close();
  }
}
function run(path: string | null, args: string[], extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "http://127.0.0.1:3100",
    ...(path ? { LOCAL_DATABASE_PATH: path } : {}),
    ...extra,
  };
  return spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts/recover-account.ts"), ...args], {
    cwd: REPO_ROOT,
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 180_000,
  });
}
test("operator recovery: guard rails, then a real recovery of a locked-out only owner", async () => {
  const path = await database();
  const snapshot = async () =>
    JSON.stringify(await read(path, `select password from auth_account where id = 'acc1'`)) +
    JSON.stringify(await read(path, `select count(*)::int as n from auth_session`)) +
    JSON.stringify(await read(path, `select count(*)::int as n from temporary_credential`));
  const before = await snapshot();
  // Missing arguments.
  const usage = run(path, []);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage: npm run auth:recover/);
  // Without --yes it names the target and changes nothing.
  const dry = run(path, ["--email", "owner@recovery.example", "--reason", "Owner locked out; verified by phone."]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Database: embedded:/);
  assert.match(dry.stdout, /Nothing changed/);
  assert.doesNotMatch(dry.stdout, /Temporary password/);
  assert.equal(await snapshot(), before);
  // A miss and a too-short reason change nothing and say why.
  const miss = run(path, ["--email", "ghost@recovery.example", "--reason", "Owner locked out; verified by phone.", "--yes"]);
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /No account matches/);
  const short = run(path, ["--email", "owner@recovery.example", "--reason", "short", "--yes"]);
  assert.equal(short.status, 1);
  assert.match(short.stderr, /reason/i);
  assert.equal(await snapshot(), before);
  // The real thing (keeping the authenticator).
  const done = run(path, ["--email", "Owner@Recovery.Example", "--reason", "Owner locked out; verified by phone.", "--yes"]);
  assert.equal(done.status, 0, done.stderr);
  const printed = done.stdout.trim().split(/\r?\n/).at(-1)!;
  assert.match(printed, /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
  assert.equal(done.stdout.split(printed).length - 1, 1, "the password is printed exactly once");
  assert.ok(!done.stderr.includes(printed));
  assert.match(done.stdout, /Sessions revoked: 1/);
  assert.match(done.stdout, /Authenticator removed: false/);
  const [account] = await read<{ password: string }>(path, `select password from auth_account where id = 'acc1'`);
  assert.equal(await verifyPassword({ hash: account.password, password: printed }), true, "the printed password is the stored credential");
  assert.equal(await verifyPassword({ hash: account.password, password: OLD_PASSWORD }), false);
  assert.ok(!account.password.includes(printed));
  assert.equal((await read(path, `select 1 from auth_session`)).length, 0, "all sessions revoked");
  assert.equal((await read(path, `select 1 from sign_in_throttle`)).length, 1, "unrelated throttle rows are left alone");
  const [marker] = await read<{ source: string; issued_by: string | null; expires_at: Date; issued_at: Date }>(path, `select * from temporary_credential where user_id = 'o1'`);
  assert.equal(marker.source, "OPERATOR_RECOVERY");
  assert.equal(marker.issued_by, null);
  assert.ok(Math.abs(new Date(marker.expires_at).getTime() - new Date(marker.issued_at).getTime() - 72 * 3600 * 1000) < 1000);
  assert.equal((await read(path, `select 1 from two_factor`)).length, 1, "the authenticator is kept unless asked");
  const [event] = await read<{ event: string; academy_id: string; actor_id: string | null; detail: Record<string, unknown> }>(path, `select * from security_event`);
  assert.equal(event.event, "OPERATOR_RECOVERY");
  assert.equal(event.academy_id, "a1");
  assert.equal(event.actor_id, null);
  assert.equal(event.detail.reason, "Owner locked out; verified by phone.");
  assert.ok(typeof event.detail.operator === "string" && event.detail.operator.length > 0);
  assert.ok(!JSON.stringify(event).includes(printed));
  // Lost authenticator and recovery codes: only with the explicit flag.
  const full = run(path, ["--email", "owner@recovery.example", "--reason", "Phone and recovery codes lost; verified in person.", "--reset-authenticator", "--yes"]);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /Authenticator removed: true/);
  assert.equal((await read(path, `select 1 from two_factor`)).length, 0);
  const [flag] = await read<{ two_factor_enabled: boolean }>(path, `select two_factor_enabled from app_user where id = 'o1'`);
  assert.equal(flag.two_factor_enabled, false);
  assert.equal((await read(path, `select 1 from temporary_credential`)).length, 1, "still exactly one marker");
  assert.equal((await read(path, `select 1 from security_event`)).length, 2);
});
test("operator recovery refuses a remote database unless the exact target is confirmed, and never prints credentials", () => {
  const remote = "postgres://admin:topsecret@db.invalid:5432/production";
  const refused = run(null, ["--email", "owner@example.test", "--reason", "Owner locked out; verified by phone.", "--yes"], { DATABASE_URL: remote });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /MIGRATION_CONFIRM_TARGET=db\.invalid:5432\/production/);
  for (const text of [refused.stdout, refused.stderr]) assert.ok(!text.includes("topsecret"));
  // A wrong confirmation is no better.
  const wrong = run(null, ["--email", "owner@example.test", "--reason", "Owner locked out; verified by phone.", "--yes"], { DATABASE_URL: remote, MIGRATION_CONFIRM_TARGET: "db.invalid:5432/other" });
  assert.equal(wrong.status, 1);
  assert.ok(!wrong.stderr.includes("topsecret"));
  // Production never falls back to the embedded database.
  const production = run(null, ["--email", "owner@example.test", "--reason", "Owner locked out; verified by phone.", "--yes"], { NODE_ENV: "production", LOCAL_DATABASE_PATH: join(tmpdir(), "never-used") });
  assert.equal(production.status, 1);
  assert.match(production.stderr, /DATABASE_URL/);
});
