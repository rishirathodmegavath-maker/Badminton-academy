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
 * RC-2: operator owner restoration (TD-5 with the independent second approval chosen for PD-5), run as the real
 * command against a throw-away embedded database.
 *
 *   AT-9b.1  an academy that still has an active owner is refused, and nothing is recorded;
 *   AT-9b.2  a former owner is restored only after a DIFFERENT operator approves with the one-time code;
 *            role OWNER and active, temporary password, sessions revoked, OPERATOR_OWNER_RESTORED logged;
 *   AT-9b.3  guardian and adult-player accounts are never eligible;
 *   AT-9b.4  a reason outside 10..500 characters is refused;
 *   plus: the Administrator fallback only when no former owner exists; same-operator approval, wrong codes,
 *   reuse, expiry and voiding after three refused approvals; the operator override is ignored outside tests;
 *   the recovery events form a hash chain that detects an edited event.
 */
const dirs: string[] = [];
after(
  () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  },
  { timeout: HOOK_TIMEOUT },
);
const SECRET = "owner-recovery-cli-secret-0123456789abcdef01234";
const PASSWORD = "Previous-Owner-Passphrase-77";
async function database() {
  const dir = mkdtempSync(join(tmpdir(), "sportozen-owner-recovery-"));
  dirs.push(dir);
  const path = join(dir, "db");
  await runMigrations({ target: { kind: "pglite", path } });
  const client = new PGlite(path);
  const people: [string, string, string, string, boolean][] = [
    // id, academy, role, email local part, active
    ["o1", "a-owned", "OWNER", "owner", true],
    ["c1", "a-owned", "COACH", "coach", true],
    ["f1", "a-former", "OWNER", "former", false],
    ["ad1", "a-former", "ADMIN", "admin-former", true],
    ["g1", "a-former", "GUARDIAN", "guardian", true],
    ["p1", "a-former", "ADULT_PLAYER", "adult", true],
    ["d1", "a-demoted", "COACH", "demoted", true],
    ["ad2", "a-admin", "ADMIN", "admin-only", true],
    ["h2", "a-admin", "HEAD_COACH", "head-coach", true],
    ["m1", "a-admin", "ADMIN", "multi", true],
  ];
  await client.exec(`
    insert into academy (id, name, timezone) values
      ('a-owned', 'Owned Academy', 'UTC'), ('a-former', 'Former Academy', 'UTC'),
      ('a-demoted', 'Demoted Academy', 'UTC'), ('a-admin', 'Admin Academy', 'UTC');
  `);
  for (const [id, academy, role, local, active] of people) {
    await client.query(`insert into app_user (id, name, email) values ($1, $2, $3)`, [id, `Person ${id}`, `${local}@recovery.example`]);
    await client.query(`insert into membership (user_id, academy_id, role, active) values ($1, $2, $3, $4)`, [id, academy, role, active]);
    await client.query(
      `insert into auth_account (id, account_id, provider_id, user_id, password) values ($1, $2, 'credential', $2, $3)`,
      [`acc-${id}`, id, await hashPassword(PASSWORD)],
    );
  }
  // m1 also belongs to a second academy: ambiguous, never restored.
  await client.query(`insert into membership (user_id, academy_id, role, active) values ('m1', 'a-owned', 'COACH', false)`);
  // d1 was an owner until an owner demoted them (the most recent role change shows fromRole OWNER).
  await client.query(
    `insert into security_event (id, event, academy_id, actor_id, target_user_id, detail, created_at)
     values ('ev-d1', 'MEMBER_ROLE_CHANGED', 'a-demoted', null, 'd1', '{"fromRole":"OWNER","toRole":"COACH"}', now() - interval '1 day')`,
  );
  await client.query(`insert into auth_session (id, expires_at, token, user_id) values ('s-f1', now() + interval '1 hour', 'tok-f1', 'f1')`);
  await client.close();
  return path;
}
async function read<T>(path: string, query: string, params: unknown[] = []) {
  const client = new PGlite(path);
  try {
    return (await client.query(query, params)).rows as T[];
  } finally {
    await client.close();
  }
}
function run(path: string, args: string[], operator: string | null = "alice", testEnv = true) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "http://127.0.0.1:3100",
    LOCAL_DATABASE_PATH: path,
    ...(testEnv ? { NODE_ENV: "test" } : {}),
    ...(operator ? { RECOVERY_OPERATOR: operator } : {}),
  };
  const r = spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts/recover-account.ts"), ...args], {
    cwd: REPO_ROOT,
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 180_000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
const REASON = ["--reason", "Ticket 4411: identity verified by phone call"];
function request(path: string, email: string, operator = "alice", testEnv = true) {
  const r = run(path, ["--restore-owner", email, ...REASON, "--yes"], operator, testEnv);
  assert.equal(r.status, 0, r.out + r.err);
  const id = /Request ID:\s+(\S+)/.exec(r.out)?.[1];
  const lines = r.out.split(/\r?\n/);
  const code = lines[lines.findIndex((l) => l.startsWith("Approval code")) + 1]?.trim();
  assert.ok(id && code, r.out);
  return { id, code };
}
const approve = (path: string, id: string, code: string, operator = "bob", testEnv = true) =>
  run(path, ["--approve-owner-restore", id, "--approval-code", code, "--yes"], operator, testEnv);
const membership = async (path: string, userId: string) =>
  (await read<{ role: string; active: boolean }>(path, `select role, active from membership where user_id = $1`, [userId]))[0];
const events = (path: string, event: string) =>
  read<{ id: string; detail: Record<string, unknown>; target_user_id: string; actor_id: string | null; academy_id: string }>(
    path,
    `select * from security_event where event = $1 order by created_at, id`,
    [event],
  );

test("operator owner recovery: TD-5 eligibility, two-operator approval, single use and a verifiable log", async () => {
  const path = await database();
  const chainEvents = async () =>
    (await read<{ n: number }>(path, `select count(*)::int as n from security_event where event like 'OPERATOR_OWNER_%'`))[0].n;

  // AT-9b.1: the academy still has an owner.
  const owned = run(path, ["--restore-owner", "coach@recovery.example", ...REASON, "--yes"]);
  assert.equal(owned.status, 1);
  assert.match(owned.err, /Cannot restore owner\. Academy already has 1 active owner\(s\)\./);
  // AT-9b.3: family accounts are never eligible.
  for (const email of ["guardian@recovery.example", "adult@recovery.example"]) {
    const r = run(path, ["--restore-owner", email, ...REASON, "--yes"]);
    assert.equal(r.status, 1);
    assert.match(r.err, /Ineligible account type/);
  }
  // Administrator fallback is refused while a former owner exists in the academy.
  const adminWhileFormer = run(path, ["--restore-owner", "admin-former@recovery.example", ...REASON, "--yes"]);
  assert.equal(adminWhileFormer.status, 1);
  assert.match(adminWhileFormer.err, /has a former owner/);
  // Other staff without owner history are not eligible; neither is an account in two academies.
  const head = run(path, ["--restore-owner", "head-coach@recovery.example", ...REASON, "--yes"]);
  assert.match(head.err, /Ineligible account: only a former owner/);
  const multi = run(path, ["--restore-owner", "multi@recovery.example", ...REASON, "--yes"]);
  assert.match(multi.err, /more than one academy/);
  // AT-9b.4: reason length.
  const short = run(path, ["--restore-owner", "former@recovery.example", "--reason", "too short", "--yes"]);
  assert.equal(short.status, 1);
  assert.match(short.err, /Give a reason of 10 to 500 characters/);
  assert.equal(await chainEvents(), 0, "no refusal above recorded a request");
  // Dry run: eligibility is shown, nothing is recorded.
  const dry = run(path, ["--restore-owner", "former@recovery.example", ...REASON]);
  assert.equal(dry.status, 0, dry.err);
  assert.match(dry.out, /Eligible: yes, as FORMER_OWNER/);
  assert.match(dry.out, /Nothing changed/);
  assert.equal(await chainEvents(), 0);

  // AT-9b.2: request by alice ...
  const req = request(path, "former@recovery.example", "alice");
  const [requested] = await events(path, "OPERATOR_OWNER_RESTORE_REQUESTED");
  assert.equal(requested.target_user_id, "f1");
  assert.equal(requested.academy_id, "a-former");
  assert.equal(requested.actor_id, null);
  assert.equal(requested.detail.requestedBy, "alice");
  assert.equal(requested.detail.candidateType, "FORMER_OWNER");
  assert.ok(!JSON.stringify(requested.detail).includes(req.code), "the approval code itself is not stored");
  assert.deepEqual(await membership(path, "f1"), { role: "OWNER", active: false }, "a request changes nothing");
  // ... cannot be approved by alice herself ...
  const self = approve(path, req.id, req.code, "alice");
  assert.equal(self.status, 1);
  assert.match(self.err, /different operator/);
  // ... nor with a wrong code ...
  const wrong = approve(path, req.id, "not-the-code", "bob");
  assert.equal(wrong.status, 1);
  assert.match(wrong.err, /does not match/);
  assert.deepEqual(await membership(path, "f1"), { role: "OWNER", active: false });
  // ... and is completed by bob with the code.
  const done = approve(path, req.id, req.code, "bob");
  assert.equal(done.status, 0, done.out + done.err);
  assert.match(done.out, /Owner restored \(FORMER_OWNER\)/);
  assert.match(done.out, /Sessions revoked: 1/);
  const lines = done.out.split(/\r?\n/);
  const temporary = lines[lines.findIndex((l) => l.startsWith("Temporary password")) + 1].trim();
  assert.deepEqual(await membership(path, "f1"), { role: "OWNER", active: true });
  const [hash] = await read<{ password: string }>(path, `select password from auth_account where user_id = 'f1'`);
  assert.equal(await verifyPassword({ hash: hash.password, password: temporary }), true);
  assert.equal((await read(path, `select * from auth_session where user_id = 'f1'`)).length, 0);
  assert.equal((await read(path, `select * from temporary_credential where user_id = 'f1'`)).length, 1);
  const [restored] = await events(path, "OPERATOR_OWNER_RESTORED");
  assert.equal(restored.detail.requestedBy, "alice");
  assert.equal(restored.detail.approvedBy, "bob");
  assert.equal(restored.detail.candidateType, "FORMER_OWNER");
  assert.equal(restored.detail.reason, REASON[1]);
  assert.ok(!JSON.stringify(restored.detail).includes(temporary), "the temporary password is not logged");
  const denied = await events(path, "OPERATOR_OWNER_RESTORE_DENIED");
  assert.deepEqual(denied.map((d) => d.detail.reason), ["SAME_OPERATOR", "BAD_APPROVAL_CODE"]);
  // A used request cannot be used again.
  const reuse = approve(path, req.id, req.code, "carol");
  assert.equal(reuse.status, 1);
  assert.match(reuse.err, /already been used/);
  // The academy now has an owner, so new requests for it are refused.
  assert.match(run(path, ["--restore-owner", "admin-former@recovery.example", ...REASON, "--yes"]).err, /already has 1 active owner/);

  // A former owner identified by the role-change history, and the void-after-three rule.
  const demoted = request(path, "demoted@recovery.example", "alice");
  for (let i = 0; i < 3; i++) assert.match(approve(path, demoted.id, `wrong-${i}`, "bob").err, /does not match/);
  const voided = approve(path, demoted.id, demoted.code, "bob");
  assert.equal(voided.status, 1);
  assert.match(voided.err, /void/);
  assert.deepEqual(await membership(path, "d1"), { role: "COACH", active: true });

  // Outside NODE_ENV=test the operator is the OS account, whatever RECOVERY_OPERATOR says.
  const real = request(path, "admin-only@recovery.example", "alice", false);
  const [realRequest] = (await events(path, "OPERATOR_OWNER_RESTORE_REQUESTED")).filter((e) => e.detail.requestId === real.id);
  assert.notEqual(realRequest.detail.requestedBy, "alice", "the override was ignored");
  const sameOs = approve(path, real.id, real.code, "bob", false);
  assert.equal(sameOs.status, 1);
  assert.match(sameOs.err, /different operator/);
  // The Administrator fallback, where the academy has no former owner.
  const adminReq = request(path, "admin-only@recovery.example", "alice");
  const adminDone = approve(path, adminReq.id, adminReq.code, "bob");
  assert.equal(adminDone.status, 0, adminDone.err);
  assert.match(adminDone.out, /Owner restored \(ADMINISTRATOR\)/);
  assert.deepEqual(await membership(path, "ad2"), { role: "OWNER", active: true });
  const roleChange = (await events(path, "MEMBER_ROLE_CHANGED")).filter((e) => e.target_user_id === "ad2");
  assert.deepEqual(roleChange.map((e) => e.detail), [{ fromRole: "ADMIN", toRole: "OWNER", via: "OPERATOR_OWNER_RESTORED" }]);

  // The recovery log verifies; editing any recorded event is detected.
  const intact = run(path, ["--verify-recovery-log"]);
  assert.equal(intact.status, 0, intact.out + intact.err);
  assert.match(intact.out, /intact/);
  const client = new PGlite(path);
  await client.query(
    `update security_event set detail = jsonb_set(detail, '{reason}', '"edited later"') where event = 'OPERATOR_OWNER_RESTORED' and target_user_id = 'f1'`,
  );
  await client.close();
  const tampered = run(path, ["--verify-recovery-log"]);
  assert.equal(tampered.status, 1);
  assert.match(tampered.out, /PROBLEMS FOUND/);
  assert.match(tampered.out, /altered \(hash mismatch\)/);
});

test("operator owner recovery: an expired request cannot be approved", async () => {
  const path = await database();
  const req = request(path, "former@recovery.example", "alice");
  const client = new PGlite(path);
  await client.query(
    `update security_event set detail = jsonb_set(detail, '{expiresAt}', to_jsonb($1::text)) where event = 'OPERATOR_OWNER_RESTORE_REQUESTED'`,
    [new Date(Date.now() - 60_000).toISOString()],
  );
  await client.close();
  const r = approve(path, req.id, req.code, "bob");
  assert.equal(r.status, 1);
  assert.match(r.err, /expired/);
  // An unreadable expiry fails closed.
  const garbled = request(path, "former@recovery.example", "alice");
  const edit = new PGlite(path);
  await edit.query(
    `update security_event set detail = jsonb_set(detail, '{expiresAt}', '"not-a-date"') where detail->>'requestId' = $1`,
    [garbled.id],
  );
  await edit.close();
  const g = approve(path, garbled.id, garbled.code, "bob");
  assert.equal(g.status, 1);
  assert.match(g.err, /expired/);
  assert.deepEqual(await membership(path, "f1"), { role: "OWNER", active: false });
});
