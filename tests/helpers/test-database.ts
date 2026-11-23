import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Client } from "pg";
import {
  isLoopbackHost,
  resolvePostgresTarget,
  runMigrations,
} from "../../src/infrastructure/database/migrations";
import { closeDatabase } from "../../src/infrastructure/database/client";
import { DATA_DIR } from "./paths";
/**
 * Disposable, per-run database for tests.
 *
 *  - default: embedded PGlite in <repo>/.data/<label>-<random> (removed afterwards)
 *  - TEST_POSTGRES_ADMIN_URL set: a fresh database `sportozen_test_<random>` on that server
 *    (dropped afterwards). `npm run test:pg` starts a throw-away container for it.
 *
 * The server must be on this machine, judged by where node-postgres will REALLY connect (query
 * overrides such as ?host= are resolved by the driver itself). Only paths and databases created
 * here are ever removed.
 */
export const DISPOSABLE_PREFIX = "sportozen_test_";
export function adminUrl() {
  const value = process.env.TEST_POSTGRES_ADMIN_URL;
  if (!value) return null;
  const endpoint = resolvePostgresTarget(value);
  if (!isLoopbackHost(endpoint.host))
    throw new Error(
      `TEST_POSTGRES_ADMIN_URL resolves to ${endpoint.host}, which is not a local, disposable server.`,
    );
  return value;
}
export function withDatabaseName(url: string, name: string) {
  const next = new URL(url);
  next.pathname = `/${name}`;
  // A ?dbname-style override must not redirect the new URL elsewhere.
  next.searchParams.delete("database");
  return next.toString();
}
export async function createPostgresDatabase(admin: string) {
  const name = `${DISPOSABLE_PREFIX}${randomBytes(6).toString("hex")}`;
  const client = new Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }
  const url = withDatabaseName(admin, name);
  // The URL we hand to the application must resolve to the database we just created.
  if (resolvePostgresTarget(url).database !== name)
    throw new Error(
      "Disposable database URL does not resolve to its database.",
    );
  return {
    name,
    url,
    async drop() {
      const dropper = new Client({ connectionString: admin });
      await dropper.connect();
      try {
        if (!name.startsWith(DISPOSABLE_PREFIX))
          throw new Error("Refusing to drop a non-disposable database.");
        await dropper.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
/**
 * An embedded test database is always a NEW directory directly under <repo>/.data named
 * `<label>-<12 hex>`. Anything else, above all the development database (`.data/development`) or a
 * path taken from the environment, is refused before a single file is opened or deleted.
 */
export function assertDisposablePath(path: string, dataDir = DATA_DIR) {
  const rel = relative(resolve(dataDir), resolve(path));
  const direct =
    rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes(sep);
  if (!direct || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*-[0-9a-f]{12}$/.test(rel))
    throw new Error(
      `Refusing to use "${path}" as a test database: tests may only create new <label>-<random> folders directly under .data.`,
    );
  return path;
}
export type TestDatabase = {
  mode: "postgres" | "pglite";
  cleanup(): Promise<void>;
};
/** Creates an empty database, migrates it with the production runner, and points the app at it. */
export async function provisionTestDatabase(
  label: string,
): Promise<TestDatabase> {
  const suffix = randomBytes(6).toString("hex");
  const media = join(DATA_DIR, `${label}-media-${suffix}`);
  process.env.PRIVATE_MEDIA_PATH = media;
  const admin = adminUrl();
  if (admin) {
    const created = await createPostgresDatabase(admin);
    process.env.DATABASE_URL = created.url;
    delete process.env.LOCAL_DATABASE_PATH;
    try {
      await runMigrations({ target: { kind: "postgres", url: created.url } });
    } catch (error) {
      await created.drop();
      throw error;
    }
    return {
      mode: "postgres",
      async cleanup() {
        await closeDatabase();
        await created.drop();
        rmSync(media, { recursive: true, force: true });
      },
    };
  }
  const path = assertDisposablePath(join(DATA_DIR, `${label}-${suffix}`));
  process.env.LOCAL_DATABASE_PATH = path;
  delete process.env.DATABASE_URL;
  await runMigrations({ target: { kind: "pglite", path } });
  return {
    mode: "pglite",
    async cleanup() {
      await closeDatabase();
      rmSync(path, { recursive: true, force: true });
      rmSync(media, { recursive: true, force: true });
    },
  };
}
