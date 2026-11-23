import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { config } from "../../shared/config";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { guardPool } from "./pool-guard";
type Database = PgliteDatabase<typeof schema>;
const globalDb = globalThis as unknown as {
  sportozenDb?: Database;
  sportozenClose?: () => Promise<void>;
};
export function database(): Database {
  if (globalDb.sportozenDb) return globalDb.sportozenDb;
  const env = config();
  if (env.DATABASE_URL) {
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    guardPool(pool);
    // Both drivers share Drizzle's PostgreSQL query/transaction API. The cast stays at this adapter boundary.
    globalDb.sportozenDb = postgresDrizzle(pool, {
      schema,
    }) as unknown as Database;
    globalDb.sportozenClose = () => pool.end();
  } else {
    mkdirSync(dirname(resolve(env.LOCAL_DATABASE_PATH!)), { recursive: true });
    const client = new PGlite(env.LOCAL_DATABASE_PATH!);
    globalDb.sportozenDb = drizzle(client, { schema });
    globalDb.sportozenClose = () => client.close();
  }
  return globalDb.sportozenDb;
}
export async function closeDatabase() {
  await globalDb.sportozenClose?.();
  globalDb.sportozenDb = undefined;
}
