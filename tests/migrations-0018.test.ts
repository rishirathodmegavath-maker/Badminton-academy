import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";
import { runMigrations, type MigrationTarget } from "../src/infrastructure/database/migrations";
import { adminUrl, createPostgresDatabase } from "./helpers/test-database";
import { HOOK_TIMEOUT, MIGRATIONS_DIR, REPO_ROOT } from "./helpers/paths";
/**
 * Migration 0018_academy_invitations: academy_invitation, an academy's invitation for a person to JOIN it (never implied by an
 * email address). Purely additive: no existing row changes and nobody is invited. A trigger makes the identity columns
 * immutable and ACCEPTED/REVOKED/EXPIRED final (replay protection in the database itself) and refuses deleting or
 * truncating invitations. The guarded rollback drops it and refuses to destroy invitation history without an explicit
 * confirmation. Every scenario runs on embedded PGlite (always) and on a real PostgreSQL server (when
 * TEST_POSTGRES_ADMIN_URL is set - `npm run test:pg`).
 */
const TAG = "0018_academy_invitations";
const WHEN = 1794513818712;
const ROLLBACK = join(REPO_ROOT, "migrations-rollback", `${TAG}.down.sql`);
const cleanups: (() => Promise<void> | void)[] = [];
after(
  async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  },
  { timeout: HOOK_TIMEOUT },
);
/** A database error as both drivers report it: SQLSTATE code and message. */
type DbError = { code?: string; message?: string };
const sqlState = (e: unknown) => (e as DbError).code;
/** One connection that keeps its session (BEGIN ... COMMIT across several calls). */
type Session = { query(sql: string): Promise<Record<string, unknown>[]>; close(): Promise<void> };
type Db = {
  target: MigrationTarget;
  query(sql: string): Promise<Record<string, unknown>[]>;
  /** Runs a multi-statement script (a rollback file) on one connection. */
  script(sql: string): Promise<void>;
  session(): Promise<Session>;
};
type Engine = { name: string; fresh(): Promise<Db> };
let template: Promise<string> | undefined;
const pgliteTemplate = () =>
  (template ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0018-template-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new PGlite(join(dir, "db"));
    await client.query("select 1");
    await client.close();
    return dir;
  })());
const pgliteEngine: Engine = {
  name: "PGlite",
  async fresh() {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0018-"));
    cpSync(await pgliteTemplate(), dir, { recursive: true });
    const path = join(dir, "db");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const session = async (): Promise<Session> => {
      const client = new PGlite(path);
      return {
        query: async (sql) => (await client.query(sql)).rows as Record<string, unknown>[],
        close: () => client.close(),
      };
    };
    return {
      target: { kind: "pglite", path },
      session,
      async query(sql) {
        const s = await session();
        try {
          return await s.query(sql);
        } finally {
          await s.close();
        }
      },
      async script(sql) {
        const client = new PGlite(path);
        try {
          await client.exec(sql);
        } finally {
          await client.close();
        }
      },
    };
  },
};
const admin = adminUrl();
const postgresEngine: Engine = {
  name: "PostgreSQL",
  async fresh() {
    const created = await createPostgresDatabase(admin!);
    cleanups.push(() => created.drop());
    const session = async (): Promise<Session> => {
      const client = new Client({ connectionString: created.url });
      await client.connect();
      return { query: async (sql) => (await client.query(sql)).rows, close: () => client.end() };
    };
    return {
      target: { kind: "postgres", url: created.url },
      session,
      async query(sql) {
        const s = await session();
        try {
          return await s.query(sql);
        } finally {
          await s.close();
        }
      },
      async script(sql) {
        const s = await session();
        try {
          await s.query(sql);
        } finally {
          await s.close();
        }
      },
    };
  },
};
const PG_ONLY = admin ? false : "TEST_POSTGRES_ADMIN_URL not set — run `npm run test:pg`";

/** A copy of the migrations folder cut before 0018 (the whole chain that precedes it); one copy per test process. */
let before0018Dir: string | undefined;
function folderBefore0018() {
  if (before0018Dir) return before0018Dir;
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0018-folder-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG);
  assert.ok(at > 0, "0018 is in the journal");
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  before0018Dir = dir;
  return dir;
}
/** A copy of the migrations folder up to and including 0018, so these tests keep 0018 as the latest migration when later ones exist. */
let through0018Dir: string | undefined;
function folderThrough0018() {
  if (through0018Dir) return through0018Dir;
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0018-through-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG) + 1;
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  through0018Dir = dir;
  return dir;
}
const seed = [
  `insert into academy (id, name, timezone) values ('a-1', 'One', 'UTC'), ('a-2', 'Two', 'UTC')`,
  ...["o-1", "c-1", "o-2", "x-1"].map((id) => `insert into app_user (id, name, email) values ('${id}', '${id}', '${id}@example.test')`),
  // o-1 owns a-1; c-1 coaches a-1; o-2 owns a-2; x-1 belongs to nothing.
  `insert into membership (user_id, academy_id, role) values ('o-1', 'a-1', 'OWNER'), ('c-1', 'a-1', 'COACH'), ('o-2', 'a-2', 'OWNER')`,
  `insert into branch (id, academy_id, name) values ('br-1', 'a-1', 'B'), ('br-2', 'a-2', 'B')`,
  `insert into batch (id, academy_id, name, branch_id, coach_id) values ('bt-1', 'a-1', 'Batch', 'br-1', 'c-1')`,
  `insert into membership (user_id, academy_id, role) values ('c-1', 'a-2', 'COACH')`,
  `insert into batch (id, academy_id, name, branch_id, coach_id) values ('bt-2', 'a-2', 'Batch', 'br-2', 'c-1')`,
  `insert into player (id, academy_id, name, batch_id) values ('p-1', 'a-1', 'Player One', 'bt-1'), ('p-2', 'a-2', 'Player Two', 'bt-2')`,
];
const accounts = `select to_jsonb(u) as v from app_user u order by u.id`;
const memberships = `select to_jsonb(m) as v from membership m order by 1`;
const sessions = `select to_jsonb(s) as v from auth_session s order by s.id`;
const bookkeeping = `select hash, created_at::text as created_at from drizzle."__drizzle_migrations" order by created_at`;
const schemaState = async (db: Db) =>
  JSON.stringify(
    await Promise.all(
      [
        `select c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default from information_schema.columns c where c.table_schema='public' order by 1,2`,
        `select conrelid::regclass::text as tbl, conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace and contype <> 'n' order by 1,2`,
        `select tgrelid::regclass::text as tbl, tgname, pg_get_triggerdef(oid) as def from pg_trigger where not tgisinternal order by 1,2`,
        `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1,2`,
        `select proname from pg_proc where pronamespace = 'public'::regnamespace order by 1`,
      ].map((q) => db.query(q)),
    ),
  );
const snapshot = async (db: Db) => JSON.stringify([await db.query(accounts), await db.query(memberships), await db.query(sessions)]);
/** A database at the migration before 0018 holding the seed, then upgraded to 0018. */
async function upgraded(engine: Engine) {
  const db = await engine.fresh();
  await runMigrations({ target: db.target, folder: folderBefore0018() });
  for (const statement of seed) await db.query(statement);
  const before = await snapshot(db);
  const report = await runMigrations({ target: db.target, folder: folderThrough0018() });
  assert.deepEqual(report.pending, [TAG]);
  return { db, before };
}
let n = 0;
type Over = Partial<{ academy: string; email: string; kind: string; role: string; player: string | null; rel: string | null; inviter: string; expires: string; status: string; token: string }>;
/** An invitation row; every default is a valid pending staff invitation in a-1 from its owner. */
const invite = (over: Over = {}) => {
  const o = { academy: "a-1", email: `new-${++n}@example.test`, kind: "STAFF", role: "COACH", player: null, rel: null, inviter: "o-1", expires: "now() + interval '7 days'", status: "PENDING", token: `tok-${n}-${Math.random()}`, ...over };
  const q = (v: string | null) => (v === null ? "null" : `'${v}'`);
  return `insert into academy_invitation (academy_id, invitee_email, kind, role, player_id, relationship, token_hash, invited_by_user_id, status, expires_at)
          values ('${o.academy}', '${o.email}', '${o.kind}', '${o.role}', ${q(o.player)}, ${q(o.rel)}, '${o.token}', '${o.inviter}', '${o.status}', ${o.expires})`;
};
const refuses = (db: Db, sql: string, pattern: RegExp, why: string) =>
  assert.rejects(() => db.query(sql), (e: unknown) => pattern.test(String(e)), why);
const count = async (db: Db, where = "true") => ((await db.query(`select count(*)::int as n from academy_invitation where ${where}`))[0] as { n: number }).n;

for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(`[${engine.name}] 0018 is additive: no account, membership or session changes; NOBODY is invited; re-running is a no-op`, opts, async () => {
    const { db, before } = await upgraded(engine);
    assert.equal(await snapshot(db), before, "accounts, memberships and sessions are untouched");
    assert.equal(await count(db), 0, "no invitation is invented");
    assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0018() })).pending, [], "re-running is a no-op");
  });

  test(`[${engine.name}] 0018 shape: staff, guardian and adult-player invitations are valid; a child player, an unknown role, a stray player or a blank address are not`, opts, async () => {
    const { db } = await upgraded(engine);
    await db.query(invite({ role: "OWNER" }));
    for (const role of ["ADMIN", "HEAD_COACH", "COACH", "FINANCE", "NUTRITION_PRO"]) await db.query(invite({ role }));
    await db.query(invite({ kind: "GUARDIAN", role: "GUARDIAN", player: "p-1", rel: "Mother" }));
    await db.query(invite({ kind: "ADULT_PLAYER", role: "ADULT_PLAYER" }));
    assert.equal(await count(db), 8);
    const bad: [Over, RegExp, string][] = [
      [{ role: "PLAYER" }, /academy_invitation_shape/, "there is no invitation for a child player (no child login)"],
      [{ role: "SUPERUSER" }, /academy_invitation_shape/, "an unknown role"],
      [{ role: "GUARDIAN" }, /academy_invitation_shape/, "a guardian role on a staff invitation"],
      [{ kind: "GUARDIAN", role: "GUARDIAN", player: null, rel: "Mother" }, /academy_invitation_shape/, "a guardian invitation needs its player"],
      [{ kind: "GUARDIAN", role: "GUARDIAN", player: "p-1", rel: null }, /academy_invitation_shape/, "a guardian invitation needs its relationship"],
      [{ kind: "GUARDIAN", role: "COACH", player: "p-1", rel: "Mother" }, /academy_invitation_shape/, "a guardian invitation grants only GUARDIAN"],
      [{ kind: "STAFF", role: "COACH", player: "p-1" }, /academy_invitation_shape/, "a staff invitation carries no player"],
      [{ kind: "ADULT_PLAYER", role: "OWNER" }, /academy_invitation_shape/, "an adult-player invitation grants only ADULT_PLAYER"],
      [{ kind: "TEAM", role: "COACH" }, /academy_invitation_kind/, "an unknown kind"],
      [{ email: "Mixed@Example.test" }, /academy_invitation_email_form/, "an address is stored lower-cased"],
      [{ email: " padded@example.test " }, /academy_invitation_email_form/, "an address is stored trimmed"],
      [{ email: "" }, /academy_invitation_email_form/, "a blank address"],
      [{ status: "MAYBE" }, /academy_invitation_status/, "an unknown status"],
      [{ expires: "now() - interval '1 day'" }, /academy_invitation_expiry/, "an invitation that expired before it was created"],
    ];
    for (const [over, pattern, why] of bad) await refuses(db, invite(over), pattern, why);
    assert.equal(await count(db), 8, "none of the refused rows was stored");
  });

  test(`[${engine.name}] 0018 tenancy: the inviter belongs to THAT academy, a guardian invitation's player belongs to it too, and the token is unique`, opts, async () => {
    const { db } = await upgraded(engine);
    await refuses(db, invite({ inviter: "o-2" }), /foreign key|23503/, "an owner of another academy cannot invite into this one");
    await refuses(db, invite({ inviter: "x-1" }), /foreign key|23503/, "a person with no membership cannot invite");
    await refuses(db, invite({ academy: "a-9" }), /foreign key|23503/, "an academy that does not exist");
    await refuses(db, invite({ kind: "GUARDIAN", role: "GUARDIAN", player: "p-2", rel: "Mother" }), /foreign key|23503/, "another academy's player");
    await refuses(db, invite({ kind: "GUARDIAN", role: "GUARDIAN", player: "no-such", rel: "Mother" }), /foreign key|23503/, "a player that does not exist");
    await db.query(invite({ token: "shared-token" }));
    await refuses(db, invite({ academy: "a-2", inviter: "o-2", token: "shared-token" }), /academy_invitation_token_hash_unique|duplicate key/, "a token hash is unique across every academy");
    assert.equal(await count(db), 1);
  });

  test(`[${engine.name}] 0018 one open invitation per address (and per player) in an academy; other academies, people and finished invitations are independent`, opts, async () => {
    const { db } = await upgraded(engine);
    const email = "same@example.test";
    await db.query(invite({ email }));
    await refuses(db, invite({ email, role: "ADMIN" }), /academy_invitation_one_pending_person|duplicate key/, "a second open invitation for the same address in the same academy");
    await db.query(invite({ email, academy: "a-2", inviter: "o-2" })); // the same person may be invited by another academy
    await db.query(invite({ email: "other@example.test" }));
    // guardian invitations are per player: two children are two invitations, the same child twice is not
    await db.query(invite({ email, kind: "GUARDIAN", role: "GUARDIAN", player: "p-1", rel: "Mother" }));
    await refuses(db, invite({ email, kind: "GUARDIAN", role: "GUARDIAN", player: "p-1", rel: "Father" }), /academy_invitation_one_pending_player|duplicate key/, "the same guardian invited twice for the same player");
    // once an invitation is no longer pending, the address can be invited again
    await db.query(`update academy_invitation set status = 'EXPIRED' where academy_id = 'a-1' and invitee_email = '${email}' and kind = 'STAFF'`);
    await db.query(invite({ email, role: "FINANCE" }));
    assert.equal(await count(db, `invitee_email = '${email}'`), 4);
  });

  test(`[${engine.name}] 0018 lifecycle: PENDING may become ACCEPTED, REVOKED or EXPIRED; those are final; identity columns never change; nothing is deleted or truncated`, opts, async () => {
    const { db } = await upgraded(engine);
    const mint = async (email: string) => {
      await db.query(invite({ email }));
      return `invitee_email = '${email}'`;
    };
    const one = (w: string) => db.query(`select status from academy_invitation where ${w}`).then((r) => (r[0] as { status: string }).status);

    const accepted = await mint("acc@example.test");
    await db.query(`update academy_invitation set status = 'ACCEPTED', accepted_at = now(), accepted_by_user_id = 'x-1' where ${accepted}`);
    assert.equal(await one(accepted), "ACCEPTED");
    for (const change of [`status = 'PENDING', accepted_at = null, accepted_by_user_id = null`, `status = 'REVOKED', revoked_at = now(), revoked_by_user_id = 'o-1'`, `accepted_by_user_id = 'c-1'`])
      await refuses(db, `update academy_invitation set ${change} where ${accepted}`, /final and cannot change|academy_invitation_state/, `an accepted invitation cannot be changed: ${change.slice(0, 40)}`);

    const revoked = await mint("rev@example.test");
    await db.query(`update academy_invitation set status = 'REVOKED', revoked_at = now(), revoked_by_user_id = 'o-1' where ${revoked}`);
    await refuses(db, `update academy_invitation set status = 'ACCEPTED', accepted_at = now(), accepted_by_user_id = 'x-1' where ${revoked}`, /final and cannot change/, "a revoked invitation can never be accepted (replay protection)");
    await refuses(db, `update academy_invitation set status = 'PENDING', revoked_at = null, revoked_by_user_id = null where ${revoked}`, /final and cannot change/, "a revoked invitation cannot be revived");

    const expired = await mint("exp@example.test");
    await db.query(`update academy_invitation set status = 'EXPIRED' where ${expired}`);
    await refuses(db, `update academy_invitation set status = 'ACCEPTED', accepted_at = now(), accepted_by_user_id = 'x-1' where ${expired}`, /final and cannot change/, "an expired invitation can never be accepted");

    // the state columns must agree with the status
    const open = await mint("state@example.test");
    await refuses(db, `update academy_invitation set status = 'ACCEPTED' where ${open}`, /academy_invitation_state/, "ACCEPTED needs who and when");
    await refuses(db, `update academy_invitation set accepted_at = now() where ${open}`, /academy_invitation_state/, "an acceptance time on a pending invitation");
    await refuses(db, `update academy_invitation set status = 'REVOKED' where ${open}`, /academy_invitation_state/, "REVOKED needs who and when");

    // what an invitation IS cannot be edited while it is pending either
    for (const change of [`role = 'OWNER'`, `invitee_email = 'someone-else@example.test'`, `academy_id = 'a-2'`, `token_hash = 'swapped'`, `invited_by_user_id = 'c-1'`, `expires_at = now() + interval '90 days'`, `kind = 'ADULT_PLAYER', role = 'ADULT_PLAYER'`])
      await refuses(db, `update academy_invitation set ${change} where ${open}`, /cannot be changed/, `an invitation's ${change.split(" ")[0]} is immutable`);
    assert.equal(await one(open), "PENDING");

    await refuses(db, `delete from academy_invitation where ${accepted}`, /never deleted/, "invitations are never deleted");
    await refuses(db, `delete from academy_invitation`, /never deleted/, "not even all of them");
    await refuses(db, `truncate academy_invitation`, /cannot be truncated while it holds invitations/, "nor truncated");
    assert.equal(await count(db), 4);
  });

  test(`[${engine.name}] 0018 rollback rehearsal: the previous schema is restored exactly, nothing else changes, only 0018's record is removed, and 0018 re-applies`, opts, async () => {
    const reference = await engine.fresh();
    await runMigrations({ target: reference.target, folder: folderBefore0018() });
    const { db, before } = await upgraded(engine);
    const records = await db.query(bookkeeping);
    assert.equal(records.at(-1)!.created_at, String(WHEN));
    await db.script(readFileSync(ROLLBACK, "utf8"));
    assert.equal(await schemaState(db), await schemaState(reference), "identical to a database that never had 0018 (tables, constraints, triggers, indexes, functions)");
    assert.equal(await snapshot(db), before, "accounts, memberships and sessions are untouched");
    assert.deepEqual(await db.query(bookkeeping), records.slice(0, -1), "only 0018's record is removed");
    assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0018() })).pending, [TAG], "0018 re-applies");
    assert.equal(await count(db), 0);
  });

  test(`[${engine.name}] 0018 rollback guard: refuses, changing nothing, unless 0018 is applied (reviewed hash), latest, intact, and invitation history is confirmed`, opts, async () => {
    const rollback = readFileSync(ROLLBACK, "utf8");
    const stateOf = async (db: Db) => {
      const rows = (await db.query(`select to_regclass('public.academy_invitation') is not null as has`))[0] as { has: boolean };
      return JSON.stringify([await schemaState(db), await db.query(bookkeeping), await snapshot(db), rows.has ? await db.query(`select to_jsonb(i) as v from academy_invitation i order by 1`) : "no table"]);
    };
    const refusedWith = async (db: Db, pattern: RegExp, name: string, script = rollback) => {
      const before = await stateOf(db);
      await assert.rejects(() => db.script(script), (e: unknown) => pattern.test(String(e)), name);
      assert.equal(await stateOf(db), before, `${name}: nothing changed`);
    };
    {
      const { db } = await upgraded(engine);
      await db.script(rollback);
      const records = await db.query(bookkeeping);
      await refusedWith(db, /0018 rollback refused: migration 0018_academy_invitations is not recorded as applied/, "second run");
      assert.deepEqual(await db.query(bookkeeping), records, "the previous migration's record is never removed");
    }
    {
      const { db } = await upgraded(engine);
      await db.query(`insert into drizzle."__drizzle_migrations" (hash, created_at) values ('a-later-migration', ${WHEN + 1})`);
      await refusedWith(db, /0018 rollback refused: 1 later migration\(s\) are applied after 0018/, "not the latest");
    }
    {
      const { db } = await upgraded(engine);
      await db.query(`update drizzle."__drizzle_migrations" set hash = 'not-the-reviewed-0018' where created_at = ${WHEN}`);
      await refusedWith(db, /not recorded as applied/, "unexpected hash");
    }
    {
      const { db } = await upgraded(engine);
      await db.query(`drop trigger academy_invitation_no_truncate on academy_invitation`);
      await refusedWith(db, /schema does not match migration 0018 \(missing: trigger academy_invitation_no_truncate\)/, "partial schema");
    }
    {
      // real data: invitation history is only destroyed with an explicit, same-session confirmation
      const { db } = await upgraded(engine);
      await db.query(invite());
      await db.query(invite());
      await refusedWith(db, /2 invitation\(s\) exist and would be destroyed/, "invitations exist");
      await refusedWith(db, /would be destroyed/, "a wrong confirmation value", `SET sportozen.rollback_invitations = 'yes';\n${rollback}`);
      await db.script(`SET sportozen.rollback_invitations = 'destroy';\n${rollback}`);
      assert.deepEqual(await db.query(`select to_regclass('public.academy_invitation') is not null as has`), [{ has: false }], "rolled back after the explicit confirmation");
    }
  });
}

test("0018's rollback is pinned to the reviewed migration file and kept outside the folder the runner applies", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, `${TAG}.sql`));
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const rollback = readFileSync(ROLLBACK, "utf8");
  assert.ok(!sql.includes("\r\n"), "the migration is stored with LF line endings");
  assert.ok(rollback.includes(hash(sql)), "the rollback names the hash of the current 0018 file");
  assert.ok(rollback.includes(hash(Buffer.from(sql.toString("utf8").replace(/\n/g, "\r\n")))), "and of its CRLF checkout");
  assert.ok(rollback.includes(String(WHEN)));
  assert.ok(ROLLBACK.replace(/\\/g, "/").includes("/migrations-rollback/"));
  const text = sql.toString("utf8");
  assert.ok(!/insert\s+into|update\s+"?(membership|app_user|auth_session|player)|delete\s+from/i.test(text), "0018 changes no data");
  assert.ok(!/DROP\s/i.test(text), "0018 drops nothing");
});
