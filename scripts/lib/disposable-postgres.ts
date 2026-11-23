import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
/**
 * A throw-away PostgreSQL container for tests, with cleanup that survives every way a run can end:
 * normal completion, an exception, a readiness or overall timeout, SIGINT/SIGTERM/SIGHUP, and
 * process exit. The container listens on 127.0.0.1 only, on a random port, with a random password,
 * and carries a label so containers orphaned by a hard kill (SIGKILL, power loss) are swept on the
 * next run.
 */
export const CONTAINER_LABEL = "sportozen-test-pg";
export type DisposablePostgres = {
  name: string;
  /** Admin connection URL (loopback, random password). */
  url: string;
  version: string;
};
export type DisposableOptions = {
  image?: string;
  /** How long to wait for the server to accept connections. */
  readyTimeoutMs?: number;
  /** Ceiling for the work itself (container start-up is bounded by readyTimeoutMs). */
  totalTimeoutMs?: number;
  /** Replaced in tests so a signal does not terminate the test runner. */
  exit?: (code: number) => void;
  /** Containers with the label older than this are removed at start (orphans). */
  staleAfterMs?: number;
};
const run = (args: string[], env?: NodeJS.ProcessEnv) =>
  spawnSync("docker", args, { encoding: "utf8", env: env ?? process.env });
export function dockerAvailable() {
  return run(["version", "--format", "{{.Server.Version}}"]).status === 0;
}
export function containersWithLabel() {
  return run([
    "ps",
    "-a",
    "--filter",
    `label=${CONTAINER_LABEL}`,
    "--format",
    "{{.Names}}",
  ])
    .stdout.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}
function sweepStale(staleAfterMs: number) {
  for (const name of containersWithLabel()) {
    const created = Date.parse(
      run(["inspect", "-f", "{{.Created}}", name]).stdout.trim(),
    );
    if (Number.isFinite(created) && Date.now() - created > staleAfterMs)
      run(["rm", "-f", name]);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function withDisposablePostgres<T>(
  fn: (pg: DisposablePostgres, signal: AbortSignal) => Promise<T>,
  options: DisposableOptions = {},
): Promise<T> {
  const image =
    options.image ?? process.env.TEST_POSTGRES_IMAGE ?? "postgres:17-alpine";
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const abort = new AbortController();
  const name = `${CONTAINER_LABEL}-${randomBytes(4).toString("hex")}`;
  const password = randomBytes(18).toString("hex");
  let started = false;
  let removed = false;
  const cleanup = () => {
    if (!started || removed) return;
    removed = true;
    run(["rm", "-f", name]);
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const codes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  const handlers = signals.map((signal) => {
    const handler = () => {
      abort.abort(new Error(`Interrupted by ${signal}`));
      cleanup();
      exit(codes[signal]);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  // Last resort for exits that bypass `finally` (explicit process.exit elsewhere in the process).
  process.on("exit", cleanup);
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!dockerAvailable())
      throw new Error("Docker is not available (is the daemon running?).");
    sweepStale(options.staleAfterMs ?? 2 * 60 * 60_000);
    const total = options.totalTimeoutMs ?? 30 * 60_000;
    const body = (async () => {
      const started0 = run(
        [
          "run",
          "-d",
          "--rm",
          "--name",
          name,
          "--label",
          CONTAINER_LABEL,
          "-e",
          "POSTGRES_PASSWORD",
          "-p",
          "127.0.0.1::5432",
          image,
        ],
        { ...process.env, POSTGRES_PASSWORD: password },
      );
      if (started0.status !== 0)
        throw new Error(
          "Could not start PostgreSQL: " + started0.stderr.trim(),
        );
      started = true;
      const port = run(["port", name, "5432/tcp"])
        .stdout.trim()
        .split("\n")[0]
        ?.split(":")
        .pop();
      if (!port) throw new Error("Could not determine the container port.");
      const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
      const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
      let ready = false;
      while (!ready && Date.now() < deadline) {
        if (abort.signal.aborted) throw abort.signal.reason;
        const client = new Client({
          connectionString: url,
          connectionTimeoutMillis: 2000,
        });
        try {
          await client.connect();
          await client.query("select 1");
          ready = true;
        } catch {
          await sleep(500);
        } finally {
          await client.end().catch(() => {});
        }
      }
      if (!ready)
        throw new Error(
          `PostgreSQL did not become ready within ${Math.round((options.readyTimeoutMs ?? 60_000) / 1000)} seconds.`,
        );
      const version = run([
        "exec",
        name,
        "postgres",
        "--version",
      ]).stdout.trim();
      // The ceiling applies to the work itself; start-up has its own readiness timeout above.
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort(new Error("timed out"));
          reject(
            new Error(
              `Disposable PostgreSQL run timed out after ${Math.round(total / 1000)} s.`,
            ),
          );
        }, total);
        fn({ name, url, version }, abort.signal).then(resolve, reject);
      });
    })();
    return await body;
  } finally {
    if (timer) clearTimeout(timer);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    process.off("exit", cleanup);
    cleanup();
  }
}
