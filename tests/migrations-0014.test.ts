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
 * RC-4, migration 0014_adult_guardian_access: purely additive (no existing row changes, nobody is granted anything),
 * the grant table's constraints, the append-only history, and the guarded rollback.
 * Every scenario runs on embedded PGlite (always) and on a real PostgreSQL server (when TEST_POSTGRES_ADMIN_URL is
 * set - `npm run test:pg` starts a disposable container). The engine scaffolding mirrors tests/migrations-0013.test.ts.
 */
const TAG = "0014_adult_guardian_access";
const WHEN = 1794381959210;
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
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0014-template-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new PGlite(join(dir, "db"));
    await client.query("select 1");
    await client.close();
    return dir;
  })());
const pgliteEngine: Engine = {
  name: "PGlite",
  async fresh() {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0014-"));
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
/** A copy of the migrations folder without 0014 (the chain up to and including 0013). */
let folderBefore0014Dir: string | undefined;
function folderBefore0014() {
  // One copy per test process: callers only read it (copying the folder on every call slowed this file 2-3x).
  if (folderBefore0014Dir) return folderBefore0014Dir;
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0014-folder-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG);
  assert.ok(at > 0, "0014 is in the journal");
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  folderBefore0014Dir = dir;
  return dir;
}
/** A copy of the migrations folder up to and including 0014 so 0014 rollback tests isolate 0014 as latest. */
let folderThrough0014Dir: string | undefined;
function folderThrough0014() {
  if (folderThrough0014Dir) return folderThrough0014Dir;
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0014-through-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG) + 1;
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  folderThrough0014Dir = dir;
  return dir;
}
/**
 * One academy with an owner, a guardian and an adult-player account; a minor (p-minor) and an ADULT (p-adult), each
 * with an active guardian link carrying consent flags, plus one consent history row: the data 0014 must not touch.
 */
const seed = [
  `insert into academy (id, name, timezone) values ('a-1', 'One', 'UTC')`,
  ...["o-1", "g-1", "ad-1"].map((id) => `insert into app_user (id, name, email) values ('${id}', '${id}', '${id}@example.test')`),
  `insert into membership (user_id, academy_id, role) values ('o-1', 'a-1', 'OWNER'), ('g-1', 'a-1', 'GUARDIAN'), ('ad-1', 'a-1', 'ADULT_PLAYER')`,
  `insert into branch (id, academy_id, name) values ('br-1', 'a-1', 'Branch')`,
  `insert into batch (id, academy_id, name, branch_id, coach_id) values ('b-1', 'a-1', 'Batch', 'br-1', 'o-1')`,
  `insert into player (id, academy_id, name, batch_id) values ('p-minor', 'a-1', 'Minor', 'b-1'), ('p-adult', 'a-1', 'Adult', 'b-1')`,
  `insert into player_profile (academy_id, player_id, data) values
     ('a-1', 'p-minor', '{"adult": false, "selfUserId": null}'),
     ('a-1', 'p-adult', '{"adult": true, "selfUserId": "ad-1"}')`,
  `insert into guardian_link (academy_id, player_id, user_id, relationship, consent) values
     ('a-1', 'p-minor', 'g-1', 'Mother', '{"portal": true, "email": true, "whatsapp": false}'),
     ('a-1', 'p-adult', 'g-1', 'Mother', '{"portal": true, "email": false, "whatsapp": false}')`,
];
const existingRows = `
  select 'link' k, to_jsonb(l)::text v from guardian_link l
  union all select 'profile', to_jsonb(p)::text from player_profile p
  union all select 'member', to_jsonb(m)::text from membership m
  union all select 'consent', to_jsonb(c)::text from consent_event c
  order by 1, 2`;
const fingerprintSql = `
  select c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
  from information_schema.columns c where c.table_schema='public' order by 1,2`;
const constraintSql = `
  select conrelid::regclass::text as tbl, conname, contype, pg_get_constraintdef(oid) as def
  from pg_constraint where connamespace = 'public'::regnamespace and contype <> 'n' order by 1,2`;
const triggerSql = `
  select tgrelid::regclass::text as tbl, tgname, pg_get_triggerdef(oid) as def
  from pg_trigger where not tgisinternal order by 1,2`;
const functionSql = `select proname from pg_proc p where pronamespace = 'public'::regnamespace order by 1`;
const indexSql = `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1,2`;
const bookkeeping = `select hash, created_at::text as created_at from drizzle."__drizzle_migrations" order by created_at`;
const schemaState = async (db: Db) =>
  JSON.stringify([
    await db.query(fingerprintSql),
    await db.query(constraintSql),
    await db.query(triggerSql),
    await db.query(functionSql),
    await db.query(indexSql),
  ]);
/** A database at 0013 holding the seed, then upgraded to 0014. */
async function upgraded(engine: Engine) {
  const db = await engine.fresh();
  await runMigrations({ target: db.target, folder: folderBefore0014() });
  for (const statement of seed) await db.query(statement);
  const before = JSON.stringify(await db.query(existingRows));
  const report = await runMigrations({ target: db.target, folder: folderThrough0014() });
  assert.deepEqual(report.pending, [TAG]);
  return { db, before };
}
const grantSql = (scopes: string, extra = "") =>
  `insert into guardian_access_grant (academy_id, player_id, guardian_user_id, scopes, granted_by) values ('a-1', 'p-adult', 'g-1', '${scopes}', 'ad-1') ${extra}`;
const eventSql = (event: string) =>
  `insert into guardian_access_event (academy_id, player_id, guardian_user_id, event, actor_id, actor_role) values ('a-1', 'p-adult', 'g-1', '${event}', 'ad-1', 'ADULT_PLAYER')`;

for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};

  test(`[${engine.name}] 0014 is additive: no existing row changes and NOBODY is granted anything (no back-fill)`, opts, async () => {
    const { db, before } = await upgraded(engine);
    assert.equal(JSON.stringify(await db.query(existingRows)), before, "links, consent, profiles and memberships are untouched");
    assert.deepEqual(await db.query(`select count(*)::int as n from guardian_access_grant`), [{ n: 0 }], "no grant for the existing adult's guardian");
    assert.deepEqual(await db.query(`select count(*)::int as n from guardian_access_event`), [{ n: 0 }]);
    assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0014() })).pending, [], "re-running is a no-op");
    // Owner decision: grants never expire. Exactly these columns; none is an expiry.
    assert.deepEqual(
      (await db.query(`select column_name from information_schema.columns where table_name = 'guardian_access_grant' order by 1`)).map((r) => r.column_name),
      ["academy_id", "granted_at", "granted_by", "guardian_user_id", "player_id", "revoked_at", "scopes", "version"],
    );
    assert.deepEqual(
      (await db.query(`select column_name from information_schema.columns where table_name = 'guardian_access_event' order by 1`)).map((r) => r.column_name),
      ["academy_id", "actor_id", "actor_role", "at", "event", "guardian_user_id", "id", "player_id", "reason", "scopes"],
    );
  });

  test(`[${engine.name}] 0014 grant table: one row per player and guardian, tied to the guardian link, scopes must be an array`, opts, async () => {
    const { db } = await upgraded(engine);
    await db.query(grantSql('["FEES"]'));
    await assert.rejects(() => db.query(grantSql('["MEDIA"]')), /guardian_access_grant/, "a second row for the same pair");
    for (const bad of ['"FEES"', '{"FEES": true}', "null", "1"])
      await assert.rejects(
        () => db.query(`update guardian_access_grant set scopes = '${bad}'`),
        /guardian_access_grant_scopes_check|null value/,
        `scopes ${bad}`,
      );
    // No grant without the guardian link it belongs to (unknown guardian, unknown player, another academy).
    for (const [player, guardian] of [["p-adult", "o-1"], ["p-none", "g-1"]])
      await assert.rejects(
        () => db.query(`insert into guardian_access_grant (academy_id, player_id, guardian_user_id, scopes, granted_by) values ('a-1', '${player}', '${guardian}', '[]', 'ad-1')`),
        /guardian_access_grant_link_fkey/,
      );
    // Removing the link removes the grant with it (the history below is independent and stays).
    await db.query(eventSql("GRANTED"));
    await db.query(`delete from guardian_link where player_id = 'p-adult' and user_id = 'g-1'`);
    assert.deepEqual(await db.query(`select count(*)::int as n from guardian_access_grant`), [{ n: 0 }]);
    assert.deepEqual(await db.query(`select count(*)::int as n from guardian_access_event`), [{ n: 1 }]);
  });

  test(`[${engine.name}] 0014 history: only the six known events, and no UPDATE, DELETE or TRUNCATE`, opts, async () => {
    const { db } = await upgraded(engine);
    for (const event of ["ACCESS_ENDED_ADULTHOOD", "GRANTED", "SCOPES_CHANGED", "REVOKED", "ENDED_LINK_INACTIVE", "ENDED_ADULT_FLAG_CLEARED"])
      await db.query(eventSql(event));
    for (const event of ["CONSENT_GRANTED", "granted", "", "PROXY_GRANTED"])
      await assert.rejects(() => db.query(eventSql(event)), /guardian_access_event_type_check/, `event '${event}'`);
    await assert.rejects(() => db.query(`update guardian_access_event set event = 'REVOKED'`), /append-only: UPDATE/);
    await assert.rejects(() => db.query(`delete from guardian_access_event`), /append-only: DELETE/);
    await assert.rejects(() => db.query(`truncate guardian_access_event`), /append-only: TRUNCATE/);
    assert.deepEqual(await db.query(`select count(*)::int as n from guardian_access_event`), [{ n: 6 }]);
  });

  test(`[${engine.name}] 0014 rollback rehearsal: the 0013 schema is restored exactly, no other row changes, only 0014's record is removed, and 0014 re-applies`, opts, async () => {
    const reference = await engine.fresh();
    await runMigrations({ target: reference.target, folder: folderBefore0014() });
    const { db, before } = await upgraded(engine);
    await db.query(grantSql('["FEES", "MEDIA"]'));
    await db.query(eventSql("GRANTED"));
    const records = await db.query(bookkeeping);
    assert.equal(records.at(-1)!.created_at, String(WHEN));
    await db.script(readFileSync(ROLLBACK, "utf8"));
    assert.equal(await schemaState(db), await schemaState(reference), "identical to a database that never had 0014");
    assert.equal(JSON.stringify(await db.query(existingRows)), before, "links, consent, profiles and memberships are untouched");
    assert.deepEqual(await db.query(bookkeeping), records.slice(0, -1), "only 0014's record is removed");
    assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0014() })).pending, [TAG], "0014 re-applies");
    assert.deepEqual(await db.query(`select count(*)::int as n from guardian_access_grant`), [{ n: 0 }], "re-applied empty: no grant survives a rollback");
  });

  test(`[${engine.name}] 0014 rollback guard: refuses, changing nothing, unless 0014 is applied (with the reviewed hash), latest and intact`, opts, async () => {
    const rollback = readFileSync(ROLLBACK, "utf8");
    const stateOf = async (db: Db) => JSON.stringify([await schemaState(db), await db.query(bookkeeping), await db.query(existingRows)]);
    const refusedWith = async (db: Db, pattern: RegExp, name: string) => {
      const before = await stateOf(db);
      await assert.rejects(() => db.script(rollback), (e: unknown) => pattern.test(String(e)), name);
      assert.equal(await stateOf(db), before, `${name}: nothing changed`);
    };
    // 1. Applied: rolled back once; a second run is refused and cannot remove 0013's record.
    {
      const { db } = await upgraded(engine);
      await db.script(rollback);
      const records = await db.query(bookkeeping);
      await refusedWith(db, /0014 rollback refused: migration 0014_adult_guardian_access is not recorded as applied/, "second run");
      assert.deepEqual(await db.query(bookkeeping), records, "0013's record is never removed");
    }
    // 2. Not the latest applied migration: refused.
    {
      const { db } = await upgraded(engine);
      await db.query(`insert into drizzle."__drizzle_migrations" (hash, created_at) values ('a-later-migration', ${WHEN + 1})`);
      await refusedWith(db, /0014 rollback refused: 1 later migration\(s\) are applied after 0014/, "not the latest");
    }
    // 3. Recorded with another hash: refused.
    {
      const { db } = await upgraded(engine);
      await db.query(`update drizzle."__drizzle_migrations" set hash = 'not-the-reviewed-0014' where created_at = ${WHEN}`);
      await refusedWith(db, /not recorded as applied/, "unexpected hash");
    }
    // 4. An 0014 object missing: refused before any DROP runs, naming what is missing.
    {
      const { db } = await upgraded(engine);
      await db.query(`drop trigger guardian_access_event_no_trunc on guardian_access_event`);
      await refusedWith(db, /schema does not match migration 0014 \(missing: trigger guardian_access_event_no_trunc\)/, "partial schema");
    }
  });
}

test("0014's rollback is pinned to the reviewed migration file and kept outside the folder the runner applies", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, `${TAG}.sql`));
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const rollback = readFileSync(ROLLBACK, "utf8");
  assert.ok(!sql.includes("\r\n"), "the migration is stored with LF line endings");
  assert.ok(rollback.includes(hash(sql)), "the rollback names the hash of the current 0014 file");
  assert.ok(rollback.includes(hash(Buffer.from(sql.toString("utf8").replace(/\n/g, "\r\n")))), "and of its CRLF checkout");
  assert.ok(rollback.includes(String(WHEN)));
  assert.ok(ROLLBACK.replace(/\\/g, "/").includes("/migrations-rollback/"));
  // The migration creates no grant and names no consent scope.
  assert.ok(!/insert\s+into/i.test(sql.toString("utf8")), "0014 inserts nothing");
});
