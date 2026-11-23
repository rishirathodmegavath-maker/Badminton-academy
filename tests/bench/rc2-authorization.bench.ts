import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { and, eq, sql } from "drizzle-orm";
import { hashPassword, symmetricEncrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { database } from "../../src/infrastructure/database/client";
import * as t from "../../src/infrastructure/database/schema";
import type { Actor } from "../../src/modules/identity/access";
import { auth } from "../../src/modules/identity/auth";
import { lockActor } from "../../src/modules/identity/lock-actor";
import { unit } from "../../src/modules/academy/application/access";
import { assertAnotherActiveOwner } from "../../src/modules/settings/application/service";
import { verifyOwnerMfaStepUp } from "../../src/modules/identity/owner-step-up";
import { provisionTestDatabase, type TestDatabase } from "../helpers/test-database";
/**
 * RC-2 BENCHMARK (test tooling only; never part of `npm test`). Measures the database work RC-2 adds:
 *
 *   lockActor        the membership read FOR SHARE inside every academy-API write and the four studio mutations
 *   unit()           the whole unit of work (academy lock + lockActor) against the pre-RC-2 shape (academy lock only)
 *   ownerCount       the last-owner precondition (count of other active owners) in saveMember
 *   stepUp           the full owner step-up (throttle, replay claim, password hash check, TOTP decrypt and verify)
 *
 * plus EXPLAIN (ANALYZE) of the two new queries. The academy has BENCH_MEMBERS memberships (default 2000).
 *   BENCH_OUT   directory for the JSON result (default .data/bench-results)
 *   BENCH_RUNS  timed runs per measurement (default 200, after 20 warm-up runs; stepUp uses a tenth)
 */
process.env.BETTER_AUTH_SECRET = "rc2-benchmark-secret-0123456789abcdef0123";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3999";
const MEMBERS = Number(process.env.BENCH_MEMBERS ?? 2000);
const RUNS = Number(process.env.BENCH_RUNS ?? 200);
const WARMUP = 20;
const OUT = resolve(process.env.BENCH_OUT ?? ".data/bench-results");
let tdb: TestDatabase;
before(async () => {
  tdb = await provisionTestDatabase("rc2-bench");
});
after(async () => {
  await tdb?.cleanup?.();
});
const stats = (samples: number[]) => {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, medianMs: +q(0.5).toFixed(3), p95Ms: +q(0.95).toFixed(3), maxMs: +s[s.length - 1].toFixed(3) };
};
async function time(runs: number, fn: () => Promise<unknown>) {
  for (let i = 0; i < Math.min(WARMUP, runs); i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return stats(samples);
}

test("RC-2 authorization benchmark", { timeout: 1_800_000 }, async () => {
  const db = database();
  const academyId = "bench-academy";
  await db.insert(t.academies).values({ id: academyId, name: "Bench Academy", timezone: "UTC" });
  const roles = ["OWNER", "ADMIN", "HEAD_COACH", "COACH", "FINANCE", "NUTRITION_PRO", "GUARDIAN", "ADULT_PLAYER"];
  for (let start = 0; start < MEMBERS; start += 500) {
    const ids = Array.from({ length: Math.min(500, MEMBERS - start) }, (_, i) => `bench-${start + i}`);
    await db.insert(t.user).values(ids.map((id) => ({ id, name: id, email: `${id}@bench.example`, emailVerified: true })));
    await db.insert(t.memberships).values(
      ids.map((id, i) => ({ academyId, userId: id, role: start + i < 3 ? "OWNER" : roles[1 + ((start + i) % 7)], active: true })),
    );
  }
  await db.execute(sql`analyze`);
  const actor: Actor = { id: "bench-0", name: "bench-0", academyId, role: "OWNER", timezone: "UTC", academyName: "Bench" };
  const result: Record<string, unknown> = { engine: tdb.mode, members: MEMBERS, runs: RUNS, at: new Date().toISOString() };
  result.lockActor = await time(RUNS, () => db.transaction((tx) => lockActor(tx, actor)));
  const legacyUnit = () =>
    db.transaction(async (tx) => {
      await tx.select().from(t.academies).where(eq(t.academies.id, academyId)).for("update");
    });
  result.unitPreRc2Shape = await time(RUNS, legacyUnit);
  result.unitRc2 = await time(RUNS, () => unit(actor, async () => undefined));
  result.ownerCount = await time(RUNS, () => db.transaction((tx) => assertAnotherActiveOwner(tx, academyId, "bench-1")));
  // Plans of the two new queries.
  const plan = async (query: ReturnType<typeof sql>) =>
    ((await db.execute(sql`explain (analyze, costs off, timing off, summary off) ${query}`)).rows as Record<string, string>[]).map(
      (r) => Object.values(r)[0],
    );
  result.lockActorPlan = await plan(
    sql`select role, active from membership where academy_id = ${academyId} and user_id = ${actor.id} for share`,
  );
  result.ownerCountPlan = await plan(
    sql`select count(*)::int from membership where academy_id = ${academyId} and role = 'OWNER' and active = true and user_id <> 'bench-1'`,
  );
  // The step-up: enrol bench-0 and time complete successful confirmations (each with a fresh replay window).
  const context = await auth().$context;
  const secret = "rc2-bench-totp-secret";
  await db.insert(t.account).values({
    id: "account-bench-0",
    accountId: "bench-0",
    providerId: "credential",
    userId: "bench-0",
    password: await hashPassword("Bench-Owner-Password-2468"),
  });
  await db.update(t.user).set({ twoFactorEnabled: true }).where(eq(t.user.id, "bench-0"));
  await db.insert(t.twoFactor).values({
    id: "tf-bench-0",
    userId: "bench-0",
    secret: await symmetricEncrypt({ key: context.secretConfig, data: secret }),
    backupCodes: await symmetricEncrypt({ key: context.secretConfig, data: "[]" }),
    verified: true,
  });
  const stepUpRuns = Math.max(10, Math.floor(RUNS / 10));
  result.stepUp = await time(stepUpRuns, async () => {
    await db.delete(t.totpUsed).where(eq(t.totpUsed.userId, "bench-0"));
    await verifyOwnerMfaStepUp({
      actorId: "bench-0",
      academyId,
      ownerPassword: "Bench-Owner-Password-2468",
      mfaCode: await createOTP(secret, { period: 30, digits: 6 }).totp(),
      change: "GRANT",
      targetUserId: null,
    });
  });
  assert.equal(
    (await db.select().from(t.memberships).where(and(eq(t.memberships.academyId, academyId), eq(t.memberships.role, "OWNER")))).length,
    3,
  );
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `rc2-authorization-${tdb.mode}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(`written ${file}`);
});
