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
 * Migration 0017_multi_academy_session: auth_session_academy (which academy a session is working in), membership.display_name
 * (an academy's own name for a person) and the unique (id, user_id) on auth_session that the first one's foreign key needs.
 * Purely additive: no existing row changes, nobody is given a selection or a display name. The guarded rollback drops
 * them again and refuses to destroy display names without an explicit confirmation. Every scenario runs on embedded
 * PGlite (always) and on a real PostgreSQL server (when TEST_POSTGRES_ADMIN_URL is set - `npm run test:pg`).
 */
const TAG = "0017_multi_academy_session";
const WHEN = 1794508151765;
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
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0017-template-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new PGlite(join(dir, "db"));
    await client.query("select 1");
    await client.close();
    return dir;
  })());
const pgliteEngine: Engine = {
  name: "PGlite",
  async fresh() {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0017-"));
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

/** A copy of the migrations folder cut before 0017 (the whole chain that precedes it); one copy per test process. */
let before0017Dir: string | undefined;
function folderBefore0017() {
  if (before0017Dir) return before0017Dir;
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0017-folder-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG);
  assert.ok(at > 0, "0017 is in the journal");
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  before0017Dir = dir;
  return dir;
}
/** A copy of the migrations folder up to and including 0017, so these tests keep 0017 as the latest migration when later ones exist. */
let through0017Dir: string | undefined;
function folderThrough0017() {
  if (through0017Dir) return through0017Dir;
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0017-through-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG) + 1;
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  through0017Dir = dir;
  return dir;
}
const seed = [
  `insert into academy (id, name, timezone) values ('a-1', 'One', 'UTC'), ('a-2', 'Two', 'UTC')`,
  ...["o-1", "m-1", "x-1"].map((id) => `insert into app_user (id, name, email) values ('${id}', '${id}', '${id}@example.test')`),
  // o-1 owns a-1 and a-2; m-1 is a coach in a-1 AND a guardian in a-2; x-1 belongs to nothing.
  `insert into membership (user_id, academy_id, role) values ('o-1', 'a-1', 'OWNER'), ('o-1', 'a-2', 'OWNER'), ('m-1', 'a-1', 'COACH'), ('m-1', 'a-2', 'GUARDIAN')`,
  `insert into auth_session (id, expires_at, token, user_id) values ('s-m1', now() + interval '1 day', 't-m1', 'm-1'), ('s-o1', now() + interval '1 day', 't-o1', 'o-1')`,
];
// Every column of every membership except the new one: these rows must be identical before and after 0017.
const accounts = `select to_jsonb(u) as v from app_user u order by u.id`;
const memberships = `select to_jsonb(m) - 'display_name' as v from membership m order by 1`;
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
      ].map((q) => db.query(q)),
    ),
  );
const snapshot = async (db: Db) => JSON.stringify([await db.query(accounts), await db.query(memberships), await db.query(sessions)]);
/** A database at the migration before 0017 holding the seed, then upgraded to 0017. */
async function upgraded(engine: Engine) {
  const db = await engine.fresh();
  await runMigrations({ target: db.target, folder: folderBefore0017() });
  for (const statement of seed) await db.query(statement);
  const before = await snapshot(db);
  const report = await runMigrations({ target: db.target, folder: folderThrough0017() });
  assert.deepEqual(report.pending, [TAG]);
  return { db, before };
}
const refuses = (db: Db, sql: string, pattern: RegExp, why: string) =>
  assert.rejects(() => db.query(sql), (e: unknown) => pattern.test(String(e)), why);

for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(`[${engine.name}] 0017 is additive: no account, membership or session changes; NOBODY gets a selection or a display name; re-running is a no-op`, opts, async () => {
    const { db, before } = await upgraded(engine);
    assert.equal(await snapshot(db), before, "accounts, memberships and sessions are untouched");
    assert.deepEqual(await db.query(`select count(*)::int as n from auth_session_academy`), [{ n: 0 }], "no selection is invented, even for a person with two academies");
    assert.deepEqual(await db.query(`select count(*)::int as n from membership where display_name is not null`), [{ n: 0 }], "no display name is back-filled");
    assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0017() })).pending, [], "re-running is a no-op");
  });

  test(`[${engine.name}] 0017 selection integrity: only a membership of the session's OWN user can be chosen, and it goes with the session`, opts, async () => {
    const { db } = await upgraded(engine);
    const pick = (session: string, user: string, academy: string) =>
      `insert into auth_session_academy (session_id, user_id, academy_id) values ('${session}', '${user}', '${academy}')`;
    await db.query(pick("s-m1", "m-1", "a-2"));
    await refuses(db, pick("s-m1", "m-1", "a-1"), /duplicate key|23505/, "one selection per session");
    await refuses(db, pick("s-o1", "o-1", "a-9"), /foreign key|23503/, "an academy that does not exist");
    await refuses(db, pick("s-o1", "x-1", "a-1"), /foreign key|23503/, "a person with no membership there (and not the session's user)");
    await refuses(db, pick("s-o1", "m-1", "a-1"), /foreign key|23503/, "another person's session cannot carry this person's membership");
    // a selection follows its session: signing out removes it, nothing else
    assert.deepEqual(await db.query(`select count(*)::int as n from auth_session_academy`), [{ n: 1 }]);
    await db.query(`delete from auth_session where id = 's-m1'`);
    assert.deepEqual(await db.query(`select count(*)::int as n from auth_session_academy`), [{ n: 0 }], "the selection went with its session");
    assert.deepEqual(await db.query(`select count(*)::int as n from membership where user_id = 'm-1'`), [{ n: 2 }], "memberships are untouched");
    // deleting a user's sessions (password change, deactivation of the last academy) clears every selection of theirs
    await db.query(pick("s-o1", "o-1", "a-1"));
    await db.query(`delete from auth_session where user_id = 'o-1'`);
    assert.deepEqual(await db.query(`select count(*)::int as n from auth_session_academy`), [{ n: 0 }]);
  });

  test(`[${engine.name}] 0017 display name: NULL (use the person's own name) or 1 to 120 characters; never blank or longer`, opts, async () => {
    const { db } = await upgraded(engine);
    await db.query(`update membership set display_name = 'Coach Priya' where user_id = 'm-1' and academy_id = 'a-1'`);
    await db.query(`update membership set display_name = '${"x".repeat(120)}' where user_id = 'm-1' and academy_id = 'a-2'`);
    await db.query(`update membership set display_name = null where user_id = 'm-1' and academy_id = 'a-2'`);
    for (const bad of ["''", `'${"x".repeat(121)}'`])
      await refuses(db, `update membership set display_name = ${bad} where user_id = 'm-1' and academy_id = 'a-2'`, /membership_display_name_length|23514/, `${bad.slice(0, 12)} refused`);
    // the person's own name and the other academy's display name are independent of it
    assert.deepEqual(await db.query(`select name from app_user where id = 'm-1'`), [{ name: "m-1" }]);
    assert.deepEqual(await db.query(`select display_name from membership where user_id = 'm-1' and academy_id = 'a-2'`), [{ display_name: null }]);
  });

  test(`[${engine.name}] 0017 rollback rehearsal: the previous schema is restored exactly, nothing else changes, only 0017's record is removed, and 0017 re-applies`, opts, async () => {
    const reference = await engine.fresh();
    await runMigrations({ target: reference.target, folder: folderBefore0017() });
    const { db, before } = await upgraded(engine);
    await db.query(`insert into auth_session_academy (session_id, user_id, academy_id) values ('s-m1', 'm-1', 'a-2')`);
    const records = await db.query(bookkeeping);
    assert.equal(records.at(-1)!.created_at, String(WHEN));
    await db.script(readFileSync(ROLLBACK, "utf8"));
    assert.equal(await schemaState(db), await schemaState(reference), "identical to a database that never had 0017");
    assert.equal(await snapshot(db), before, "accounts, memberships and sessions are untouched (selection rows are gone with their table)");
    assert.deepEqual(await db.query(bookkeeping), records.slice(0, -1), "only 0017's record is removed");
    assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0017() })).pending, [TAG], "0017 re-applies");
    assert.deepEqual(await db.query(`select count(*)::int as n from auth_session_academy`), [{ n: 0 }]);
  });

  test(`[${engine.name}] 0017 rollback guard: refuses, changing nothing, unless 0017 is applied (reviewed hash), latest, intact, and display names are confirmed`, opts, async () => {
    const rollback = readFileSync(ROLLBACK, "utf8");
    const stateOf = async (db: Db) =>
      JSON.stringify([await schemaState(db), await db.query(bookkeeping), await snapshot(db), await db.query(`select to_jsonb(m) as v from membership m order by 1`)]);
    const refusedWith = async (db: Db, pattern: RegExp, name: string, script = rollback) => {
      const before = await stateOf(db);
      await assert.rejects(() => db.script(script), (e: unknown) => pattern.test(String(e)), name);
      assert.equal(await stateOf(db), before, `${name}: nothing changed`);
    };
    {
      const { db } = await upgraded(engine);
      await db.script(rollback);
      const records = await db.query(bookkeeping);
      await refusedWith(db, /0017 rollback refused: migration 0017_multi_academy_session is not recorded as applied/, "second run");
      assert.deepEqual(await db.query(bookkeeping), records, "the previous migration's record is never removed");
    }
    {
      const { db } = await upgraded(engine);
      await db.query(`insert into drizzle."__drizzle_migrations" (hash, created_at) values ('a-later-migration', ${WHEN + 1})`);
      await refusedWith(db, /0017 rollback refused: 1 later migration\(s\) are applied after 0017/, "not the latest");
    }
    {
      const { db } = await upgraded(engine);
      await db.query(`update drizzle."__drizzle_migrations" set hash = 'not-the-reviewed-0017' where created_at = ${WHEN}`);
      await refusedWith(db, /not recorded as applied/, "unexpected hash");
    }
    {
      const { db } = await upgraded(engine);
      await db.query(`alter table membership drop constraint membership_display_name_length`);
      await refusedWith(db, /schema does not match migration 0017 \(missing: constraint membership_display_name_length\)/, "partial schema");
    }
    {
      // real data: display names are only destroyed with an explicit, same-session confirmation
      const { db } = await upgraded(engine);
      await db.query(`update membership set display_name = 'Coach Priya' where user_id = 'm-1' and academy_id = 'a-1'`);
      await refusedWith(db, /1 academy display name\(s\) exist and would be destroyed/, "display names exist");
      await refusedWith(db, /would be destroyed/, "a wrong confirmation value", `SET sportozen.rollback_display_names = 'yes';\n${rollback}`);
      await db.script(`SET sportozen.rollback_display_names = 'destroy';\n${rollback}`);
      assert.deepEqual(
        await db.query(`select count(*)::int as n from information_schema.columns where table_name = 'membership' and column_name = 'display_name'`),
        [{ n: 0 }],
        "rolled back after the explicit confirmation",
      );
    }
  });
}

test("0017's rollback is pinned to the reviewed migration file and kept outside the folder the runner applies", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, `${TAG}.sql`));
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const rollback = readFileSync(ROLLBACK, "utf8");
  assert.ok(!sql.includes("\r\n"), "the migration is stored with LF line endings");
  assert.ok(rollback.includes(hash(sql)), "the rollback names the hash of the current 0017 file");
  assert.ok(rollback.includes(hash(Buffer.from(sql.toString("utf8").replace(/\n/g, "\r\n")))), "and of its CRLF checkout");
  assert.ok(rollback.includes(String(WHEN)));
  assert.ok(ROLLBACK.replace(/\\/g, "/").includes("/migrations-rollback/"));
  const text = sql.toString("utf8");
  assert.ok(!/insert\s+into|update\s+"?(membership|app_user|auth_session)|delete\s+from/i.test(text), "0017 changes no data");
  assert.ok(!/DROP\s/i.test(text), "0017 drops nothing");
});
