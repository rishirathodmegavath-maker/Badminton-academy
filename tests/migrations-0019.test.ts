import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";
import { runMigrations, type MigrationTarget } from "../src/infrastructure/database/migrations";
import { adminUrl, createPostgresDatabase } from "./helpers/test-database";
import { HOOK_TIMEOUT, MIGRATIONS_DIR, REPO_ROOT } from "./helpers/paths";
/**
 * Migration 0019_contacts_dispatch: contact_point (a place a message may be sent, with WhatsApp opt-in and suppression),
 * report_policy, the delivery queue (dispatch_batch / dispatch_item / dispatch_event), report_link, and
 * observation_review.category. Purely additive: no existing row changes. Addresses are never unique across people, so a parent
 * and a player can share any contact value. The guarded rollback drops the new objects and refuses to destroy delivery history,
 * opt-in records or category tags without an explicit confirmation. Every scenario runs on embedded PGlite (always) and on a real
 * PostgreSQL server (when TEST_POSTGRES_ADMIN_URL is set - npm run test:pg).
 */
const TAG = "0019_contacts_dispatch";
const WHEN = 1794600000000;
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
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0019-template-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new PGlite(join(dir, "db"));
    await client.query("select 1");
    await client.close();
    return dir;
  })());
const pgliteEngine: Engine = {
  name: "PGlite",
  async fresh() {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-0019-"));
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


/** A copy of the migrations folder cut before 0019 (the whole chain that precedes it); one copy per test process. */
let before0019Dir: string | undefined;
function folderBefore0019() {
  if (before0019Dir) return before0019Dir;
  const dir = mkdtempSync(join(tmpdir(), "sportozen-0019-folder-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === TAG);
  assert.ok(at > 0, "0019 is in the journal");
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  before0019Dir = dir;
  return dir;
}
const seed = [
  `insert into academy (id, name, timezone) values ('a-1', 'One', 'UTC'), ('a-2', 'Two', 'UTC')`,
  ...["o-1", "g-1", "o-2"].map((id) => `insert into app_user (id, name, email) values ('${id}', '${id}', '${id}@example.test')`),
  `insert into membership (user_id, academy_id, role) values ('o-1', 'a-1', 'OWNER'), ('g-1', 'a-1', 'GUARDIAN'), ('o-2', 'a-2', 'OWNER')`,
  `insert into branch (id, academy_id, name) values ('br-1', 'a-1', 'B'), ('br-2', 'a-2', 'B')`,
  `insert into batch (id, academy_id, name, branch_id, coach_id) values ('bt-1', 'a-1', 'Batch', 'br-1', 'o-1'), ('bt-2', 'a-2', 'Batch', 'br-2', 'o-2')`,
  `insert into player (id, academy_id, name, batch_id) values ('p-1', 'a-1', 'Player One', 'bt-1'), ('p-2', 'a-2', 'Player Two', 'bt-2')`,
  `insert into player_report (id, academy_id, player_id, data) values ('r-1', 'a-1', 'p-1', '{}'::jsonb)`,
];
const accounts = `select to_jsonb(u) as v from app_user u order by u.id`;
const memberships = `select to_jsonb(m) as v from membership m order by 1`;
const reports = `select to_jsonb(r) as v from player_report r order by r.id`;
const bookkeeping = `select hash, created_at::text as created_at from drizzle."__drizzle_migrations" order by created_at`;
const NEW_TABLES = ["contact_point", "report_policy", "dispatch_batch", "dispatch_item", "dispatch_event", "report_link"];
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
const snapshot = async (db: Db) => JSON.stringify([await db.query(accounts), await db.query(memberships), await db.query(reports)]);
async function upgraded(engine: Engine) {
  const db = await engine.fresh();
  await runMigrations({ target: db.target, folder: folderBefore0019() });
  for (const statement of seed) await db.query(statement);
  const before = await snapshot(db);
  const report = await runMigrations({ target: db.target });
  assert.deepEqual(report.pending, [TAG]);
  return { db, before };
}
const refuses = (db: Db, sql: string, code: string, why: string) =>
  assert.rejects(
    () => db.query(sql),
    (e: unknown) => sqlState(e) === code,
    why,
  );
const total = async (db: Db) => {
  let n = 0;
  for (const t of NEW_TABLES) n += ((await db.query(`select count(*)::int as n from ${t}`))[0] as { n: number }).n;
  return n;
};
const contact = (cols: string, vals: string) => `insert into contact_point (academy_id, ${cols}) values ('a-1', ${vals})`;
const BATCH = "00000000-0000-0000-0000-0000000000b1";

for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(`[${engine.name}] 0019 is additive: no account, membership or report changes; every new table starts empty; re-running is a no-op`, opts, async () => {
    const { db, before } = await upgraded(engine);
    assert.equal(await snapshot(db), before, "accounts, memberships and reports are untouched");
    assert.equal(await total(db), 0, "nothing is invented: no contact, policy, batch, item, event or link");
    assert.deepEqual(await db.query(`select count(*)::int as n from observation_review where category is not null`), [{ n: 0 }]);
    assert.deepEqual((await runMigrations({ target: db.target })).pending, [], "re-running is a no-op");
  });

  test(`[${engine.name}] 0019 contacts: a parent and a player may share ANY value; the shape, opt-in and suppression rules are enforced by the database`, opts, async () => {
    const { db } = await upgraded(engine);
    // The same e-mail and the same number for a player and for a parent account: plain rows, no merging.
    await db.query(contact("player_id, channel, address", `'p-1', 'EMAIL', 'family@example.test'`));
    await db.query(contact("user_id, channel, address", `'g-1', 'EMAIL', 'family@example.test'`));
    await db.query(contact("player_id, channel, address", `'p-1', 'WHATSAPP', '+919876543210'`));
    await db.query(contact("user_id, channel, address", `'g-1', 'WHATSAPP', '+919876543210'`));
    await db.query(contact("user_id, channel, address", `'g-1', 'WHATSAPP', '+919876500000'`));
    assert.deepEqual(await db.query(`select count(*)::int as n from contact_point`), [{ n: 5 }]);
    await refuses(db, contact("user_id, channel, address", `'g-1', 'EMAIL', 'family@example.test'`), "23505", "the same subject cannot hold the same address twice");
    await refuses(db, contact("player_id, user_id, channel, address", `'p-1', 'g-1', 'EMAIL', 'both@example.test'`), "23514", "exactly one subject");
    await refuses(db, contact("channel, address", `'EMAIL', 'nobody@example.test'`), "23514", "a contact belongs to someone");
    await refuses(db, contact("user_id, channel, address", `'g-1', 'WHATSAPP', '12345'`), "23514", "a number is E.164");
    await refuses(db, contact("user_id, channel, address", `'g-1', 'EMAIL', 'Upper@Example.test'`), "23514", "an address is lower case");
    await refuses(db, contact("user_id, channel, address", `'g-1', 'EMAIL', 'not an address'`), "23514", "an address looks like one");
    await refuses(db, contact("user_id, channel, address", `'g-1', 'SMS', '+919876543211'`), "23514", "only e-mail and WhatsApp");
    // tenancy: a player or member of ANOTHER academy cannot be the subject
    await refuses(db, contact("player_id, channel, address", `'p-2', 'EMAIL', 'x@example.test'`), "23503", "a player of another academy");
    await refuses(db, contact("user_id, channel, address", `'o-2', 'EMAIL', 'y@example.test'`), "23503", "a member of another academy");
    // WhatsApp opt-in: only on a WhatsApp number, source and time travel together, the source is a known one
    await db.query(`update contact_point set opted_in_at = now(), opt_in_source = 'INVITATION_ACCEPT' where channel = 'WHATSAPP' and user_id = 'g-1' and address = '+919876543210'`);
    await refuses(db, `update contact_point set opted_in_at = now(), opt_in_source = 'OWNER_VERBAL' where channel = 'EMAIL' and user_id = 'g-1'`, "23514", "opt-in is WhatsApp only");
    await refuses(db, `update contact_point set opt_in_source = 'OWNER_WRITTEN' where address = '+919876500000'`, "23514", "a source needs its time");
    await refuses(db, `update contact_point set opted_in_at = now(), opt_in_source = 'GUESS' where address = '+919876500000'`, "23514", "a known source");
    await db.query(`update contact_point set opt_in_revoked_at = now() where address = '+919876543210' and user_id = 'g-1'`);
    // suppression: reason and time travel together
    await refuses(db, `update contact_point set suppressed_at = now() where channel = 'EMAIL' and player_id = 'p-1'`, "23514", "a suppression needs its reason");
    await db.query(`update contact_point set suppressed_at = now(), suppression_reason = 'BOUNCED' where channel = 'EMAIL' and player_id = 'p-1'`);
  });

  test(`[${engine.name}] 0019 delivery queue: one item per address in a batch, valid statuses, skip reasons, once-only provider events, links bound to a real report`, opts, async () => {
    const { db } = await upgraded(engine);
    await db.query(`insert into dispatch_batch (id, academy_id, title, recipient_mode, channels, report_ids, created_by) values ('${BATCH}', 'a-1', 'March', 'BOTH', '["EMAIL"]', '["r-1"]', 'o-1')`);
    const item = (hash: string, cols = "", vals = "", academy = "a-1") =>
      `insert into dispatch_item (academy_id, batch_id, channel, address, address_hash, recipient_names, report_ids${cols}) values ('${academy}', '${BATCH}', 'EMAIL', 'family@example.test', '${hash}', '["A"]', '["r-1"]'${vals})`;
    await db.query(item("h1"));
    await refuses(db, item("h1"), "23505", "two recipients sharing an address are ONE item in a batch (no duplicate send)");
    await db.query(item("h2", ", status, skip_reason", `, 'SKIPPED', 'No contact'`));
    await refuses(db, item("h3", ", status", `, 'SKIPPED'`), "23514", "a skipped item says why");
    await refuses(db, item("h4", ", skip_reason", `, 'because'`), "23514", "a reason only on a skipped item");
    await refuses(db, item("h5", ", status", `, 'DONE'`), "23514", "only known statuses");
    await refuses(db, item("h6", "", "", "a-2"), "23503", "an item belongs to a batch of ITS academy");
    await refuses(db, `insert into dispatch_batch (academy_id, title, recipient_mode, channels, report_ids, created_by) values ('a-1', 'x', 'EVERYONE', '[]', '[]', 'o-1')`, "23514", "known recipient modes");
    await refuses(db, `insert into dispatch_batch (academy_id, title, recipient_mode, channels, report_ids, created_by, approved_at) values ('a-1', 'x', 'BOTH', '[]', '[]', 'o-1', now())`, "23514", "an approval names who and when");
    const itemId = ((await db.query(`select id from dispatch_item where address_hash = 'h1'`))[0] as { id: string }).id;
    const event = (id: string, type: string) => `insert into dispatch_event (academy_id, item_id, provider, provider_event_id, type, occurred_at) values ('a-1', '${itemId}', 'test', '${id}', '${type}', now())`;
    await db.query(event("evt-1", "DELIVERED"));
    await refuses(db, event("evt-1", "DELIVERED"), "23505", "a provider event is recorded once");
    await refuses(db, event("evt-2", "MAYBE"), "23514", "known event types");
    const link = (report: string) => `insert into report_link (academy_id, item_id, report_id, expires_at) values ('a-1', '${itemId}', '${report}', now() + interval '30 days')`;
    await db.query(link("r-1"));
    await refuses(db, link("r-1"), "23505", "one link per item and report");
    await refuses(db, link("no-such-report"), "23503", "a link names a real report of this academy");
  });

  test(`[${engine.name}] 0019 report policy: bounded values only, one per academy`, opts, async () => {
    const { db } = await upgraded(engine);
    await db.query(`insert into report_policy (academy_id, monthly_enabled, sessions_enabled, sessions_n, required_categories) values ('a-1', true, true, 8, '["BEHAVIOUR"]')`);
    await refuses(db, `insert into report_policy (academy_id, sessions_n) values ('a-2', 1)`, "23514", "N is at least 2");
    await refuses(db, `insert into report_policy (academy_id, sessions_n) values ('a-2', 61)`, "23514", "N is at most 60");
    await refuses(db, `insert into report_policy (academy_id, required_categories) values ('a-2', '{"a":1}')`, "23514", "categories are a list");
    await refuses(db, `insert into report_policy (academy_id) values ('a-1')`, "23505", "one policy per academy");
    const columns = await db.query(`select column_name from information_schema.columns where table_name = 'observation_review' and column_name = 'category'`);
    assert.equal(columns.length, 1, "observation_review.category exists");
    const checks = await db.query(`select conname from pg_constraint where conname = 'observation_review_category'`);
    assert.equal(checks.length, 1, "and only the four known categories are allowed");
  });

  test(`[${engine.name}] 0019 rollback rehearsal: the previous schema is restored exactly, nothing else changes, only 0019's record is removed, and 0019 re-applies`, opts, async () => {
    const reference = await engine.fresh();
    await runMigrations({ target: reference.target, folder: folderBefore0019() });
    const { db, before } = await upgraded(engine);
    const records = await db.query(bookkeeping);
    assert.equal(records.at(-1)!.created_at, String(WHEN));
    await db.script(readFileSync(ROLLBACK, "utf8"));
    assert.equal(await schemaState(db), await schemaState(reference), "identical to a database that never had 0019 (tables, constraints, triggers, indexes, functions)");
    assert.equal(await snapshot(db), before, "accounts, memberships and reports are untouched");
    assert.deepEqual(await db.query(bookkeeping), records.slice(0, -1), "only 0019's record is removed");
    assert.deepEqual((await runMigrations({ target: db.target })).pending, [TAG], "0019 re-applies");
    assert.equal(await total(db), 0);
  });

  test(`[${engine.name}] 0019 rollback guard: refuses, changing nothing, unless 0019 is applied (reviewed hash), latest, intact, and any history is confirmed`, opts, async () => {
    const rollback = readFileSync(ROLLBACK, "utf8");
    const stateOf = async (db: Db) => {
      const has = ((await db.query(`select to_regclass('public.contact_point') is not null as has`))[0] as { has: boolean }).has;
      return JSON.stringify([await schemaState(db), await db.query(bookkeeping), await snapshot(db), has ? await db.query(`select to_jsonb(c) as v from contact_point c order by 1`) : "no table"]);
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
      await refusedWith(db, /0019 rollback refused: migration 0019_contacts_dispatch is not recorded as applied/, "second run");
      assert.deepEqual(await db.query(bookkeeping), records, "the previous migration's record is never removed");
    }
    {
      const { db } = await upgraded(engine);
      await db.query(`insert into drizzle."__drizzle_migrations" (hash, created_at) values ('a-later-migration', ${WHEN + 1})`);
      await refusedWith(db, /0019 rollback refused: 1 later migration\(s\) are applied after 0019/, "not the latest");
    }
    {
      const { db } = await upgraded(engine);
      await db.query(`update drizzle."__drizzle_migrations" set hash = 'not-the-reviewed-0019' where created_at = ${WHEN}`);
      await refusedWith(db, /not recorded as applied/, "unexpected hash");
    }
    {
      const { db } = await upgraded(engine);
      await db.query(`drop index dispatch_item_one_per_address`);
      await refusedWith(db, /schema does not match migration 0019 \(missing: index dispatch_item_one_per_address\)/, "partial schema");
    }
    {
      // real data: opt-in records and delivery history are only destroyed with an explicit, same-session confirmation
      const { db } = await upgraded(engine);
      await db.query(contact("user_id, channel, address, opted_in_at, opt_in_source", `'g-1', 'WHATSAPP', '+919876543210', now(), 'OWNER_WRITTEN'`));
      await refusedWith(db, /1 row\(s\) of contacts, policy, delivery history, links or category tags would be destroyed/, "data exists");
      await refusedWith(db, /would be destroyed/, "a wrong confirmation value", `SET sportozen.rollback_dispatch = 'yes';\n${rollback}`);
      await db.script(`SET sportozen.rollback_dispatch = 'destroy';\n${rollback}`);
      assert.deepEqual(await db.query(`select to_regclass('public.contact_point') is not null as has`), [{ has: false }], "rolled back after the explicit confirmation");
    }
  });
}

test("0019's rollback is pinned to the reviewed migration file and kept outside the folder the runner applies", () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, `${TAG}.sql`));
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const rollback = readFileSync(ROLLBACK, "utf8");
  assert.ok(!sql.includes("\r\n"), "the migration is stored with LF line endings");
  assert.ok(rollback.includes(hash(sql)), "the rollback names the hash of the current 0019 file");
  assert.ok(rollback.includes(hash(Buffer.from(sql.toString("utf8").replace(/\n/g, "\r\n")))), "and of its CRLF checkout");
  assert.ok(rollback.includes(String(WHEN)));
  assert.ok(ROLLBACK.replace(/\\/g, "/").includes("/migrations-rollback/"));
  assert.ok(!existsSync(join(MIGRATIONS_DIR, `${TAG}.down.sql`)));
});
