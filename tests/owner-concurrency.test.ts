import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { hashPassword, symmetricEncrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { Client } from "pg";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { auth } from "../src/modules/identity/auth";
import { saveMember } from "../src/modules/settings/application/service";
import { verifyPayment } from "../src/modules/fees/application/service";
import { createDrill } from "../src/modules/training/application/service";
import { DomainError } from "../src/modules/training/domain/rules";
import { FIXTURE_PASSWORD, USERS, addFixtureUser } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { newMember } from "./helpers/accounts";
import { enroll } from "./helpers/mfa";
import { totpAt } from "./helpers/totp";
import { throttleKey } from "../src/modules/identity/sign-in-throttle";
/**
 * RC-2 concurrency on PostgreSQL (two or more real connections; the embedded database serialises everything on
 * one connection, so these are skipped there):
 *
 *   AT-9   two owners demote each other at the same moment. Both requests are authorised (stale actors) and
 *          both pass the password + TOTP step-up; a third transaction holds the academy lock until BOTH are
 *          waiting on it (a real barrier, observed in pg_stat_activity), then releases it. Exactly one demotion
 *          commits, the other is refused by lockActor (409 ACCESS_CHANGED; 403 MEMBERSHIP_INACTIVE for mutual
 *          deactivation), and exactly one active owner
 *          remains. 100 repetitions, plus 20 of mutual deactivation.
 *   AT-7.6 the shared five-attempt owner counter is atomic across concurrent password and TOTP attempts: with the
 *          counter row held, 22 simultaneous attempts (wrong code, wrong password, privacy re-authentication) queue
 *          at the atomic claim (10 on the row, the rest for a pool connection), and exactly five are judged.
 *   AT-10  a request already waiting for a lock while its actor's membership changes is refused when it wakes:
 *          academy-API (unit) and Training Studio (createDrill, which takes no academy lock).
 */
const PG = !!process.env.TEST_POSTGRES_ADMIN_URL;
const SKIP = PG ? false : "TEST_POSTGRES_ADMIN_URL not set - run `npm run test:pg`";
const REPS = Number(process.env.RC2_RACE_REPS ?? 100);
let app: Harness;
let passwordHash: string;
before(
  async () => {
    if (!PG) return;
    app = await startHarness("rc2-owner-concurrency");
    passwordHash = await hashPassword(FIXTURE_PASSWORD);
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app?.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const db = () => database();
async function enrolledOwner(academyId: string, id: string): Promise<{ actor: Actor; code: () => Promise<string> }> {
  const context = await auth().$context;
  const secret = `rc2-race-secret-${id}-${crypto.randomUUID()}`;
  await db().insert(t.user).values({ id, name: `Fixture ${id}`, email: `${id}@example.test`, emailVerified: true, twoFactorEnabled: true });
  await db().insert(t.account).values({ id: `account-${id}`, accountId: id, providerId: "credential", userId: id, password: passwordHash });
  await db().insert(t.memberships).values({ academyId, userId: id, role: "OWNER", active: true });
  await db().insert(t.twoFactor).values({
    id: `tf-${id}`,
    userId: id,
    secret: await symmetricEncrypt({ key: context.secretConfig, data: secret }),
    backupCodes: await symmetricEncrypt({ key: context.secretConfig, data: "[]" }),
    verified: true,
  });
  return {
    actor: { id, name: `Fixture ${id}`, academyId, role: "OWNER", timezone: "UTC", academyName: academyId },
    code: () => createOTP(secret, { period: 30, digits: 6 }).totp(),
  };
}
const lockWaiters = async () =>
  (
    await db().execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    )
  ).rows[0].n;
/** Holds the academy row lock until `waiters` sessions are blocked on a lock (or 15 s pass), then commits. */
async function barrier(academyId: string, waiters: number, during: () => Promise<unknown>[]) {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const taken = new Promise<void>((resolve) => (locked = resolve));
  const holder = db().transaction(async (tx) => {
    await tx.select().from(t.academies).where(eq(t.academies.id, academyId)).for("update");
    locked();
    await hold;
  });
  await taken;
  const pending = during().map((p) => p.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })));
  const deadline = Date.now() + 15_000;
  let seen = 0;
  while (Date.now() < deadline && (seen = await lockWaiters()) < waiters) await new Promise((r) => setTimeout(r, 20));
  release();
  await holder;
  return { results: await Promise.all(pending), waitersSeen: seen };
}
const activeOwners = async (academyId: string) =>
  (
    await db()
      .select()
      .from(t.memberships)
      .where(and(eq(t.memberships.academyId, academyId), eq(t.memberships.role, "OWNER"), eq(t.memberships.active, true)))
  ).length;
const demote = (actor: Actor, target: Actor, code: string, active = true) =>
  saveMember(actor, {
    id: target.id,
    name: target.name,
    email: `${target.id}@example.test`,
    role: active ? "COACH" : "OWNER",
    active,
    professionalAttestation: "",
    ownerPassword: FIXTURE_PASSWORD,
    mfaCode: code,
  });

async function race(label: string, reps: number, deactivate: boolean) {
  // The loser finds its own membership demoted (409 ACCESS_CHANGED) or deactivated (403 MEMBERSHIP_INACTIVE).
  const [status, code] = deactivate ? [403, "MEMBERSHIP_INACTIVE"] : [409, "ACCESS_CHANGED"];
  const tally = { oneCommitted: 0, refusedByLockActor: 0, exactlyOneOwner: 0, barrierHeld: 0 };
  for (let i = 0; i < reps; i++) {
    const academyId = `rc2-${label}-${i}`;
    await db().insert(t.academies).values({ id: academyId, name: academyId, timezone: "UTC" });
    const a = await enrolledOwner(academyId, `${academyId}-a`);
    const b = await enrolledOwner(academyId, `${academyId}-b`);
    const [codeA, codeB] = [await a.code(), await b.code()];
    const { results, waitersSeen } = await barrier(academyId, 2, () => [
      demote(a.actor, b.actor, codeA, !deactivate),
      demote(b.actor, a.actor, codeB, !deactivate),
    ]);
    const ok = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    if (ok.length === 1) tally.oneCommitted++;
    if (
      refused.length === 1 &&
      !refused[0].ok &&
      refused[0].error instanceof DomainError &&
      refused[0].error.status === status &&
      refused[0].error.code === code
    )
      tally.refusedByLockActor++;
    else if (refused.length) console.log(`${academyId}: unexpected refusal`, refused.map((r) => (!r.ok ? String((r.error as Error)?.message) : "")));
    if ((await activeOwners(academyId)) === 1) tally.exactlyOneOwner++;
    if (waitersSeen >= 2) tally.barrierHeld++;
  }
  return tally;
}

test(`AT-9: mutual owner demotion under a real barrier keeps exactly one owner (${REPS} repetitions)`, { skip: SKIP }, async () => {
  const tally = await race("demote", REPS, false);
  console.log(`AT-9 demotion: ${JSON.stringify(tally)}`);
  assert.deepEqual(tally, { oneCommitted: REPS, refusedByLockActor: REPS, exactlyOneOwner: REPS, barrierHeld: REPS });
});

test("AT-9: mutual owner deactivation under a real barrier keeps exactly one owner (20 repetitions)", { skip: SKIP }, async () => {
  const tally = await race("deactivate", 20, true);
  console.log(`AT-9 deactivation: ${JSON.stringify(tally)}`);
  assert.deepEqual(tally, { oneCommitted: 20, refusedByLockActor: 20, exactlyOneOwner: 20, barrierHeld: 20 });
});

const actorOf = (key: keyof typeof USERS): Actor => ({
  id: USERS[key].id,
  name: USERS[key].name,
  academyId: USERS[key].academyId,
  role: USERS[key].role,
  timezone: "Asia/Kolkata",
  academyName: "Green",
});

test("AT-10: a payment decision waiting for the academy lock is refused when its actor is deactivated meanwhile", { skip: SKIP }, async () => {
  const finance = actorOf("finance");
  const payment = { id: "rc2-no-such-payment", version: 1, decision: "VERIFIED", reason: "stale actor test" };
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const taken = new Promise<void>((resolve) => (locked = resolve));
  // An owner's member change, as saveMember performs it: academy lock, then the membership update.
  const deactivation = db().transaction(async (tx) => {
    await tx.select().from(t.academies).where(eq(t.academies.id, "green")).for("update");
    await tx.update(t.memberships).set({ active: false }).where(eq(t.memberships.userId, finance.id));
    locked();
    await hold;
  });
  await taken;
  const pending = verifyPayment(finance, payment).then(
    () => null,
    (e: unknown) => e,
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (await lockWaiters()) < 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok((await lockWaiters()) >= 1, "the payment request is waiting on the lock");
  release();
  await deactivation;
  const error = await pending;
  assert.ok(error instanceof DomainError && error.status === 403 && error.code === "MEMBERSHIP_INACTIVE", String(error));
  await db().update(t.memberships).set({ active: true }).where(eq(t.memberships.userId, finance.id));
  // Control: the current actor reaches the service's own lookup.
  await assert.rejects(verifyPayment(finance, payment), (e: unknown) => e instanceof DomainError && e.status === 404);
});

test("AT-10: a drill creation waiting on the actor's membership row is refused after a concurrent role change", { skip: SKIP }, async () => {
  const hc = await addFixtureUser("rc2-pg-stale-hc", [{ academyId: "green", role: "HEAD_COACH" }]);
  const actor: Actor = { ...actorOf("headCoach"), id: hc.id, name: `Fixture ${hc.id}` };
  const drills = async () => (await db().select().from(t.drills)).length;
  const before = await drills();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const taken = new Promise<void>((resolve) => (locked = resolve));
  const change = db().transaction(async (tx) => {
    await tx.update(t.memberships).set({ role: "ADMIN" }).where(eq(t.memberships.userId, hc.id));
    locked();
    await hold;
  });
  await taken;
  const pending = createDrill(actor, {
    title: "Racing drill",
    objective: "Must not be saved",
    setup: "Half court",
    steps: ["Step"],
    cues: [],
    minutes: 10,
    skill: "Defence",
    level: "Beginner",
    format: "Singles",
    players: 2,
    equipment: [],
    mistakes: [],
    easier: "",
    harder: "",
  }).then(
    () => null,
    (e: unknown) => e,
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (await lockWaiters()) < 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok((await lockWaiters()) >= 1, "the drill request is waiting on the membership row");
  release();
  await change;
  const error = await pending;
  assert.ok(error instanceof DomainError && error.status === 409 && error.code === "ACCESS_CHANGED", String(error));
  assert.equal(await drills(), before, "no drill written");
});

test("AT-7.6 on PostgreSQL: 22 simultaneous owner re-authentications held at the shared counter row; exactly five are judged", { skip: SKIP }, async () => {
  const owner = await enroll(app, USERS.owner);
  const key = throttleKey(process.env.BETTER_AUTH_SECRET!, "owner-reauth", USERS.owner.id);
  await db().delete(t.signInThrottle).where(eq(t.signInThrottle.key, key));
  await db().insert(t.signInThrottle).values({ key, failures: 0, windowStartedAt: new Date() });
  await db().delete(t.totpUsed).where(eq(t.totpUsed.userId, USERS.owner.id));
  const target = await newMember("COACH", "green", "rc2-pg-burst");
  const change = (extra: Record<string, unknown>) =>
    owner.client.post("/api/academy/settings/member", {
      id: target.id,
      name: `Fixture ${target.id}`,
      email: target.email,
      role: "OWNER",
      active: true,
      professionalAttestation: "",
      ...extra,
    });
  const code = totpAt(owner.uri.secret, 0);
  // The holder and the observer use their OWN connections, outside the application's pool (20 connections, see
  // infrastructure/database/client.ts): requests blocked on the row may occupy every pooled connection, and must not
  // starve either of them.
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  const observer = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  await observer.connect();
  // Only attempts blocked at the counter row's atomic claim (the statement on sign_in_throttle) are counted, not every
  // lock wait in the database. How many pile up depends on the pool size and on timing, so the test never asserts an
  // exact number of them: it asserts what matters (nothing is judged while the row is held; exactly five are judged
  // afterwards).
  const waiters = async () =>
    (await observer.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%"sign_in_throttle"%'`,
    )).rows[0].n;
  // Hold the counter row: a correct implementation must claim an attempt on it (atomically) before judging anything.
  await holder.query("begin");
  await holder.query("select * from sign_in_throttle where key = $1 for update", [key]);
  let judgedWhileHeld = 0;
  const attempts = [
    ...Array.from({ length: 8 }, () => change({ ownerPassword: FIXTURE_PASSWORD, mfaCode: "000000" })),
    ...Array.from({ length: 8 }, (_, i) => change({ ownerPassword: `Burst-Wrong-${i}-xxxxxxxx`, mfaCode: code })),
    ...Array.from({ length: 6 }, (_, i) =>
      owner.client.post("/api/academy/privacy/release", { id: "rc2-no-such-hold", reason: "Burst on the shared counter.", ownerPassword: `Burst-Privacy-${i}-xxxx` }),
    ),
  ];
  // A response before the row is released would mean an attempt was judged without first claiming its slot.
  let released = false;
  const burst = Promise.all(
    attempts.map((request) =>
      request.then((r) => {
        if (!released) judgedWhileHeld++;
        return r;
      }),
    ),
  );
  // Wait until a real number of attempts are queued at the held row (the rest wait for a pool connection, or arrive a
  // moment later). The exact count is not the invariant and varies with the pool and with timing.
  const QUEUED_AT_LEAST = 10;
  const deadline = Date.now() + 30_000;
  let waiting = 0;
  while (Date.now() < deadline && (waiting = await waiters()) < QUEUED_AT_LEAST) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 150)); // let any attempt that could be judged early show itself
  const heldFor = judgedWhileHeld;
  released = true;
  await holder.query("commit");
  await holder.end();
  await observer.end();
  const results = await burst;
  const tally: Record<number, number> = {};
  for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
  console.log(`AT-7.6 PostgreSQL counter barrier: waiting=${waiting} ${JSON.stringify(tally)}`);
  assert.ok(waiting >= QUEUED_AT_LEAST, `attempts were queued at the counter row while it was held (saw ${waiting})`);
  assert.equal(heldFor, 0, "no attempt was judged while the counter row was held: each claims its slot atomically first");
  assert.equal(results.length, 22);
  assert.deepEqual(tally, { 403: 5, 429: 17 }, "exactly five attempts were judged, the other seventeen were throttled");
  const [member] = await db().select().from(t.memberships).where(eq(t.memberships.userId, target.id));
  assert.equal(member.role, "COACH");
  await db().delete(t.signInThrottle).where(eq(t.signInThrottle.key, key));
});
