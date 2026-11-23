import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { database } from "../../src/infrastructure/database/client";
import * as t from "../../src/infrastructure/database/schema";
import type { Actor } from "../../src/modules/identity/access";
import { bootstrapAcademy } from "../../src/modules/academy/application/bootstrap";
import { unit } from "../../src/modules/academy/application/access";
import { invoiceAccess, ledger } from "../../src/modules/fees/application/service";
import { defaultSettings } from "../../src/modules/academy/domain/types";
import { legacyBootstrapAcademy, legacyInvoiceAccess, legacyLedger } from "../helpers/family-oracle";
import { captureStatements, type Statement } from "../helpers/statement-log";
import { provisionTestDatabase, type TestDatabase } from "../helpers/test-database";
/**
 * STAGE 5F BENCHMARK (test tooling only; never part of `npm test`).
 *
 * Builds a deterministic academy in a DISPOSABLE database (the test helper refuses anything else), then measures the
 * pre-5F loader (tests/helpers/family-oracle.ts) and the Stage 5F loader on the same data, in the same process,
 * alternating runs. The probe family is identical at every scale; only the rest of the academy grows.
 *
 *   BENCH_SCALE   S | M | L            (players per academy: 60 / 600 / 2400; two academies)
 *   BENCH_OUT     directory for the JSON result (default .data/bench-results)
 *   BENCH_RUNS    timed runs per variant (default 30, after 5 warm-up runs)
 *
 * Volumes are a test grid, not a forecast.
 */
process.env.BETTER_AUTH_SECRET = "family-benchmark-secret-0123456789abcdef";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3999";
const SCALES = { S: 60, M: 600, L: 2400 } as const;
const scale = (process.env.BENCH_SCALE ?? "S") as keyof typeof SCALES;
const PLAYERS = SCALES[scale];
if (!PLAYERS) throw new Error(`BENCH_SCALE must be S, M or L`);
const RUNS = Number(process.env.BENCH_RUNS ?? 30);
const WARMUP = 5;
const OUT = resolve(process.env.BENCH_OUT ?? ".data/bench-results");
const BATCH_SIZE = 15;
// The staff (OWNER) control runs unchanged code whose own JavaScript work grows faster than linearly with the
// academy (about 11 s per load at M on PGlite). It is timed fully at S, briefly at M, and skipped at L; staff
// equality is proven by T-RB1 and by the S/M runs.
const OWNER_RUNS = { S: RUNS, M: 5, L: 0 }[scale];
const SESSIONS_PER_BATCH = 12;
const EVENTS_PER_BATCH = 3;
const MESSAGES_PER_BATCH = 2;
const INVOICES_PER_PLAYER = 3;
const STAMP = "2027-01-02T10:00:00.000Z";
let db: TestDatabase;
const pad = (n: number) => String(n).padStart(6, "0");
const uuid = (academy: number, kind: number, n: number) =>
  `0000${academy}${kind}00-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function insertAll<T>(table: Parameters<ReturnType<typeof database>["insert"]>[0], rows: T[]) {
  for (let i = 0; i < rows.length; i += 400)
    await database().insert(table).values(rows.slice(i, i + 400) as never);
}
/** One academy: players in batches of 15, one guardian each, every tenth child shared with a second guardian. */
async function seedAcademy(index: number) {
  const academyId = `bench-${index}`;
  const p = (n: number) => `${academyId}-player-${pad(n)}`;
  const g = (n: number) => `${academyId}-guardian-${pad(n)}`;
  const batches = Math.ceil(PLAYERS / BATCH_SIZE);
  const coach = (b: number) => `${academyId}-coach-${pad(Math.floor(b / 4))}`;
  const coaches = Math.ceil(batches / 4);
  await database().insert(t.academies).values({ id: academyId, name: `Bench ${index}`, timezone: "Asia/Kolkata" });
  await database().insert(t.academySettings).values({ academyId, data: defaultSettings });
  await database().insert(t.entitlements).values({
    academyId,
    data: { reports: true, nutrition: true, communications: true, manualVideo: true },
  });
  await database().insert(t.branches).values({ id: `${academyId}-branch`, academyId, name: "Branch" });
  const users = [
    { id: `${academyId}-owner`, role: "OWNER" },
    ...Array.from({ length: coaches }, (_, c) => ({ id: `${academyId}-coach-${pad(c)}`, role: "COACH" })),
    // Guardians: one per child, plus a second guardian for every tenth child.
    ...Array.from({ length: PLAYERS + Math.ceil(PLAYERS / 10) }, (_, n) => ({ id: g(n), role: "GUARDIAN" })),
  ];
  await insertAll(t.user, users.map((u) => ({ id: u.id, name: `Bench ${u.id}`, email: `${u.id}@bench.test`, emailVerified: true })));
  await insertAll(t.memberships, users.map((u) => ({ academyId, userId: u.id, role: u.role })));
  await insertAll(
    t.batches,
    Array.from({ length: batches }, (_, b) => ({
      id: `${academyId}-batch-${pad(b)}`,
      academyId,
      name: `Batch ${b}`,
      branchId: `${academyId}-branch`,
      coachId: coach(b),
    })),
  );
  const batchOf = (n: number) => `${academyId}-batch-${pad(Math.floor(n / BATCH_SIZE))}`;
  const players = Array.from({ length: PLAYERS }, (_, n) => n);
  await insertAll(t.players, players.map((n) => ({ id: p(n), academyId, batchId: batchOf(n), name: `Bench child ${n}` })));
  await insertAll(
    t.profiles,
    players.map((n) => ({
      academyId,
      playerId: p(n),
      data: { adult: false, birthDate: "2014-01-01", email: `child${n}@bench.test`, phone: "+91-0", notes: `PRIVATE-NOTES-${n}`, status: "ACTIVE", selfUserId: null, preferences: "" },
    })),
  );
  // Probe family (same at every scale): guardian 0 has children 0 and 1 (child 1 is also another family's child).
  const links: { academyId: string; playerId: string; userId: string; relationship: string; consent: unknown }[] = [];
  const consent = { portal: true, email: true, whatsapp: false };
  for (const n of players) links.push({ academyId, playerId: p(n), userId: g(n === 1 ? 0 : n), relationship: "Parent", consent });
  for (const n of players.filter((n) => n % 10 === 1)) links.push({ academyId, playerId: p(n), userId: g(PLAYERS + Math.floor(n / 10)), relationship: "Parent", consent });
  await insertAll(t.guardianLinks, links);
  const guardiansOf = (n: number) => links.filter((l) => l.playerId === p(n)).map((l) => l.userId);
  await insertAll(t.restrictedNutrition, players.map((n) => ({ academyId, playerId: p(n), allergies: `ALLERGY-${n}`, restrictions: "" })));
  await insertAll(t.nutritionQuestions, players.map((n) => ({ id: `${academyId}-q-${pad(n)}`, academyId, playerId: p(n), authorId: guardiansOf(n)[0], question: `QUESTION-${n}` })));
  const plan = (n: number, title: string) => ({ playerId: p(n), title, guidance: title, professional: "Pro", reviewNote: "ok", approvedAt: STAMP });
  await insertAll(t.nutritionPlans, players.map((n) => ({ id: `${academyId}-plan-${pad(n)}`, academyId, playerId: p(n), status: n % 2 ? "SHARED" : "DRAFT", data: plan(n, `PLAN-${n}`) })));
  const report = (n: number, summary: string) => ({
    playerId: p(n), periodStart: "2027-01-01", periodEnd: "2027-01-31", title: "Report", summary, evidence: [],
    academyName: academyId, playerName: `Bench child ${n}`, reviewer: "Coach", approvedAt: null,
  });
  await insertAll(t.reports, players.map((n) => ({ id: `${academyId}-report-${pad(n)}`, academyId, playerId: p(n), version: 3, status: n % 2 ? "PUBLISHED" : "DRAFT", data: report(n, `REPORT-${n}`) })));
  const revisions: unknown[] = [];
  for (const n of players) {
    for (const [version, status] of [[1, "DRAFT"], [2, "PUBLISHED"], [3, n % 2 ? "PUBLISHED" : "DRAFT"]] as const)
      revisions.push({ id: `${academyId}-rev-report-${pad(n)}-${version}`, academyId, entityId: `${academyId}-report-${pad(n)}`, kind: "report", version, data: { status, data: report(n, `REPORT-${n}-v${version}`), reason: "" } });
    revisions.push({ id: `${academyId}-rev-plan-${pad(n)}`, academyId, entityId: `${academyId}-plan-${pad(n)}`, kind: "nutrition-plan", version: 1, data: { status: n % 2 ? "SHARED" : "DRAFT", data: plan(n, `PLAN-${n}`) } });
    revisions.push({ id: `${academyId}-rev-profile-${pad(n)}`, academyId, entityId: p(n), kind: "player-profile", version: 1, data: { name: `Bench child ${n}` } });
  }
  const invoices: unknown[] = [];
  const payments: unknown[] = [];
  const refunds: unknown[] = [];
  for (const n of players)
    for (let k = 0; k < INVOICES_PER_PLAYER; k++) {
      const id = `${academyId}-inv-${pad(n)}-${k}`;
      invoices.push({ id, academyId, data: { number: `INV-${n}-${k}`, playerIds: [p(n)], familyUserId: k === 2 ? guardiansOf(n)[0] : null, planId: null, description: `INVOICE-${n}-${k}`, currency: "INR", subtotal: 1000, discount: 0, total: 1000, dueDate: "2027-02-01", issuedAt: STAMP, voidReason: "" } });
      revisions.push({ id: `${academyId}-rev-${id}`, academyId, entityId: id, kind: "invoice", version: 1, data: { number: `INV-${n}-${k}` } });
      const pay = `${academyId}-pay-${pad(n)}-${k}`;
      payments.push({ id: pay, academyId, invoiceId: id, status: "VERIFIED", idempotencyKey: `idem-${pay}`, reference: `REF-${index}-${n}-${k}`, data: { invoiceId: id, amount: 500, currency: "INR", reference: `REF-${index}-${n}-${k}`, method: "UPI", submittedBy: guardiansOf(n)[0], verifiedBy: `${academyId}-owner`, reason: "", receiptNumber: `RCT-${n}-${k}` } });
      if (k === 0) refunds.push({ id: `${academyId}-refund-${pad(n)}`, academyId, paymentId: pay, amount: 100, reason: `REFUND-${n}`, idempotencyKey: `idem-refund-${academyId}-${n}` });
    }
  await insertAll(t.invoices, invoices);
  await insertAll(t.payments, payments);
  await insertAll(t.refunds, refunds);
  await insertAll(t.recordRevisions, revisions);
  await insertAll(t.lessonCredits, players.map((n) => ({ id: `${academyId}-credit-${pad(n)}`, academyId, playerId: p(n), units: 1, reason: `CREDIT-${n}`, idempotencyKey: `idem-credit-${academyId}-${n}` })));
  await insertAll(t.conversations, players.map((n) => ({ id: `${academyId}-conv-${pad(n)}`, academyId, playerId: p(n), guardianId: guardiansOf(n)[0], subject: "Question", entries: [{ id: `e-${n}`, authorId: guardiansOf(n)[0], name: "Guardian", text: `CONVERSATION-${n}`, at: STAMP }] })));
  await insertAll(t.mediaAssets, players.map((n) => ({ id: uuid(index, 1, n), academyId, playerId: p(n), ownerId: coach(Math.floor(n / BATCH_SIZE)), name: `clip-${n}.png`, mime: "image/png", size: 72, storageKey: `bench/${n}`, status: n % 3 ? "SHARED" : "PRIVATE", expiresAt: new Date("2099-01-01T00:00:00.000Z") })));
  const sessions: unknown[] = [];
  const events: unknown[] = [];
  const messages: unknown[] = [];
  const deliveries: unknown[] = [];
  const audits: unknown[] = [];
  for (let b = 0; b < batches; b++) {
    const members = players.filter((n) => Math.floor(n / BATCH_SIZE) === b);
    const batchId = `${academyId}-batch-${pad(b)}`;
    for (let s = 0; s < SESSIONS_PER_BATCH; s++)
      sessions.push({
        id: `${academyId}-session-${pad(b)}-${s}`, academyId, coachId: coach(b), batchId, status: s === 0 ? "DRAFT" : "PUBLISHED",
        data: {
          title: `Session ${s}`, batchId, branchId: `${academyId}-branch`, coachId: coach(b), localDate: `2027-04-${String(1 + s).padStart(2, "0")}`, localTime: "17:00",
          startsAt: "2027-04-01T11:30:00.000Z", timezone: "Asia/Kolkata", duration: 60, objective: `OBJECTIVE-${b}-${s}`,
          activities: [{ id: `act-${s}`, drillId: null, drillVersion: null, title: "Footwork", minutes: 20, cues: "", snapshot: null }],
          roster: members.map((n) => ({ id: p(n), name: `Bench child ${n}` })),
          attendance: Object.fromEntries(members.map((n) => [p(n), "PRESENT"])),
          observations: members.map((n) => ({ id: `obs-${b}-${s}-${n}`, playerId: p(n), activityId: null, text: `PRIVATE-OBSERVATION-${n}`, author: "Coach", at: STAMP, visibility: "PRIVATE_DRAFT" })),
          adjustments: [], progress: { index: 0, elapsed: 0, runningSince: null }, actuals: {}, recap: `RECAP-${b}-${s}`,
        },
      });
    for (let e = 0; e < EVENTS_PER_BATCH; e++)
      events.push({
        id: `${academyId}-event-${pad(b)}-${e}`, academyId, kind: "EVENT",
        data: { title: `Event ${e}`, localDate: "2027-03-01", localTime: "10:00", duration: 60, startsAt: "2027-03-01T04:30:00.000Z", endsAt: "2027-03-01T05:30:00.000Z", timezone: "Asia/Kolkata", branchId: `${academyId}-branch`, coachId: coach(b), batchId, playerIds: members.map(p), enquiryId: null, seriesId: null },
      });
    for (let m = 0; m < MESSAGES_PER_BATCH; m++) {
      const id = `${academyId}-message-${pad(b)}-${m}`;
      const recipients = members.flatMap((n) => guardiansOf(n).map((u) => ({ userId: u, name: `Bench ${u}`, email: `${u}@bench.test`, playerIds: [p(n)], channels: ["PORTAL"] })));
      messages.push({ id, authorId: coach(b), academyId, status: "SENT", data: { subject: `Message ${m}`, body: "Batch news", playerIds: members.map(p), batchIds: [batchId], allBatches: false, channels: ["PORTAL"], recipients, scheduledAt: null, approvedBy: coach(b), approvalHash: "h", templateId: null } });
      for (const r of recipients)
        deliveries.push({ id: `${id}-${r.userId}`, academyId, messageId: id, userId: r.userId, channel: "PORTAL", status: "AVAILABLE_IN_PORTAL", detail: "ok" });
      audits.push({ id: `${id}-audit`, academyId, actorId: coach(b), entityId: id, action: "message-send", version: 1, detail: {} });
    }
  }
  // Deliveries are unique per (message, user, channel); a shared child's second guardian appears once per message.
  const seen = new Set<string>();
  const uniqueDeliveries = (deliveries as { id: string }[]).filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  await insertAll(t.trainingSessions, sessions);
  await insertAll(t.calendarEvents, events);
  await insertAll(t.messages, messages);
  await insertAll(t.deliveries, uniqueDeliveries);
  await insertAll(t.audit, audits);
  return {
    probe: { id: g(0), name: "Probe guardian", academyId, role: "GUARDIAN", timezone: "Asia/Kolkata", academyName: `Bench ${index}` } as Actor,
    single: { id: g(2), name: "Single-child guardian", academyId, role: "GUARDIAN", timezone: "Asia/Kolkata", academyName: `Bench ${index}` } as Actor,
    owner: { id: `${academyId}-owner`, name: "Owner", academyId, role: "OWNER", timezone: "Asia/Kolkata", academyName: `Bench ${index}` } as Actor,
    probeInvoice: `${academyId}-inv-${pad(0)}-0`,
  };
}
const reads = (log: Statement[]) => log.filter((s) => /^\s*select/i.test(s.sql));
const sum = (log: Statement[], f: (s: Statement) => number) => log.reduce((n, s) => n + f(s), 0);
const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]));
  return v;
}
async function explain(statements: Statement[]) {
  const client = (database() as unknown as { $client: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const plans = [];
  for (const s of reads(statements)) {
    const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${s.sql}`, s.params);
    const raw = result.rows[0]["QUERY PLAN"];
    const plan = (typeof raw === "string" ? JSON.parse(raw) : raw) as { Plan: Record<string, unknown>; "Execution Time": number }[];
    const nodes: string[] = [];
    const walk = (n: Record<string, unknown>) => {
      nodes.push(`${n["Node Type"]}${n["Relation Name"] ? ` on ${n["Relation Name"]}` : ""}${n["Index Name"] ? ` using ${n["Index Name"]}` : ""} (rows ${n["Actual Rows"]}${n["Rows Removed by Filter"] ? `, removed by filter ${n["Rows Removed by Filter"]}` : ""})`);
      for (const c of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c);
    };
    walk(plan[0].Plan);
    plans.push({ tables: s.tables, sql: s.sql.slice(0, 160), executionMs: plan[0]["Execution Time"], nodes });
  }
  return plans;
}
type Variant = "before" | "after";
async function measure(name: string, run: Record<Variant, () => Promise<unknown>>, runs = RUNS, warmup = WARMUP) {
  const shape: Record<string, unknown> = {};
  for (const v of ["before", "after"] as Variant[]) {
    const { value, log } = await captureStatements(run[v]);
    shape[v] = {
      statements: log.length,
      reads: reads(log).length,
      rowsRead: sum(reads(log), (s) => s.rows),
      dbBytes: sum(reads(log), (s) => s.bytes),
      payloadBytes: JSON.stringify(value).length,
      log,
    };
  }
  const times: Record<Variant, number[]> = { before: [], after: [] };
  for (let i = 0; i < warmup; i++) {
    await run.before();
    await run.after();
  }
  for (let i = 0; i < runs; i++)
    for (const v of (i % 2 ? ["after", "before"] : ["before", "after"]) as Variant[]) {
      const start = performance.now();
      await run[v]();
      times[v].push(performance.now() - start);
    }
  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return { p50: +pct(s, 0.5).toFixed(2), p95: +pct(s, 0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) };
  };
  return { name, runs, ...shape, time: runs ? { before: stats(times.before), after: stats(times.after) } : null } as Record<string, any>;
}
const results: Record<string, unknown> = {};
let seeded = false;
before(async () => {
  db = await provisionTestDatabase(`bench-${scale.toLowerCase()}`);
}, { timeout: 3_600_000 });
after(async () => {
  await db.cleanup();
}, { timeout: 600_000 });
test(`family benchmark, scale ${scale}`, { skip: process.env.BENCH_MAIN === "0", timeout: 3_600_000 }, async () => {
  const seedStart = performance.now();
  const green = await seedAcademy(1);
  await seedAcademy(2);
  seeded = true;
  const seedMs = performance.now() - seedStart;
  // Like-for-like: both loaders return the same payload for the probe family on this data.
  assert.deepEqual(canon(JSON.parse(JSON.stringify(await bootstrapAcademy(green.probe)))), canon(JSON.parse(JSON.stringify(await legacyBootstrapAcademy(green.probe)))));
  assert.deepEqual(canon(JSON.parse(JSON.stringify(await bootstrapAcademy(green.single)))), canon(JSON.parse(JSON.stringify(await legacyBootstrapAcademy(green.single)))));
  if (OWNER_RUNS) assert.equal(JSON.stringify(await bootstrapAcademy(green.owner)), JSON.stringify(await legacyBootstrapAcademy(green.owner)));
  const probe = await measure("GUARDIAN, 2 children (one shared)", {
    before: () => legacyBootstrapAcademy(green.probe),
    after: () => bootstrapAcademy(green.probe),
  });
  const single = await measure("GUARDIAN, 1 child", {
    before: () => legacyBootstrapAcademy(green.single),
    after: () => bootstrapAcademy(green.single),
  });
  const owner = OWNER_RUNS
    ? await measure("OWNER (staff path, unchanged)", {
        before: () => legacyBootstrapAcademy(green.owner),
        after: () => bootstrapAcademy(green.owner),
      }, OWNER_RUNS, 1)
    : null;
  const receipt = await measure("invoiceAccess + ledger (receipt path)", {
    before: () => unit(green.probe, async (tx) => { const i = await legacyInvoiceAccess(green.probe, green.probeInvoice, tx); return legacyLedger(tx, i.academyId, i.id); }),
    after: () => unit(green.probe, async (tx) => { const i = await invoiceAccess(green.probe, green.probeInvoice, tx); return ledger(tx, i.academyId, i.id); }),
  });
  const plans = { before: await explain(probe.before.log), after: await explain(probe.after.log) };
  const strip = (m: Record<string, any>) => {
    const out = { ...m };
    for (const v of ["before", "after"]) {
      const { log, ...rest } = out[v];
      out[v] = { ...rest, statementTables: log.map((s: Statement) => `${s.tables.join("+")}: ${s.rows} rows`) };
    }
    return out;
  };
  Object.assign(results, {
    scale,
    engine: db.mode,
    playersPerAcademy: PLAYERS,
    academies: 2,
    runs: RUNS,
    warmup: WARMUP,
    seedMs: Math.round(seedMs),
    node: process.version,
    ownerRuns: OWNER_RUNS,
    measurements: [probe, single, owner, receipt].filter((m) => m).map((m) => strip(m!)),
    plans,
  });
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${process.env.BENCH_LABEL ?? db.mode}-${scale}.json`);
  writeFileSync(file, JSON.stringify(results, null, 1));
  console.log(`BENCH RESULT ${file}`);
  for (const m of [probe, single, owner, receipt].filter((x): x is Record<string, any> => !!x))
    console.log(
      `${m.name}: statements ${m.before.statements}->${m.after.statements}, rows ${m.before.rowsRead}->${m.after.rowsRead}, dbBytes ${m.before.dbBytes}->${m.after.dbBytes}, payload ${m.before.payloadBytes}->${m.after.payloadBytes}, p50 ${m.time?.before.p50}->${m.time?.after.p50} ms, p95 ${m.time?.before.p95}->${m.time?.after.p95} ms`,
    );
});
/**
 * Optional (BENCH_PREDICATES=1): the two JSON predicates of the first Stage 5F version (array expansion) against the
 * final ones (JSON containment), on the same seeded data, alternating, by EXPLAIN ANALYZE execution time. Run after
 * the main test, on the same database. Both versions must select the same rows.
 */
test("predicate comparison: array expansion (first version) vs containment (final)", { skip: process.env.BENCH_PREDICATES !== "1", timeout: 3_600_000 }, async () => {
  if (!seeded) {
    await seedAcademy(1);
    await seedAcademy(2);
    seeded = true;
  }
  const client = (database() as unknown as { $client: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  const academy = "bench-1";
  const kids = ["bench-1-player-000000", "bench-1-player-000001"];
  const queries = {
    rosterExpansion: [`select count(*)::int n from training_session where academy_id = $1 and status not in ('DRAFT','CANCELLED') and case when jsonb_typeof(data -> 'roster') = 'array' then exists (select 1 from jsonb_array_elements(data -> 'roster') as r(entry) where r.entry ->> 'id' = any($2::text[])) else false end`, [academy, kids]],
    rosterContainment: [`select count(*)::int n from training_session where academy_id = $1 and status not in ('DRAFT','CANCELLED') and case when jsonb_typeof(data -> 'roster') = 'array' then (data -> 'roster') @> any($2::jsonb[]) else false end`, [academy, kids.map((id) => JSON.stringify([{ id }]))]],
    invoiceExpansion: [`select count(*)::int n from invoice where academy_id = $1 and case when jsonb_typeof(data -> 'playerIds') = 'array' then jsonb_array_length(data -> 'playerIds') > 0 and not exists (select 1 from jsonb_array_elements_text(data -> 'playerIds') as x(id) where x.id is null or not (x.id = any($2::text[]))) else false end`, [academy, kids]],
    invoiceContainment: [`select count(*)::int n from invoice where academy_id = $1 and case when jsonb_typeof(data -> 'playerIds') = 'array' then jsonb_array_length(data -> 'playerIds') > 0 and (data -> 'playerIds') <@ $2::jsonb else false end`, [academy, JSON.stringify(kids)]],
  } as const;
  const count = async (k: keyof typeof queries) => (await client.query(queries[k][0], [...queries[k][1]])).rows[0].n;
  assert.equal(await count("rosterContainment"), await count("rosterExpansion"), "same sessions");
  assert.equal(await count("invoiceContainment"), await count("invoiceExpansion"), "same invoices");
  const exec = async (k: keyof typeof queries) => {
    const r = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${queries[k][0]}`, [...queries[k][1]]);
    const raw = r.rows[0]["QUERY PLAN"];
    return (typeof raw === "string" ? JSON.parse(raw) : raw)[0]["Execution Time"] as number;
  };
  const times: Record<string, number[]> = {};
  for (let i = 0; i < 25; i++)
    for (const k of (i % 2 ? Object.keys(queries).reverse() : Object.keys(queries)) as (keyof typeof queries)[]) {
      const ms = await exec(k);
      if (i >= 4) (times[k] ??= []).push(ms);
    }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const out = {
    scale, engine: db.mode, runs: 21, matched: { sessions: await count("rosterContainment"), invoices: await count("invoiceContainment") },
    medianMs: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, +median(v).toFixed(3)])),
    p95Ms: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, +[...v].sort((a, b) => a - b)[Math.floor(v.length * 0.95)].toFixed(3)])),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${process.env.BENCH_LABEL ?? db.mode}-${scale}-predicates.json`), JSON.stringify(out, null, 1));
  console.log(`PREDICATES ${JSON.stringify(out)}`);
});
