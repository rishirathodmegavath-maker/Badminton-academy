import { closeDatabase } from "../src/infrastructure/database/client";
import { processDispatchOnce } from "../src/modules/dispatch/application/worker";
import { channelStates, providersFromEnv } from "../src/modules/dispatch/providers/registry";
import { runReportScheduler } from "../src/modules/reports/application/policy";

/**
 * The background worker. It runs in its own process, independent of the browser and of the web server:
 *
 *   npm run dispatch:worker                 keep running: send queued messages and prepare scheduled report drafts
 *   npm run dispatch:worker -- --once       one pass of each, then exit (a cron job, a one-off, a test)
 *   npm run dispatch:worker -- --no-scheduler   deliver only; do not prepare scheduled drafts
 *
 * Needs the same environment as the application (DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL) and the delivery
 * provider variables (see src/modules/dispatch/providers/registry.ts). Several workers may run at once: items are claimed with
 * FOR UPDATE SKIP LOCKED and leased. A crash loses nothing: the queue is in the database and an unfinished item is picked up
 * again when its lease runs out. A channel with no configured provider is left alone: its items wait.
 *
 *   DISPATCH_WORKER_INTERVAL_MS     delivery pass interval, default 5000 (minimum 1000)
 *   DISPATCH_SCHEDULER_INTERVAL_MS  scheduled-draft pass interval, default 900000 = 15 minutes (minimum 60000)
 *   DISPATCH_LEASE_SECONDS          how long a worker may hold an item, default 120
 *
 * Output is one JSON line per event with COUNTS only. No address, name or message text is ever printed.
 */
const args = process.argv.slice(2);
const once = args.includes("--once");
const scheduler = !args.includes("--no-scheduler");
const num = (name: string, fallback: number, min: number) => Math.max(min, Number(process.env[name]) || fallback);
const interval = num("DISPATCH_WORKER_INTERVAL_MS", 5000, 1000);
const schedulerEvery = num("DISPATCH_SCHEDULER_INTERVAL_MS", 900_000, 60_000);
const lease = num("DISPATCH_LEASE_SECONDS", 120, 30);
let stopping = false;
let wake: (() => void) | null = null;
/** Ask the worker to finish what it is doing and exit: the pass in progress completes, nothing new is claimed. */
const requestStop = (why: string) => {
  if (!stopping) console.log(JSON.stringify({ ts: new Date().toISOString(), event: "dispatch.worker.stopping", why }));
  stopping = true;
  wake?.();
};
// SIGINT/SIGTERM from a supervisor; SIGBREAK is what Windows delivers for Ctrl+Break and service stops.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(signal, () => requestStop(signal));
// Windows cannot deliver SIGTERM to a child, so a parent that started this with an IPC channel (child_process.fork) can ask the
// same graceful stop with a message. This only ever LISTENS when a parent opened a channel; run normally it does nothing.
process.on("message", (m) => {
  if (m === "shutdown") requestStop("ipc");
});
/** Sleeps, but wakes at once when a stop is requested, so a shutdown does not wait for the interval. */
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
/** What may be printed about an error: its code or name, never a database message (those can quote a query and its parameters). */
const why = (error: unknown) => {
  const e = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : typeof e?.name === "string" ? e.name : "Error";
  const text = typeof e?.message === "string" && !/query|params|select |insert |update /i.test(e.message) ? e.message.slice(0, 120).replace(/\s+/g, " ") : "";
  return text ? `${code}: ${text}` : code;
};

try {
  const states = channelStates();
  const providers = providersFromEnv();
  log("dispatch.worker.started", {
    email: states.EMAIL.mode,
    whatsapp: states.WHATSAPP.mode,
    scheduler,
    problems: [...states.EMAIL.problems, ...states.WHATSAPP.problems],
  });
  if (!providers.EMAIL && !providers.WHATSAPP) log("dispatch.worker.no_channel", { note: "No delivery channel is configured: queued messages wait. Scheduled drafts still run." });
  let lastScheduler = 0;
  let everWorked = false;
  let failures = 0;
  const template = { name: process.env.WHATSAPP_META_TEMPLATE || "report_ready", language: process.env.WHATSAPP_META_LANGUAGE || "en" };
  do {
    try {
      const pass = await processDispatchOnce({ providers, leaseSeconds: lease, whatsappTemplate: template, workerId: `worker-${process.pid}` });
      if (pass.claimed || pass.reclaimed || once || failures) log("dispatch.pass", pass);
      if (scheduler && (once || Date.now() - lastScheduler >= schedulerEvery)) {
        lastScheduler = Date.now();
        const results = await runReportScheduler();
        if (results.length || once)
          log("dispatch.scheduler", {
            academies: results.length,
            created: results.reduce((n, r) => n + r.created, 0),
            skipped: results.reduce((n, r) => n + r.skipped, 0),
            notes: results.filter((r) => r.note).length,
          });
      }
      if (failures) log("dispatch.worker.recovered", { afterFailures: failures });
      everWorked = true;
      failures = 0;
    } catch (error) {
      // A database that goes away for a while (restart, failover, network) must not need a human: keep trying, slowly. A worker that
      // has never managed a single pass is misconfigured, so that one still exits with an error for the supervisor to report.
      if (once || !everWorked) throw error;
      failures++;
      log("dispatch.pass.failed", { consecutiveFailures: failures, reason: why(error) });
      // Held items keep their leases; they are picked up again after the database returns. Back off up to 60 s between tries.
      await sleep(Math.min(60_000, interval * 2 ** Math.min(failures, 6)));
      continue;
    }
    if (once || stopping) break;
    await sleep(interval);
  } while (!stopping);
  log("dispatch.worker.stopped");
} catch (error) {
  log("dispatch.worker.crashed", { reason: why(error) });
  process.exitCode = 1;
} finally {
  await closeDatabase();
  // A listener on an IPC channel keeps a process alive: let go of it so the worker can exit now that its work is finished.
  if (process.connected) process.disconnect();
}
