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
 * Migration 0016_guardian_phone: adds app_user.phone (a person's own registered WhatsApp number, E.164 or NULL) with a CHECK.
 * Purely additive: no existing row changes and NOBODY is given a number. The guarded rollback drops the column and the
 * constraint. Every scenario runs on embedded PGlite (always) and on a real PostgreSQL server (when TEST_POSTGRES_ADMIN_URL
 * is set - `npm run test:pg` starts a disposable container). The scaffolding mirrors tests/migrations-0014.test.ts.
 */
const TAG = "0016_guardian_phone";
const WHEN = 1794493950734;
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
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0016-template-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new PGlite(join(dir, "db"));
    await client.query("select 1");
    await client.close();
    return dir;
  })());
const pgliteEngine: Engine = {
  name: "PGlite",
  async fresh() {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0016-"));
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

/** A copy of the migrations folder cut before 0016 (the whole chain that precedes it); one copy per test process. */
let before0016Dir: string | undefined;
function folderBefore0016() {
  if (before0016Dir) return before0016Dir;
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0016-folder-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG);
  assert.ok(at > 0, "0016 is in the journal");
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  before0016Dir = dir;
  return dir;
}
/** A copy of the migrations folder up to and including 0016, so these tests keep 0016 as the latest migration when later ones exist. */
let through0016Dir: string | undefined;
function folderThrough0016() {
  if (through0016Dir) return through0016Dir;
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0016-through-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG) + 1;
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  through0016Dir = dir;
  return dir;
}
const seed = [
  `insert into academy (id, name, timezone) values ('a-1', 'One', 'UTC')`,
  ...["o-1", "g-1", "g-2"].map((id) => `insert into app_user (id, name, email) values ('${id}', '${id}', '${id}@example.test')`),
  `insert into membership (user_id, academy_id, role) values ('o-1', 'a-1', 'OWNER'), ('g-1', 'a-1', 'GUARDIAN'), ('g-2', 'a-1', 'GUARDIAN')`,
];
// Every column of every account except the new one: these rows must be identical before and after 0016.
const accounts = `select to_jsonb(u) - 'phone' as v from app_user u order by u.id`;
const memberships = `select to_jsonb(m) as v from membership m order by 1`;
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
/** A database at the migration before 0016 holding the seed, then upgraded to 0016. */
async function upgraded(engine: Engine) {
  const db = await engine.fresh();
  await runMigrations({ target: db.target, folder: folderBefore0016() });
  for (const statement of seed) await db.query(statement);
  const before = JSON.stringify([await db.query(accounts), await db.query(memberships)]);
  const report = await runMigrations({ target: db.target, folder: folderThrough0016() });
  assert.deepEqual(report.pending, [TAG]);
  return { db, before };
}

for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(`[${engine.name}] 0016 is additive: no existing row changes and NOBODY is given a number; re-running is a no-op`, opts, async () => {
    const { db, before } = await upgraded(engine);
    assert.equal(JSON.stringify([await db.query(accounts), await db.query(memberships)]), before, "accounts and memberships are untouched");
    assert.deepEqual(await db.query(`select count(*)::int as n from app_user where phone is not null`), [{ n: 0 }], "no number is invented or back-filled");
    assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0016() })).pending, [], "re-running is a no-op");
  });

  test(`[${engine.name}] 0016 CHECK: only E.164 (+, 8 to 15 digits, no leading 0) or NULL can be stored`, opts, async () => {
    const { db } = await upgraded(engine);
    for (const ok of ["+919876543210", "+14155552671", "+4477009001", "+12345678", "+123456789012345"])
      await db.query(`update app_user set phone = '${ok}' where id = 'g-1'`);
    await db.query(`update app_user set phone = null where id = 'g-1'`);
    for (const bad of ["9876543210", "919876543210", "+91 98765 43210", "+0123456789", "+1234567", "+1234567890123456", "+91-9876543210", "abc", "", " +919876543210"]) {
      await assert.rejects(
        () => db.query(`update app_user set phone = '${bad}' where id = 'g-1'`),
        (e: unknown) => sqlState(e) === "23514" || /app_user_phone_e164_check/.test(String(e)),
        `${JSON.stringify(bad)} must be rejected`,
      );
    }
    await assert.rejects(() => db.query(`insert into app_user (id, name, email, phone) values ('x-1', 'x', 'x@example.test', '12345')`), /./, "insert is checked too");
    assert.deepEqual(await db.query(`select count(*)::int as n from app_user where phone is not null`), [{ n: 0 }]);
  });

  test(`[${engine.name}] 0016 rollback rehearsal: the previous schema is restored exactly, accounts are untouched, only 0016's record is removed, and 0016 re-applies`, opts, async () => {
    const reference = await engine.fresh();
    await runMigrations({ target: reference.target, folder: folderBefore0016() });
    const { db, before } = await upgraded(engine);
    await db.query(`update app_user set phone = '+919876543210' where id = 'g-1'`);
    const records = await db.query(bookkeeping);
    assert.equal(records.at(-1)!.created_at, String(WHEN));
    await db.script(readFileSync(ROLLBACK, "utf8"));
    assert.equal(await schemaState(db), await schemaState(reference), "identical to a database that never had 0016");
    assert.equal(JSON.stringify([await db.query(accounts), await db.query(memberships)]), before, "accounts and memberships are untouched");
    assert.deepEqual(await db.query(bookkeeping), records.slice(0, -1), "only 0016's record is removed");
    assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0016() })).pending, [TAG], "0016 re-applies");
    assert.deepEqual(await db.query(`select count(*)::int as n from app_user where phone is not null`), [{ n: 0 }], "re-applied empty: the numbers were destroyed by the rollback, as documented");
  });

  test(`[${engine.name}] 0016 rollback guard: refuses, changing nothing, unless 0016 is applied (with the reviewed hash), latest and intact`, opts, async () => {
    const rollback = readFileSync(ROLLBACK, "utf8");
    const stateOf = async (db: Db) => JSON.stringify([await schemaState(db), await db.query(bookkeeping), await db.query(accounts)]);
    const refusedWith = async (db: Db, pattern: RegExp, name: string) => {
      const before = await stateOf(db);
      await assert.rejects(() => db.script(rollback), (e: unknown) => pattern.test(String(e)), name);
      assert.equal(await stateOf(db), before, `${name}: nothing changed`);
    };
    {
      const { db } = await upgraded(engine);
      await db.script(rollback);
      const records = await db.query(bookkeeping);
      await refusedWith(db, /0016 rollback refused: migration 0016_guardian_phone is not recorded as applied/, "second run");
      assert.deepEqual(await db.query(bookkeeping), records, "the previous migration's record is never removed");
    }
    {
      const { db } = await upgraded(engine);
      await db.query(`insert into drizzle."__drizzle_migrations" (hash, created_at) values ('a-later-migration', ${WHEN + 1})`);
      await refusedWith(db, /0016 rollback refused: 1 later migration\(s\) are applied after 0016/, "not the latest");
    }
    {
      const { db } = await upgraded(engine);
      await db.query(`update drizzle."__drizzle_migrations" set hash = 'not-the-reviewed-0016' where created_at = ${WHEN}`);
      await refusedWith(db, /not recorded as applied/, "unexpected hash");
    }
    {
      const { db } = await upgraded(engine);
      await db.query(`alter table app_user drop constraint app_user_phone_e164_check`);
      await refusedWith(db, /schema does not match migration 0016 \(missing: constraint app_user_phone_e164_check\)/, "partial schema");
    }
  });
}

test("0016's rollback is pinned to the reviewed migration file and kept outside the folder the runner applies", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, `${TAG}.sql`));
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const rollback = readFileSync(ROLLBACK, "utf8");
  assert.ok(!sql.includes("\r\n"), "the migration is stored with LF line endings");
  assert.ok(rollback.includes(hash(sql)), "the rollback names the hash of the current 0016 file");
  assert.ok(rollback.includes(hash(Buffer.from(sql.toString("utf8").replace(/\n/g, "\r\n")))), "and of its CRLF checkout");
  assert.ok(rollback.includes(String(WHEN)));
  assert.ok(ROLLBACK.replace(/\\/g, "/").includes("/migrations-rollback/"));
  assert.ok(!/insert\s+into|update\s+"?app_user/i.test(sql.toString("utf8")), "0016 changes no data");
});
