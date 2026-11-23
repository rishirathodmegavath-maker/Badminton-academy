import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Small read/rollback helper for the EMBEDDED development database (a PGlite data directory). It exists so the migration
 * runbook has commands that work in PowerShell (no quoting tricks) and that refuse unsafe targets. It never touches a
 * PostgreSQL server (there is no DATABASE_URL here) and never reads `.env.local`.
 *
 *   npx tsx scripts/dev-db-tool.ts state <data-dir>
 *       read-only: migrations recorded, whether academy_invitation exists, its triggers and row count
 *   npx tsx scripts/dev-db-tool.ts run-sql <data-dir> <file.sql> --yes
 *       executes a reviewed SQL file once (used for the guarded rollback in migrations-rollback/); without --yes it only says what it would do
 *
 * Both refuse a folder that is not an embedded data directory and refuse while a server holds it (postmaster.pid).
 */
const [command, dirArg, fileArg] = process.argv.slice(2);
const yes = process.argv.includes("--yes");
const fail = (message: string): never => {
  console.error(`dev-db-tool: ${message}`);
  process.exit(2);
};
if (!command || !dirArg) fail("usage: state <data-dir> | run-sql <data-dir> <file.sql> --yes");
const dir = resolve(dirArg);
for (const need of ["PG_VERSION", "base", "global"])
  if (!existsSync(join(dir, need))) fail(`${dir} is not an embedded PostgreSQL data directory (missing ${need}).`);
if (existsSync(join(dir, "postmaster.pid")))
  fail(`postmaster.pid exists in ${dir}: a server may be using it. Stop the application first (a clean stop removes the file).`);

async function withDatabase<T>(work: (db: PGlite) => Promise<T>) {
  const db = new PGlite(dir);
  try {
    await db.waitReady;
    return await work(db);
  } finally {
    await db.close();
  }
}

if (command === "state") {
  await withDatabase(async (db) => {
    const one = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows[0];
    console.log(JSON.stringify(await one(`select count(*)::int as migrations_recorded from drizzle."__drizzle_migrations"`)));
    const table = await one(`select to_regclass('academy_invitation')::text as academy_invitation`);
    console.log(JSON.stringify(table));
    if (table.academy_invitation)
      console.log(
        JSON.stringify(
          await one(
            `select (select count(*)::int from academy_invitation) as invitations, (select count(*)::int from pg_trigger where tgrelid = 'academy_invitation'::regclass and not tgisinternal) as triggers`,
          ),
        ),
      );
  });
} else if (command === "run-sql") {
  if (!fileArg) fail("run-sql needs a .sql file");
  const sql = readFileSync(resolve(fileArg), "utf8");
  if (!yes) console.log(`Would run ${fileArg} (${sql.length} characters) against ${dir}. Nothing changed. Repeat with --yes.`);
  else {
    // The file is the whole transaction (BEGIN ... COMMIT); it stops with an error, and changes nothing, if its own guard refuses.
    await withDatabase((db) => db.exec(sql));
    console.log(`Ran ${fileArg} against ${dir}.`);
  }
} else fail(`unknown command ${command}`);
