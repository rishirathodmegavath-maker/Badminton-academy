import { database } from "../../src/infrastructure/database/client";
/**
 * Test-only statement log. Wraps the query method of the application's own database client (PGlite or a
 * node-postgres pool) so a test can see every SQL statement a request issues, its parameters and the
 * rows it returned. Nothing here changes what is executed.
 */
export type Statement = {
  sql: string;
  params: unknown[];
  rows: number;
  bytes: number;
  /** The returned rows as JSON text (for canary searches). */
  text: string;
  tables: string[];
};
type Query = (...args: unknown[]) => Promise<{ rows?: unknown[] } | undefined>;
let current: Statement[] | null = null;
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x)) ?? "";
let installed = false;
const tablesOf = (sql: string) =>
  [...sql.matchAll(/\b(?:from|join|into|update)\s+"([a-z_]+)"/gi)].map((m) => m[1]);
function record(text: unknown, params: unknown, result: { rows?: unknown[] } | undefined) {
  if (!current) return;
  const sql = typeof text === "string" ? text : String((text as { text?: string })?.text ?? "");
  const values = Array.isArray(params) ? params : ((text as { values?: unknown[] })?.values ?? []);
  const rows = result?.rows ?? [];
  current.push({
    sql,
    params: values,
    rows: rows.length,
    bytes: rows.reduce<number>((n, r) => n + json(r).length, 0),
    text: json(rows),
    tables: [...new Set(tablesOf(sql))],
  });
}
function wrap(target: { query: Query }) {
  const original = target.query.bind(target);
  target.query = (...args: unknown[]) => {
    // Callback-style calls (node-postgres internals) are passed through untouched and not recorded.
    if (typeof args[args.length - 1] === "function") return original(...args);
    return original(...args).then((result) => {
      record(args[0], args[1], result);
      return result;
    });
  };
}
/** Installs the wrapper once on the process's database client. */
export function installStatementLog() {
  if (installed) return;
  installed = true;
  const client = (database() as unknown as { $client: Record<string, unknown> }).$client;
  wrap(client as unknown as { query: Query });
  // PGlite transactions hand the callback a separate object; wrap it too.
  if (typeof client.transaction === "function") {
    const transaction = (client.transaction as (fn: (tx: unknown) => unknown) => unknown).bind(client);
    client.transaction = (fn: (tx: { query: Query }) => unknown) =>
      transaction((tx: unknown) => {
        wrap(tx as { query: Query });
        return fn(tx as { query: Query });
      });
  }
  // node-postgres transactions use a pooled client.
  if (typeof client.connect === "function" && typeof client.end === "function") {
    const connect = (client.connect as (...a: unknown[]) => Promise<{ query: Query }>).bind(client);
    // Pool.query itself uses the callback form internally (already logged by the pool wrapper): pass it through.
    client.connect = (...args: unknown[]) => {
      if (typeof args[0] === "function") return connect(...args);
      return connect().then((pooled) => {
        if (!(pooled as unknown as { __logged?: boolean }).__logged) {
          wrap(pooled);
          (pooled as unknown as { __logged?: boolean }).__logged = true;
        }
        return pooled;
      });
    };
  }
}
/** Runs fn and returns the statements it issued (statements of concurrent work are included, so run alone). */
export async function captureStatements<T>(fn: () => Promise<T>) {
  installStatementLog();
  const log: Statement[] = [];
  current = log;
  try {
    const value = await fn();
    return { value, log };
  } finally {
    current = null;
  }
}
