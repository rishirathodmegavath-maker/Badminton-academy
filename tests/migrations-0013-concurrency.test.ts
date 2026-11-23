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
  await runMigrations({ target: db.target });
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


/* ================= F-02: concurrent direct SQL on PostgreSQL (separate connections, transaction barrier) ================= */
/**
 * A deterministic commit barrier. A test-only deferred constraint trigger, zz_test_commit_barrier, fires on every
 * membership UPDATE or DELETE AFTER 0013's own triggers (constraint triggers on one event fire in name order) and
 * waits for a shared advisory lock that a third "gate" session holds exclusively. Both racing transactions do all
 * their work, then COMMIT; the test waits until BOTH backends are blocked on a lock (pg_stat_activity), and only then
 * releases the gate. With the original non-locking trigger both commits pass their owner check before either commits
 * (the race of finding F-02, reproduced below as a negative control); with the hardened trigger the second one waits
 * on the academy row inside its check instead.
 */
const BARRIER = 7013;
const barrierSql = `
  CREATE FUNCTION zz_test_commit_barrier() RETURNS trigger AS $$
  BEGIN
    PERFORM pg_advisory_xact_lock_shared(${BARRIER});
    RETURN NULL;
  END $$ LANGUAGE plpgsql;
  CREATE CONSTRAINT TRIGGER zz_test_commit_barrier AFTER UPDATE OR DELETE ON membership
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zz_test_commit_barrier();`;
/** The function body of DATABASE_AND_MIGRATION_DESIGN.md section 2.1 (no serialization), for the negative control. */
const unserializedSql = `
  CREATE OR REPLACE FUNCTION membership_owner_presence() RETURNS trigger AS $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM membership WHERE academy_id = OLD.academy_id AND role = 'OWNER' AND active = true) THEN
      RAISE EXCEPTION 'OWNER_REQUIRED: Academy % must retain at least one active owner.', OLD.academy_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END;
  $$ LANGUAGE plpgsql;`;
/** a-4 is a second two-owner academy for the cross-academy moves. */
const raceSeed = [
  `insert into academy (id, name, timezone) values ('a-4', 'Four', 'UTC')`,
  ...["o-4a", "o-4b"].map(person),
  member("o-4a", "a-4", "OWNER"),
  member("o-4b", "a-4", "OWNER"),
];
const ownerless = `select a.id from academy a where exists (select 1 from membership m where m.academy_id = a.id)
  and not exists (select 1 from membership m where m.academy_id = a.id and m.role = 'OWNER' and m.active) order by 1`;
const activeOwners = (academy: string) =>
  `select user_id from membership where academy_id = ${lit(academy)} and role = 'OWNER' and active order by 1`;
type Outcome = { ok: boolean; code?: string; message?: string };
async function raceDb(variant: "hardened" | "unserialized" = "hardened") {
  const db = await migrated(postgresEngine);
  for (const statement of raceSeed) await db.query(statement);
  await db.script(barrierSql);
  if (variant === "unserialized") await db.script(unserializedSql);
  return db;
}
/**
 * Waits until every racing transaction is either blocked on a lock (the barrier, or the academy row inside the owner
 * check) or has already finished. A transaction finishes before the barrier only when its own owner check refused it
 * outright against committed state (e.g. a destination that has no owner yet); every other case blocks.
 */
async function waitUntilBlocked(gate: Session, pids: number[], settled: () => number) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const [{ n }] = await gate.query(
      `select count(*)::int as n from pg_stat_activity where pid in (${pids.join(", ")}) and wait_event_type = 'Lock'`,
    );
    if (Number(n) + settled() === pids.length) return;
    if (Date.now() > deadline) throw new Error("the racing transactions never both reached the commit barrier");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
/**
 * Runs a and b in two transactions on separate connections, then commits both through the barrier. By default BOTH
 * commits must be blocked before the gate opens (a true overlap); `mayFinishEarly` allows one of them to have been
 * refused already, for races whose outcome legitimately depends on which transaction checks first.
 */
async function race(db: Db, a: string[], b: string[], isolation = "read committed", mayFinishEarly = false): Promise<[Outcome, Outcome]> {
  const gate = await db.session();
  const sessions = [await db.session(), await db.session()];
  try {
    await gate.query(`select pg_advisory_lock(${BARRIER})`);
    const pids: number[] = [];
    for (const s of sessions) pids.push(Number((await s.query(`select pg_backend_pid() as pid`))[0].pid));
    // Each transaction does all of its work (and so takes its snapshot) before either tries to commit.
    for (const [i, statements] of [a, b].entries()) {
      await sessions[i].query(`begin isolation level ${isolation}`);
      for (const statement of statements) await sessions[i].query(statement);
    }
    let settled = 0;
    const commits = sessions.map((s) =>
      s
        .query("commit")
        .then(
          (): Outcome => ({ ok: true }),
          (e: unknown): Outcome => ({ ok: false, code: sqlState(e), message: String((e as DbError).message) }),
        )
        .finally(() => settled++),
    );
    await waitUntilBlocked(gate, pids, () => (mayFinishEarly ? settled : 0));
    await gate.query(`select pg_advisory_unlock(${BARRIER})`);
    return (await Promise.all(commits)) as [Outcome, Outcome];
  } finally {
    for (const s of [...sessions, gate]) await s.close().catch(() => undefined);
  }
}
const pgOpts = { skip: PG_ONLY };
const REPS = 3;
/** Two transactions each removing a different one of a-2's two owners, in every way the brief lists. */
const removals: [string, string[], string[]][] = [
  ["deletion of different owners", [`delete from membership where user_id = 'o-2a'`], [`delete from membership where user_id = 'o-2b'`]],
  ["deactivation of different owners", [`update membership set active = false where user_id = 'o-2a'`], [`update membership set active = false where user_id = 'o-2b'`]],
  ["demotion of different owners", [`update membership set role = 'ADMIN' where user_id = 'o-2a'`], [`update membership set role = 'FINANCE' where user_id = 'o-2b'`]],
  ["moves of different owners to other academies", [`update membership set academy_id = 'a-1' where user_id = 'o-2a'`], [`update membership set academy_id = 'a-3' where user_id = 'o-2b'`]],
  ["a deletion against a move", [`delete from membership where user_id = 'o-2a'`], [`update membership set academy_id = 'a-3' where user_id = 'o-2b'`]],
  ["a demotion against a deactivation", [`update membership set role = 'COACH' where user_id = 'o-2a'`], [`update membership set active = false where user_id = 'o-2b'`]],
  [
    "an application-style unit (academy FOR UPDATE first, as RC-2 unit() does) against direct SQL",
    [`select id from academy where id = 'a-2' for update`, `update membership set role = 'COACH' where user_id = 'o-2a'`],
    [`delete from membership where user_id = 'o-2b'`],
  ],
];
for (const [name, a, b] of removals)
  test(`[PostgreSQL] F-02 concurrent ${name}: exactly one commits, the other fails with OWNER_REQUIRED, a-2 keeps one owner (${REPS} runs)`, pgOpts, async () => {
    for (let run = 0; run < REPS; run++) {
      const db = await raceDb();
      const outcomes = await race(db, a, b);
      assert.equal(outcomes.filter((o) => o.ok).length, 1, `${name} run ${run}: exactly one commit (${JSON.stringify(outcomes)})`);
      const failed = outcomes.find((o) => !o.ok)!;
      assert.equal(failed.code, "23514", `${name} run ${run}`);
      assert.match(failed.message ?? "", /OWNER_REQUIRED: Academy a-2 must retain at least one active owner/);
      assert.equal((await db.query(activeOwners("a-2"))).length, 1, `${name} run ${run}: a-2 has exactly one active owner`);
      assert.deepEqual(await db.query(ownerless), [], `${name} run ${run}: no academy with members is ownerless`);
    }
  });
for (const isolation of ["repeatable read", "serializable"])
  test(`[PostgreSQL] F-02 under ${isolation.toUpperCase()}: concurrent removal of different owners cannot both commit (write skew is refused)`, pgOpts, async () => {
    for (const [name, a, b] of removals.slice(0, 4)) {
      const db = await raceDb();
      const outcomes = await race(db, a, b, isolation);
      assert.equal(outcomes.filter((o) => o.ok).length, 1, `${isolation} ${name}: exactly one commit (${JSON.stringify(outcomes)})`);
      const failed = outcomes.find((o) => !o.ok)!;
      assert.ok(["40001", "23514"].includes(failed.code ?? ""), `${isolation} ${name}: serialization failure or OWNER_REQUIRED, got ${failed.code} ${failed.message}`);
      assert.equal((await db.query(activeOwners("a-2"))).length, 1, `${isolation} ${name}: a-2 keeps one active owner`);
    }
  });
test("[PostgreSQL] F-01/F-02 concurrent moves into an academy: the destination is checked against committed state", pgOpts, async () => {
  for (let run = 0; run < REPS; run++) {
    const db = await raceDb();
    // A moves an owner into the empty a-3; B moves a coach into a-3. B may commit only if A's owner is there first.
    const [first, second] = await race(
      db,
      [`update membership set academy_id = 'a-3' where user_id = 'o-2a'`],
      [`update membership set academy_id = 'a-3' where user_id = 's-2'`],
      "read committed",
      true,
    );
    assert.equal(first.ok, true, JSON.stringify(first));
    if (!second.ok) assert.match(second.message ?? "", /OWNER_REQUIRED: Academy a-3/);
    assert.deepEqual(await db.query(ownerless), [], `run ${run}: no academy with members is ownerless`);
    assert.deepEqual((await db.query(activeOwners("a-3"))).map((r) => r.user_id), ["o-2a"]);
  }
});
test("[PostgreSQL] F-02 lock order: owner moves in opposite directions between two academies never deadlock and both commit", pgOpts, async () => {
  for (let run = 0; run < REPS; run++) {
    const db = await raceDb();
    // Each move locks both academies, always in ascending id order, so the two transactions queue instead of deadlocking.
    const outcomes = await race(
      db,
      [`update membership set academy_id = 'a-4' where user_id = 'o-2a'`],
      [`update membership set academy_id = 'a-2' where user_id = 'o-4a'`],
    );
    assert.deepEqual(outcomes, [{ ok: true }, { ok: true }], `run ${run}: no deadlock (40P01), no refusal`);
    assert.deepEqual((await db.query(activeOwners("a-2"))).map((r) => r.user_id), ["o-2b", "o-4a"]);
    assert.deepEqual((await db.query(activeOwners("a-4"))).map((r) => r.user_id), ["o-2a", "o-4b"]);
  }
});
test("[PostgreSQL] F-02 negative control: with the original non-serialized trigger the same barrier lets both commits through and a-2 ends with no owner", pgOpts, async () => {
  for (const [name, a, b] of removals.slice(0, 3)) {
    const db = await raceDb("unserialized");
    const outcomes = await race(db, a, b);
    assert.deepEqual(outcomes, [{ ok: true }, { ok: true }], `${name}: the race is real without serialization`);
    assert.equal((await db.query(activeOwners("a-2"))).length, 0, `${name}: the invariant is broken without serialization`);
  }
});
