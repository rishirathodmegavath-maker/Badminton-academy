import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { Client } from "pg";
import { readMigrationFiles } from "drizzle-orm/migrator";
/**
 * Migration execution for both supported databases.
 *
 * - Hosted PostgreSQL (`DATABASE_URL`): node-postgres, one dedicated connection, a session
 *   advisory lock (no two migrators at once), a pre-flight check of the migration folder, a full
 *   reconciliation of the migration history, and an explicit confirmation for any target that is
 *   not on this machine.
 * - Embedded development database (`LOCAL_DATABASE_PATH`): PGlite, as before.
 *
 * drizzle runs every pending migration inside ONE transaction, so a failing migration leaves the
 * database exactly as it was. This module does not need BETTER_AUTH_* settings.
 */
export class MigrationError extends Error {}
/** Plain string map: accepts process.env as well as hand-built environments (tests, CLI). */
export type Env = Readonly<Record<string, string | undefined>>;
export type MigrationTarget =
  { kind: "postgres"; url: string } | { kind: "pglite"; path: string };
export type MigrationReport = {
  target: string;
  applied: string[];
  pending: string[];
  dryRun: boolean;
};
type JournalEntry = { idx: number; tag: string; when: number };
type Journal = { entries: JournalEntry[] };
// Arbitrary constant: identifies "Sportozen schema migration" among advisory locks.
export const LOCK_KEY = 7_102_026;
const DEFAULT_FOLDER = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);
export function targetFromEnv(env: Env): MigrationTarget {
  if (env.DATABASE_URL) return { kind: "postgres", url: env.DATABASE_URL };
  if (env.NODE_ENV === "production")
    throw new MigrationError(
      "Production migrations require DATABASE_URL. The embedded database is development-only.",
    );
  if (!env.LOCAL_DATABASE_PATH)
    throw new MigrationError(
      "Set DATABASE_URL (PostgreSQL) or LOCAL_DATABASE_PATH (embedded development database).",
    );
  return { kind: "pglite", path: env.LOCAL_DATABASE_PATH };
}
export type PostgresEndpoint = { host: string; port: number; database: string };
/**
 * Where node-postgres will REALLY connect. The driver itself parses the URL (query overrides such
 * as `?host=` and `?port=`, `postgres:///db`, and PGHOST/PGPORT/PGDATABASE fallbacks included), so
 * what is displayed, confirmed and connected to can never disagree. `hostaddr` is refused: libpq
 * honours it, node-postgres ignores it, and a URL that means different things to different tools
 * is not safe to confirm.
 */
export function resolvePostgresTarget(url: string): PostgresEndpoint {
  if (!/^postgres(ql)?:\/\//i.test(url))
    throw new MigrationError("DATABASE_URL must start with postgres://.");
  if (/[?&]hostaddr=/i.test(url))
    throw new MigrationError(
      "DATABASE_URL uses `hostaddr`, which is ambiguous between database tools. Use `host` only.",
    );
  let client: Client;
  try {
    client = new Client({ connectionString: url });
  } catch {
    throw new MigrationError("DATABASE_URL is not a valid PostgreSQL URL.");
  }
  const { host, port, database } = client;
  if (!host || !database)
    throw new MigrationError("DATABASE_URL must name a host and a database.");
  return { host: String(host), port: Number(port) || 5432, database };
}
/** True only for this machine's loopback interface. Unix sockets and unknown hosts are remote. */
export function isLoopbackHost(host: string) {
  const bare = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    bare === "localhost" ||
    bare === "::1" ||
    (isIP(bare) === 4 && bare.startsWith("127."))
  );
}
export const formatEndpoint = (e: PostgresEndpoint) =>
  `${e.host}:${e.port}/${e.database}`;
/** Host:port/database only. Never includes credentials or query parameters. */
export function describeTarget(target: MigrationTarget) {
  if (target.kind === "pglite") return `embedded:${resolve(target.path)}`;
  return formatEndpoint(resolvePostgresTarget(target.url));
}
/**
 * A target that is not on this machine is only migrated when the operator repeats its exact
 * effective `host:port/database` in MIGRATION_CONFIRM_TARGET. This stops a stray DATABASE_URL in a
 * shell or env file from migrating the wrong environment.
 */
export function assertSafeTarget(target: MigrationTarget, env: Env) {
  if (target.kind === "pglite") return;
  const endpoint = resolvePostgresTarget(target.url);
  if (isLoopbackHost(endpoint.host)) return;
  const described = formatEndpoint(endpoint);
  if (env.MIGRATION_CONFIRM_TARGET !== described)
    throw new MigrationError(
      `Refusing to migrate remote database ${described}. Set MIGRATION_CONFIRM_TARGET=${described} to confirm this exact target.`,
    );
}
/** Journal order is what drizzle uses to decide "already applied"; it must be strictly increasing. */
export function verifyMigrationFolder(folder: string) {
  const journalPath = resolve(folder, "meta/_journal.json");
  if (!existsSync(journalPath))
    throw new MigrationError(`Missing ${journalPath}.`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  if (!Array.isArray(journal.entries) || !journal.entries.length)
    throw new MigrationError("The migration journal is empty.");
  let previous = -Infinity;
  journal.entries.forEach((entry, index) => {
    if (entry.idx !== index)
      throw new MigrationError(
        `Journal entry ${entry.tag} has idx ${entry.idx}; expected ${index}.`,
      );
    if (!entry.tag.startsWith(String(index).padStart(4, "0") + "_"))
      throw new MigrationError(
        `Migration ${entry.tag} is out of numeric order.`,
      );
    if (!(entry.when > previous))
      throw new MigrationError(
        `Migration ${entry.tag} is not newer than the one before it; applied migrations are tracked by timestamp so it would be skipped.`,
      );
    previous = entry.when;
    if (!existsSync(resolve(folder, `${entry.tag}.sql`)))
      throw new MigrationError(`Missing ${entry.tag}.sql.`);
  });
  const listed = new Set(journal.entries.map((e) => `${e.tag}.sql`));
  const orphan = readdirSync(folder).find(
    (f) => f.endsWith(".sql") && !listed.has(f),
  );
  if (orphan)
    throw new MigrationError(
      `${orphan} is not listed in the migration journal, so it would never run.`,
    );
  return journal.entries;
}
type Applied = { hash: string; created_at: string | number }[];
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/**
 * drizzle stores the hash of the file's raw bytes, so the same migration checked out with CRLF
 * (Windows autocrlf) and with LF (Linux, CI) hashes differently. Accept either form; any other
 * difference is a genuine edit.
 */
export function acceptableHashes(file: string) {
  const text = readFileSync(file, "utf8");
  const lf = text.replace(/\r\n/g, "\n");
  return new Set([sha256(text), sha256(lf), sha256(lf.replace(/\n/g, "\r\n"))]);
}
/**
 * Reconciles the database's migration records with the complete ordered journal.
 *  - every recorded migration must exist in the journal with identical content;
 *  - a migration may be missing from the database only if it is newer than everything applied
 *    (drizzle applies "newer than the latest record" and would silently skip anything older).
 */
export function reconcileHistory(
  entries: JournalEntry[],
  folder: string,
  rows: Applied,
) {
  const byWhen = new Map(entries.map((e) => [e.when, e]));
  const recorded = new Map<string, number>();
  for (const row of rows) {
    const when = Number(row.created_at);
    const entry = byWhen.get(when);
    if (!entry)
      throw new MigrationError(
        "The database contains a migration that is not in this migrations folder (wrong branch or database).",
      );
    if (recorded.has(entry.tag))
      throw new MigrationError(
        `Migration ${entry.tag} is recorded more than once in the database.`,
      );
    if (!acceptableHashes(resolve(folder, `${entry.tag}.sql`)).has(row.hash))
      throw new MigrationError(
        `Migration ${entry.tag} was modified after it was applied. Add a new migration instead of editing an applied one.`,
      );
    recorded.set(entry.tag, when);
  }
  const latest = rows.length
    ? Math.max(...rows.map((r) => Number(r.created_at)))
    : -Infinity;
  const pending = entries.filter((e) => !recorded.has(e.tag));
  const skipped = pending.filter((e) => e.when < latest);
  if (skipped.length)
    throw new MigrationError(
      `Inconsistent migration history: ${skipped.map((e) => e.tag).join(", ")} ${skipped.length > 1 ? "were" : "was"} never applied to this database, but later migrations were. drizzle would skip ${skipped.length > 1 ? "them" : "it"} silently. Reconcile the database with this branch before migrating.`,
    );
  return {
    applied: entries.filter((e) => recorded.has(e.tag)).map((e) => e.tag),
    pending: pending.map((e) => e.tag),
  };
}
const TABLE = 'drizzle."__drizzle_migrations"';
const PRESENT =
  "select to_regclass('drizzle.__drizzle_migrations') is not null as present";
function statementTimeout(env: Env) {
  const raw = env.MIGRATION_STATEMENT_TIMEOUT_MS;
  const value = raw === undefined ? 5 * 60_000 : Number(raw);
  if (!Number.isInteger(value) || value < 1000)
    throw new MigrationError(
      "MIGRATION_STATEMENT_TIMEOUT_MS must be an integer of at least 1000.",
    );
  return value;
}
export async function runMigrations(options: {
  target: MigrationTarget;
  folder?: string;
  env?: Env;
  /** Report what would run without changing anything (not even creating a data directory). */
  dryRun?: boolean;
}): Promise<MigrationReport> {
  const env = options.env ?? process.env;
  const folder = resolve(options.folder ?? DEFAULT_FOLDER);
  const entries = verifyMigrationFolder(folder);
  readMigrationFiles({ migrationsFolder: folder }); // fail early if any file is unreadable
  assertSafeTarget(options.target, env);
  const target = describeTarget(options.target);
  const dryRun = !!options.dryRun;
  if (options.target.kind === "pglite")
    return runPglite(options.target.path, folder, entries, target, dryRun);
  const endpoint = resolvePostgresTarget(options.target.url);
  const client = new Client({
    connectionString: options.target.url,
    connectionTimeoutMillis: 10_000,
    // A stuck DDL statement must not hold the lock forever.
    statement_timeout: statementTimeout(env),
  });
  // Defence in depth: the connection we open is the endpoint that was confirmed.
  if (
    client.host !== endpoint.host ||
    Number(client.port) !== endpoint.port ||
    client.database !== endpoint.database
  )
    throw new MigrationError("The database target changed while resolving it.");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await client.connect().catch((error: Error) => {
    throw new MigrationError(`Cannot connect to ${target}: ${error.message}`);
  });
  try {
    const lock = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [LOCK_KEY],
    );
    if (!lock.rows[0].locked)
      throw new MigrationError(
        "Another migration is already running against this database.",
      );
    try {
      const exists = await client.query<{ present: boolean }>(PRESENT);
      const applied: Applied = exists.rows[0].present
        ? (
            await client.query<Applied[number]>(
              `select hash, created_at from ${TABLE}`,
            )
          ).rows
        : [];
      const plan = reconcileHistory(entries, folder, applied);
      if (!dryRun && plan.pending.length)
        await migrate(drizzle(client), { migrationsFolder: folder });
      return { target, ...plan, dryRun };
    } finally {
      // Never let a failed unlock (e.g. a dropped connection) hide the real error.
      await client
        .query("select pg_advisory_unlock($1)", [LOCK_KEY])
        .catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}
async function runPglite(
  path: string,
  folder: string,
  entries: JournalEntry[],
  target: string,
  dryRun: boolean,
): Promise<MigrationReport> {
  const { PGlite } = await import("@electric-sql/pglite");
  const inspect = async (dataDir: string) => {
    const client = new PGlite(dataDir);
    try {
      const exists = await client.query<{ present: boolean }>(PRESENT);
      const rows: Applied = exists.rows[0]?.present
        ? (
            await client.query<Applied[number]>(
              `select hash, created_at from ${TABLE}`,
            )
          ).rows
        : [];
      return reconcileHistory(entries, folder, rows);
    } finally {
      await client.close();
    }
  };
  if (dryRun) {
    // Opening a PGlite data directory writes to it, so planning inspects a throw-away copy and
    // never creates or touches the real directory.
    if (!existsSync(resolve(path))) {
      return {
        target,
        applied: [],
        pending: entries.map((e) => e.tag),
        dryRun,
      };
    }
    const scratch = mkdtempSync(join(tmpdir(), "sportozen-plan-"));
    try {
      cpSync(resolve(path), join(scratch, "db"), { recursive: true });
      return { target, ...(await inspect(join(scratch, "db"))), dryRun };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const client = new PGlite(path);
  try {
    const exists = await client.query<{ present: boolean }>(PRESENT);
    const rows: Applied = exists.rows[0]?.present
      ? (
          await client.query<Applied[number]>(
            `select hash, created_at from ${TABLE}`,
          )
        ).rows
      : [];
    const plan = reconcileHistory(entries, folder, rows);
    if (plan.pending.length)
      await migrate(drizzle(client), { migrationsFolder: folder });
    return { target, ...plan, dryRun };
  } finally {
    await client.close();
  }
}
