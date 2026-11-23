import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { Client } from "pg";
import * as schema from "../src/infrastructure/database/schema";
import {
  MigrationError,
  assertSafeTarget,
  describeTarget,
  runMigrations,
  targetFromEnv,
  verifyMigrationFolder,
  type MigrationTarget,
} from "../src/infrastructure/database/migrations";
import { adminUrl, createPostgresDatabase } from "./helpers/test-database";
import { HOOK_TIMEOUT, MIGRATIONS_DIR, REPO_ROOT } from "./helpers/paths";
/**
 * The migration runner and the migration chain itself.
 * The same scenarios run on embedded PGlite (always) and on a real PostgreSQL server
 * (when TEST_POSTGRES_ADMIN_URL is set — `npm run test:pg` starts a disposable container).
 */
const FOLDER = MIGRATIONS_DIR;
// The chain length is read from the repository, so adding a migration never needs a count edited here.
const TOTAL = verifyMigrationFolder(FOLDER).length;
// Tag prefix for a migration appended after the real chain (the runner enforces numeric order).
const NEXT = String(TOTAL).padStart(4, "0");
const cleanups: (() => Promise<void> | void)[] = [];
after(
  async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  },
  { timeout: HOOK_TIMEOUT },
);
type Engine = {
  name: string;
  fresh(): Promise<{
    target: MigrationTarget;
    query(sql: string): Promise<Record<string, unknown>[]>;
    /** Runs a multi-statement script (a rollback file) on one connection. */
    script(sql: string): Promise<void>;
  }>;
};
/**
 * Initialising a brand-new PGlite data directory costs ~10-16 s. Do it once (empty, unmigrated),
 * then copy it for each scenario; the runner under test still starts from a database with no tables.
 */
let template: Promise<string> | undefined;
function pgliteTemplate() {
  template ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-template-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const client = new PGlite(join(dir, "db"));
    await client.query("select 1");
    await client.close();
    return dir;
  })();
  return template;
}
const pgliteEngine: Engine = {
  name: "PGlite",
  async fresh() {
    const dir = mkdtempSync(join(tmpdir(), "sportozen-mig-"));
    cpSync(await pgliteTemplate(), dir, { recursive: true });
    const path = join(dir, "db");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return {
      target: { kind: "pglite", path },
      async query(sql) {
        const client = new PGlite(path);
        try {
          return (await client.query(sql)).rows as Record<string, unknown>[];
        } finally {
          await client.close();
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
    return {
      target: { kind: "postgres", url: created.url },
      async query(sql) {
        const client = new Client({ connectionString: created.url });
        await client.connect();
        try {
          return (await client.query(sql)).rows;
        } finally {
          await client.end();
        }
      },
      async script(sql) {
        const client = new Client({ connectionString: created.url });
        await client.connect();
        try {
          await client.query(sql);
        } finally {
          await client.end();
        }
      },
    };
  },
};
const tables = `select table_name from information_schema.tables where table_schema='public' order by 1`;
const fingerprintSql = `
  select c.table_name, c.column_name, c.data_type, c.is_nullable
  from information_schema.columns c where c.table_schema='public' order by 1,2`;
// NOT NULL appears as a pg_constraint row only from PostgreSQL 18 (contype 'n'); nullability is
// already compared through information_schema.columns, so it is excluded to stay version-neutral.
const constraintSql = `
  select conrelid::regclass::text as tbl, conname, contype
  from pg_constraint where connamespace = 'public'::regnamespace and contype <> 'n' order by 1,2`;
const expectedTables = Object.values(schema)
  .filter((x) => is(x, PgTable))
  .map((x) => getTableName(x as PgTable))
  .sort();
/** A copy of the migrations folder that tests may extend or damage. */
function scratchFolder() {
  const dir = mkdtempSync(join(tmpdir(), "sportozen-folder-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(FOLDER, dir, { recursive: true });
  return dir;
}
function appendMigration(folder: string, tag: string, sql: string) {
  const path = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8"));
  const last = journal.entries.at(-1);
  journal.entries.push({
    idx: last.idx + 1,
    version: "7",
    when: last.when + 1000,
    tag,
    breakpoints: true,
  });
  writeFileSync(path, JSON.stringify(journal, null, 2));
  writeFileSync(join(folder, `${tag}.sql`), sql);
}
test("the repository's migration folder is internally consistent", () => {
  const entries = verifyMigrationFolder(FOLDER);
  assert.deepEqual(
    entries.map((e) => e.tag),
    [
      "0000_quiet_network",
      "0001_dark_paladin",
      "0002_loud_gladiator",
      "0003_military_the_twelve",
      "0004_account_security",
      "0005_nutrition_assignment",
      "0006_mfa_policy",
      "0007_consent_management",
      "0008_access_audit",
      "0009_privacy_lifecycle",
      "0010_payment_attempts",
      "0011_coach_assignment_integrity",
      "0012_calendar_series",
      "0013_role_validation_owner_presence",
      "0014_adult_guardian_access",
      "0015_auth_onboarding_and_outbox",
      "0016_guardian_phone",
      "0017_multi_academy_session",
      "0018_academy_invitations",
    "0019_contacts_dispatch",
  ],
  );
});
for (const engine of [pgliteEngine, postgresEngine]) {
  const opts =
    engine === postgresEngine && !admin
      ? { skip: "TEST_POSTGRES_ADMIN_URL not set — run `npm run test:pg`" }
      : {};
  test(
    `[${engine.name}] the full chain applies in order and produces exactly the tables Drizzle's schema defines`,
    opts,
    async () => {
      const db = await engine.fresh();
      const report = await runMigrations({ target: db.target });
      assert.deepEqual(report.applied, []);
      assert.equal(report.pending.length, TOTAL);
      const present = (await db.query(tables)).map(
        (r) => r.table_name as string,
      );
      assert.deepEqual(
        present,
        expectedTables,
        "migrated tables differ from schema.ts (run drizzle-kit generate?)",
      );
      const log = await db.query(
        `select hash, created_at from drizzle."__drizzle_migrations" order by created_at`,
      );
      assert.equal(log.length, TOTAL);
    },
  );
  test(
    `[${engine.name}] re-running is a no-op; --plan changes nothing`,
    opts,
    async () => {
      const db = await engine.fresh();
      const planned = await runMigrations({ target: db.target, dryRun: true });
      assert.equal(planned.pending.length, TOTAL);
      assert.equal(
        (await db.query(tables)).length,
        0,
        "dry run must not create anything",
      );
      await runMigrations({ target: db.target });
      const again = await runMigrations({ target: db.target });
      assert.equal(again.pending.length, 0);
      assert.equal(again.applied.length, TOTAL);
      assert.equal(
        (await db.query(`select 1 from drizzle."__drizzle_migrations"`)).length,
        TOTAL,
      );
    },
  );
  test(
    `[${engine.name}] a failing migration leaves nothing behind, and a later fix applies cleanly`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      const before = JSON.stringify(await db.query(fingerprintSql));
      const folder = scratchFolder();
      appendMigration(
        folder,
        `${NEXT}_broken`,
        `CREATE TABLE "zz_partial" ("id" text PRIMARY KEY);--> statement-breakpoint\nTHIS IS NOT SQL;`,
      );
      await assert.rejects(
        () => runMigrations({ target: db.target, folder }),
        /syntax|THIS/i,
      );
      assert.ok(
        !(await db.query(tables)).some((r) => r.table_name === "zz_partial"),
        "partial DDL leaked",
      );
      assert.equal(JSON.stringify(await db.query(fingerprintSql)), before);
      assert.equal(
        (await db.query(`select 1 from drizzle."__drizzle_migrations"`)).length,
        TOTAL,
      );
      writeFileSync(
        join(folder, `${NEXT}_broken.sql`),
        `CREATE TABLE "zz_partial" ("id" text PRIMARY KEY);`,
      );
      const fixed = await runMigrations({ target: db.target, folder });
      assert.deepEqual(fixed.pending, [`${NEXT}_broken`]);
      assert.ok(
        (await db.query(tables)).some((r) => r.table_name === "zz_partial"),
      );
    },
  );
  test(
    `[${engine.name}] a failing migration on a fresh database leaves the whole chain unapplied`,
    opts,
    async () => {
      const db = await engine.fresh();
      const folder = scratchFolder();
      appendMigration(folder, `${NEXT}_broken`, `THIS IS NOT SQL;`);
      await assert.rejects(() => runMigrations({ target: db.target, folder }));
      assert.equal(
        (await db.query(tables)).length,
        0,
        "no table from the existing chain may survive a failed run",
      );
    },
  );
  test(
    `[${engine.name}] a migration edited after it was applied is detected`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      const folder = scratchFolder();
      writeFileSync(
        join(folder, "0003_military_the_twelve.sql"),
        readFileSync(join(folder, "0003_military_the_twelve.sql"), "utf8") +
          "\n-- edited\n",
      );
      await assert.rejects(
        () => runMigrations({ target: db.target, folder }),
        /modified after it was applied/,
      );
    },
  );
  test(
    `[${engine.name}] a database from another branch (unknown applied migration) is refused`,
    opts,
    async () => {
      const db = await engine.fresh();
      const folder = scratchFolder();
      appendMigration(
        folder,
        `${NEXT}_extra`,
        `CREATE TABLE "zz_extra" ("id" text PRIMARY KEY);`,
      );
      await runMigrations({ target: db.target, folder });
      await assert.rejects(
        () => runMigrations({ target: db.target }),
        /not in this migrations folder/,
      );
    },
  );
}
test(
  "[PostgreSQL] a second migrator is refused while the migration lock is held",
  {
    skip: admin
      ? false
      : "TEST_POSTGRES_ADMIN_URL not set — run `npm run test:pg`",
  },
  async () => {
    const db = await postgresEngine.fresh();
    const holder = new Client({
      connectionString: (db.target as { url: string }).url,
    });
    await holder.connect();
    try {
      await holder.query("select pg_advisory_lock(7102026)");
      await assert.rejects(
        () => runMigrations({ target: db.target }),
        /already running/,
      );
      await holder.query("select pg_advisory_unlock(7102026)");
      assert.equal(
        (await runMigrations({ target: db.target })).pending.length,
        TOTAL,
      );
    } finally {
      await holder.end();
    }
  },
);
test(
  "[PostgreSQL] the migrated schema is identical to the embedded PGlite one (columns and constraints)",
  {
    skip: admin
      ? false
      : "TEST_POSTGRES_ADMIN_URL not set — run `npm run test:pg`",
  },
  async () => {
    const [a, b] = [await pgliteEngine.fresh(), await postgresEngine.fresh()];
    await runMigrations({ target: a.target });
    await runMigrations({ target: b.target });
    assert.deepEqual(
      await b.query(fingerprintSql),
      await a.query(fingerprintSql),
    );
    assert.deepEqual(
      await b.query(constraintSql),
      await a.query(constraintSql),
    );
  },
);
test(
  "[PostgreSQL] composite foreign keys reject cross-academy references on a real server",
  {
    skip: admin
      ? false
      : "TEST_POSTGRES_ADMIN_URL not set — run `npm run test:pg`",
  },
  async () => {
    const db = await postgresEngine.fresh();
    await runMigrations({ target: db.target });
    await db.query(
      `insert into academy values ('a','A','UTC'),('b','B','UTC')`,
    );
    await db.query(
      `insert into app_user (id,name,email) values ('u','U','u@example.test')`,
    );
    await db.query(
      `insert into membership (user_id,academy_id,role) values ('u','a','COACH')`,
    );
    await db.query(
      `insert into branch (id,academy_id,name) values ('br','a','Br')`,
    );
    await db.query(
      `insert into batch (id,academy_id,name,branch_id,coach_id) values ('ba','a','Ba','br','u')`,
    );
    await assert.rejects(
      () =>
        db.query(
          `insert into player (id,academy_id,name,batch_id) values ('p','b','P','ba')`,
        ),
      /foreign key|violates/i,
    );
  },
);
test("remote databases need an exact confirmation; loopback does not; credentials are never described", () => {
  const remote: MigrationTarget = {
    kind: "postgres",
    url: "postgres://admin:s3cr3t-pass@db.example.com:5432/sportozen?sslmode=require",
  };
  assert.equal(describeTarget(remote), "db.example.com:5432/sportozen");
  assert.ok(!describeTarget(remote).includes("s3cr3t"));
  assert.throws(() => assertSafeTarget(remote, {}), MigrationError);
  assert.throws(
    () =>
      assertSafeTarget(remote, {
        MIGRATION_CONFIRM_TARGET: "db.example.com:5432/other",
      }),
    /Refusing/,
  );
  assert.doesNotThrow(() =>
    assertSafeTarget(remote, {
      MIGRATION_CONFIRM_TARGET: "db.example.com:5432/sportozen",
    }),
  );
  for (const host of ["localhost", "127.0.0.1", "[::1]"])
    assert.doesNotThrow(() =>
      assertSafeTarget(
        { kind: "postgres", url: `postgres://u:p@${host}:5432/db` },
        {},
      ),
    );
  assert.throws(
    () => describeTarget({ kind: "postgres", url: "mysql://x/y" }),
    /postgres/,
  );
  assert.throws(
    () => describeTarget({ kind: "postgres", url: "not a url" }),
    /must start with postgres/,
  );
  try {
    assertSafeTarget(remote, {});
  } catch (error) {
    assert.ok(
      !(error as Error).message.includes("s3cr3t"),
      "error leaked the password",
    );
  }
});
test("target selection: DATABASE_URL wins; production never falls back to the embedded database", () => {
  assert.deepEqual(
    targetFromEnv({
      DATABASE_URL: "postgres://h/d",
      LOCAL_DATABASE_PATH: "./x",
    }),
    { kind: "postgres", url: "postgres://h/d" },
  );
  assert.deepEqual(targetFromEnv({ LOCAL_DATABASE_PATH: "./x" }), {
    kind: "pglite",
    path: "./x",
  });
  assert.throws(
    () =>
      targetFromEnv({
        NODE_ENV: "production",
        LOCAL_DATABASE_PATH: "./x",
      }),
    /Production/,
  );
  assert.throws(() => targetFromEnv({}), /DATABASE_URL/);
});
test("journal problems that would make drizzle silently skip a migration are rejected", () => {
  const folder = scratchFolder();
  const path = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8"));
  journal.entries[2].when = journal.entries[1].when - 1;
  writeFileSync(path, JSON.stringify(journal));
  assert.throws(() => verifyMigrationFolder(folder), /not newer/);
  journal.entries[2].when = journal.entries[1].when + 1;
  rmSync(join(folder, "0002_loud_gladiator.sql"));
  writeFileSync(path, JSON.stringify(journal));
  assert.throws(() => verifyMigrationFolder(folder), /Missing 0002/);
});
test("`npm run db:migrate` keeps working for the embedded development database, and refuses an unconfirmed remote target", () => {
  const dir = mkdtempSync(join(tmpdir(), "sportozen-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const run = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        join(REPO_ROOT, "scripts/migrate.ts"),
        ...(env.PLAN ? ["--plan"] : []),
      ],
      {
        // Deliberately NOT the repository: the runner and scripts must not depend on the caller's cwd.
        cwd: tmpdir(),
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          NODE_ENV: "development",
          ...env,
        },
        encoding: "utf8",
      },
    );
  const local = { LOCAL_DATABASE_PATH: join(dir, "dev") };
  const plan = run({ ...local, PLAN: "1" });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /Would apply: 0000_quiet_network/);
  const first = run(local);
  assert.equal(first.status, 0, first.stderr);
  assert.match(
    first.stdout,
    /Applied: 0000_quiet_network.*0009_privacy_lifecycle/,
  );
  const second = run(local);
  assert.match(second.stdout, /up to date/);
  const remote = run({
    DATABASE_URL: "postgres://user:topsecret@db.invalid:5432/prod",
  });
  assert.equal(remote.status, 1);
  assert.match(
    remote.stderr,
    /Refusing to migrate remote database db\.invalid:5432\/prod/,
  );
  assert.ok(
    !remote.stderr.includes("topsecret") &&
      !remote.stdout.includes("topsecret"),
  );
  const nothing = run({});
  assert.equal(nothing.status, 1);
  assert.match(nothing.stderr, /DATABASE_URL|LOCAL_DATABASE_PATH/);
});

/* ===================== Phase 2.1 corrections (Gemini review H1, M1, M2, L2) ===================== */
const eol = (style: "lf" | "crlf") => {
  const dir = scratchFolder();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const lf = readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n");
    writeFileSync(
      join(dir, f),
      style === "lf" ? lf : lf.replace(/\n/g, "\r\n"),
    );
  }
  return dir;
};
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
const treeHash = (dir: string) => {
  const hash = createHash("sha256");
  for (const f of walk(dir).sort())
    hash.update(f.slice(dir.length)).update(readFileSync(f));
  return hash.digest("hex");
};
const PG_ONLY = admin
  ? false
  : "TEST_POSTGRES_ADMIN_URL not set — run `npm run test:pg`";
for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(
    `[${engine.name}] H1: a migration older than the latest applied one, merged in later, is rejected instead of silently skipped`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      // The reviewer's scenario: another branch's migration (timestamp between 0002 and 0003) is
      // merged in after 0003 was already applied; the old tail is renumbered 0004.
      const merged = scratchFolder();
      const journalPath = join(merged, "meta/_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const old3 = journal.entries[3];
      renameSync(
        join(merged, `${old3.tag}.sql`),
        join(merged, "0004_military_the_twelve.sql"),
      );
      writeFileSync(
        join(merged, "0003_from_other_branch.sql"),
        `CREATE TABLE "zz_must_exist" ("id" text PRIMARY KEY);`,
      );
      journal.entries = [
        ...journal.entries.slice(0, 3),
        {
          idx: 3,
          version: "7",
          when: journal.entries[2].when + 1000,
          tag: "0003_from_other_branch",
          breakpoints: true,
        },
        { ...old3, idx: 4, tag: "0004_military_the_twelve" },
        // Everything after the old tail follows, renumbered (files renamed to match).
        ...journal.entries.slice(4).map((e: { idx: number; tag: string }) => {
          const tag = `${String(e.idx + 1).padStart(4, "0")}${e.tag.slice(4)}`;
          renameSync(join(merged, `${e.tag}.sql`), join(merged, `${tag}.sql`));
          return { ...e, idx: e.idx + 1, tag };
        }),
      ];
      writeFileSync(journalPath, JSON.stringify(journal, null, 2));
      await assert.rejects(
        () => runMigrations({ target: db.target, folder: merged }),
        /Inconsistent migration history.*0003_from_other_branch.*never applied/s,
      );
      await assert.rejects(
        () =>
          runMigrations({ target: db.target, folder: merged, dryRun: true }),
        /Inconsistent/,
      );
      assert.ok(
        !(await db.query(tables)).some((r) => r.table_name === "zz_must_exist"),
      );
    },
  );
  test(
    `[${engine.name}] H1: a recorded migration missing from the middle of the history, or recorded twice, is rejected`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      const journal = JSON.parse(
        readFileSync(join(FOLDER, "meta/_journal.json"), "utf8"),
      );
      await db.query(
        `delete from drizzle."__drizzle_migrations" where created_at = ${journal.entries[1].when}`,
      );
      await assert.rejects(
        () => runMigrations({ target: db.target }),
        /Inconsistent migration history: 0001_dark_paladin was never applied/,
      );
      const [first] = (await db.query(
        `select hash from drizzle."__drizzle_migrations" order by created_at limit 1`,
      )) as { hash: string }[];
      await db.query(
        `insert into drizzle."__drizzle_migrations" (hash, created_at) values ('${first.hash}', ${journal.entries[0].when})`,
      );
      await assert.rejects(
        () => runMigrations({ target: db.target }),
        /(never applied|recorded more than once)/,
      );
    },
  );
  test(
    `[${engine.name}] M2: CRLF and LF checkouts of the same migrations are interchangeable; genuine edits are still caught`,
    opts,
    async () => {
      for (const [applyWith, verifyWith] of [
        ["crlf", "lf"],
        ["lf", "crlf"],
      ] as const) {
        const db = await engine.fresh();
        await runMigrations({ target: db.target, folder: eol(applyWith) });
        const again = await runMigrations({
          target: db.target,
          folder: eol(verifyWith),
        });
        assert.deepEqual(
          again.pending,
          [],
          `${applyWith} -> ${verifyWith} produced a false drift error`,
        );
        assert.equal(again.applied.length, TOTAL);
        for (const style of ["lf", "crlf"] as const) {
          const edited = eol(style);
          const file = join(edited, "0001_dark_paladin.sql");
          writeFileSync(
            file,
            readFileSync(file, "utf8") +
              (style === "crlf" ? "\r\n-- edited\r\n" : "\n-- edited\n"),
          );
          await assert.rejects(
            () => runMigrations({ target: db.target, folder: edited }),
            /0001_dark_paladin was modified after it was applied/,
            `genuine edit (${style}) missed after ${applyWith} apply`,
          );
        }
      }
    },
  );
}
test("[PGlite] L2: planning never creates or modifies a database directory", async () => {
  const holder = mkdtempSync(join(tmpdir(), "sportozen-plan-missing-"));
  cleanups.push(() => rmSync(holder, { recursive: true, force: true }));
  const missing = join(holder, "does-not-exist");
  const planned = await runMigrations({
    target: { kind: "pglite", path: missing },
    dryRun: true,
  });
  assert.equal(planned.pending.length, TOTAL);
  assert.equal(existsSync(missing), false, "plan created the data directory");
  // An existing, partially migrated database: its bytes must be identical afterwards.
  const partial = scratchFolder();
  const jp = join(partial, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  journal.entries = journal.entries.slice(0, 2);
  writeFileSync(jp, JSON.stringify(journal));
  rmSync(join(partial, "0002_loud_gladiator.sql"));
  rmSync(join(partial, "0003_military_the_twelve.sql"));
  rmSync(join(partial, "0004_account_security.sql"));
  rmSync(join(partial, "0005_nutrition_assignment.sql"));
  rmSync(join(partial, "0006_mfa_policy.sql"));
  rmSync(join(partial, "0007_consent_management.sql"));
  rmSync(join(partial, "0008_access_audit.sql"));
  rmSync(join(partial, "0009_privacy_lifecycle.sql"));
  rmSync(join(partial, "0010_payment_attempts.sql"));
  rmSync(join(partial, "0011_coach_assignment_integrity.sql"));
  rmSync(join(partial, "0012_calendar_series.sql"));
  rmSync(join(partial, "0013_role_validation_owner_presence.sql"));
  rmSync(join(partial, "0014_adult_guardian_access.sql"));
  rmSync(join(partial, "0015_auth_onboarding_and_outbox.sql"));
  rmSync(join(partial, "0016_guardian_phone.sql"));
  rmSync(join(partial, "0017_multi_academy_session.sql"));
  rmSync(join(partial, "0018_academy_invitations.sql"));
  rmSync(join(partial, "0019_contacts_dispatch.sql"));
  const db = await pgliteEngine.fresh();
  await runMigrations({ target: db.target, folder: partial });
  const path = (db.target as { path: string }).path;
  const before = treeHash(path);
  // RC-4 test isolation. The plan makes its scratch copy in the operating system's temp directory, which every test
  // process shares: another process planning at the same moment (tests/migrations-0013.test.ts does) has its own
  // `sportozen-plan-*` folder there for an instant, and this test used to blame its own plan for it. The plan under
  // test therefore gets a PRIVATE temp directory (os.tmpdir() reads these variables on every call), so the assertion
  // below is about this plan alone, and is stricter than before: nothing at all may remain in it.
  const privateTemp = mkdtempSync(join(tmpdir(), "sportozen-l2-private-"));
  cleanups.push(() => rmSync(privateTemp, { recursive: true, force: true }));
  const tempVariables = ["TEMP", "TMP", "TMPDIR"] as const;
  const savedTemp = tempVariables.map((name) => process.env[name]);
  let report: Awaited<ReturnType<typeof runMigrations>>;
  try {
    for (const name of tempVariables) process.env[name] = privateTemp;
    assert.equal(tmpdir(), privateTemp, "the plan under test uses the private temp directory");
    report = await runMigrations({ target: db.target, dryRun: true });
  } finally {
    tempVariables.forEach((name, i) => {
      if (savedTemp[i] === undefined) delete process.env[name];
      else process.env[name] = savedTemp[i];
    });
  }
  assert.deepEqual(report.pending, [
    "0002_loud_gladiator",
    "0003_military_the_twelve",
    "0004_account_security",
    "0005_nutrition_assignment",
    "0006_mfa_policy",
    "0007_consent_management",
    "0008_access_audit",
    "0009_privacy_lifecycle",
    "0010_payment_attempts",
    "0011_coach_assignment_integrity",
    "0012_calendar_series",
    "0013_role_validation_owner_presence",
    "0014_adult_guardian_access",
    "0015_auth_onboarding_and_outbox",
    "0016_guardian_phone",
    "0017_multi_academy_session",
    "0018_academy_invitations",
  "0019_contacts_dispatch",
]);
  assert.equal(treeHash(path), before, "plan modified the database directory");
  assert.deepEqual(
    readdirSync(privateTemp),
    [],
    "plan left a scratch copy behind",
  );
});
test(
  "[PostgreSQL] concurrent migrators: exactly one applies, the others are refused cleanly, the lock is released",
  { skip: PG_ONLY },
  async () => {
    for (let round = 0; round < 3; round++) {
      const db = await postgresEngine.fresh();
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => runMigrations({ target: db.target })),
      );
      const done = results.filter((r) => r.status === "fulfilled");
      assert.ok(done.length >= 1, "at least one migrator must succeed");
      for (const r of results)
        if (r.status === "rejected")
          assert.match(
            String(r.reason),
            /already running/,
            "unexpected failure",
          );
      assert.equal(
        done.filter(
          (r) =>
            (r as PromiseFulfilledResult<{ pending: string[] }>).value.pending
              .length === TOTAL,
        ).length,
        1,
        "exactly one migrator applies the chain",
      );
      assert.equal(
        (await db.query(`select 1 from drizzle."__drizzle_migrations"`)).length,
        TOTAL,
      );
      assert.deepEqual(
        (await db.query(tables)).map((r) => r.table_name),
        expectedTables,
      );
      assert.equal(
        (await runMigrations({ target: db.target })).pending.length,
        0,
        "lock not released",
      );
    }
  },
);
test("M1: the confirmed target is where the driver really connects (connection-string overrides cannot bypass it)", () => {
  const resolved = (url: string) => describeTarget({ kind: "postgres", url });
  const refuse = (url: string, shown: string) => {
    assert.throws(
      () => assertSafeTarget({ kind: "postgres", url }, {}),
      (error: Error) =>
        error instanceof MigrationError &&
        error.message.includes(shown) &&
        !error.message.includes(":pw@"),
      url,
    );
    assert.doesNotThrow(() =>
      assertSafeTarget(
        { kind: "postgres", url },
        { MIGRATION_CONFIRM_TARGET: shown },
      ),
    );
  };
  // The reproduction from the review: loopback in the authority, remote in the query.
  assert.equal(
    resolved("postgres://u:pw@localhost:5432/prod?host=prod-db.example.com"),
    "prod-db.example.com:5432/prod",
  );
  refuse(
    "postgres://u:pw@localhost:5432/prod?host=prod-db.example.com",
    "prod-db.example.com:5432/prod",
  );
  // Port override on a remote authority.
  assert.equal(
    resolved("postgres://u:pw@db.example.com:5432/prod?port=6543"),
    "db.example.com:6543/prod",
  );
  refuse(
    "postgres://u:pw@db.example.com:5432/prod?port=6543",
    "db.example.com:6543/prod",
  );
  // The reverse: remote in the authority, loopback in the query -> the driver connects locally.
  assert.equal(
    resolved("postgres://u:pw@db.example.com/prod?host=localhost"),
    "localhost:5432/prod",
  );
  assert.doesNotThrow(() =>
    assertSafeTarget(
      {
        kind: "postgres",
        url: "postgres://u:pw@db.example.com/prod?host=localhost",
      },
      {},
    ),
  );
  // Unix sockets (e.g. Cloud SQL) are not loopback: they need the exact confirmation.
  refuse(
    "postgres:///prod?host=/cloudsql/proj:region:inst",
    "/cloudsql/proj:region:inst:5432/prod",
  );
  // Multiple hosts are not a loopback target.
  refuse(
    "postgres://u:pw@localhost/prod?host=a.example.com,b.example.com",
    "a.example.com,b.example.com:5432/prod",
  );
  // hostaddr means different things to different tools: refused outright.
  assert.throws(
    () => resolved("postgres://u:pw@localhost/prod?hostaddr=10.1.2.3"),
    /hostaddr/,
  );
  // PGHOST/PGPORT fallbacks apply when the URL omits them.
  const saved = { host: process.env.PGHOST, port: process.env.PGPORT };
  process.env.PGHOST = "env-db.example.com";
  process.env.PGPORT = "5433";
  try {
    assert.equal(resolved("postgres:///prod"), "env-db.example.com:5433/prod");
    refuse("postgres:///prod", "env-db.example.com:5433/prod");
  } finally {
    for (const [k, v] of [
      ["PGHOST", saved.host],
      ["PGPORT", saved.port],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  // Loopback forms: case, whole 127/8 range, IPv6.
  for (const host of ["LOCALHOST", "127.0.0.1", "127.8.9.10", "[::1]"])
    assert.doesNotThrow(
      () =>
        assertSafeTarget(
          { kind: "postgres", url: `postgres://u:pw@${host}:5432/db` },
          {},
        ),
      host,
    );
  for (const host of [
    "0.0.0.0",
    "10.0.0.5",
    "192.168.1.9",
    "localhost.example.com",
  ])
    assert.throws(
      () =>
        assertSafeTarget(
          { kind: "postgres", url: `postgres://u:pw@${host}:5432/db` },
          {},
        ),
      MigrationError,
      host,
    );
});
test("M1: a bypass attempt is refused before any connection is made, by the runner and by the test helper", async () => {
  // db.invalid never resolves: a connection attempt would fail with 'Cannot connect', not 'Refusing'.
  const url = "postgres://u:pw@localhost:5432/prod?host=db.invalid";
  await assert.rejects(
    () => runMigrations({ target: { kind: "postgres", url } }),
    /Refusing to migrate remote database db\.invalid:5432\/prod/,
  );
  await assert.rejects(
    () => runMigrations({ target: { kind: "postgres", url }, dryRun: true }),
    /Refusing/,
  );
  const saved = process.env.TEST_POSTGRES_ADMIN_URL;
  process.env.TEST_POSTGRES_ADMIN_URL = url;
  try {
    assert.throws(
      () => adminUrl(),
      /db\.invalid, which is not a local, disposable server/,
    );
    process.env.TEST_POSTGRES_ADMIN_URL =
      "postgres://u:pw@localhost/postgres?hostaddr=10.0.0.1";
    assert.throws(() => adminUrl(), /hostaddr/);
  } finally {
    if (saved === undefined) delete process.env.TEST_POSTGRES_ADMIN_URL;
    else process.env.TEST_POSTGRES_ADMIN_URL = saved;
  }
});
test("migration folder checks: unlisted .sql files, bad timeout settings, and caller-independent defaults", async () => {
  const folder = scratchFolder();
  writeFileSync(join(folder, "0009_orphan.sql"), "select 1;");
  assert.throws(
    () => verifyMigrationFolder(folder),
    /0009_orphan\.sql is not listed in the migration journal/,
  );
  await assert.rejects(
    () =>
      runMigrations({
        target: { kind: "postgres", url: "postgres://u:pw@127.0.0.1:1/db" },
        env: { MIGRATION_STATEMENT_TIMEOUT_MS: "abc" },
      }),
    /MIGRATION_STATEMENT_TIMEOUT_MS/,
  );
  const cwd = process.cwd();
  process.chdir(tmpdir());
  try {
    const planned = await runMigrations({
      target: {
        kind: "pglite",
        path: join(tmpdir(), "sportozen-never-created"),
      },
      dryRun: true,
    });
    assert.equal(
      planned.pending.length,
      TOTAL,
      "default migrations folder must not depend on the cwd",
    );
  } finally {
    process.chdir(cwd);
  }
});

/* ===================== Phase 2.2: 0004_account_security ===================== */
const ROLLBACK = join(
  REPO_ROOT,
  "migrations-rollback",
  "0004_account_security.down.sql",
);
const ROLLBACK_0005 = join(
  REPO_ROOT,
  "migrations-rollback",
  "0005_nutrition_assignment.down.sql",
);
const ROLLBACK_0006 = join(
  REPO_ROOT,
  "migrations-rollback",
  "0006_mfa_policy.down.sql",
);
const ROLLBACK_0007 = join(
  REPO_ROOT,
  "migrations-rollback",
  "0007_consent_management.down.sql",
);
const ROLLBACK_0008 = join(
  REPO_ROOT,
  "migrations-rollback",
  "0008_access_audit.down.sql",
);
const ROLLBACK_0009 = join(
  REPO_ROOT,
  "migrations-rollback",
  "0009_privacy_lifecycle.down.sql",
);
const STAMP = "'2030-01-01 00:00:00'";
/** The chain up to (excluding) `tag`, as an upgrade starting point. */
function folderBefore(tag: string) {
  const dir = scratchFolder();
  const jp = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  const at = journal.entries.findIndex((e: { tag: string }) => e.tag === tag);
  for (const e of journal.entries.slice(at)) rmSync(join(dir, `${e.tag}.sql`));
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(jp, JSON.stringify(journal));
  return dir;
}
const folderBefore0004 = () => folderBefore("0004_account_security");
// The chain up to and including 0012 (0012's own rollback tests need 0012 to be the latest applied migration).
const folderThrough0012 = () => folderBefore("0013_role_validation_owner_presence");
const seedAcademy = (n: string) => [
  `insert into academy (id, name, timezone) values ('a-${n}', 'Academy ${n}', 'UTC')`,
  `insert into app_user (id, name, email) values ('u-${n}', 'User ${n}', 'u-${n}@example.test')`,
  `insert into auth_account (id, account_id, provider_id, user_id, password) values ('acc-${n}', 'u-${n}', 'credential', 'u-${n}', 'salt:hash-${n}')`,
  `insert into membership (user_id, academy_id, role) values ('u-${n}', 'a-${n}', 'OWNER')`,
];
for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(
    `[${engine.name}] 0004 is purely additive: existing users, passwords and memberships survive the upgrade untouched`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore0004() });
      for (const statement of seedAcademy("one")) await db.query(statement);
      const snapshot = async () =>
        JSON.stringify([
          await db.query(
            `select id, name, email, email_verified from app_user order by id`,
          ),
          await db.query(
            `select id, user_id, provider_id, password from auth_account order by id`,
          ),
          await db.query(`select user_id, academy_id, role, active from membership order by user_id`),
          await db.query(`select * from academy order by id`),
        ]);
      const before = await snapshot();
      const report = await runMigrations({ target: db.target });
      assert.deepEqual(report.pending, [
        "0004_account_security",
        "0005_nutrition_assignment",
        "0006_mfa_policy",
        "0007_consent_management",
        "0008_access_audit",
        "0009_privacy_lifecycle",
        "0010_payment_attempts",
        "0011_coach_assignment_integrity",
        "0012_calendar_series",
        "0013_role_validation_owner_presence",
        "0014_adult_guardian_access",
        "0015_auth_onboarding_and_outbox",
        "0016_guardian_phone",
        "0017_multi_academy_session",
        "0018_academy_invitations",
      "0019_contacts_dispatch",
    ]);
      assert.equal(await snapshot(), before, "existing rows changed");
      const [flag] = await db.query(
        `select two_factor_enabled from app_user where id = 'u-one'`,
      );
      assert.equal(
        flag.two_factor_enabled,
        false,
        "existing users default to no second factor",
      );
      for (const table of [
        "two_factor",
        "temporary_credential",
        "security_event",
        "sign_in_throttle",
        "totp_used_code",
      ])
        assert.equal(
          (await db.query(`select 1 from ${table}`)).length,
          0,
          `${table} starts empty`,
        );
    },
  );
  test(
    `[${engine.name}] 0004 constraints: expiry after issue, known sources, one authenticator per user, cascades`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of [...seedAcademy("one"), ...seedAcademy("two")])
        await db.query(statement);
      const fails = async (sql: string, pattern: RegExp) => {
        await assert.rejects(() => db.query(sql), pattern, sql);
      };
      await fails(
        `insert into temporary_credential (user_id, source, issued_at, expires_at) values ('u-one', 'OWNER_RESET', ${STAMP}, ${STAMP})`,
        /temporary_credential_expiry|check/i,
      );
      await fails(
        `insert into temporary_credential (user_id, source, issued_at, expires_at) values ('u-one', 'SOMETHING_ELSE', ${STAMP}, '2030-01-02 00:00:00')`,
        /temporary_credential_source|check/i,
      );
      await fails(
        `insert into temporary_credential (user_id, source, expires_at) values ('nobody', 'OWNER_RESET', '2030-01-02 00:00:00')`,
        /foreign key|violates/i,
      );
      await db.query(
        `insert into temporary_credential (user_id, issued_by, source, issued_at, expires_at) values ('u-one', 'u-two', 'OWNER_RESET', ${STAMP}, '2030-01-04 00:00:00')`,
      );
      await fails(
        `insert into temporary_credential (user_id, source, issued_at, expires_at) values ('u-one', 'OWNER_RESET', ${STAMP}, '2030-01-04 00:00:00')`,
        /duplicate|unique|primary/i,
      );
      await db.query(
        `insert into two_factor (id, secret, backup_codes, user_id) values ('t1', 'enc', 'enc', 'u-one')`,
      );
      await fails(
        `insert into two_factor (id, secret, backup_codes, user_id) values ('t2', 'enc', 'enc', 'u-one')`,
        /two_factor_user_unique|duplicate|unique/i,
      );
      const [defaults] = await db.query(
        `select verified, failed_verification_count, locked_until from two_factor where id = 't1'`,
      );
      assert.deepEqual(
        { ...defaults },
        { verified: true, failed_verification_count: 0, locked_until: null },
      );
      await db.query(
        `insert into totp_used_code (user_id, code_hash, expires_at) values ('u-one', 'abc', ${STAMP})`,
      );
      await fails(
        `insert into totp_used_code (user_id, code_hash, expires_at) values ('u-one', 'abc', ${STAMP})`,
        /duplicate|unique|primary/i,
      );
      await db.query(
        `insert into security_event (id, event, academy_id, actor_id, target_user_id) values ('e1', 'TEST', 'a-one', 'u-two', 'u-one')`,
      );
      await fails(
        `insert into security_event (id, event, academy_id) values ('e2', 'TEST', 'no-such-academy')`,
        /foreign key|violates/i,
      );
      // RC-3 (0013): u-one is a-one's only owner; a second owner keeps the academy owned when u-one is deleted.
      await db.query(`insert into membership (user_id, academy_id, role) values ('u-two', 'a-one', 'OWNER')`);
      // Deleting a person removes their credential state and unlinks, but keeps, the audit trail.
      await db.query(`delete from auth_account where user_id = 'u-one'`);
      await db.query(`delete from membership where user_id = 'u-one'`);
      await db.query(`delete from app_user where id = 'u-one'`);
      assert.equal((await db.query(`select 1 from two_factor`)).length, 0);
      assert.equal(
        (await db.query(`select 1 from temporary_credential`)).length,
        0,
      );
      assert.equal((await db.query(`select 1 from totp_used_code`)).length, 0);
      const [event] = await db.query(
        `select actor_id, target_user_id from security_event where id = 'e1'`,
      );
      assert.deepEqual(
        { ...event },
        { actor_id: "u-two", target_user_id: null },
      );
    },
  );
  test(
    `[${engine.name}] 0004 rollback script restores the 0003 schema, keeps all academy data, and the chain can be re-applied`,
    opts,
    async () => {
      const reference = await engine.fresh();
      await runMigrations({
        target: reference.target,
        folder: folderBefore0004(),
      });
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of seedAcademy("one")) await db.query(statement);
      await db.query(
        `insert into two_factor (id, secret, backup_codes, user_id) values ('t1', 'enc', 'enc', 'u-one')`,
      );
      await db.query(
        `insert into security_event (id, event) values ('e1', 'TEST')`,
      );
      const keep = async () =>
        JSON.stringify([
          await db.query(`select id, name, email from app_user order by id`),
          await db.query(`select id, password from auth_account order by id`),
          await db.query(`select user_id, academy_id, role, active from membership order by user_id`),
        ]);
      const before = await keep();
      // Newest first.
      await db.script(readFileSync(ROLLBACK_0019, "utf8"));
      await db.script(readFileSync(ROLLBACK_0018, "utf8"));
      await db.script(readFileSync(ROLLBACK_0017, "utf8"));
      await db.script(readFileSync(ROLLBACK_0016, "utf8"));
      await db.script(readFileSync(ROLLBACK_0015, "utf8"));
      await db.script(readFileSync(ROLLBACK_0014, "utf8"));
      await db.script(readFileSync(ROLLBACK_0013, "utf8"));
      await db.script(readFileSync(ROLLBACK_0012, "utf8"));
      await db.script(readFileSync(ROLLBACK_0011, "utf8"));
      await db.script(readFileSync(ROLLBACK_0010, "utf8"));
      await db.script(readFileSync(ROLLBACK_0009, "utf8"));
      await db.script(readFileSync(ROLLBACK_0008, "utf8"));
      await db.script(readFileSync(ROLLBACK_0007, "utf8"));
      await db.script(readFileSync(ROLLBACK_0006, "utf8"));
      await db.script(readFileSync(ROLLBACK_0005, "utf8"));
      await db.script(readFileSync(ROLLBACK, "utf8"));
      // Same columns and constraints as a database that never had 0004.
      assert.equal(
        JSON.stringify(await db.query(fingerprintSql)),
        JSON.stringify(await reference.query(fingerprintSql)),
      );
      const constraints = async (d: typeof db) =>
        JSON.stringify(
          (await d.query(constraintSql)).filter(
            (r) => !String(r.tbl).startsWith("drizzle"),
          ),
        );
      assert.equal(await constraints(db), await constraints(reference));
      assert.equal(
        await keep(),
        before,
        "rollback must not touch passwords, users or memberships",
      );
      // Moving forward again: drop the bookkeeping row the rollback note describes, then migrate.
      await db.query(
        `delete from drizzle."__drizzle_migrations" where created_at in (select created_at from drizzle."__drizzle_migrations" order by created_at desc limit 8)`,
      );
      const forward = await runMigrations({ target: db.target });
      assert.deepEqual(forward.pending, [
        "0004_account_security",
        "0005_nutrition_assignment",
        "0006_mfa_policy",
        "0007_consent_management",
        "0008_access_audit",
        "0009_privacy_lifecycle",
        "0010_payment_attempts",
        "0011_coach_assignment_integrity",
        "0012_calendar_series",
        "0013_role_validation_owner_presence",
        "0014_adult_guardian_access",
        "0015_auth_onboarding_and_outbox",
        "0016_guardian_phone",
        "0017_multi_academy_session",
        "0018_academy_invitations",
      "0019_contacts_dispatch",
    ]);
      assert.equal(await keep(), before);
      assert.deepEqual(
        (await db.query(tables)).map((r) => r.table_name),
        expectedTables,
      );
    },
  );
}
test("the rollback script is kept outside the folder the migration runner applies", () => {
  assert.equal(existsSync(ROLLBACK), true);
  assert.ok(!verifyMigrationFolder(FOLDER).some((e) => e.tag.includes("down")));
  assert.ok(!readdirSync(FOLDER).some((f) => f.includes(".down.")));
});

/* ===================== Phase 2.3: 0005_nutrition_assignment ===================== */
const seedPeople = [
  `insert into academy (id, name, timezone) values ('a-one', 'Academy one', 'UTC'), ('a-two', 'Academy two', 'UTC')`,
  `insert into app_user (id, name, email) values ('pro-one', 'Pro one', 'pro-one@example.test'), ('pro-two', 'Pro two', 'pro-two@example.test'), ('coach-one', 'Coach one', 'coach-one@example.test'), ('coach-two', 'Coach two', 'coach-two@example.test')`,
  `insert into membership (user_id, academy_id, role) values ('pro-one', 'a-one', 'NUTRITION_PRO'), ('pro-two', 'a-two', 'NUTRITION_PRO'), ('coach-one', 'a-one', 'COACH'), ('coach-two', 'a-two', 'COACH')`,
  // RC-3 (0013): every academy with members has an active owner.
  `insert into app_user (id, name, email) values ('own-one', 'Owner one', 'own-one@example.test'), ('own-two', 'Owner two', 'own-two@example.test')`,
  `insert into membership (user_id, academy_id, role) values ('own-one', 'a-one', 'OWNER'), ('own-two', 'a-two', 'OWNER')`,
  `insert into branch (id, academy_id, name) values ('b-one', 'a-one', 'Branch'), ('b-two', 'a-two', 'Branch')`,
  // Stage 5D (0011): a batch is coached by an active coaching member, not by a nutrition professional.
  `insert into batch (id, academy_id, branch_id, name, coach_id) values ('batch-one', 'a-one', 'b-one', 'Batch', 'coach-one'), ('batch-two', 'a-two', 'b-two', 'Batch', 'coach-two')`,
  `insert into player (id, academy_id, name, batch_id) values ('pl-one', 'a-one', 'Player one', 'batch-one'), ('pl-two', 'a-two', 'Player two', 'batch-two')`,
];
for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(
    `[${engine.name}] 0005 is additive and grants nothing: existing data is untouched and no assignment exists afterwards`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({
        target: db.target,
        folder: folderBefore("0005_nutrition_assignment"),
      });
      for (const statement of seedPeople) await db.query(statement);
      const snapshot = async () =>
        JSON.stringify([
          await db.query(`select * from player order by id`),
          await db.query(`select user_id, academy_id, role, active from membership order by user_id`),
          await db.query(`select id, name, email from app_user order by id`),
        ]);
      const before = await snapshot();
      const report = await runMigrations({ target: db.target });
      assert.deepEqual(report.pending, [
        "0005_nutrition_assignment",
        "0006_mfa_policy",
        "0007_consent_management",
        "0008_access_audit",
        "0009_privacy_lifecycle",
        "0010_payment_attempts",
        "0011_coach_assignment_integrity",
        "0012_calendar_series",
        "0013_role_validation_owner_presence",
        "0014_adult_guardian_access",
        "0015_auth_onboarding_and_outbox",
        "0016_guardian_phone",
        "0017_multi_academy_session",
        "0018_academy_invitations",
      "0019_contacts_dispatch",
    ]);
      assert.equal(await snapshot(), before);
      assert.equal(
        (await db.query(`select 1 from nutrition_assignment`)).length,
        0,
      );
    },
  );
  test(
    `[${engine.name}] 0005 constraints: same-academy players and members only, one row per pair, defaults`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of seedPeople) await db.query(statement);
      const fails = async (sql: string, pattern: RegExp) =>
        assert.rejects(() => db.query(sql), pattern, sql);
      await db.query(
        `insert into nutrition_assignment (academy_id, player_id, professional_id) values ('a-one', 'pl-one', 'pro-one')`,
      );
      const [row] = await db.query(
        `select active, assigned_by from nutrition_assignment`,
      );
      assert.deepEqual({ ...row }, { active: true, assigned_by: null });
      await fails(
        `insert into nutrition_assignment (academy_id, player_id, professional_id) values ('a-one', 'pl-one', 'pro-one')`,
        /duplicate|unique|primary/i,
      );
      await fails(
        `insert into nutrition_assignment (academy_id, player_id, professional_id) values ('a-one', 'pl-two', 'pro-one')`,
        /foreign key|violates/i,
      );
      await fails(
        `insert into nutrition_assignment (academy_id, player_id, professional_id) values ('a-one', 'pl-one', 'pro-two')`,
        /foreign key|violates/i,
      );
      await fails(
        `insert into nutrition_assignment (academy_id, player_id, professional_id) values ('a-one', 'pl-one', 'nobody')`,
        /foreign key|violates/i,
      );
    },
  );
  test(
    `[${engine.name}] 0005 rollback script removes only the assignment table, and the chain can be re-applied`,
    opts,
    async () => {
      const reference = await engine.fresh();
      await runMigrations({
        target: reference.target,
        folder: folderBefore("0005_nutrition_assignment"),
      });
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of seedPeople) await db.query(statement);
      await db.query(
        `insert into nutrition_assignment (academy_id, player_id, professional_id) values ('a-one', 'pl-one', 'pro-one')`,
      );
      const keep = async () =>
        JSON.stringify([
          await db.query(`select * from player order by id`),
          await db.query(`select user_id, academy_id, role, active from membership order by user_id`),
        ]);
      const before = await keep();
      await db.script(readFileSync(ROLLBACK_0019, "utf8"));
      await db.script(readFileSync(ROLLBACK_0018, "utf8"));
      await db.script(readFileSync(ROLLBACK_0017, "utf8"));
      await db.script(readFileSync(ROLLBACK_0016, "utf8"));
      await db.script(readFileSync(ROLLBACK_0015, "utf8"));
      await db.script(readFileSync(ROLLBACK_0014, "utf8"));
      await db.script(readFileSync(ROLLBACK_0013, "utf8"));
      await db.script(readFileSync(ROLLBACK_0012, "utf8"));
      await db.script(readFileSync(ROLLBACK_0011, "utf8"));
      await db.script(readFileSync(ROLLBACK_0010, "utf8"));
      await db.script(readFileSync(ROLLBACK_0009, "utf8"));
      await db.script(readFileSync(ROLLBACK_0008, "utf8"));
      await db.script(readFileSync(ROLLBACK_0007, "utf8"));
      await db.script(readFileSync(ROLLBACK_0006, "utf8"));
      await db.script(readFileSync(ROLLBACK_0005, "utf8"));
      assert.equal(
        JSON.stringify(await db.query(fingerprintSql)),
        JSON.stringify(await reference.query(fingerprintSql)),
      );
      assert.equal(
        await keep(),
        before,
        "rollback must not touch players or memberships",
      );
      await db.query(
        `delete from drizzle."__drizzle_migrations" where created_at in (select created_at from drizzle."__drizzle_migrations" order by created_at desc limit 7)`,
      );
      const forward = await runMigrations({ target: db.target });
      assert.deepEqual(forward.pending, [
        "0005_nutrition_assignment",
        "0006_mfa_policy",
        "0007_consent_management",
        "0008_access_audit",
        "0009_privacy_lifecycle",
        "0010_payment_attempts",
        "0011_coach_assignment_integrity",
        "0012_calendar_series",
        "0013_role_validation_owner_presence",
        "0014_adult_guardian_access",
        "0015_auth_onboarding_and_outbox",
        "0016_guardian_phone",
        "0017_multi_academy_session",
        "0018_academy_invitations",
      "0019_contacts_dispatch",
    ]);
      assert.equal(await keep(), before);
      assert.deepEqual(
        (await db.query(tables)).map((r) => r.table_name),
        expectedTables,
      );
    },
  );
}

/* ===================== Phase 4: 0006_mfa_policy ===================== */
for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(
    `[${engine.name}] 0006 is additive and requires nothing: existing data is untouched and no policy row exists afterwards`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({
        target: db.target,
        folder: folderBefore("0006_mfa_policy"),
      });
      for (const statement of seedPeople) await db.query(statement);
      const snapshot = async () =>
        JSON.stringify([
          await db.query(`select * from academy order by id`),
          await db.query(`select user_id, academy_id, role, active from membership order by user_id`),
          await db.query(`select id, name, email, two_factor_enabled from app_user order by id`),
          await db.query(`select user_id, password from auth_account order by user_id`),
        ]);
      const before = await snapshot();
      const report = await runMigrations({ target: db.target });
      assert.deepEqual(report.pending, ["0006_mfa_policy", "0007_consent_management", "0008_access_audit", "0009_privacy_lifecycle", "0010_payment_attempts", "0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      assert.equal(await snapshot(), before);
      assert.equal((await db.query(`select 1 from academy_mfa_policy`)).length, 0, "no academy is switched on by upgrading");
    },
  );
  test(
    `[${engine.name}] 0006 constraints: defaults, valid modes only, real academies only, one row per academy`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of seedPeople) await db.query(statement);
      const fails = async (sql: string, pattern: RegExp) =>
        assert.rejects(() => db.query(sql), pattern, sql);
      await db.query(`insert into academy_mfa_policy (academy_id) values ('a-one')`);
      const [row] = await db.query(
        `select mode, roles, warn_since, updated_by, updated_at is not null as stamped from academy_mfa_policy`,
      );
      assert.deepEqual(
        { ...row, roles: JSON.parse(JSON.stringify(row.roles)) },
        { mode: "off", roles: [], warn_since: null, updated_by: null, stamped: true },
      );
      await fails(`insert into academy_mfa_policy (academy_id) values ('a-one')`, /duplicate|unique|primary/i);
      await fails(`insert into academy_mfa_policy (academy_id, mode) values ('a-two', 'maybe')`, /check|violat/i);
      await fails(`insert into academy_mfa_policy (academy_id) values ('no-such-academy')`, /foreign key|violat/i);
      // The editor reference is cleared (not the policy) when that account is deleted.
      await db.query(
        `insert into app_user (id, name, email) values ('editor-x', 'Editor', 'editor-x@example.test')`,
      );
      await db.query(
        `update academy_mfa_policy set mode = 'enforce', updated_by = 'editor-x' where academy_id = 'a-one'`,
      );
      await db.query(`delete from app_user where id = 'editor-x'`);
      const [kept] = await db.query(
        `select mode, updated_by from academy_mfa_policy where academy_id = 'a-one'`,
      );
      assert.deepEqual({ ...kept }, { mode: "enforce", updated_by: null });
    },
  );
  test(
    `[${engine.name}] 0006 rollback script removes only the policy table, and the chain can be re-applied`,
    opts,
    async () => {
      const reference = await engine.fresh();
      await runMigrations({
        target: reference.target,
        folder: folderBefore("0006_mfa_policy"),
      });
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of seedPeople) await db.query(statement);
      await db.query(`insert into academy_mfa_policy (academy_id, mode) values ('a-one', 'warn')`);
      const keep = async () =>
        JSON.stringify([
          await db.query(`select * from academy order by id`),
          await db.query(`select user_id, academy_id, role, active from membership order by user_id`),
        ]);
      const before = await keep();
      await db.script(readFileSync(ROLLBACK_0019, "utf8"));
      await db.script(readFileSync(ROLLBACK_0018, "utf8"));
      await db.script(readFileSync(ROLLBACK_0017, "utf8"));
      await db.script(readFileSync(ROLLBACK_0016, "utf8"));
      await db.script(readFileSync(ROLLBACK_0015, "utf8"));
      await db.script(readFileSync(ROLLBACK_0014, "utf8"));
      await db.script(readFileSync(ROLLBACK_0013, "utf8"));
      await db.script(readFileSync(ROLLBACK_0012, "utf8"));
      await db.script(readFileSync(ROLLBACK_0011, "utf8"));
      await db.script(readFileSync(ROLLBACK_0010, "utf8"));
      await db.script(readFileSync(ROLLBACK_0009, "utf8"));
      await db.script(readFileSync(ROLLBACK_0008, "utf8"));
      await db.script(readFileSync(ROLLBACK_0007, "utf8"));
      await db.script(readFileSync(ROLLBACK_0006, "utf8"));
      assert.equal(
        JSON.stringify(await db.query(fingerprintSql)),
        JSON.stringify(await reference.query(fingerprintSql)),
      );
      assert.equal(await keep(), before, "rollback must not touch academies or memberships");
      await db.query(
        `delete from drizzle."__drizzle_migrations" where created_at in (select created_at from drizzle."__drizzle_migrations" order by created_at desc limit 6)`,
      );
      const forward = await runMigrations({ target: db.target });
      assert.deepEqual(forward.pending, ["0006_mfa_policy", "0007_consent_management", "0008_access_audit", "0009_privacy_lifecycle", "0010_payment_attempts", "0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      assert.equal(await keep(), before);
      assert.deepEqual(
        (await db.query(tables)).map((r) => r.table_name),
        expectedTables,
      );
    },
  );
}

/* ===================== Phase 5: 0007_consent_management ===================== */
const consentSeed = [
  ...seedPeople,
  `insert into player (id, academy_id, name, batch_id) values ('pl-one-b', 'a-one', 'Player one B', 'batch-one')`,
  `insert into guardian_link (academy_id, player_id, user_id, relationship, consent) values ('a-one', 'pl-one', 'pro-one', 'Mother', '{"portal": true, "email": false, "whatsapp": true}'::jsonb), ('a-one', 'pl-one-b', 'pro-one', 'Aunt', '{"portal": false, "email": false, "whatsapp": false}'::jsonb)`,
];
for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(
    `[${engine.name}] 0007 keeps existing consent as explicitly-marked legacy events, invents nothing, and changes no flag`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore("0007_consent_management") });
      for (const statement of consentSeed) await db.query(statement);
      const flags = async () => JSON.stringify(await db.query(`select player_id, user_id, consent from guardian_link order by player_id`));
      const before = await flags();
      const report = await runMigrations({ target: db.target });
      assert.deepEqual(report.pending, ["0007_consent_management", "0008_access_audit", "0009_privacy_lifecycle", "0010_payment_attempts", "0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      assert.equal(await flags(), before, "no message is gained or lost by upgrading");
      const events = await db.query(
        `select category, decision, method, actor_id, actor_role, policy_version_id, effective_at, recorded_at is not null as stamped, sequence, previous_event_id, authority, evidence_ref is not null as noted, player_id from consent_event order by category`,
      );
      assert.deepEqual(
        events.map((e) => ({ ...e })),
        ["PORTAL", "WHATSAPP"].map((category) => ({
          category,
          decision: "GRANTED",
          method: "IMPORT_LEGACY",
          actor_id: null,
          actor_role: null,
          policy_version_id: null,
          effective_at: null,
          stamped: true,
          sequence: 1,
          previous_event_id: null,
          authority: "Mother",
          noted: true,
          player_id: "pl-one",
        })),
        "one event per TRUE flag; none for false flags; no actor, version or effective date is invented",
      );
      const again = await runMigrations({ target: db.target });
      assert.deepEqual(again.pending, []);
      assert.equal((await db.query(`select 1 from consent_event`)).length, 2, "re-running adds nothing");
      assert.equal((await db.query(`select 1 from consent_policy_version`)).length, 0, "no document version is invented");
    },
  );
  test(
    `[${engine.name}] 0007 fresh install: history is append-only and a published version is frozen, in the database itself`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of consentSeed) await db.query(statement);
      await db.query(
        `insert into consent_event (id, academy_id, player_id, subject_user_id, category, sequence, decision, method) values ('e1', 'a-one', 'pl-one', 'pro-one', 'EMAIL', 1, 'GRANTED', 'PORTAL_SELF')`,
      );
      await assert.rejects(() => db.query(`update consent_event set decision = 'WITHDRAWN' where id = 'e1'`), /append-only/);
      await assert.rejects(() => db.query(`delete from consent_event where id = 'e1'`), /append-only/);
      await db.query(
        `insert into consent_policy_version (id, academy_id, category, version, title, body) values ('v1', 'a-one', 'EMAIL', 1, 'Title', 'Body text of the document.')`,
      );
      await db.query(`update consent_policy_version set body = 'Edited draft text.' where id = 'v1'`);
      await assert.rejects(
        () => db.query(`insert into consent_policy_version (id, academy_id, category, version, title, body) values ('v1b', 'a-one', 'EMAIL', 2, 'Another', 'A second open draft.')`),
        /one_draft|duplicate|unique/i,
      );
      await db.query(
        `update consent_policy_version set status = 'PUBLISHED', published_at = now(), effective_at = now() where id = 'v1'`,
      );
      await assert.rejects(() => db.query(`update consent_policy_version set body = 'Tampered.' where id = 'v1'`), /cannot be changed/);
      await assert.rejects(() => db.query(`update consent_policy_version set status = 'DRAFT', published_at = null, effective_at = null where id = 'v1'`), /cannot be changed/);
      await assert.rejects(() => db.query(`delete from consent_policy_version where id = 'v1'`), /cannot be deleted/);
      assert.equal((await db.query(`select body from consent_policy_version where id = 'v1'`))[0].body, "Edited draft text.");
      await assert.rejects(
        () => db.query(`insert into consent_event (id, academy_id, player_id, subject_user_id, category, sequence, decision, method, policy_version_id) values ('e2', 'a-one', 'pl-one', 'pro-one', 'PORTAL', 1, 'GRANTED', 'PORTAL_SELF', 'v1')`),
        /foreign key|violates/i,
        "a version of another category cannot be attached",
      );
    },
  );
  test(
    `[${engine.name}] 0007 rollback removes only the consent tables and functions, keeps the flags, and the chain re-applies`,
    opts,
    async () => {
      const reference = await engine.fresh();
      await runMigrations({ target: reference.target, folder: folderBefore("0007_consent_management") });
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of consentSeed) await db.query(statement);
      const keep = async () =>
        JSON.stringify([
          await db.query(`select * from player order by id`),
          await db.query(`select player_id, user_id, relationship, active, consent from guardian_link order by player_id`),
        ]);
      const before = await keep();
      await db.script(readFileSync(ROLLBACK_0019, "utf8"));
      await db.script(readFileSync(ROLLBACK_0018, "utf8"));
      await db.script(readFileSync(ROLLBACK_0017, "utf8"));
      await db.script(readFileSync(ROLLBACK_0016, "utf8"));
      await db.script(readFileSync(ROLLBACK_0015, "utf8"));
      await db.script(readFileSync(ROLLBACK_0014, "utf8"));
      await db.script(readFileSync(ROLLBACK_0013, "utf8"));
      await db.script(readFileSync(ROLLBACK_0012, "utf8"));
      await db.script(readFileSync(ROLLBACK_0011, "utf8"));
      await db.script(readFileSync(ROLLBACK_0010, "utf8"));
      await db.script(readFileSync(ROLLBACK_0009, "utf8"));
      await db.script(readFileSync(ROLLBACK_0008, "utf8"));
      await db.script(readFileSync(ROLLBACK_0007, "utf8"));
      assert.equal(JSON.stringify(await db.query(fingerprintSql)), JSON.stringify(await reference.query(fingerprintSql)));
      assert.equal(await keep(), before, "rollback must not touch players, links or consent flags");
      assert.equal(
        (await db.query(`select 1 from pg_proc where proname in ('consent_event_append_only', 'consent_policy_version_guard')`)).length,
        0,
      );
      await db.query(
        `delete from drizzle."__drizzle_migrations" where created_at in (select created_at from drizzle."__drizzle_migrations" order by created_at desc limit 5)`,
      );
      const forward = await runMigrations({ target: db.target });
      assert.deepEqual(forward.pending, ["0007_consent_management", "0008_access_audit", "0009_privacy_lifecycle", "0010_payment_attempts", "0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      assert.equal(await keep(), before);
      assert.equal((await db.query(`select 1 from consent_event`)).length, 2, "legacy events are recreated from the flags");
      assert.deepEqual((await db.query(tables)).map((r) => r.table_name), expectedTables);
    },
  );
}
/* ===================== Phase 7: 0008_access_audit ===================== */
const accessInsert = (id: string, extra = "") =>
  `insert into access_event (id, academy_id, actor_id, actor_role, category, operation, outcome, channel${extra ? ", " + extra.split("=")[0] : ""}) values ('${id}', 'a-one', 'pro-one', 'OWNER', 'REPORT', 'PDF', 'SUCCESS', 'service'${extra ? ", " + extra.split("=")[1] : ""})`;
for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(
    `[${engine.name}] 0008 is additive: existing data and audit/security history are untouched, and no access history is invented`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore("0008_access_audit") });
      for (const statement of consentSeed) await db.query(statement);
      await db.query(`insert into audit_event (id, academy_id, actor_id, entity_id, action, version, detail) values ('au-1', 'a-one', 'pro-one', 'x', 'report', 1, '{}'::jsonb)`);
      await db.query(`insert into security_event (id, event, academy_id, detail) values ('se-1', 'PASSWORD_CHANGED', 'a-one', '{}'::jsonb)`);
      const keep = async () =>
        JSON.stringify([
          await db.query(`select * from player order by id`),
          await db.query(`select * from guardian_link order by player_id`),
          await db.query(`select * from audit_event order by id`),
          await db.query(`select * from security_event order by id`),
          await db.query(`select * from consent_event order by id`),
        ]);
      const before = await keep();
      const report = await runMigrations({ target: db.target });
      assert.deepEqual(report.pending, ["0008_access_audit", "0009_privacy_lifecycle", "0010_payment_attempts", "0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      assert.equal(await keep(), before, "existing rows changed");
      assert.equal((await db.query(`select 1 from access_event`)).length, 0, "no access is invented for the past");
      assert.deepEqual((await runMigrations({ target: db.target })).pending, []);
      assert.deepEqual((await db.query(tables)).map((r) => r.table_name), expectedTables);
    },
  );
  test(
    `[${engine.name}] 0008 fresh install: the access history is append-only and constrained, in the database itself`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of consentSeed) await db.query(statement);
      await db.query(accessInsert("x1"));
      await assert.rejects(() => db.query(`update access_event set outcome = 'DENIED' where id = 'x1'`), /append-only/);
      await assert.rejects(() => db.query(`delete from access_event where id = 'x1'`), /append-only/);
      await assert.rejects(() => db.query(`truncate access_event`), /append-only/);
      assert.equal((await db.query(`select outcome from access_event where id = 'x1'`))[0].outcome, "SUCCESS");
      await assert.rejects(() => db.query(accessInsert("x2").replace("'SUCCESS'", "'MAYBE'")), /check|violates/i);
      await assert.rejects(() => db.query(accessInsert("x3").replace("'PDF'", "'PEEK'")), /check|violates/i);
      await assert.rejects(() => db.query(accessInsert("x4").replace("'REPORT'", "'EVERYTHING'")), /check|violates/i);
      await assert.rejects(() => db.query(accessInsert("x5").replace("'a-one'", "'no-such-academy'")), /foreign key|violates/i);
      // The history of who looked outlives the account or player it names (no foreign key to either).
      await db.query(accessInsert("x6", "player_id='gone-player'"));
      assert.equal((await db.query(`select 1 from access_event`)).length, 2);
    },
  );
  test(
    `[${engine.name}] 0008 rollback removes only the access history, keeps everything else, and the chain re-applies`,
    opts,
    async () => {
      const reference = await engine.fresh();
      await runMigrations({ target: reference.target, folder: folderBefore("0008_access_audit") });
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of consentSeed) await db.query(statement);
      await db.query(accessInsert("x1"));
      const keep = async () => JSON.stringify([await db.query(`select * from player order by id`), await db.query(`select * from guardian_link order by player_id`), await db.query(`select * from consent_event order by id`)]);
      const before = await keep();
      await db.script(readFileSync(ROLLBACK_0019, "utf8"));
      await db.script(readFileSync(ROLLBACK_0018, "utf8"));
      await db.script(readFileSync(ROLLBACK_0017, "utf8"));
      await db.script(readFileSync(ROLLBACK_0016, "utf8"));
      await db.script(readFileSync(ROLLBACK_0015, "utf8"));
      await db.script(readFileSync(ROLLBACK_0014, "utf8"));
      await db.script(readFileSync(ROLLBACK_0013, "utf8"));
      await db.script(readFileSync(ROLLBACK_0012, "utf8"));
      await db.script(readFileSync(ROLLBACK_0011, "utf8"));
      await db.script(readFileSync(ROLLBACK_0010, "utf8"));
      await db.script(readFileSync(ROLLBACK_0009, "utf8"));
      await db.script(readFileSync(ROLLBACK_0008, "utf8"));
      assert.equal(JSON.stringify(await db.query(fingerprintSql)), JSON.stringify(await reference.query(fingerprintSql)));
      assert.equal(await keep(), before, "rollback must not touch application data");
      assert.equal((await db.query(`select 1 from pg_proc where proname = 'access_event_append_only'`)).length, 0);
      await db.query(`delete from drizzle."__drizzle_migrations" where created_at in (select created_at from drizzle."__drizzle_migrations" order by created_at desc limit 4)`);
      const forward = await runMigrations({ target: db.target });
      assert.deepEqual(forward.pending, ["0008_access_audit", "0009_privacy_lifecycle", "0010_payment_attempts", "0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      assert.equal((await db.query(`select 1 from access_event`)).length, 0, "the destroyed history is not recreated");
      assert.deepEqual((await db.query(tables)).map((r) => r.table_name), expectedTables);
    },
  );
}
/* ===================== Phase 8: 0009_privacy_lifecycle ===================== */
for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(
    `[${engine.name}] 0009 is additive: nothing is erased, held or approved by upgrading, and existing data and history are untouched`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore("0009_privacy_lifecycle") });
      for (const statement of consentSeed) await db.query(statement);
      await db.query(`insert into audit_event (id, academy_id, actor_id, entity_id, action, version, detail) values ('au-1', 'a-one', 'pro-one', 'x', 'report', 1, '{}'::jsonb)`);
      await db.query(accessInsert("x1"));
      const keep = async () =>
        JSON.stringify([
          await db.query(`select * from player order by id`),
          await db.query(`select * from guardian_link order by player_id`),
          await db.query(`select * from consent_event order by id`),
          await db.query(`select * from audit_event order by id`),
          await db.query(`select * from access_event order by id`),
        ]);
      const before = await keep();
      const report = await runMigrations({ target: db.target });
      assert.deepEqual(report.pending, ["0009_privacy_lifecycle", "0010_payment_attempts", "0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      assert.equal(await keep(), before, "existing rows changed");
      for (const table of ["retention_policy", "legal_hold", "erasure_request", "erasure_event", "storage_deletion"])
        assert.equal((await db.query(`select 1 from ${table}`)).length, 0, `${table} starts empty: no rule, hold or erasure is created by upgrading`);
      assert.deepEqual((await runMigrations({ target: db.target })).pending, []);
      assert.deepEqual((await db.query(tables)).map((r) => r.table_name), expectedTables);
      // The access history now accepts the new category and still refuses unknown ones.
      await db.query(accessInsert("x2").replace("'REPORT'", "'PRIVACY'"));
      await assert.rejects(() => db.query(accessInsert("x3").replace("'REPORT'", "'EVERYTHING'")), /check|violates/i);
    },
  );
  test(
    `[${engine.name}] 0009 fresh install: the erasure history is append-only; states, scopes and one-open-request are enforced by the database`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of consentSeed) await db.query(statement);
      const request = (id: string, status: string) =>
        `insert into erasure_request (id, academy_id, player_id, source, reason, requested_by, status) values ('${id}', 'a-one', 'pl-one', 'STAFF', 'A reason for the test', 'u', '${status}')`;
      await db.query(request("r1", "PREVIEW_READY"));
      await assert.rejects(() => db.query(request("r2", "GRACE_PERIOD")), /one_open|unique|duplicate/i);
      await assert.rejects(() => db.query(request("r3", "MAYBE")), /check|violates/i);
      await db.query(`insert into erasure_event (id, academy_id, request_id, event) values ('e1', 'a-one', 'r1', 'REQUESTED')`);
      await assert.rejects(() => db.query(`update erasure_event set event = 'X' where id = 'e1'`), /append-only/);
      await assert.rejects(() => db.query(`delete from erasure_event where id = 'e1'`), /append-only/);
      await assert.rejects(() => db.query(`truncate erasure_event`), /append-only/);
      await assert.rejects(() => db.query(`insert into legal_hold (id, academy_id, scope, player_id, reason, created_by) values ('h', 'a-one', 'PLAYER', null, 'r', 'u')`), /check|violates/i);
      await assert.rejects(() => db.query(`insert into legal_hold (id, academy_id, scope, player_id, reason, created_by) values ('h', 'a-one', 'ACADEMY', 'pl-one', 'r', 'u')`), /check|violates/i);
      await assert.rejects(() => db.query(`insert into retention_policy (academy_id, category, action, retention_days, basis, approved_by) values ('a-one', 'REPORTS', 'ERASE', -1, 'b', 'u')`), /check|violates/i);
      await assert.rejects(() => db.query(`insert into retention_policy (academy_id, category, action, basis, approved_by) values ('no-such', 'REPORTS', 'ERASE', 'b', 'u')`), /foreign key|violates/i);
      await db.query(`insert into storage_deletion (id, academy_id, request_id, storage_key) values ('s1', 'a-one', 'r1', 'k')`);
      await assert.rejects(() => db.query(`insert into storage_deletion (id, academy_id, request_id, storage_key) values ('s2', 'a-one', 'r1', 'k')`), /unique|duplicate/i);
    },
  );
  test(
    `[${engine.name}] 0009 rollback removes only the privacy tables, keeps everything else, refuses to rewrite access history, and the chain re-applies`,
    opts,
    async () => {
      const reference = await engine.fresh();
      await runMigrations({ target: reference.target, folder: folderBefore("0009_privacy_lifecycle") });
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of consentSeed) await db.query(statement);
      await db.query(accessInsert("x1").replace("'REPORT'", "'PRIVACY'"));
      // With a PRIVACY access event present the append-only history must not be rewritten: the rollback stops.
      await assert.rejects(() => db.script(readFileSync(ROLLBACK_0009, "utf8")), /PRIVACY events/);
      assert.equal((await db.query(`select 1 from retention_policy`)).length, 0, "the failed rollback changed nothing (the table is still there)");
      const clean = await engine.fresh();
      await runMigrations({ target: clean.target });
      for (const statement of consentSeed) await clean.query(statement);
      const keep = async () => JSON.stringify([await clean.query(`select * from player order by id`), await clean.query(`select * from consent_event order by id`)]);
      const before = await keep();
      await clean.script(readFileSync(ROLLBACK_0019, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0018, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0017, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0016, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0015, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0014, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0013, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0012, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0011, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0010, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0009, "utf8"));
      assert.equal(JSON.stringify(await clean.query(fingerprintSql)), JSON.stringify(await reference.query(fingerprintSql)));
      assert.equal(await keep(), before, "application data untouched");
      assert.equal((await clean.query(`select 1 from pg_proc where proname = 'erasure_event_append_only'`)).length, 0);
      await clean.query(`delete from drizzle."__drizzle_migrations" where created_at in (select created_at from drizzle."__drizzle_migrations" order by created_at desc limit 3)`);
      const forward = await runMigrations({ target: clean.target });
      assert.deepEqual(forward.pending, ["0009_privacy_lifecycle", "0010_payment_attempts", "0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      assert.deepEqual((await clean.query(tables)).map((r) => r.table_name), expectedTables);
    },
  );
}

/* ===================== Stage 5C: 0010_payment_attempts ===================== */
const ROLLBACK_0010 = join(REPO_ROOT, "migrations-rollback", "0010_payment_attempts.down.sql");
const ROLLBACK_0011 = join(REPO_ROOT, "migrations-rollback", "0011_coach_assignment_integrity.down.sql");
const ROLLBACK_0012 = join(REPO_ROOT, "migrations-rollback", "0012_calendar_series.down.sql");
const ROLLBACK_0013 = join(REPO_ROOT, "migrations-rollback", "0013_role_validation_owner_presence.down.sql");
const ROLLBACK_0014 = join(REPO_ROOT, "migrations-rollback", "0014_adult_guardian_access.down.sql");
const ROLLBACK_0015 = join(REPO_ROOT, "migrations-rollback", "0015_auth_onboarding_and_outbox.down.sql");
const ROLLBACK_0016 = join(REPO_ROOT, "migrations-rollback", "0016_guardian_phone.down.sql");
const ROLLBACK_0017 = join(REPO_ROOT, "migrations-rollback", "0017_multi_academy_session.down.sql");
const ROLLBACK_0018 = join(REPO_ROOT, "migrations-rollback", "0018_academy_invitations.down.sql");
const ROLLBACK_0019 = join(REPO_ROOT, "migrations-rollback", "0019_contacts_dispatch.down.sql");
const paymentHistorySeed = [
  `insert into academy (id, name, timezone) values ('a-pay', 'Pay academy', 'UTC'), ('a-other', 'Other academy', 'UTC')`,
  `insert into invoice (id, academy_id, data) values ('inv-1', 'a-pay', '{"total": 1000, "currency": "INR"}'::jsonb), ('inv-2', 'a-pay', '{"total": 1000, "currency": "INR"}'::jsonb), ('inv-o', 'a-other', '{"total": 1000, "currency": "INR"}'::jsonb)`,
];
const historicalPayment = (id: string, invoice: string, status: string, reference: string, academy = "a-pay") =>
  `insert into payment_reference (id, academy_id, invoice_id, version, status, idempotency_key, reference, data) values ('${id}', '${academy}', '${invoice}', ${status === "SUBMITTED" ? 1 : 2}, '${status}', 'idem-${id}', '${reference}', '{"amount": 100, "currency": "INR"}'::jsonb)`;
const paymentColumns = `select id, academy_id, invoice_id, version, status, idempotency_key, reference, data from payment_reference order by id`;
for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(
    `[${engine.name}] 0010 keeps every historical payment attempt unchanged and only adds the canonical reference`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore("0010_payment_attempts") });
      for (const statement of paymentHistorySeed) await db.query(statement);
      // History the old exact-text rule allowed: case variants of a rejected reference, two rejected
      // variants, the same text in another academy, and more than three pending on one invoice.
      for (const statement of [
        historicalPayment("p1", "inv-1", "VERIFIED", "UTR-1001"),
        historicalPayment("p2", "inv-1", "REJECTED", "REF-77"),
        historicalPayment("p3", "inv-1", "SUBMITTED", "ref-77"),
        historicalPayment("p4", "inv-2", "REJECTED", "Dup  Ref"),
        historicalPayment("p5", "inv-2", "REJECTED", "dup ref"),
        historicalPayment("p6", "inv-2", "SUBMITTED", "A-1"),
        historicalPayment("p7", "inv-2", "SUBMITTED", "A-2"),
        historicalPayment("p8", "inv-2", "SUBMITTED", "A-3"),
        historicalPayment("p9", "inv-2", "SUBMITTED", "A-4"),
        historicalPayment("po", "inv-o", "VERIFIED", "utr-1001", "a-other"),
      ])
        await db.query(statement);
      const before = JSON.stringify(await db.query(paymentColumns));
      const report = await runMigrations({ target: db.target });
      assert.deepEqual(report.pending, ["0010_payment_attempts", "0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      assert.equal(JSON.stringify(await db.query(paymentColumns)), before, "no historical attempt was changed, merged or removed");
      const keys = await db.query(`select id, reference_key, rejection_kind from payment_reference order by id`);
      assert.deepEqual(
        keys.map((r) => `${r.id}:${r.reference_key}:${r.rejection_kind}`),
        ["p1:utr-1001:null", "p2:ref-77:null", "p3:ref-77:null", "p4:dup ref:null", "p5:dup ref:null", "p6:a-1:null", "p7:a-2:null", "p8:a-3:null", "p9:a-4:null", "po:utr-1001:null"],
      );
      // From now on the database refuses a second live attempt with the same canonical reference.
      await assert.rejects(() => db.query(historicalPayment("p10", "inv-1", "SUBMITTED", " UTR-1001 ")), /payment_reference_live_key|unique|duplicate/i);
      // A rejected attempt can no longer be changed or removed.
      await assert.rejects(() => db.query(`update payment_reference set reference = 'x' where id = 'p2'`), /immutable/);
      await assert.rejects(() => db.query(`delete from payment_reference where id = 'p2'`), /immutable/);
      // The pending limit applies to new attempts; the existing four are left alone.
      await assert.rejects(() => db.query(historicalPayment("p11", "inv-2", "SUBMITTED", "A-5")), /PAYMENT_PENDING_LIMIT/);
      assert.equal((await db.query(`select 1 from payment_reference where invoice_id = 'inv-2' and status = 'SUBMITTED'`)).length, 4);
      await assert.rejects(() => db.query(`update payment_reference set rejection_kind = 'INVALID' where id = 'p1'`), /check|violates/i);
      assert.deepEqual((await runMigrations({ target: db.target })).pending, []);
    },
  );
  test(
    `[${engine.name}] 0010 stops, changing nothing, when live history would collide once case and spacing are ignored`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore("0010_payment_attempts") });
      for (const statement of paymentHistorySeed) await db.query(statement);
      await db.query(historicalPayment("q1", "inv-1", "VERIFIED", "REF-9"));
      await db.query(historicalPayment("q2", "inv-2", "SUBMITTED", "ref-9"));
      const state = async () => JSON.stringify([await db.query(fingerprintSql), await db.query(paymentColumns)]);
      const before = await state();
      await assert.rejects(
        () => runMigrations({ target: db.target }),
        (error: unknown) => /0010 pre-flight: live payment attempts share a reference[\s\S]*q1, q2/.test(`${String(error)} ${String((error as { cause?: unknown }).cause)}`),
      );
      assert.equal(await state(), before, "the failed migration changed nothing");
      assert.equal((await db.query(`select 1 from pg_constraint where conname = 'payment_reference_academy_id_reference_unique'`)).length, 1, "the old rule is still in force");
      assert.deepEqual((await runMigrations({ target: db.target, dryRun: true })).pending, ["0010_payment_attempts", "0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
    },
  );
  test(
    `[${engine.name}] 0010 rollback restores the 0009 schema while the new features are unused, and refuses afterwards`,
    opts,
    async () => {
      const reference = await engine.fresh();
      await runMigrations({ target: reference.target, folder: folderBefore("0010_payment_attempts") });
      const clean = await engine.fresh();
      await runMigrations({ target: clean.target });
      for (const statement of paymentHistorySeed) await clean.query(statement);
      await clean.query(historicalPayment("r1", "inv-1", "SUBMITTED", "R-1"));
      await clean.script(readFileSync(ROLLBACK_0019, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0018, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0017, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0016, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0015, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0014, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0013, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0012, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0011, "utf8"));
      await clean.script(readFileSync(ROLLBACK_0010, "utf8"));
      assert.equal(JSON.stringify(await clean.query(fingerprintSql)), JSON.stringify(await reference.query(fingerprintSql)));
      assert.equal(JSON.stringify(await clean.query(constraintSql)), JSON.stringify(await reference.query(constraintSql)));
      assert.equal((await clean.query(`select 1 from pg_proc where proname in ('payment_reference_pending_limit', 'payment_reference_rejected_immutable')`)).length, 0);
      assert.equal((await clean.query(`select 1 from payment_reference`)).length, 1, "payment rows untouched");
      await clean.query(`delete from drizzle."__drizzle_migrations" where created_at in (select created_at from drizzle."__drizzle_migrations" order by created_at desc limit 2)`);
      assert.deepEqual((await runMigrations({ target: clean.target })).pending, ["0010_payment_attempts", "0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      // Once a rejection kind has been recorded the rollback refuses and changes nothing.
      await clean.query(`update payment_reference set status = 'REJECTED', version = 2, rejection_kind = 'CORRECTABLE' where id = 'r1'`);
      await assert.rejects(() => clean.script(readFileSync(ROLLBACK_0010, "utf8")), /rejection kinds/);
      assert.equal((await clean.query(`select 1 from information_schema.columns where column_name = 'reference_key'`)).length, 1, "the failed rollback changed nothing");
    },
  );
}
/* ===================== Stage 5D: 0011_coach_assignment_integrity ===================== */
const coachSeed = [
  `insert into academy (id, name, timezone) values ('a-c', 'Coach academy', 'UTC'), ('a-x', 'Other academy', 'UTC')`,
  `insert into app_user (id, name, email) values ('c-1', 'Coach 1', 'c1@example.test'), ('c-2', 'Coach 2', 'c2@example.test'), ('c-old', 'Retired coach', 'old@example.test'), ('c-fin', 'Finance', 'fin@example.test'), ('c-x', 'Other coach', 'x@example.test')`,
  `insert into membership (user_id, academy_id, role, active) values ('c-1', 'a-c', 'COACH', true), ('c-2', 'a-c', 'HEAD_COACH', true), ('c-old', 'a-c', 'COACH', false), ('c-fin', 'a-c', 'FINANCE', true), ('c-x', 'a-x', 'COACH', true)`,
  // RC-3 (0013): every academy with members has an active owner.
  `insert into app_user (id, name, email) values ('c-own', 'Owner C', 'c-own@example.test'), ('x-own', 'Owner X', 'x-own@example.test')`,
  `insert into membership (user_id, academy_id, role, active) values ('c-own', 'a-c', 'OWNER', true), ('x-own', 'a-x', 'OWNER', true)`,
  `insert into branch (id, academy_id, name) values ('br', 'a-c', 'Branch'), ('br-x', 'a-x', 'Branch')`,
  `insert into batch (id, academy_id, branch_id, name, coach_id) values ('bt-1', 'a-c', 'br', 'Batch 1', 'c-1'), ('bt-x', 'a-x', 'br-x', 'Batch X', 'c-x')`,
];
const coachState = `select (select json_agg(b order by b.academy_id, b.id) from batch b) as batches, (select json_agg(json_build_object('user_id', m.user_id, 'academy_id', m.academy_id, 'role', m.role, 'active', m.active) order by m.academy_id, m.user_id) from membership m) as members`;
for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(
    `[${engine.name}] 0011 changes no row and only adds the coach-assignment rules, which the database then enforces`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore("0011_coach_assignment_integrity") });
      for (const statement of coachSeed) await db.query(statement);
      const before = JSON.stringify(await db.query(coachState));
      const schemaBefore = JSON.stringify([await db.query(fingerprintSql), await db.query(constraintSql)]);
      // Up to 0011 only: 0012 (Stage 5E) adds calendar columns and is checked in its own tests below.
      const report = await runMigrations({ target: db.target, folder: folderBefore("0012_calendar_series") });
      assert.deepEqual(report.pending, ["0011_coach_assignment_integrity"]);
      assert.equal(JSON.stringify(await db.query(coachState)), before, "no batch or membership changed");
      assert.equal(JSON.stringify([await db.query(fingerprintSql), await db.query(constraintSql)]), schemaBefore, "no column or constraint changed");
      assert.deepEqual(
        (await db.query(`select tgname from pg_trigger where tgname in ('batch_coach_must_coach', 'membership_coach_assignments') order by 1`)).map((r) => r.tgname),
        ["batch_coach_must_coach", "membership_coach_assignments"],
      );
      const refused = (sql: string, pattern: RegExp) => assert.rejects(() => db.query(sql), pattern, sql);
      // A batch cannot be created with, or moved to, someone who cannot coach.
      await refused(`insert into batch (id, academy_id, branch_id, name, coach_id) values ('bt-2', 'a-c', 'br', 'B', 'c-old')`, /COACH_ASSIGNMENT_INVALID/);
      await refused(`insert into batch (id, academy_id, branch_id, name, coach_id) values ('bt-2', 'a-c', 'br', 'B', 'c-fin')`, /COACH_ASSIGNMENT_INVALID/);
      await refused(`update batch set coach_id = 'c-old' where id = 'bt-1'`, /COACH_ASSIGNMENT_INVALID/);
      await refused(`update batch set coach_id = 'c-fin' where id = 'bt-1'`, /COACH_ASSIGNMENT_INVALID/);
      // Another academy's coach: refused (no active coaching membership in this academy; the
      // composite foreign key would refuse it too).
      await refused(`update batch set coach_id = 'c-x' where id = 'bt-1'`, /COACH_ASSIGNMENT_INVALID|foreign key|violates/i);
      // A coach with a batch cannot lose coaching access, by deactivation or by role.
      await refused(`update membership set active = false where user_id = 'c-1'`, /COACH_REASSIGNMENT_REQUIRED[\s\S]*bt-1/);
      await refused(`update membership set role = 'FINANCE' where user_id = 'c-1'`, /COACH_REASSIGNMENT_REQUIRED/);
      await refused(`update membership set role = 'GUARDIAN', active = false where user_id = 'c-1'`, /COACH_REASSIGNMENT_REQUIRED/);
      assert.equal(JSON.stringify(await db.query(coachState)), before, "every refusal changed nothing");
      // Allowed: changes that keep coaching access, renaming a batch, and the reassign-then-deactivate order.
      await db.query(`update membership set role = 'ADMIN' where user_id = 'c-1'`);
      await db.query(`update membership set role = 'COACH' where user_id = 'c-1'`);
      await db.query(`update batch set name = 'Batch one' where id = 'bt-1'`);
      await db.query(`update membership set active = false where user_id = 'c-fin'`);
      await db.script(`begin; update batch set coach_id = 'c-2' where id = 'bt-1'; update membership set active = false where user_id = 'c-1'; commit;`);
      assert.deepEqual({ ...(await db.query(`select coach_id from batch where id = 'bt-1'`))[0] }, { coach_id: "c-2" });
      assert.deepEqual({ ...(await db.query(`select active from membership where user_id = 'c-1'`))[0] }, { active: false });
      // A failed step rolls the whole transaction back: the earlier steps are undone with it.
      await assert.rejects(
        () => db.script(`begin; update membership set active = true where user_id = 'c-old'; update batch set coach_id = 'c-old' where id = 'bt-1'; update membership set active = false where user_id = 'c-old'; commit;`),
        /COACH_REASSIGNMENT_REQUIRED/,
      );
      assert.deepEqual({ ...(await db.query(`select coach_id from batch where id = 'bt-1'`))[0] }, { coach_id: "c-2" });
      assert.deepEqual({ ...(await db.query(`select active from membership where user_id = 'c-old'`))[0] }, { active: false });
      assert.deepEqual((await runMigrations({ target: db.target })).pending, ["0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"], "0012 then applies on top of the coach-assignment data");
    },
  );
  test(
    `[${engine.name}] 0011 stops, changing nothing, when an existing batch is already coached by someone who cannot coach`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore("0011_coach_assignment_integrity") });
      for (const statement of coachSeed) await db.query(statement);
      await db.query(`insert into batch (id, academy_id, branch_id, name, coach_id) values ('bt-old', 'a-c', 'br', 'Old', 'c-old'), ('bt-fin', 'a-c', 'br', 'Fin', 'c-fin')`);
      const state = async () => JSON.stringify([await db.query(fingerprintSql), await db.query(coachState)]);
      const before = await state();
      await assert.rejects(
        () => runMigrations({ target: db.target }),
        (error: unknown) => /0011 pre-flight[\s\S]*bt-fin[\s\S]*bt-old/.test(`${String(error)} ${String((error as { cause?: unknown }).cause)}`),
      );
      assert.equal(await state(), before, "the failed migration changed nothing");
      assert.equal((await db.query(`select 1 from pg_trigger where tgname = 'batch_coach_must_coach'`)).length, 0);
      assert.deepEqual((await runMigrations({ target: db.target, dryRun: true })).pending, ["0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
    },
  );
  test(
    `[${engine.name}] 0011 rollback removes only its triggers and functions, keeps every row, and the chain re-applies`,
    opts,
    async () => {
      const reference = await engine.fresh();
      await runMigrations({ target: reference.target, folder: folderBefore("0011_coach_assignment_integrity") });
      const db = await engine.fresh();
      await runMigrations({ target: db.target });
      for (const statement of coachSeed) await db.query(statement);
      const before = JSON.stringify(await db.query(coachState));
      await db.script(readFileSync(ROLLBACK_0019, "utf8"));
      await db.script(readFileSync(ROLLBACK_0018, "utf8"));
      await db.script(readFileSync(ROLLBACK_0017, "utf8"));
      await db.script(readFileSync(ROLLBACK_0016, "utf8"));
      await db.script(readFileSync(ROLLBACK_0015, "utf8"));
      await db.script(readFileSync(ROLLBACK_0014, "utf8"));
      await db.script(readFileSync(ROLLBACK_0013, "utf8"));
      await db.script(readFileSync(ROLLBACK_0012, "utf8"));
      await db.script(readFileSync(ROLLBACK_0011, "utf8"));
      assert.equal(JSON.stringify(await db.query(fingerprintSql)), JSON.stringify(await reference.query(fingerprintSql)));
      assert.equal(JSON.stringify(await db.query(constraintSql)), JSON.stringify(await reference.query(constraintSql)));
      assert.equal((await db.query(`select 1 from pg_proc where proname in ('batch_coach_must_coach', 'membership_coach_assignments')`)).length, 0);
      assert.equal(JSON.stringify(await db.query(coachState)), before, "rows untouched");
      await db.query(`delete from drizzle."__drizzle_migrations" where created_at in (select created_at from drizzle."__drizzle_migrations" order by created_at desc limit 1)`);
      assert.deepEqual((await runMigrations({ target: db.target })).pending, ["0011_coach_assignment_integrity", "0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      await assert.rejects(() => db.query(`update membership set active = false where user_id = 'c-1'`), /COACH_REASSIGNMENT_REQUIRED/);
    },
  );
}
// Two real connections racing: the batch trigger's share lock on the coach's membership serialises an
// assignment and a deactivation, so one of them is always refused (PostgreSQL only: PGlite has one connection).
test(
  "[PostgreSQL] 0011 under concurrency: an assignment and a deactivation of the same coach never both commit",
  { skip: PG_ONLY },
  async () => {
    const db = await postgresEngine.fresh();
    await runMigrations({ target: db.target });
    for (const statement of coachSeed) await db.query(statement);
    const url = (db.target as { url: string }).url;
    const connect = async () => {
      const c = new Client({ connectionString: url });
      await c.connect();
      return c;
    };
    const one = await connect();
    const two = await connect();
    const settle = (p: Promise<unknown>) => p.then(() => "committed", (e: Error) => e.message);
    try {
      // Order A: the assignment takes its lock first; the deactivation waits, then sees the batch.
      await one.query("begin");
      await one.query(`update batch set coach_id = 'c-2' where id = 'bt-1'`);
      await two.query("begin");
      const deactivate = settle(two.query(`update membership set active = false where user_id = 'c-2'`));
      await new Promise((r) => setTimeout(r, 300));
      await one.query("commit");
      assert.match(await deactivate, /COACH_REASSIGNMENT_REQUIRED/);
      await two.query("rollback");
      // Order B: the deactivation commits first; the waiting assignment is then refused.
      await two.query("begin");
      await two.query(`update membership set active = false where user_id = 'c-1'`);
      await one.query("begin");
      const assign = settle(one.query(`update batch set coach_id = 'c-1' where id = 'bt-1'`));
      await new Promise((r) => setTimeout(r, 300));
      await two.query("commit");
      assert.match(await assign, /COACH_ASSIGNMENT_INVALID/);
      await one.query("rollback");
      assert.deepEqual(
        (await db.query(`select b.coach_id, m.active, m.role from batch b join membership m on m.academy_id = b.academy_id and m.user_id = b.coach_id where b.academy_id = 'a-c'`)).map((r) => ({ ...r })),
        [{ coach_id: "c-2", active: true, role: "HEAD_COACH" }],
        "the surviving batch is coached by an active coach",
      );
    } finally {
      await one.end();
      await two.end();
    }
  },
);

/* ===================== Stage 5E: 0012_calendar_series ===================== */
const calendarSeed = [
  `insert into academy (id, name, timezone) values ('a-s', 'Series academy', 'UTC'), ('a-t', 'Other academy', 'UTC')`,
];
/**
 * A calendar_event row as the application stored it before 0012 (data only), or, with `columns`, a row that
 * also sets the 0012 columns directly (to prove the constraints).
 */
function legacyEvent(
  id: string,
  academy: string,
  localDate: string,
  seriesId: string | null,
  status = "SCHEDULED",
  kind = "EVENT",
  columns?: { series_id: string | null; occurrence_date?: string | null },
) {
  const data = JSON.stringify({
    title: "Weekly", localDate, localTime: "17:00", duration: 60, startsAt: `${localDate}T17:00:00.000Z`,
    endsAt: `${localDate}T18:00:00.000Z`, timezone: "UTC", branchId: "br", coachId: "c-1", batchId: "",
    playerIds: [], enquiryId: null, seriesId,
  });
  const lit = (v: string | null | undefined) => (v == null ? "null" : `'${v}'`);
  return columns
    ? `insert into calendar_event (id, academy_id, version, kind, status, data, series_id, occurrence_date) values ('${id}', '${academy}', 1, '${kind}', '${status}', '${data}'::jsonb, ${lit(columns.series_id)}, ${lit(columns.occurrence_date)})`
    : `insert into calendar_event (id, academy_id, version, kind, status, data) values ('${id}', '${academy}', 1, '${kind}', '${status}', '${data}'::jsonb)`;
}
const legacyRows = [
  legacyEvent("ev-1", "a-s", "2027-01-04", "ser-1"),
  legacyEvent("ev-2", "a-s", "2027-01-11", "ser-1"),
  legacyEvent("ev-3", "a-s", "2027-01-18", "ser-1"),
  // Detached by the old defect (its first edit erased the tag): stays a one-off event.
  legacyEvent("ev-4", "a-s", "2027-01-25", null, "CANCELLED"),
  legacyEvent("ev-5", "a-s", "2027-02-01", null),
  legacyEvent("ev-6", "a-t", "2027-01-04", "ser-x"),
];
const eventContent = `select id, academy_id, version, kind, status, data from calendar_event order by id`;
for (const engine of [pgliteEngine, postgresEngine]) {
  const opts = engine === postgresEngine ? { skip: PG_ONLY } : {};
  test(
    `[${engine.name}] 0012 links tagged occurrences to series rows without changing any event's content, version or status`,
    opts,
    async () => {
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore("0012_calendar_series") });
      for (const statement of [...calendarSeed, ...legacyRows]) await db.query(statement);
      const before = JSON.stringify(await db.query(eventContent));
      const report = await runMigrations({ target: db.target });
      assert.deepEqual(report.pending, ["0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      assert.equal(JSON.stringify(await db.query(eventContent)), before, "no event content, version or status changed");
      assert.deepEqual(
        (await db.query(`select id, series_id, occurrence_date::text as occurrence_date from calendar_event order by id`)).map((r) => ({ ...r })),
        [
          { id: "ev-1", series_id: "ser-1", occurrence_date: "2027-01-04" },
          { id: "ev-2", series_id: "ser-1", occurrence_date: "2027-01-11" },
          { id: "ev-3", series_id: "ser-1", occurrence_date: "2027-01-18" },
          { id: "ev-4", series_id: null, occurrence_date: null },
          { id: "ev-5", series_id: null, occurrence_date: null },
          { id: "ev-6", series_id: "ser-x", occurrence_date: "2027-01-04" },
        ],
      );
      assert.deepEqual(
        (await db.query(`select id, academy_id, version, kind, split_from, data from calendar_series order by id`)).map((r) => ({ ...r })),
        [
          { id: "ser-1", academy_id: "a-s", version: 1, kind: "EVENT", split_from: null, data: { origin: "MIGRATED", firstDate: "2027-01-04", count: 3, interval: 1 } },
          { id: "ser-x", academy_id: "a-t", version: 1, kind: "EVENT", split_from: null, data: { origin: "MIGRATED", firstDate: "2027-01-04", count: 1, interval: 1 } },
        ],
      );
      const refused = (sql: string, pattern: RegExp) => assert.rejects(() => db.query(sql), pattern, sql);
      // An occurrence can never leave its series, be re-dated, or be attached to a series later.
      await refused(`update calendar_event set series_id = null, occurrence_date = null, data = jsonb_set(data, '{seriesId}', 'null') where id = 'ev-2'`, /SERIES_IDENTITY_IMMUTABLE/);
      await refused(`update calendar_event set data = jsonb_set(data, '{seriesId}', 'null') where id = 'ev-2'`, /calendar_event_series_mirror/);
      await refused(`update calendar_event set occurrence_date = '2027-01-12' where id = 'ev-2'`, /SERIES_IDENTITY_IMMUTABLE/);
      await refused(`update calendar_event set series_id = 'ser-1', occurrence_date = '2027-02-01', data = jsonb_set(data, '{seriesId}', '"ser-1"') where id = 'ev-5'`, /SERIES_IDENTITY_IMMUTABLE/);
      await db.query(`insert into calendar_series (id, academy_id, kind, data) values ('ser-2', 'a-s', 'EVENT', '{}'::jsonb)`);
      await refused(`update calendar_event set series_id = 'ser-2', data = jsonb_set(data, '{seriesId}', '"ser-2"') where id = 'ev-3'`, /SERIES_IDENTITY_IMMUTABLE/);
      // One occurrence per slot; a series of the same academy only; consistent shape.
      await refused(legacyEvent("ev-dup", "a-s", "2027-01-11", "ser-1", "SCHEDULED", "EVENT", { series_id: "ser-1", occurrence_date: "2027-01-11" }), /calendar_event_occurrence_unique|duplicate key/);
      await refused(legacyEvent("ev-cross", "a-t", "2027-03-01", "ser-1", "SCHEDULED", "EVENT", { series_id: "ser-1", occurrence_date: "2027-03-01" }), /calendar_event_series_fk|foreign key/);
      await refused(legacyEvent("ev-shape", "a-s", "2027-03-01", "ser-1", "SCHEDULED", "EVENT", { series_id: "ser-1", occurrence_date: null }), /calendar_event_series_shape/);
      await refused(legacyEvent("ev-mirror", "a-s", "2027-03-01", null, "SCHEDULED", "EVENT", { series_id: "ser-1", occurrence_date: "2027-03-01" }), /calendar_event_series_mirror/);
      await refused(`insert into calendar_series (id, academy_id, kind, split_from, data) values ('ser-y', 'a-t', 'EVENT', 'ser-1', '{}'::jsonb)`, /calendar_series_split_from_fk|foreign key/);
      // Allowed: moving to a series split from its own, keeping the occurrence date; ordinary edits.
      await db.query(`insert into calendar_series (id, academy_id, kind, split_from, data) values ('ser-1b', 'a-s', 'EVENT', 'ser-1', '{}'::jsonb)`);
      await db.query(`update calendar_event set series_id = 'ser-1b', data = jsonb_set(data, '{seriesId}', '"ser-1b"'), version = version + 1 where id = 'ev-3'`);
      await db.query(`update calendar_event set status = 'CANCELLED', data = jsonb_set(data, '{title}', '"Renamed"') where id = 'ev-1'`);
      assert.deepEqual((await runMigrations({ target: db.target })).pending, []);
    },
  );
  test(
    `[${engine.name}] 0012 stops, changing nothing, when existing series tags are ambiguous`,
    opts,
    async () => {
      const cases: [string, string[], RegExp][] = [
        ["two occurrences on one date", [legacyEvent("d-1", "a-s", "2027-01-04", "ser-d"), legacyEvent("d-2", "a-s", "2027-01-04", "ser-d")], /0012 pre-flight[\s\S]*ser-d on 2027-01-04/],
        ["one tag in two academies", [legacyEvent("x-1", "a-s", "2027-01-04", "ser-a"), legacyEvent("x-2", "a-t", "2027-01-11", "ser-a")], /0012 pre-flight[\s\S]*series ser-a/],
        ["one tag on two kinds", [legacyEvent("k-1", "a-s", "2027-01-04", "ser-k"), legacyEvent("k-2", "a-s", "2027-01-11", "ser-k", "SCHEDULED", "TRIAL")], /0012 pre-flight[\s\S]*series ser-k/],
        ["unusable local date", [legacyEvent("b-1", "a-s", "4 Jan", "ser-b")], /0012 pre-flight[\s\S]*event b-1/],
      ];
      for (const [name, rows, pattern] of cases) {
        const db = await engine.fresh();
        await runMigrations({ target: db.target, folder: folderBefore("0012_calendar_series") });
        for (const statement of [...calendarSeed, ...rows]) await db.query(statement);
        const state = async () => JSON.stringify([await db.query(fingerprintSql), await db.query(eventContent)]);
        const before = await state();
        await assert.rejects(
          () => runMigrations({ target: db.target }),
          (error: unknown) => pattern.test(`${String(error)} ${String((error as { cause?: unknown }).cause)}`),
          name,
        );
        assert.equal(await state(), before, `${name}: the failed migration changed nothing`);
        assert.deepEqual((await runMigrations({ target: db.target, dryRun: true })).pending, ["0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"], name);
      }
    },
  );
  test(
    `[${engine.name}] 0012 rollback removes only its table, columns, constraints and trigger; events keep their tags; the chain re-applies`,
    opts,
    async () => {
      const reference = await engine.fresh();
      await runMigrations({ target: reference.target, folder: folderBefore("0012_calendar_series") });
      const db = await engine.fresh();
      await runMigrations({ target: db.target, folder: folderBefore("0012_calendar_series") });
      for (const statement of [...calendarSeed, ...legacyRows]) await db.query(statement);
      const before = JSON.stringify(await db.query(eventContent));
      await runMigrations({ target: db.target, folder: folderThrough0012() });
      // Tagged rows were linked by the backfill (series data), so the loss must be accepted explicitly.
      await db.script(`SET sportozen.allow_series_data_loss = 'on';
${readFileSync(ROLLBACK_0012, "utf8")}`);
      assert.equal(JSON.stringify(await db.query(fingerprintSql)), JSON.stringify(await reference.query(fingerprintSql)));
      assert.equal(JSON.stringify(await db.query(constraintSql)), JSON.stringify(await reference.query(constraintSql)));
      assert.equal((await db.query(`select 1 from pg_proc where proname = 'calendar_event_series_stable'`)).length, 0);
      assert.equal(JSON.stringify(await db.query(eventContent)), before, "event rows untouched");
      // The hardened rollback removed 0012's own bookkeeping row in the same transaction (and nothing else).
      assert.equal((await db.query(`select 1 from drizzle."__drizzle_migrations" where created_at = 1794226000000`)).length, 0);
      assert.deepEqual((await runMigrations({ target: db.target })).pending, ["0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"]);
      assert.equal((await db.query(`select 1 from calendar_event where series_id is not null`)).length, 4, "the re-applied backfill links the tagged rows again");
    },
  );
  test(
    `[${engine.name}] 0012 rollback guard: refuses, changing nothing, unless 0012 is applied, latest and intact and series data loss is accepted; only 0012's own record is removed`,
    opts,
    async () => {
      type Db = Awaited<ReturnType<Engine["fresh"]>>;
      const bookkeeping = `select hash, created_at::text as created_at from drizzle."__drizzle_migrations" order by created_at`;
      const rollback = readFileSync(ROLLBACK_0012, "utf8");
      const accept = (script: string) => `SET sportozen.allow_series_data_loss = 'on';\n${script}`;
      const stateOf = async (db: Db) =>
        JSON.stringify([
          await db.query(fingerprintSql),
          await db.query(constraintSql),
          await db.query(bookkeeping),
          await db.query(eventContent),
          await db.query(`select tgname from pg_trigger where tgname = 'calendar_event_series_stable'`),
          await db.query(`select proname from pg_proc where proname = 'calendar_event_series_stable'`),
          await db.query(`select to_regclass('public.calendar_series') is not null as present`),
        ]);
      const refusedWith = async (db: Db, script: string, pattern: RegExp, name: string) => {
        const before = await stateOf(db);
        await assert.rejects(() => db.script(script), (e: unknown) => pattern.test(String(e)), name);
        assert.equal(await stateOf(db), before, `${name}: a refused rollback changes nothing`);
      };
      const gone = async (db: Db) => (await db.query(`select to_regclass('public.calendar_series') is null as gone`))[0].gone;

      // 1. 0012 applied, no series data: rolled back in one transaction; exactly 0012's record removed, 0011's kept.
      {
        const db = await engine.fresh();
        await runMigrations({ target: db.target, folder: folderThrough0012() });
        const recordsBefore = await db.query(bookkeeping);
        assert.equal(recordsBefore.at(-1)!.created_at, "1794226000000");
        await db.script(rollback);
        assert.equal(await gone(db), true);
        assert.deepEqual(await db.query(bookkeeping), recordsBefore.slice(0, -1), "only 0012's record is removed");
        // Running it again is refused and cannot remove 0011's record.
        await refusedWith(db, rollback, /0012 rollback refused: migration 0012_calendar_series is not recorded as applied/, "second run");
        await refusedWith(db, accept(rollback), /not recorded as applied/, "second run with acceptance");
        assert.deepEqual((await runMigrations({ target: db.target })).pending, ["0012_calendar_series", "0013_role_validation_owner_presence", "0014_adult_guardian_access", "0015_auth_onboarding_and_outbox", "0016_guardian_phone", "0017_multi_academy_session", "0018_academy_invitations", "0019_contacts_dispatch"], "the chain re-applies");
      }
      // 2. 0012 applied and series data exists: refused without acceptance; with acceptance rolled back, events kept.
      {
        const db = await engine.fresh();
        await runMigrations({ target: db.target, folder: folderBefore("0012_calendar_series") });
        for (const statement of [...calendarSeed, ...legacyRows]) await db.query(statement);
        await runMigrations({ target: db.target, folder: folderThrough0012() });
        const events = JSON.stringify(await db.query(eventContent));
        await refusedWith(db, rollback, /0012 rollback refused: \d+ series and 4 linked occurrences exist/, "series data, loss not accepted");
        await refusedWith(db, `SET sportozen.allow_series_data_loss = 'yes';\n${rollback}`, /linked occurrences exist/, "anything but 'on' is not acceptance");
        await db.script(accept(rollback));
        assert.equal(await gone(db), true);
        assert.equal((await db.query(`select 1 from drizzle."__drizzle_migrations" where created_at = 1794226000000`)).length, 0);
        assert.equal(JSON.stringify(await db.query(eventContent)), events, "every event row is kept");
      }
      // 3. 0012 absent (database at 0011): refused; 0011's record and schema untouched.
      {
        const db = await engine.fresh();
        await runMigrations({ target: db.target, folder: folderBefore("0012_calendar_series") });
        const records = await db.query(bookkeeping);
        await refusedWith(db, rollback, /not recorded as applied/, "0012 absent");
        await refusedWith(db, accept(rollback), /not recorded as applied/, "0012 absent, acceptance set");
        assert.deepEqual(await db.query(bookkeeping), records, "0011's record is never removed");
      }
      // 4. 0012 applied but not the latest migration: refused.
      {
        const db = await engine.fresh();
        await runMigrations({ target: db.target, folder: folderThrough0012() });
        await db.query(`insert into drizzle."__drizzle_migrations" (hash, created_at) values ('a-later-migration', 1794226000001)`);
        await refusedWith(db, rollback, /0012 rollback refused: 1 later migration\(s\) are applied after 0012/, "not the latest");
        await refusedWith(db, accept(rollback), /later migration/, "not the latest, acceptance set");
      }
      // 5. Recorded with another hash, or an 0012 object missing: refused before any DROP runs.
      {
        const db = await engine.fresh();
        await runMigrations({ target: db.target, folder: folderThrough0012() });
        await db.query(`update drizzle."__drizzle_migrations" set hash = 'not-the-reviewed-0012' where created_at = 1794226000000`);
        await refusedWith(db, rollback, /not recorded as applied/, "unexpected hash");
      }
      {
        const db = await engine.fresh();
        await runMigrations({ target: db.target, folder: folderThrough0012() });
        await db.query(`drop trigger calendar_event_series_stable on calendar_event`);
        await refusedWith(db, rollback, /schema does not match migration 0012 \(missing: trigger calendar_event_series_stable\)/, "partial schema");
      }
    },
  );
}
