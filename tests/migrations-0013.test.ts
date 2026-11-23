import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";
import { runMigrations, type MigrationTarget } from "../src/infrastructure/database/migrations";
import { STORED_ROLES } from "../src/modules/identity/authority";
import { adminUrl, createPostgresDatabase } from "./helpers/test-database";
import { HOOK_TIMEOUT, MIGRATIONS_DIR, REPO_ROOT } from "./helpers/paths";
/**
 * AT-11 (RC-3, migration 0013_role_validation_owner_presence): the membership_role_known CHECK constraint, the deferred
 * membership_owner_presence constraint trigger, both pre-flights, and the guarded rollback.
 * Every scenario runs on embedded PGlite (always) and on a real PostgreSQL server (when TEST_POSTGRES_ADMIN_URL is
 * set — `npm run test:pg` starts a disposable container).
 */
const TAG = "0013_role_validation_owner_presence";
const WHEN = 1794379117705;
const ROLLBACK = join(REPO_ROOT, "migrations-rollback", `${TAG}.down.sql`);
const OWNER_REQUIRED = /OWNER_REQUIRED: Academy a-1 must retain at least one active owner/;
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
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0013-template-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new PGlite(join(dir, "db"));
    await client.query("select 1");
    await client.close();
    return dir;
  })());
const pgliteEngine: Engine = {
  name: "PGlite",
  async fresh() {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0013-"));
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
/** A copy of the migrations folder without 0013 (the chain up to and including 0012). */
function folderBefore0013() {
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0013-folder-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG);
  assert.ok(at > 0, "0013 is in the journal");
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  return dir;
}
/**
 * RC-4 added migration 0014. These tests are about 0013 being the LATEST applied migration (its rollback guard
 * refuses otherwise), so they apply the chain up to and including 0013; the assertions themselves are unchanged.
 */
let folderThrough0013Dir: string | undefined;
function folderThrough0013() {
  // One copy per test process: callers only read it (copying the folder on every call slowed this file 2-3x).
  if (folderThrough0013Dir) return folderThrough0013Dir;
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0013-through-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG) + 1;
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  folderThrough0013Dir = dir;
  return dir;
}
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const person = (id: string) => `insert into app_user (id, name, email) values (${lit(id)}, ${lit(id)}, ${lit(`${id}@example.test`)})`;
const member = (user: string, academy: string, role: string, active = true) =>
  `insert into membership (user_id, academy_id, role, active) values (${lit(user)}, ${lit(academy)}, ${lit(role)}, ${active})`;
/**
 * a-1: one active owner (o-1), an inactive former owner (o-old) and staff; a-2: two active owners; a-3: no members.
 */
const seed = [
  `insert into academy (id, name, timezone) values ('a-1', 'One', 'UTC'), ('a-2', 'Two', 'UTC'), ('a-3', 'Empty', 'UTC')`,
  ...["o-1", "o-old", "s-1", "s-2", "o-2a", "o-2b"].map(person),
  member("o-1", "a-1", "OWNER"),
  member("o-old", "a-1", "OWNER", false),
  member("s-1", "a-1", "ADMIN"),
  member("s-2", "a-1", "COACH"),
  member("o-2a", "a-2", "OWNER"),
  member("o-2b", "a-2", "OWNER"),
];
const memberships = `select academy_id, user_id, role, active from membership order by academy_id, user_id`;
const fingerprintSql = `
  select c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
  from information_schema.columns c where c.table_schema='public' order by 1,2`;
const constraintSql = `
  select conrelid::regclass::text as tbl, conname, contype, pg_get_constraintdef(oid) as def, condeferrable, condeferred
  from pg_constraint where connamespace = 'public'::regnamespace and contype <> 'n' order by 1,2`;
const triggerSql = `
  select tgrelid::regclass::text as tbl, tgname, pg_get_triggerdef(oid) as def
  from pg_trigger where not tgisinternal order by 1,2`;
const functionSql = `
  select proname, pg_get_functiondef(p.oid) as def
  from pg_proc p where pronamespace = 'public'::regnamespace order by 1`;
const bookkeeping = `select hash, created_at::text as created_at from drizzle."__drizzle_migrations" order by created_at`;
const schemaState = async (db: Db) =>
  JSON.stringify([
    await db.query(fingerprintSql),
    await db.query(constraintSql),
    await db.query(triggerSql),
    await db.query(functionSql),
  ]);
async function migrated(engine: Engine) {
  const db = await engine.fresh();
  await runMigrations({ target: db.target, folder: folderThrough0013() });
  for (const statement of seed) await db.query(statement);
  return db;
}
/** Runs statements on one connection inside BEGIN; returns the COMMIT error (or undefined if it committed). */
async function commitError(db: Db, statements: string[]) {
  const s = await db.session();
  try {
    await s.query("begin");
    for (const statement of statements) await s.query(statement);
    try {
      await s.query("commit");
      return undefined;
    } catch (error) {
      return error;
    }
  } finally {
    await s.close();
  }
}

for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};

  test(`[${engine.name}] AT-11 0013 installs the role CHECK and a deferred constraint trigger, and its role list equals STORED_ROLES`, opts, async () => {
    const db = await engine.fresh();
    const report = await runMigrations({ target: db.target, folder: folderBefore0013() });
    assert.equal(report.applied.length, 0);
    assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0013() })).pending, [TAG]);
    const [check] = await db.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'membership_role_known' and conrelid = 'public.membership'::regclass and contype = 'c'`,
    );
    assert.ok(check, "membership_role_known exists");
    const roles = [...String(check.def).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...roles].sort(), [...STORED_ROLES].sort(), "the CHECK lists exactly the authority module's stored roles");
    const triggers = await db.query(
      `select t.tgname, t.tgdeferrable as deferrable, t.tginitdeferred as initially_deferred, c.contype from pg_trigger t join pg_constraint c on c.oid = t.tgconstraint where t.tgrelid = 'public.membership'::regclass and t.tgname like 'membership_owner_presence%' order by 1`,
    );
    assert.deepEqual(
      triggers.map((r) => ({ ...r })),
      ["membership_owner_presence", "membership_owner_presence_delete"].map((tgname) => ({ tgname, deferrable: true, initially_deferred: true, contype: "t" })),
      "UPDATE and DELETE are DEFERRABLE INITIALLY DEFERRED constraint triggers",
    );
    // F-01: the UPDATE trigger covers academy_id (a move between academies), not only role and active.
    const [update] = await db.query(`select pg_get_triggerdef(oid) as def from pg_trigger where tgname = 'membership_owner_presence'`);
    assert.match(String(update.def), /AFTER UPDATE OF role, active, academy_id ON public\.membership/);
    // The 0011 coach-assignment triggers on membership are untouched (Regression invariant, Stage 5D).
    assert.deepEqual(
      (await db.query(`select tgname from pg_trigger where tgrelid = 'public.membership'::regclass and not tgisinternal order by 1`)).map((r) => r.tgname),
      ["membership_coach_assignments", "membership_owner_presence", "membership_owner_presence_delete", "membership_owner_presence_truncate"],
    );
  });

  test(`[${engine.name}] AT-11 unknown role values are rejected with check_violation on membership_role_known; all eight stored roles are accepted`, opts, async () => {
    const db = await migrated(engine);
    await db.query(person("u-new"));
    const rejected = async (sql: string) =>
      assert.rejects(
        () => db.query(sql),
        (e: unknown) => sqlState(e) === "23514" && /membership_role_known/.test(String((e as DbError).message)),
        sql,
      );
    // The AT-11 statement itself, and the near misses an invalid script or manual edit could produce.
    await rejected(member("u-new", "a-1", "SuperAdmin"));
    for (const bad of ["owner", "Owner", " OWNER", "OWNER ", "PLAYER", "PARENT", "STAFF", ""]) await rejected(member("u-new", "a-1", bad));
    await rejected(`update membership set role = 'SuperAdmin' where user_id = 's-1'`);
    assert.equal((await db.query(`select 1 from membership where user_id = 'u-new'`)).length, 0);
    // All eight stored roles insert cleanly, and an existing member can move between them.
    for (const [i, role] of STORED_ROLES.entries()) {
      await db.query(person(`r-${i}`));
      await db.query(member(`r-${i}`, "a-3", role));
    }
    assert.deepEqual(
      (await db.query(`select role from membership where academy_id = 'a-3' order by role`)).map((r) => r.role),
      [...STORED_ROLES].sort(),
    );
    for (const role of STORED_ROLES) await db.query(`update membership set role = ${lit(role)} where user_id = 's-2'`);
  });

  test(`[${engine.name}] AT-11 removing, deactivating or demoting an academy's last active owner fails at COMMIT with OWNER_REQUIRED (check_violation); nothing changes`, opts, async () => {
    const db = await migrated(engine);
    const before = JSON.stringify(await db.query(memberships));
    const removals = [
      `delete from membership where role = 'OWNER' and academy_id = 'a-1'`,
      `delete from membership where user_id = 'o-1'`,
      `update membership set active = false where user_id = 'o-1'`,
      `update membership set role = 'ADMIN' where user_id = 'o-1'`,
      `update membership set role = 'GUARDIAN', active = false where user_id = 'o-1'`,
      `delete from membership where academy_id = 'a-1'`,
    ];
    for (const statement of removals) {
      // Inside a transaction the statement itself succeeds (the check is deferred) and COMMIT is refused.
      const error = await commitError(db, [statement]);
      assert.ok(error, `${statement}: commit refused`);
      assert.equal(sqlState(error), "23514", `${statement}: check_violation`);
      assert.match(String((error as DbError).message), OWNER_REQUIRED, statement);
      // Autocommit: the same statement is refused as a whole.
      await assert.rejects(() => db.query(statement), OWNER_REQUIRED, `${statement} (autocommit)`);
      assert.equal(JSON.stringify(await db.query(memberships)), before, `${statement}: nothing changed`);
    }
    // A transaction that reactivates the former owner and then removes every owner still ends ownerless: refused.
    const error = await commitError(db, [
      `update membership set active = true where user_id = 'o-old'`,
      `delete from membership where role = 'OWNER' and academy_id = 'a-1'`,
    ]);
    assert.match(String((error as DbError).message), OWNER_REQUIRED);
    // SET CONSTRAINTS ... IMMEDIATE makes the same check fire at the statement (it is a real constraint trigger).
    const s = await db.session();
    try {
      await s.query("begin");
      await s.query("set constraints membership_owner_presence, membership_owner_presence_delete immediate");
      await assert.rejects(() => s.query(`delete from membership where user_id = 'o-1'`), OWNER_REQUIRED);
      await s.query("rollback");
    } finally {
      await s.close();
    }
    assert.equal(JSON.stringify(await db.query(memberships)), before);
  });

  test(`[${engine.name}] AT-11 ownership can still change hands: hand-over in one transaction (either order), a second owner, staff and inactive rows`, opts, async () => {
    const db = await migrated(engine);
    // An academy with two active owners may lose one of them.
    await db.query(`update membership set role = 'ADMIN' where user_id = 'o-2a'`);
    await assert.rejects(() => db.query(`delete from membership where user_id = 'o-2b'`), /OWNER_REQUIRED: Academy a-2/);
    // Hand-over in one transaction, removing first and adding second: the deferred check sees the final state.
    assert.equal(
      await commitError(db, [`update membership set active = false where user_id = 'o-1'`, `update membership set role = 'OWNER' where user_id = 's-1'`]),
      undefined,
      "remove-then-add hand-over commits",
    );
    assert.equal(
      await commitError(db, [`update membership set active = true where user_id = 'o-1'`, `update membership set role = 'ADMIN' where user_id = 's-1'`]),
      undefined,
      "and back again",
    );
    // Staff, inactive former owners and rows of other academies are not constrained by the owner rule.
    await db.query(`delete from membership where user_id = 's-2'`);
    await db.query(`update membership set role = 'COACH' where user_id = 'o-old'`);
    await db.query(`delete from membership where user_id = 'o-old'`);
    await db.query(`update membership set active = false where user_id = 's-1'`);
    // The owner row itself may change while staying an active owner.
    await db.query(`update membership set role = 'OWNER', active = true where user_id = 'o-1'`);
    assert.deepEqual(
      (await db.query(`select user_id, role, active from membership where academy_id = 'a-1' order by user_id`)).map((r) => ({ ...r })),
      [
        { user_id: "o-1", role: "OWNER", active: true },
        { user_id: "s-1", role: "ADMIN", active: false },
      ],
    );
  });

  test(`[${engine.name}] AT-11 0013 changes no existing row, and both pre-flights stop it (changing nothing) and name the offending values`, opts, async () => {
    // Applies cleanly over existing data (with an academy that has no members at all), leaving every row as it was.
    {
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore0013() });
      for (const statement of seed) await db.query(statement);
      const before = JSON.stringify(await db.query(memberships));
      assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0013() })).pending, [TAG]);
      assert.equal(JSON.stringify(await db.query(memberships)), before);
    }
    const cases: [string, string[], RegExp][] = [
      [
        "unknown roles",
        [person("x-1"), person("x-2"), member("x-1", "a-1", "SuperAdmin"), member("x-2", "a-2", "owner")],
        /MIGRATION_PREFLIGHT_FAILED: Unknown membership role values found: \((SuperAdmin, owner|owner, SuperAdmin)\)/,
      ],
      [
        "academies without an active owner",
        [`update membership set active = false where user_id = 'o-1'`, `update membership set role = 'ADMIN' where academy_id = 'a-2'`],
        /MIGRATION_PREFLIGHT_FAILED: Academies without an active owner found: \((a-1, a-2|a-2, a-1)\)/,
      ],
    ];
    for (const [name, statements, pattern] of cases) {
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore0013() });
      for (const statement of [...seed, ...statements]) await db.query(statement);
      const state = async () => JSON.stringify([await schemaState(db), await db.query(memberships), await db.query(bookkeeping)]);
      const before = await state();
      await assert.rejects(
        () => runMigrations({ target: db.target, folder: folderThrough0013() }),
        (error: unknown) => pattern.test(`${String(error)} ${String((error as { cause?: unknown }).cause)}`),
        name,
      );
      assert.equal(await state(), before, `${name}: the failed migration changed nothing`);
      assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0013(), dryRun: true })).pending, [TAG], name);
    }
  });

  test(`[${engine.name}] AT-11 rollback rehearsal: the 0012 schema is restored exactly, no row changes, only 0013's record is removed, and 0013 re-applies`, opts, async () => {
    const reference = await engine.fresh();
    await runMigrations({ target: reference.target, folder: folderBefore0013() });
    const db = await migrated(engine);
    const rows = JSON.stringify(await db.query(memberships));
    const records = await db.query(bookkeeping);
    assert.equal(records.at(-1)!.created_at, String(WHEN));
    await db.script(readFileSync(ROLLBACK, "utf8"));
    // Columns, constraints (with definitions), triggers and functions: identical to a database that never had 0013.
    assert.equal(await schemaState(db), await schemaState(reference));
    assert.equal(JSON.stringify(await db.query(memberships)), rows, "no membership row changed");
    assert.deepEqual(await db.query(bookkeeping), records.slice(0, -1), "only 0013's record is removed");
    // Without 0013 the database no longer refuses either rule (the application checks of RC-2 still do).
    await db.query(`update membership set role = 'SuperAdmin' where user_id = 's-2'`);
    await db.query(`update membership set role = 'COACH' where user_id = 's-2'`);
    // Re-applied, 0013 is enforced again.
    assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0013() })).pending, [TAG]);
    await assert.rejects(() => db.query(`delete from membership where user_id = 'o-1'`), OWNER_REQUIRED);
    await assert.rejects(() => db.query(`update membership set role = 'SuperAdmin' where user_id = 's-2'`), /membership_role_known/);
  });

  const rollback = readFileSync(ROLLBACK, "utf8");
  const stateOf = async (db: Db) => JSON.stringify([await schemaState(db), await db.query(bookkeeping), await db.query(memberships)]);
  const refusedWith = async (db: Db, pattern: RegExp, name: string) => {
    const before = await stateOf(db);
    await assert.rejects(() => db.script(rollback), (e: unknown) => pattern.test(String(e)), name);
    assert.equal(await stateOf(db), before, `${name}: a refused rollback changes nothing`);
  };
  test(`[${engine.name}] AT-11 rollback guard: refuses, changing nothing, unless 0013 is applied (with the reviewed hash) and latest`, opts, async () => {
    // 1. Applied: rolled back once; a second run is refused and cannot remove 0012's record.
    {
      const db = await migrated(engine);
      await db.script(rollback);
      const records = await db.query(bookkeeping);
      await refusedWith(db, /0013 rollback refused: migration 0013_role_validation_owner_presence is not recorded as applied/, "second run");
      assert.deepEqual(await db.query(bookkeeping), records, "0012's record is never removed");
    }
    // 2. 0013 absent (database at 0012): refused.
    {
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore0013() });
      await refusedWith(db, /not recorded as applied/, "0013 absent");
    }
    // 3. Not the latest applied migration: refused.
    {
      const db = await migrated(engine);
      await db.query(`insert into drizzle."__drizzle_migrations" (hash, created_at) values ('a-later-migration', ${WHEN + 1})`);
      await refusedWith(db, /0013 rollback refused: 1 later migration\(s\) are applied after 0013/, "not the latest");
    }
    // 4. Recorded with another hash: refused.
    {
      const db = await migrated(engine);
      await db.query(`update drizzle."__drizzle_migrations" set hash = 'not-the-reviewed-0013' where created_at = ${WHEN}`);
      await refusedWith(db, /not recorded as applied/, "unexpected hash");
    }
  });
  test(`[${engine.name}] AT-11 rollback guard: refuses, changing nothing, when any object 0013 created is missing`, opts, async () => {
    // 5. An 0013 object missing: refused before any DROP runs, naming what is missing.
    for (const [drop, missing] of [
      [`drop trigger membership_owner_presence on membership`, "trigger membership_owner_presence"],
      [`drop trigger membership_owner_presence_delete on membership`, "trigger membership_owner_presence_delete"],
      [`drop trigger membership_owner_presence_truncate on membership`, "trigger membership_owner_presence_truncate"],
      [`drop trigger membership_owner_presence_truncate on membership; drop function membership_owner_presence_truncate()`, "function membership_owner_presence_truncate, trigger membership_owner_presence_truncate"],
      [`alter table membership drop constraint membership_role_known`, "constraint membership_role_known"],
    ]) {
      const db = await migrated(engine);
      await db.script(drop);
      await refusedWith(db, new RegExp(`schema does not match migration 0013 \\(missing: ${missing}\\)`), `partial schema: ${missing}`);
    }
  });

  test(`[${engine.name}] F-01 a membership moved between academies (academy_id): the source and the destination must both keep an active owner`, opts, async () => {
    const db = await migrated(engine);
    const before = JSON.stringify(await db.query(memberships));
    const refusedAt = async (statements: string[], academy: string, name: string) => {
      const error = await commitError(db, statements);
      assert.ok(error, `${name}: commit refused`);
      assert.equal(sqlState(error), "23514", name);
      assert.match(String((error as DbError).message), new RegExp(`OWNER_REQUIRED: Academy ${academy} must retain`), name);
      assert.equal(JSON.stringify(await db.query(memberships)), before, `${name}: nothing changed`);
    };
    // Source: a-1's only active owner leaves (alone, demoted on the way, or with every owner row of a-1).
    await refusedAt([`update membership set academy_id = 'a-2' where user_id = 'o-1'`], "a-1", "last owner moved out");
    await refusedAt([`update membership set academy_id = 'a-2', role = 'ADMIN' where user_id = 'o-1'`], "a-1", "moved out and demoted");
    await refusedAt([`update membership set academy_id = 'a-2' where academy_id = 'a-1' and role = 'OWNER'`], "a-1", "every owner row moved out");
    // Destination: a member moved into an academy without an active owner (a-3 has no members at all).
    await refusedAt([`update membership set academy_id = 'a-3' where user_id = 's-2'`], "a-3", "coach moved into an ownerless academy");
    await refusedAt([`update membership set academy_id = 'a-3' where user_id = 'o-old'`], "a-3", "an inactive owner moved into an ownerless academy");
    await refusedAt([`update membership set academy_id = 'a-3', role = 'OWNER', active = false where user_id = 's-2'`], "a-3", "moved and made an inactive owner");
    // Autocommit is refused the same way.
    await assert.rejects(() => db.query(`update membership set academy_id = 'a-2' where user_id = 'o-1'`), /OWNER_REQUIRED: Academy a-1/);
    assert.equal(JSON.stringify(await db.query(memberships)), before);
    // Allowed: one owner of the two-owner academy moves to the empty academy, which then has an owner ...
    await db.query(`update membership set academy_id = 'a-3' where user_id = 'o-2a'`);
    // ... so staff may follow; and the last owner of a-1 may move in the transaction that promotes a replacement.
    await db.query(`update membership set academy_id = 'a-3' where user_id = 's-2'`);
    assert.equal(
      await commitError(db, [`update membership set academy_id = 'a-2' where user_id = 'o-1'`, `update membership set role = 'OWNER' where user_id = 's-1'`]),
      undefined,
      "a move with a hand-over commits",
    );
    assert.deepEqual(
      (await db.query(`select academy_id, user_id from membership where role = 'OWNER' and active order by 1, 2`)).map((r) => `${r.academy_id}:${r.user_id}`),
      ["a-1:s-1", "a-2:o-1", "a-2:o-2b", "a-3:o-2a"],
    );
  });

  test(`[${engine.name}] F-02 every commit that removes or moves an owner row writes its academy row (the serialization point); other changes do not`, opts, async () => {
    const db = await migrated(engine);
    const academies = `select id, name, timezone from academy order by id`;
    const content = JSON.stringify(await db.query(academies));
    const version = async (id: string) => String((await db.query(`select xmin::text as v from academy where id = ${lit(id)}`))[0].v);
    const [a1, a2, a3] = [await version("a-1"), await version("a-2"), await version("a-3")];
    // Changes that cannot remove an active owner leave the academy row alone.
    await db.query(`update membership set role = 'FINANCE' where user_id = 's-2'`);
    await db.query(`update membership set role = 'COACH' where user_id = 'o-old'`);
    await db.query(`delete from membership where user_id = 's-2'`);
    assert.equal(await version("a-1"), a1, "no active owner row changed: a-1 untouched");
    // Demoting one of two owners writes a-2 (once checked, it is serialized with any other owner change of a-2).
    await db.query(`update membership set role = 'ADMIN' where user_id = 'o-2a'`);
    assert.notEqual(await version("a-2"), a2, "a-2 written");
    // A move writes both academies.
    const a2b = await version("a-2");
    await db.query(`update membership set role = 'OWNER' where user_id = 'o-2a'`);
    await db.query(`update membership set academy_id = 'a-3' where user_id = 'o-2a'`);
    assert.notEqual(await version("a-3"), a3, "a-3 (destination) written");
    assert.notEqual(await version("a-2"), a2b, "a-2 (source) written");
    assert.equal(JSON.stringify(await db.query(academies)), content, "the write changes no academy data");
  });

  test(`[${engine.name}] TRUNCATE of membership, directly or by CASCADE, is refused while any active owner exists`, opts, async () => {
    const db = await migrated(engine);
    const before = JSON.stringify(await db.query(memberships));
    // Plain TRUNCATE is already refused by the foreign keys that reference membership; CASCADE gets past those and
    // reaches the owner guard.
    await assert.rejects(() => db.query(`truncate membership`));
    for (const statement of [`truncate membership cascade`, `truncate membership restart identity cascade`])
      await assert.rejects(
        () => db.query(statement),
        (e: unknown) => sqlState(e) === "23514" && /OWNER_REQUIRED: TRUNCATE of membership/.test(String((e as DbError).message)),
        statement,
      );
    // Truncating the academy table cascades to membership and is refused too (by this or another guard).
    await assert.rejects(() => db.query(`truncate academy cascade`));
    assert.equal(JSON.stringify(await db.query(memberships)), before, "nothing truncated");
    // The rule protects owners, not the table: without an active owner the table may be truncated.
    const empty = await engine.fresh();
    await runMigrations({ target: empty.target, folder: folderThrough0013() });
    await empty.query(`truncate membership cascade`);
  });

  test(`[${engine.name}] invalid historical states fail safely: a legacy unknown role and a legacy ownerless academy`, opts, async () => {
    const db = await migrated(engine);
    // (1) A row with an unknown role that predates 0013 (made exactly as tests/helpers/fixtures.ts does).
    const [{ def }] = await db.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'membership_role_known'`);
    await db.script(`begin;
      alter table membership drop constraint membership_role_known;
      ${person("legacy")};
      ${member("legacy", "a-1", "STAFF")};
      alter table membership add constraint membership_role_known ${def} not valid;
      commit;`);
    await assert.rejects(() => db.query(`alter table membership validate constraint membership_role_known`), /membership_role_known/, "the legacy row is detectable");
    // Any change that keeps the unknown role is refused; correcting it to a stored role is accepted.
    await assert.rejects(() => db.query(`update membership set active = false where user_id = 'legacy'`), /membership_role_known/);
    await assert.rejects(() => db.query(`update membership set role = 'Staff' where user_id = 'legacy'`), /membership_role_known/);
    await db.query(`update membership set role = 'COACH' where user_id = 'legacy'`);
    await db.query(`alter table membership validate constraint membership_role_known`);
    // (2) An academy that already has no active owner (only possible by bypassing 0013's triggers, as a superuser or
    // a restore could): a-1 loses o-1 with the DELETE trigger disabled.
    await db.script(`begin;
      alter table membership disable trigger membership_owner_presence_delete;
      delete from membership where user_id = 'o-1';
      alter table membership enable trigger membership_owner_presence_delete;
      commit;`);
    // Moving members out of it or into it is refused: the database never confirms a move involving an ownerless academy.
    await assert.rejects(() => db.query(`update membership set academy_id = 'a-2' where user_id = 's-2'`), /OWNER_REQUIRED: Academy a-1/);
    await db.query(person("c-2"));
    await db.query(member("c-2", "a-2", "COACH"));
    await assert.rejects(() => db.query(`update membership set academy_id = 'a-1' where user_id = 'c-2'`), /OWNER_REQUIRED: Academy a-1/);
    // Ordinary staff changes inside it are not blocked (they cannot make it worse), and it can be repaired:
    await db.query(`update membership set role = 'COACH' where user_id = 's-1'`);
    await db.query(`update membership set active = true where user_id = 'o-old'`);
    // once repaired, the earlier moves are accepted.
    await db.query(`update membership set academy_id = 'a-2' where user_id = 's-2'`);
    await db.query(`update membership set academy_id = 'a-1' where user_id = 'c-2'`);
    assert.deepEqual(
      (await db.query(`select academy_id, user_id from membership where role = 'OWNER' and active order by 1, 2`)).map((r) => `${r.academy_id}:${r.user_id}`),
      ["a-1:o-old", "a-2:o-2a", "a-2:o-2b"],
    );
  });
}

