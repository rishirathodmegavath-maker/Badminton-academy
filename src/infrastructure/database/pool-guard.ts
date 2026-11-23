import type { Pool } from "pg";

/**
 * node-postgres emits "error" on the pool when an IDLE connection fails (the database restarted, a failover, a network
 * reset, an idle-connection reaper). An EventEmitter with no "error" listener turns that into an uncaught exception that
 * stops the whole server, so one database restart would take the application down with it. The failed connection is
 * already discarded by the pool and the next query opens a new one; all that is needed is to say so and carry on.
 * Only the error's name and code are logged: a message can carry a connection string.
 */
export function guardPool<P extends Pick<Pool, "on">>(pool: P, log: Pick<Console, "error"> = console): P {
  pool.on("error", (error: Error & { code?: string }) => {
    log.error("[database] an idle connection failed and was discarded", error.name, error.code ?? "");
  });
  return pool;
}
