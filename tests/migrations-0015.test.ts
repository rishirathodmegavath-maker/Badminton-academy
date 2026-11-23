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
 * Auth integration Phase 1 — migration 0015_auth_onboarding_and_outbox:
 * - Purely additive on app_user: preserves existing verified and owner-provisioned (email_verified=false)
 *   accounts with email_verification_required = false (never silently marking them email_verified = true).
 * - Adds Better Auth lookup indexes on auth_session, auth_account, auth_verification.
 * - Installs auth_email_outbox constraints (kind, status, attempts >= 0) and partial dispatch index.
 * - Guarded rollback cleanly restores the exact 0014 schema and bookkeeping row.
 */
const TAG = "0015_auth_onboarding_and_outbox";
const WHEN = 1794483556845;
const ROLLBACK = join(REPO_ROOT, "migrations-rollback", `${TAG}.down.sql`);
const cleanups: (() => Promise<void> | void)[] = [];
after(
  async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  },
  { timeout: HOOK_TIMEOUT },
);

type Session = { query(sql: string): Promise<Record<string, unknown>[]>; close(): Promise<void> };
type Db = {
  target: MigrationTarget;
  query(sql: string): Promise<Record<string, unknown>[]>;
  script(sql: string): Promise<void>;
  session(): Promise<Session>;
};
type Engine = { name: string; fresh(): Promise<Db> };

let template: Promise<string> | undefined;
const pgliteTemplate = () =>
  (template ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0015-template-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new PGlite(join(dir, "db"));
    await client.query("select 1");
    await client.close();
    return dir;
  })());

const pgliteEngine: Engine = {
  name: "PGlite",
  async fresh(): Promise<Db> {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0015-"));
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
  async fresh(): Promise<Db> {
    const created = await createPostgresDatabase(admin!);
    cleanups.push(() => created.drop());
    const session = async (): Promise<Session> => {
      const client = new Client({ connectionString: created.url });
      await client.connect();
      return {
        query: async (sql) => (await client.query(sql)).rows,
        close: () => client.end(),
      };
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

let folderBefore0015Dir: string | undefined;
function folderBefore0015() {
  if (folderBefore0015Dir) return folderBefore0015Dir;
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0015-folder-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG);
  assert.ok(at > 0, "0015 is in the journal");
  // Migrations added after 0015 are cut off too, so this test keeps proving 0015 on its own.
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  folderBefore0015Dir = dir;
  return dir;
}

/** A copy of the migrations folder up to and including 0015 so 0015 rollback tests isolate 0015 as the latest migration. */
let folderThrough0015Dir: string | undefined;
function folderThrough0015() {
  if (folderThrough0015Dir) return folderThrough0015Dir;
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0015-through-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG) + 1;
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  folderThrough0015Dir = dir;
  return dir;
}

const seed = [
  `insert into academy (id, name, timezone) values ('a-1', 'One', 'UTC')`,
  `insert into app_user (id, name, email, email_verified) values
     ('u-verified', 'Verified Owner', 'owner@example.test', true),
     ('u-provisioned', 'Provisioned Staff', 'staff@example.test', false)`,
  `insert into membership (user_id, academy_id, role) values ('u-verified', 'a-1', 'OWNER'), ('u-provisioned', 'a-1', 'COACH')`,
];

const existingUsersSql = `select id, email, email_verified, email_verification_required, terms_accepted_at, terms_version from app_user order by id`;
const fingerprintSql = `
  select c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
  from information_schema.columns c where c.table_schema='public' order by 1,2`;
const constraintSql = `
  select conrelid::regclass::text as tbl, conname, contype, pg_get_constraintdef(oid) as def
  from pg_constraint where connamespace = 'public'::regnamespace and contype <> 'n' order by 1,2`;
const indexSql = `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1,2`;
const bookkeeping = `select hash, created_at::text as created_at from drizzle."__drizzle_migrations" order by created_at`;
const schemaState = async (db: Db) =>
  JSON.stringify([
    await db.query(fingerprintSql),
    await db.query(constraintSql),
    await db.query(indexSql),
  ]);

async function upgraded(engine: Engine) {
  const db = await engine.fresh();
  await runMigrations({ target: db.target, folder: folderBefore0015() });
  for (const statement of seed) await db.query(statement);
  const report = await runMigrations({ target: db.target, folder: folderThrough0015() });
  assert.deepEqual(report.pending, [TAG]);
  return db;
}

for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};

  test(`[${engine.name}] 0015 preserves existing and owner-provisioned users without marking them verified or blocking them`, opts, async () => {
    const db = await upgraded(engine);
    const users = await db.query(existingUsersSql);
    assert.deepEqual(
      users.map((u) => ({
        id: u.id,
        email_verified: u.email_verified,
        email_verification_required: u.email_verification_required,
        terms_accepted_at: u.terms_accepted_at,
        terms_version: u.terms_version,
      })),
      [
        {
          id: "u-provisioned",
          email_verified: false,
          email_verification_required: false,
          terms_accepted_at: null,
          terms_version: null,
        },
        {
          id: "u-verified",
          email_verified: true,
          email_verification_required: false,
          terms_accepted_at: null,
          terms_version: null,
        },
      ],
    );
    assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0015() })).pending, [], "re-running 0015 is a no-op");
  });

  test(`[${engine.name}] 0015 installs Better Auth indexes and outbox constraints`, opts, async () => {
    const db = await upgraded(engine);
    const indexes = (await db.query(indexSql)).map((r) => String(r.indexname));
    for (const expected of [
      "auth_session_user_idx",
      "auth_account_user_provider_idx",
      "auth_verification_identifier_idx",
      "auth_email_outbox_idempotency_key_idx",
      "auth_email_outbox_dispatch_idx",
      "auth_email_outbox_user_idx",
    ]) {
      assert.ok(indexes.includes(expected), `missing index ${expected}`);
    }

    await assert.rejects(
      () =>
        db.query(
          `insert into auth_email_outbox (kind, recipient_hash, idempotency_key, expires_at) values ('MARKETING', 'abc', 'k1', now() + interval '1 hour')`,
        ),
      /auth_email_outbox_kind_check/,
    );
    await assert.rejects(
      () =>
        db.query(
          `insert into auth_email_outbox (kind, recipient_hash, idempotency_key, status, expires_at) values ('EMAIL_VERIFICATION_OTP', 'abc', 'k2', 'UNKNOWN', now() + interval '1 hour')`,
        ),
      /auth_email_outbox_status_check/,
    );
    await assert.rejects(
      () =>
        db.query(
          `insert into auth_email_outbox (kind, recipient_hash, idempotency_key, attempts, expires_at) values ('EMAIL_VERIFICATION_OTP', 'abc', 'k3', -1, now() + interval '1 hour')`,
        ),
      /auth_email_outbox_attempts_check/,
    );
  });

  test(`[${engine.name}] 0015 rollback rehearsal restores exact 0014 schema and re-applies cleanly`, opts, async () => {
    const reference = await engine.fresh();
    await runMigrations({ target: reference.target, folder: folderBefore0015() });
    const db = await upgraded(engine);
    const records = await db.query(bookkeeping);
    assert.equal(records.at(-1)!.created_at, String(WHEN));

    await db.script(readFileSync(ROLLBACK, "utf8"));
    assert.equal(await schemaState(db), await schemaState(reference));
    assert.deepEqual(await db.query(bookkeeping), records.slice(0, -1));
    assert.deepEqual((await runMigrations({ target: db.target, folder: folderThrough0015() })).pending, [TAG]);
  });

  test(`[${engine.name}] 0015 rollback guard refuses on missing hash, newer migration, or tampered schema`, opts, async () => {
    const rollback = readFileSync(ROLLBACK, "utf8");
    const stateOf = async (db: Db) => JSON.stringify([await schemaState(db), await db.query(bookkeeping)]);
    const refusedWith = async (db: Db, pattern: RegExp, name: string) => {
      const before = await stateOf(db);
      await assert.rejects(() => db.script(rollback), (e: unknown) => pattern.test(String(e)), name);
      assert.equal(await stateOf(db), before, `${name}: nothing changed`);
    };

    {
      const db = await upgraded(engine);
      await db.script(rollback);
      await refusedWith(db, /0015 rollback refused: migration 0015_auth_onboarding_and_outbox is not recorded/, "second rollback");
    }
    {
      const db = await upgraded(engine);
      await db.query(`insert into drizzle."__drizzle_migrations" (hash, created_at) values ('later-migration', ${WHEN + 1})`);
      await refusedWith(db, /0015 rollback refused: 1 later migration\(s\) are applied/, "newer migration");
    }
    {
      const db = await upgraded(engine);
      await db.query(`update drizzle."__drizzle_migrations" set hash = 'tampered' where created_at = ${WHEN}`);
      await refusedWith(db, /not recorded as applied/, "wrong hash");
    }
    {
      const db = await upgraded(engine);
      await db.query(`drop index auth_session_user_idx`);
      await refusedWith(db, /missing: index auth_session_user_idx/, "missing index");
    }
  });
}

test("0015 rollback pins both LF and CRLF SHA-256 hashes of LF-stored 0015 SQL", () => {
  const bytes = readFileSync(join(MIGRATIONS_DIR, `${TAG}.sql`));
  const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
  const rollback = readFileSync(ROLLBACK, "utf8");
  assert.ok(!bytes.includes("\r\n"), "0015 SQL must use LF line endings");
  assert.ok(rollback.includes(sha(bytes)), "rollback pins LF hash");
  assert.ok(rollback.includes(sha(Buffer.from(bytes.toString("utf8").replace(/\n/g, "\r\n")))), "rollback pins CRLF hash");
  assert.ok(rollback.includes(String(WHEN)));
});
