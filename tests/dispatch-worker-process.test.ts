import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { closeDatabase, database } from "../src/infrastructure/database/client";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";
import { REPO_ROOT } from "./helpers/paths";
import * as t from "../src/infrastructure/database/schema";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { processDispatchOnce } from "../src/modules/dispatch/application/worker";
import { TestEmailProvider } from "../src/modules/dispatch/providers/test-adapter";

process.env.BETTER_AUTH_SECRET = "isolated-worker-process-test-secret-1234567890123";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
/**
 * The delivery worker as a REAL operating-system process (`scripts/dispatch-worker.ts`), against PostgreSQL, with the safe test
 * adapter (nothing leaves the machine). Needs PostgreSQL: the embedded database allows one process at a time, so these are skipped
 * on it (`npm run test:pg`, or set TEST_POSTGRES_ADMIN_URL to a disposable local server).
 *
 * Checked: start and graceful stop, queue persistence while no worker runs, two workers at once (no item taken twice), a worker
 * killed in the middle of sending (the queue recovers; the single edge where a message is sent a second time is shown, not hidden),
 * retry exhaustion, a permanent failure and its suppression.
 */
const HAVE_POSTGRES = !!process.env.TEST_POSTGRES_ADMIN_URL;
const SKIP = HAVE_POSTGRES ? false : "needs PostgreSQL (TEST_POSTGRES_ADMIN_URL): the embedded database allows one process at a time";
let testDb: TestDatabase | undefined;
let outbox = "";
let dir = "";
const workers: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, check: () => Promise<T | false | null | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await check();
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(250);
  }
}

type Worker = { child: ChildProcess; lines: Record<string, unknown>[]; exited: Promise<number | null>; pid: number };
/** Starts the real worker script in its own process, with an IPC channel so it can be asked to stop gracefully on every platform. */
function startWorker(env: Record<string, string> = {}, args: string[] = ["--no-scheduler"]): Worker {
  const child = fork(join(REPO_ROOT, "scripts", "dispatch-worker.ts"), args, {
    cwd: REPO_ROOT,
    execArgv: ["--import", "tsx"],
    silent: true,
    env: {
      ...process.env,
      DISPATCH_EMAIL_PROVIDER: "test",
      DISPATCH_WHATSAPP_PROVIDER: "none",
      DISPATCH_TEST_OUTBOX_FILE: outbox,
      DISPATCH_WORKER_INTERVAL_MS: "1000",
      ...env,
    },
  });
  workers.push(child);
  const lines: Record<string, unknown>[] = [];
  let buffer = "";
  child.stdout!.on("data", (d: Buffer) => {
    buffer += d.toString();
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      try {
        lines.push(JSON.parse(line));
      } catch {
        /* not a log line */
      }
    }
  });
  child.stderr!.resume();
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, lines, exited, pid: child.pid! };
}
const started = (w: Worker) => until("worker started", async () => w.lines.some((l) => l.event === "dispatch.worker.started"), 90_000);
const stopGracefully = async (w: Worker) => {
  w.child.send("shutdown");
  return Promise.race([w.exited, sleep(20_000).then(() => "timeout" as const)]);
};
const sentLines = () =>
  existsSync(outbox) ? readFileSync(outbox, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to: string; idempotencyKey: string }) : [];

let batchId = "";
const PLAYER = "p1";
before(async () => {
  if (!HAVE_POSTGRES) return;
  dir = mkdtempSync(join(tmpdir(), "worker-proc-"));
  outbox = join(dir, "outbox.jsonl");
  testDb = await provisionTestDatabase("worker-proc");
  const db = database();
  await db.insert(t.academies).values({ id: "green", name: "Academy green", timezone: "Asia/Kolkata" });
  await db.insert(t.academySettings).values({ academyId: "green", data: defaultSettings });
  await db.insert(t.branches).values({ id: "green-branch", academyId: "green", name: "Test branch" });
  await db.insert(t.user).values({ id: "owner", name: "Owner", email: "owner@example.test" });
  await db.insert(t.user).values({ id: "coach", name: "Coach", email: "coach@example.test" });
  await db.insert(t.memberships).values({ academyId: "green", userId: "owner", role: "OWNER" });
  await db.insert(t.memberships).values({ academyId: "green", userId: "coach", role: "COACH" });
  await db.insert(t.batches).values({ id: "green-batch", academyId: "green", coachId: "coach", branchId: "green-branch", name: "Under 13" });
  await db.insert(t.players).values({ id: PLAYER, academyId: "green", batchId: "green-batch", name: "Aadi Sharma" });
  await db.insert(t.profiles).values({ academyId: "green", playerId: PLAYER, data: { ...defaultProfile, status: "ACTIVE" } });
  await db.insert(t.reports).values({
    id: "rep-1",
    academyId: "green",
    playerId: PLAYER,
    status: "PUBLISHED",
    version: 2,
    data: { playerId: PLAYER, periodStart: "2027-03-01", periodEnd: "2027-03-31", title: "March report", summary: "s", evidence: [], academyName: "Academy green", playerName: "Aadi Sharma", reviewer: null, approvedAt: null } as never,
  });
  const [b] = await db
    .insert(t.dispatchBatches)
    .values({ academyId: "green", title: "Process test", recipientMode: "PARENTS", channels: ["EMAIL"], reportIds: ["rep-1"], status: "APPROVED", createdBy: "owner", approvedBy: "owner", approvedAt: new Date() })
    .returning();
  batchId = b.id;
});
after(async () => {
  for (const w of workers) if (w.exitCode === null) w.kill("SIGKILL");
  await sleep(500);
  await testDb?.cleanup();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

let serial = 0;
/** Queues `n` approved e-mail messages (one per distinct address) that are due now, each with a live link to the one report. */
async function queue(n: number, address: (i: number) => string = (i) => `parent-${serial}-${i}@example.test`) {
  serial++;
  const db = database();
  const rows = Array.from({ length: n }, (_, i) => ({
    academyId: "green",
    batchId,
    channel: "EMAIL",
    address: address(i),
    addressHash: `hash-${serial}-${i}`,
    recipientNames: [`Parent ${i}`],
    subjectRefs: [],
    reportIds: ["rep-1"],
    status: "QUEUED",
    nextAttemptAt: new Date(Date.now() - 60_000),
  }));
  const made: { id: string }[] = [];
  for (let i = 0; i < rows.length; i += 50) made.push(...(await db.insert(t.dispatchItems).values(rows.slice(i, i + 50)).returning({ id: t.dispatchItems.id })));
  await db.insert(t.reportLinks).values(made.map((m) => ({ academyId: "green", itemId: m.id, reportId: "rep-1", expiresAt: new Date(Date.now() + 86_400_000) })));
  return made.map((m) => m.id);
}
const rowsOf = (ids: string[]) => database().select().from(t.dispatchItems).where(inArray(t.dispatchItems.id, ids));
const allIn = async (ids: string[], status: string) => (await rowsOf(ids)).every((r) => r.status === status);

test("start and graceful stop: the worker reports its configuration, then finishes and exits 0 when asked", { skip: SKIP, timeout: 120_000 }, async () => {
  const w = startWorker();
  await started(w);
  const hello = w.lines.find((l) => l.event === "dispatch.worker.started")!;
  assert.equal(hello.email, "TEST");
  assert.equal(hello.whatsapp, "NONE");
  assert.equal(await stopGracefully(w), 0, "a graceful stop exits with code 0");
  assert.ok(w.lines.some((l) => l.event === "dispatch.worker.stopping"));
  assert.ok(w.lines.some((l) => l.event === "dispatch.worker.stopped"));
  assert.ok(!w.lines.some((l) => l.event === "dispatch.worker.crashed"));
  const text = JSON.stringify(w.lines);
  assert.ok(!/@example\.test|Aadi|Parent \d/.test(text), "the log carries counts only: no address, name or text");
});

test("queue persistence: messages wait in the database while no worker runs, and a worker started later sends each exactly once", { skip: SKIP, timeout: 180_000 }, async () => {
  const ids = await queue(12);
  await sleep(2500);
  assert.ok(await allIn(ids, "QUEUED"), "with no worker, nothing moves and nothing is lost");
  assert.equal(sentLines().length, 0);
  const w = startWorker();
  await until("all sent", () => allIn(ids, "SENT"), 120_000);
  assert.equal(await stopGracefully(w), 0);
  const rows = await rowsOf(ids);
  assert.ok(rows.every((r) => r.attempts === 1 && r.sentAt && r.providerMessageId && !r.leasedBy && !r.leaseUntil));
  const sent = sentLines().filter((s) => ids.includes(s.idempotencyKey));
  assert.equal(sent.length, 12);
  assert.equal(new Set(sent.map((s) => s.idempotencyKey)).size, 12, "one message per item");
  const events = await database().select().from(t.dispatchEvents).where(inArray(t.dispatchEvents.itemId, ids));
  assert.equal(events.filter((e) => e.type === "SENT").length, 12, "one SENT event per item");
});

test("two workers at once: every item is taken by exactly one of them, and nothing is sent twice", { skip: SKIP, timeout: 240_000 }, async () => {
  const [a, b] = [startWorker(), startWorker()];
  await Promise.all([started(a), started(b)]);
  const already = sentLines().length;
  const ids = await queue(150);
  await until("all sent", () => allIn(ids, "SENT"), 180_000);
  assert.equal(await stopGracefully(a), 0);
  assert.equal(await stopGracefully(b), 0);
  const rows = await rowsOf(ids);
  assert.ok(rows.every((r) => r.attempts === 1), "no item was claimed twice");
  const sent = sentLines().slice(already).filter((s) => ids.includes(s.idempotencyKey));
  assert.equal(sent.length, 150, "exactly 150 messages for 150 items");
  assert.equal(new Set(sent.map((s) => s.idempotencyKey)).size, 150, "no item was sent twice");
  const claimed = (w: Worker) => w.lines.filter((l) => l.event === "dispatch.pass").reduce((n, l) => n + Number(l.claimed ?? 0), 0);
  assert.equal(claimed(a) + claimed(b), 150, "between them the two workers claimed each item once");
  assert.ok(claimed(a) > 0 && claimed(b) > 0, `both workers took part (${claimed(a)} and ${claimed(b)})`);
});

test("a worker killed in the middle of sending: nothing is lost, a later worker finishes the job, and the one duplicate edge is real and bounded", { skip: SKIP, timeout: 240_000 }, async () => {
  const ids = await queue(6);
  // Hold each send for 8 s AFTER the message was recorded, then kill the process without warning inside that window.
  const doomed = startWorker({ DISPATCH_TEST_SEND_DELAY_MS: "8000", DISPATCH_LEASE_SECONDS: "30" });
  await started(doomed);
  await until("messages recorded by the doomed worker", async () => sentLines().filter((s) => ids.includes(s.idempotencyKey)).length >= 4, 60_000);
  const inFlight = sentLines().filter((s) => ids.includes(s.idempotencyKey)).map((s) => s.idempotencyKey);
  doomed.child.kill("SIGKILL");
  await doomed.exited;
  const mid = await rowsOf(ids);
  assert.ok(mid.every((r) => r.status === "SENDING" && r.attempts === 1), "the killed worker left its claimed items leased, none lost and none marked sent");
  assert.ok(inFlight.length >= 4 && inFlight.length <= 6);
  // Before the lease runs out another worker must NOT take them (they may still be in a live worker's hands).
  const early = startWorker({ DISPATCH_LEASE_SECONDS: "30" });
  await started(early);
  await sleep(5000);
  assert.ok((await rowsOf(ids)).every((r) => r.status === "SENDING"), "an unexpired lease is respected");
  // After the lease runs out the items are reclaimed and sent.
  await until("all sent after the lease ran out", () => allIn(ids, "SENT"), 120_000);
  assert.equal(await stopGracefully(early), 0);
  const rows = await rowsOf(ids);
  assert.ok(rows.every((r) => r.attempts === 2), "each item was attempted twice: once by the worker that died, once by the one that recovered it");
  const all = sentLines().filter((s) => ids.includes(s.idempotencyKey));
  const perItem = new Map<string, number>();
  for (const s of all) perItem.set(s.idempotencyKey, (perItem.get(s.idempotencyKey) ?? 0) + 1);
  assert.deepEqual([...perItem.keys()].sort(), [...ids].sort(), "every item was sent at least once");
  assert.ok([...perItem.values()].every((n) => n === 1 || n === 2), "no item more than twice");
  const duplicated = [...perItem].filter(([, n]) => n === 2).map(([k]) => k);
  assert.deepEqual(duplicated.sort(), [...inFlight].sort(), "AT-LEAST-ONCE, stated plainly: exactly the messages the dead worker had already handed over were sent again, with the same idempotency key");
});

test("a LIVE worker whose send outlives its lease: another worker takes the item over, the late worker cannot overwrite the result, and the message is sent twice (why a lease must outlast the provider's timeout)", { skip: SKIP, timeout: 200_000 }, async () => {
  const [id] = await queue(1);
  // 45 s of "provider time" against a 30 s lease: the worker is alive and well, only slow.
  const slow = startWorker({ DISPATCH_TEST_SEND_DELAY_MS: "45000", DISPATCH_LEASE_SECONDS: "30" });
  await started(slow);
  await until("the slow worker has handed the message over", async () => sentLines().filter((s) => s.idempotencyKey === id).length >= 1, 60_000);
  await sleep(31_000); // its lease has now run out although it is still working
  const rescuer = startWorker({ DISPATCH_LEASE_SECONDS: "30" });
  await started(rescuer);
  await until("the second worker finished it", async () => (await rowsOf([id]))[0].status === "SENT", 90_000);
  const afterRescue = (await rowsOf([id]))[0];
  assert.equal(afterRescue.attempts, 2);
  await sleep(20_000); // the slow worker now returns from its provider call and tries to record its result
  const final = (await rowsOf([id]))[0];
  assert.deepEqual([final.status, final.attempts, final.providerMessageId], ["SENT", 2, afterRescue.providerMessageId], "the late worker's result did not overwrite the record");
  const copies = sentLines().filter((s) => s.idempotencyKey === id).length;
  assert.equal(copies, 2, "AT-LEAST-ONCE: handed to the provider twice (same idempotency key); keep the lease well above the provider's own timeout (the Meta adapter gives up after 15 s, the lease is 120 s)");
  assert.equal(await stopGracefully(rescuer), 0);
  assert.equal(await stopGracefully(slow), 0);
});

test("retry exhaustion and a permanent failure, as a real process: temporary failures are retried on the schedule then given up, a bounce fails at once and suppresses the address", { skip: SKIP, timeout: 240_000 }, async () => {
  const [flaky] = await queue(1, () => "always-retry@example.test");
  const [bounce] = await queue(1, () => "bounce-parent@example.test");
  const [fine] = await queue(1, () => "fine-parent@example.test");
  const w = startWorker();
  await started(w);
  const state = async (id: string) => (await rowsOf([id]))[0];
  // Each time the item waits for its next try, bring the clock forward by making it due (the real delays are 1 min, 5 min, 30 min, 2 h, 6 h).
  const seen: number[] = [];
  await until(
    "the always-failing item is given up",
    async () => {
      const r = await state(flaky);
      if (r.status === "FAILED_RETRYABLE" && !seen.includes(r.attempts)) {
        seen.push(r.attempts);
        assert.ok(r.nextAttemptAt.getTime() > Date.now() + 30_000, "the next try is scheduled in the future (at least a minute), not immediate");
        await database().update(t.dispatchItems).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(t.dispatchItems.id, flaky));
      }
      return r.status === "FAILED";
    },
    150_000,
  );
  const gone = await state(flaky);
  assert.equal(gone.attempts, 6, "six attempts in all (the first try and five retries)");
  assert.deepEqual(seen, [1, 2, 3, 4, 5], "it waited for a retry after each of the first five attempts");
  assert.equal(gone.lastErrorCode, "TEST_TEMPORARY");
  const permanent = await state(bounce);
  assert.deepEqual([permanent.status, permanent.attempts, permanent.lastErrorCode], ["FAILED", 1, "TEST_BOUNCED"]);
  assert.equal((await state(fine)).status, "SENT");
  assert.ok(!sentLines().some((s) => s.idempotencyKey === flaky || s.idempotencyKey === bounce), "nothing was sent for the two that failed");
  await sleep(3500);
  assert.equal((await state(flaky)).attempts, 6, "once given up it is never claimed again");
  assert.equal(await stopGracefully(w), 0);
});

/**
 * The database goes away while a worker is running, mid-send, and comes back. Needs a server this test may stop and start, so it runs
 * only when TEST_POSTGRES_STOP_CMD and TEST_POSTGRES_START_CMD name commands that do exactly that for the SAME disposable server
 * TEST_POSTGRES_ADMIN_URL points at (never share that server with another run).
 */
const OUTAGE_SKIP = !HAVE_POSTGRES
  ? SKIP
  : process.env.TEST_POSTGRES_STOP_CMD && process.env.TEST_POSTGRES_START_CMD
    ? false
    : "needs TEST_POSTGRES_STOP_CMD and TEST_POSTGRES_START_CMD for a disposable server this test may stop";
const runCommand = (cmd: string, wait: boolean) =>
  new Promise<void>((resolve) => {
    const p = spawn(cmd, { shell: true, detached: !wait, stdio: "ignore", windowsHide: true });
    if (!wait) {
      p.unref();
      resolve();
    } else p.once("exit", () => resolve());
  });
async function serverAnswers() {
  const c = new PgClient({ connectionString: process.env.TEST_POSTGRES_ADMIN_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}

test("the database stops while a worker is sending and comes back: the worker stays up, recovers on its own, loses nothing, and the duplicate edge is bounded", { skip: OUTAGE_SKIP, timeout: 300_000 }, async () => {
  const w = startWorker({ DISPATCH_TEST_SEND_DELAY_MS: "4000", DISPATCH_LEASE_SECONDS: "30" });
  await started(w);
  const ids = await queue(4);
  await until("the messages were handed to the (test) provider", async () => sentLines().filter((s) => ids.includes(s.idempotencyKey)).length >= 4, 60_000);
  // The provider has accepted all four; the worker has not yet written that down. Take the database away right now.
  await closeDatabase();
  await runCommand(process.env.TEST_POSTGRES_STOP_CMD!, true);
  assert.equal(await serverAnswers(), false, "the server is really down");
  await until("the worker notices and keeps trying", async () => w.lines.filter((l) => l.event === "dispatch.pass.failed").length >= 2, 60_000);
  assert.equal(w.child.exitCode, null, "the worker did not exit");
  assert.ok(!w.lines.some((l) => l.event === "dispatch.worker.crashed"));
  assert.ok(!/@example\.test|params:|insert into|select /i.test(JSON.stringify(w.lines)), "outage logging carries no address, query or parameter");
  await runCommand(process.env.TEST_POSTGRES_START_CMD!, false);
  await until("the server answers again", serverAnswers, 90_000);
  database(); // a fresh connection pool for this process
  // The four were in flight: the worker could not record them. After the lease runs out they are sent again (at least once), never lost.
  await until("all four are recorded as sent", () => allIn(ids, "SENT"), 150_000);
  assert.ok(w.lines.some((l) => l.event === "dispatch.worker.recovered"), "the worker says it recovered");
  assert.equal(w.child.exitCode, null, "the same process carried on: no restart was needed");
  const rows = await rowsOf(ids);
  assert.ok(rows.every((r) => r.attempts === 2), "each was attempted twice: before the outage and after");
  const per = new Map<string, number>();
  for (const s of sentLines().filter((x) => ids.includes(x.idempotencyKey))) per.set(s.idempotencyKey, (per.get(s.idempotencyKey) ?? 0) + 1);
  assert.deepEqual([...per.keys()].sort(), [...ids].sort(), "none lost");
  assert.ok([...per.values()].every((n) => n === 2), "AT-LEAST-ONCE: each was handed to the provider twice (same idempotency key), because the first hand-over could not be written down");
  // New work after the outage is sent once each.
  const later = await queue(3);
  await until("later work is sent", () => allIn(later, "SENT"), 90_000);
  assert.ok((await rowsOf(later)).every((r) => r.attempts === 1));
  assert.equal(sentLines().filter((s) => later.includes(s.idempotencyKey)).length, 3);
  assert.equal(await stopGracefully(w), 0);
});

test("claims under real PostgreSQL concurrency: ten simultaneous passes with separate connections claim disjoint items (FOR UPDATE SKIP LOCKED), each item once", { skip: SKIP, timeout: 240_000 }, async () => {
  const ids = await queue(300);
  const providers = Array.from({ length: 10 }, () => ({ EMAIL: new TestEmailProvider() }));
  const passes = await Promise.all(providers.map((p, i) => processDispatchOnce({ providers: p, workerId: `inproc-${i}`, batchSize: 40, concurrency: 4, leaseSeconds: 120 })));
  // Keep passing until the queue is drained (each pass takes at most 40).
  for (let round = 0; round < 10 && !(await allIn(ids, "SENT")); round++) passes.push(...(await Promise.all(providers.map((p, i) => processDispatchOnce({ providers: p, workerId: `inproc-${i}`, batchSize: 40, concurrency: 4, leaseSeconds: 120 })))));
  assert.ok(await allIn(ids, "SENT"));
  const rows = await rowsOf(ids);
  assert.ok(rows.every((r) => r.attempts === 1), "no item was claimed twice");
  const keys = providers.flatMap((p) => p.EMAIL.sent.map((s) => s.idempotencyKey)).filter((k) => ids.includes(k));
  assert.equal(keys.length, 300);
  assert.equal(new Set(keys).size, 300, "no item was handed to a provider twice");
  assert.ok(providers.filter((p) => p.EMAIL.sent.length > 0).length >= 2, "more than one pass did real work, so the claims really were concurrent");
  assert.equal(passes.reduce((n, p) => n + p.claimed, 0), 300);
});

test("lease recovery with an injected clock under PostgreSQL: an expired SENDING item is reclaimed once, an unexpired one is left alone", { skip: SKIP, timeout: 120_000 }, async () => {
  const [stuck, live] = await queue(2);
  const now = new Date();
  await database().update(t.dispatchItems).set({ status: "SENDING", leasedBy: "dead", leaseUntil: new Date(now.getTime() - 1000), attempts: 1 }).where(eq(t.dispatchItems.id, stuck));
  await database().update(t.dispatchItems).set({ status: "SENDING", leasedBy: "alive", leaseUntil: new Date(now.getTime() + 600_000), attempts: 1 }).where(eq(t.dispatchItems.id, live));
  const p = { EMAIL: new TestEmailProvider() };
  const [a, b] = await Promise.all([processDispatchOnce({ providers: p, workerId: "r1", now }), processDispatchOnce({ providers: p, workerId: "r2", now })]);
  assert.equal(a.reclaimed + b.reclaimed, 1, "exactly one of two simultaneous passes reclaimed it");
  const [s, l] = [(await rowsOf([stuck]))[0], (await rowsOf([live]))[0]];
  assert.deepEqual([s.status, s.attempts], ["SENT", 2]);
  assert.deepEqual([l.status, l.leasedBy], ["SENDING", "alive"], "a lease still running is respected");
  assert.equal(p.EMAIL.sent.filter((x) => x.idempotencyKey === stuck).length, 1);
});
