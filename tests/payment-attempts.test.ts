import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { DomainError } from "../src/modules/training/domain/rules";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { bootstrapAcademy } from "../src/modules/academy/application/bootstrap";
import {
  issueInvoice,
  submitPayment,
  verifyPayment,
  voidInvoice,
} from "../src/modules/fees/application/service";
import { receiptPdf } from "../src/modules/reports/application/pdf";
import {
  MAX_PENDING_ATTEMPTS,
  referenceDecision,
  referenceKey,
} from "../src/modules/fees/domain/reference";
import { HOOK_TIMEOUT } from "./helpers/paths";
import {
  provisionTestDatabase,
  type TestDatabase,
} from "./helpers/test-database";

/**
 * Stage 5C: payment attempts and reference integrity. Runs on embedded PGlite and, under
 * `npm run test:pg`, on real PostgreSQL 17 and 18 (where the parallel tests run on separate
 * connections). Every test builds its own academy.
 */
process.env.BETTER_AUTH_SECRET = "payment-test-secret-0123456789abcdef0123456";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
let testDb: TestDatabase | undefined;
before(
  async () => {
    testDb = await provisionTestDatabase("payments");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await testDb?.cleanup();
  },
  { timeout: HOOK_TIMEOUT },
);

const ROLES = ["OWNER", "ADMIN", "HEAD_COACH", "COACH", "FINANCE", "NUTRITION_PRO", "GUARDIAN", "ADULT_PLAYER"];
const actorOf = (world: string, role: string): Actor => ({
  id: `${world}-${role.toLowerCase().replace("_", "-")}`,
  name: `Fixture ${role}`,
  role,
  academyId: world,
  timezone: "Asia/Kolkata",
  academyName: `Academy ${world}`,
});
async function world(id: string) {
  const db = database();
  await db.insert(t.academies).values({ id, name: `Academy ${id}`, timezone: "Asia/Kolkata" });
  await db.insert(t.academySettings).values({ academyId: id, data: defaultSettings });
  await db.insert(t.entitlements).values({
    academyId: id,
    data: { reports: true, nutrition: true, communications: true, manualVideo: true },
  });
  await db.insert(t.branches).values({ id: `${id}-branch`, academyId: id, name: "Branch" });
  for (const role of ROLES) {
    const a = actorOf(id, role);
    await db.insert(t.user).values({ id: a.id, name: a.name, email: `${a.id}@example.test` });
    await db.insert(t.memberships).values({ academyId: id, userId: a.id, role });
  }
  // A second, unrelated family in the same academy.
  const other = `${id}-other-guardian`;
  await db.insert(t.user).values({ id: other, name: "Other family", email: `${other}@example.test` });
  await db.insert(t.memberships).values({ academyId: id, userId: other, role: "GUARDIAN" });
  await db.insert(t.batches).values({ id: `${id}-batch`, academyId: id, name: "Batch", branchId: `${id}-branch`, coachId: actorOf(id, "COACH").id });
  for (const child of ["child", "other-child"]) {
    await db.insert(t.players).values({ id: `${id}-${child}`, academyId: id, batchId: `${id}-batch`, name: child });
    await db.insert(t.profiles).values({ academyId: id, playerId: `${id}-${child}`, data: defaultProfile });
  }
  await db.insert(t.guardianLinks).values([
    { academyId: id, playerId: `${id}-child`, userId: actorOf(id, "GUARDIAN").id, relationship: "Parent", consent: { portal: true, email: false, whatsapp: false } },
    { academyId: id, playerId: `${id}-other-child`, userId: other, relationship: "Parent", consent: { portal: true, email: false, whatsapp: false } },
  ]);
  const owner = actorOf(id, "OWNER");
  const invoice = async (total = 300000) =>
    issueInvoice(owner, {
      id: crypto.randomUUID(),
      playerIds: [`${id}-child`],
      familyUserId: null,
      planId: null,
      description: "Monthly academy fee",
      subtotal: total,
      discount: 0,
      currency: "INR",
      dueDate: "2030-01-31",
    });
  return {
    id,
    owner,
    finance: actorOf(id, "FINANCE"),
    guardian: actorOf(id, "GUARDIAN"),
    otherGuardian: { ...actorOf(id, "GUARDIAN"), id: other },
    invoice,
  };
}
const pay = (invoiceId: string, reference: string, amount = 100000) => ({
  invoiceId,
  idempotencyKey: crypto.randomUUID(),
  amount,
  reference,
  method: "BANK",
});
const decide = (id: string, decision: "VERIFIED" | "REJECTED", rejectionKind?: "CORRECTABLE" | "INVALID", version = 1) => ({
  id,
  version,
  decision,
  reason: decision === "VERIFIED" ? "Matched the bank statement." : "Amount on the statement differs.",
  ...(rejectionKind ? { rejectionKind } : {}),
});
async function refuses(work: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    if (code) assert.equal(error.code, code, error.message);
    return true;
  });
}
/** Database refusals arrive wrapped by the driver; the reason is in the cause. */
const refusedWith = (re: RegExp) => (e: unknown) =>
  re.test(`${String(e)} ${String((e as { cause?: unknown }).cause)}`);
const row = async (id: string) =>
  (await database().select().from(t.payments).where(eq(t.payments.id, id)))[0];
const attemptsOf = async (invoiceId: string) =>
  database().select().from(t.payments).where(eq(t.payments.invoiceId, invoiceId));

// ---------------------------------------------------------------------------------------------
test("reference normalization: the rule, and the database computes exactly the same canonical form", async () => {
  const corpus: [string, string][] = [
    ["UTR-1001", "utr-1001"],
    ["  utr-1001  ", "utr-1001"],
    ["UTR\t\t1001", "utr 1001"],
    ["UTR   1001", "utr 1001"],
    ["Utr 1001\n", "utr 1001"],
    ["UTR 1001", "utr 1001"],
    ["ＵＴＲ１", "utr1"],
    ["x　y", "x y"],
    ["UPI/ABC@okicici", "upi/abc@okicici"],
    ["École-1", "École-1"],
    ["A\r\nB\fC\vD", "a b c d"],
  ];
  for (const [input, expected] of corpus) assert.equal(referenceKey(input), expected, JSON.stringify(input));
  const expr = t.PAYMENT_REFERENCE_KEY_SQL.replace('"reference"', "r");
  const result = (await database().execute(
    sql`select r, ${sql.raw(expr)} as k from (values ${sql.join(corpus.map(([input]) => sql`(${input}::text)`), sql`, `)}) as v(r)`,
  )) as unknown as { rows: { r: string; k: string }[] };
  for (const { r, k } of result.rows) assert.equal(k, referenceKey(r), `database and application differ for ${JSON.stringify(r)}`);
  assert.equal(result.rows.length, corpus.length);
});

test("duplicates are refused: exact, different case, surrounding and repeated whitespace, and on another invoice", async () => {
  const w = await world("pa-dup");
  const first = await w.invoice();
  const second = await w.invoice();
  const original = await submitPayment(w.guardian, pay(first.id, "UTR-2024-0001"));
  assert.equal(original.reference, "UTR-2024-0001");
  assert.equal(original.referenceKey, "utr-2024-0001");
  for (const variant of ["UTR-2024-0001", "utr-2024-0001", "  UTR-2024-0001  ", "Utr-2024-0001"])
    await refuses(submitPayment(w.guardian, pay(first.id, variant)), 409, "PAYMENT_REFERENCE_DUPLICATE");
  await refuses(submitPayment(w.owner, pay(second.id, "utr-2024-0001")), 409, "PAYMENT_REFERENCE_DUPLICATE");
  const spaced = await submitPayment(w.guardian, pay(second.id, "BANK  REF   77"));
  assert.equal(spaced.reference, "BANK  REF   77", "the submitted text is kept as it was");
  for (const variant of ["bank ref 77", "BANK\tREF 77", "Bank Ref\t\t77"])
    await refuses(submitPayment(w.guardian, pay(second.id, variant)), 409, "PAYMENT_REFERENCE_DUPLICATE");
  assert.equal((await attemptsOf(first.id)).length, 1);
  assert.equal((await attemptsOf(second.id)).length, 1);
  // A retry of the same request (same idempotency key) is still answered with the same attempt.
  const request = pay(first.id, "UTR-RETRY-9");
  const once = await submitPayment(w.guardian, request);
  assert.equal((await submitPayment(w.guardian, request)).id, once.id);
});

test("a correctable rejection can be followed by a new attempt; the rejected attempt never changes", async () => {
  const w = await world("pa-resubmit");
  const invoice = await w.invoice();
  const attempt1 = await submitPayment(w.guardian, pay(invoice.id, "UTR-555"));
  const rejected = await verifyPayment(w.finance, decide(attempt1.id, "REJECTED", "CORRECTABLE"));
  assert.deepEqual([rejected.status, rejected.rejectionKind, rejected.data.rejectionKind], ["REJECTED", "CORRECTABLE", "CORRECTABLE"]);
  const frozen = JSON.stringify(await row(attempt1.id));
  // Same reference, different case and spacing: a NEW attempt on the same invoice.
  const attempt2 = await submitPayment(w.guardian, pay(invoice.id, " utr-555 "));
  assert.notEqual(attempt2.id, attempt1.id);
  assert.deepEqual(
    [attempt2.status, attempt2.invoiceId, attempt2.data.invoiceId, attempt2.data.previousAttemptId, attempt2.data.attemptNo, attempt2.version],
    ["SUBMITTED", invoice.id, invoice.id, attempt1.id, 2, 1],
  );
  assert.equal(JSON.stringify(await row(attempt1.id)), frozen, "the rejected attempt is unchanged");
  // A second correctable rejection, a third attempt.
  await verifyPayment(w.finance, decide(attempt2.id, "REJECTED", "CORRECTABLE"));
  const attempt3 = await submitPayment(w.guardian, pay(invoice.id, "UTR-555"));
  assert.deepEqual([attempt3.data.previousAttemptId, attempt3.data.attemptNo], [attempt2.id, 3]);
  // The history keeps every attempt, each with its own audit trail.
  assert.equal((await attemptsOf(invoice.id)).length, 3);
  const revisions = await database().select().from(t.recordRevisions).where(and(eq(t.recordRevisions.kind, "payment"), eq(t.recordRevisions.entityId, attempt1.id)));
  assert.deepEqual(revisions.map((r) => r.version).sort(), [1, 2]);
  // The database itself refuses to change or remove a rejected attempt.
  await assert.rejects(() => database().update(t.payments).set({ reference: "edited" }).where(eq(t.payments.id, attempt1.id)), refusedWith(/immutable/));
  await assert.rejects(() => database().delete(t.payments).where(eq(t.payments.id, attempt1.id)), refusedWith(/immutable/));
  assert.equal(JSON.stringify(await row(attempt1.id)), frozen);
  // Deciding a rejected attempt again changes nothing.
  assert.equal((await verifyPayment(w.finance, decide(attempt1.id, "REJECTED", "INVALID", 2))).rejectionKind, "CORRECTABLE");
  await refuses(verifyPayment(w.finance, decide(attempt1.id, "VERIFIED", undefined, 2)), 422);
});

test("invalid or unspecified rejections keep the reference blocked; a correctable one only for its own invoice", async () => {
  const w = await world("pa-blocked");
  const a = await w.invoice();
  const b = await w.invoice();
  const invalid = await submitPayment(w.guardian, pay(a.id, "FAKE-REF-1"));
  await verifyPayment(w.finance, decide(invalid.id, "REJECTED", "INVALID"));
  await refuses(submitPayment(w.guardian, pay(a.id, "fake-ref-1")), 409, "PAYMENT_REFERENCE_BLOCKED");
  await refuses(submitPayment(w.guardian, pay(b.id, "FAKE-REF-1")), 409, "PAYMENT_REFERENCE_BLOCKED");
  // Without a kind a rejection is INVALID: the behaviour before Stage 5C.
  const unspecified = await submitPayment(w.guardian, pay(a.id, "OLD-STYLE-2"));
  const decided = await verifyPayment(w.finance, decide(unspecified.id, "REJECTED"));
  assert.equal(decided.rejectionKind, "INVALID");
  await refuses(submitPayment(w.guardian, pay(a.id, "OLD-STYLE-2")), 409, "PAYMENT_REFERENCE_BLOCKED");
  // A rejection recorded before Stage 5C (no kind at all) also keeps the reference blocked.
  const legacy = crypto.randomUUID();
  await database().insert(t.payments).values({
    id: legacy, academyId: w.id, invoiceId: a.id, status: "REJECTED", version: 2, idempotencyKey: crypto.randomUUID(), reference: "LEGACY-3",
    data: { invoiceId: a.id, amount: 1000, currency: "INR", reference: "LEGACY-3", method: "BANK", submittedBy: w.guardian.id, verifiedBy: w.owner.id, reason: "Old rejection.", receiptNumber: null },
  });
  await refuses(submitPayment(w.guardian, pay(a.id, "legacy-3")), 409, "PAYMENT_REFERENCE_BLOCKED");
  // A correctable rejection on invoice A does not open the reference for invoice B.
  const correctable = await submitPayment(w.guardian, pay(a.id, "UTR-AB"));
  await verifyPayment(w.finance, decide(correctable.id, "REJECTED", "CORRECTABLE"));
  await refuses(submitPayment(w.guardian, pay(b.id, "UTR-AB")), 409, "PAYMENT_RESUBMISSION_INVALID");
  assert.equal((await submitPayment(w.guardian, pay(a.id, "UTR-AB"))).data.previousAttemptId, correctable.id);
  // A rejection type is only for rejections.
  const pending = await submitPayment(w.guardian, pay(b.id, "UTR-B-OK"));
  await refuses(verifyPayment(w.finance, decide(pending.id, "VERIFIED", "CORRECTABLE")), 422, "PAYMENT_DECISION_INVALID");
  await assert.rejects(() => verifyPayment(w.finance, { ...decide(pending.id, "REJECTED"), rejectionKind: "MAYBE" }));
  assert.equal((await row(pending.id)).status, "SUBMITTED");
});

test(`at most ${MAX_PENDING_ATTEMPTS} attempts per invoice wait for a decision; rejected and verified ones do not count`, async () => {
  const w = await world("pa-limit");
  const invoice = await w.invoice(900000);
  const attempts = [];
  for (const n of [1, 2, 3]) attempts.push(await submitPayment(w.guardian, pay(invoice.id, `PEND-${n}`, 100000)));
  await refuses(submitPayment(w.guardian, pay(invoice.id, "PEND-4", 100000)), 409, "PAYMENT_PENDING_LIMIT");
  await refuses(submitPayment(w.finance, pay(invoice.id, "PEND-4", 100000)), 409, "PAYMENT_PENDING_LIMIT");
  // Another invoice is not affected.
  const other = await w.invoice();
  await submitPayment(w.guardian, pay(other.id, "OTHER-1"));
  await verifyPayment(w.finance, decide(attempts[0].id, "REJECTED", "CORRECTABLE"));
  const fourth = await submitPayment(w.guardian, pay(invoice.id, "PEND-4", 100000));
  await refuses(submitPayment(w.guardian, pay(invoice.id, "PEND-5", 100000)), 409, "PAYMENT_PENDING_LIMIT");
  await verifyPayment(w.finance, decide(attempts[1].id, "VERIFIED"));
  await submitPayment(w.guardian, pay(invoice.id, "PEND-5", 100000));
  const pending = (await attemptsOf(invoice.id)).filter((p) => p.status === "SUBMITTED");
  assert.deepEqual(pending.map((p) => p.reference).sort(), ["PEND-3", "PEND-4", "PEND-5"]);
  assert.ok(fourth.id);
  // The database refuses a fourth pending attempt even when the application is bypassed.
  await assert.rejects(
    () => database().insert(t.payments).values({
      id: crypto.randomUUID(), academyId: w.id, invoiceId: invoice.id, idempotencyKey: crypto.randomUUID(), reference: "RAW-6",
      data: { invoiceId: invoice.id, amount: 1, currency: "INR", reference: "RAW-6", method: "BANK", submittedBy: w.owner.id, verifiedBy: null, reason: "", receiptNumber: null },
    }),
    (e: unknown) => /PAYMENT_PENDING_LIMIT/.test(`${String(e)} ${String((e as { cause?: unknown }).cause)}`),
  );
});

test("verification is unchanged: a resubmission is verified normally, never twice, and never beyond the balance", async () => {
  const w = await world("pa-verify");
  const invoice = await w.invoice(200000);
  const attempt1 = await submitPayment(w.guardian, pay(invoice.id, "UTR-900", 200000));
  await verifyPayment(w.finance, decide(attempt1.id, "REJECTED", "CORRECTABLE"));
  const attempt2 = await submitPayment(w.guardian, pay(invoice.id, "utr-900", 200000));
  const verified = await verifyPayment(w.finance, decide(attempt2.id, "VERIFIED"));
  assert.equal(verified.status, "VERIFIED");
  assert.match(verified.data.receiptNumber ?? "", /^RCT-/);
  assert.equal(verified.data.previousAttemptId, attempt1.id);
  assert.equal((await receiptPdf(w.guardian, attempt2.id)).name, `receipt-${attempt2.id}.pdf`);
  await refuses(receiptPdf(w.guardian, attempt1.id), 404);
  // The same reference cannot come back after verification.
  await refuses(submitPayment(w.guardian, pay(invoice.id, "UTR-900", 1)), 409, "PAYMENT_REFERENCE_DUPLICATE");
  // The invoice is paid: nothing more can be submitted or verified for it.
  await refuses(submitPayment(w.guardian, pay(invoice.id, "UTR-901", 1)), 422);
  const summary = (await bootstrapAcademy(w.owner)).invoices.find((i) => i.id === invoice.id)!;
  assert.deepEqual([summary.verified, summary.balance], [200000, 0]);
  // Two pending attempts for the full amount: only one can be verified.
  const second = await w.invoice(100000);
  const x = await submitPayment(w.guardian, pay(second.id, "UTR-X", 100000));
  const y = await submitPayment(w.guardian, pay(second.id, "UTR-Y", 100000));
  await verifyPayment(w.finance, decide(x.id, "VERIFIED"));
  await refuses(verifyPayment(w.finance, decide(y.id, "VERIFIED")), 422);
  assert.equal((await attemptsOf(second.id)).filter((p) => p.status === "VERIFIED").length, 1);
  // A void invoice takes no attempts.
  const third = await w.invoice(100000);
  await voidInvoice(w.owner, { id: third.id, version: 1, reason: "Issued by mistake." });
  await refuses(submitPayment(w.guardian, pay(third.id, "UTR-VOID")), 422);
});

test("concurrent identical submissions: exactly one attempt is stored", async () => {
  const w = await world("pa-race-dup");
  const invoice = await w.invoice();
  const variants = ["UTR-RACE", "utr-race", " UTR-RACE ", "Utr-Race", "UTR-RACE", "utr-race"];
  const results = await Promise.allSettled(variants.map((r, i) => submitPayment(i % 2 ? w.guardian : w.finance, pay(invoice.id, r))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results)
    if (r.status === "rejected") {
      assert.ok(r.reason instanceof DomainError, String(r.reason));
      assert.equal(r.reason.code, "PAYMENT_REFERENCE_DUPLICATE");
    }
  assert.equal((await attemptsOf(invoice.id)).length, 1);
});

test("concurrent submissions at the pending limit: never more than three wait for a decision", async () => {
  const w = await world("pa-race-limit");
  const invoice = await w.invoice(900000);
  await submitPayment(w.guardian, pay(invoice.id, "BASE-1", 100000));
  await submitPayment(w.guardian, pay(invoice.id, "BASE-2", 100000));
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => submitPayment(n % 2 ? w.guardian : w.finance, pay(invoice.id, `RACE-${n}`, 100000))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results)
    if (r.status === "rejected") assert.equal((r.reason as DomainError).code, "PAYMENT_PENDING_LIMIT", String(r.reason));
  assert.equal((await attemptsOf(invoice.id)).filter((p) => p.status === "SUBMITTED").length, MAX_PENDING_ATTEMPTS);
});

test("the database alone serialises racing writers on separate connections (PostgreSQL)", async (t) => {
  if (testDb?.mode !== "postgres") return t.skip("needs separate connections: runs under npm run test:pg");
  const w = await world("pa-race-db");
  const invoice = await w.invoice(900000);
  const insert = (client: Client, reference: string) =>
    client.query(
      `insert into payment_reference (id, academy_id, invoice_id, idempotency_key, reference, data) values ($1, $2, $3, $4, $5, '{"amount": 1, "currency": "INR"}'::jsonb)`,
      [crypto.randomUUID(), w.id, invoice.id, crypto.randomUUID(), reference],
    );
  const connect = async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    return c;
  };
  // Same canonical reference from two open transactions: the second waits, then fails on commit of the first.
  const [one, two] = [await connect(), await connect()];
  try {
    await one.query("begin");
    await two.query("begin");
    await insert(one, "DB-RACE-1");
    const second = insert(two, "db-race-1").then(() => "inserted", (e: { code?: string; constraint?: string }) => `${e.code}:${e.constraint}`);
    await one.query("commit");
    assert.equal(await second, "23505:payment_reference_live_key");
    await two.query("rollback");
    // Pending limit: one pending exists; three more from three connections, each in its own transaction.
    const three = await connect();
    try {
      for (const c of [one, two, three]) await c.query("begin");
      await insert(one, "DB-P-2");
      await insert(one, "DB-P-3");
      const waiting = insert(two, "DB-P-4").then(() => "inserted", (e: Error) => e.message);
      await one.query("commit");
      assert.match(await waiting, /PAYMENT_PENDING_LIMIT/);
      await two.query("rollback");
      await three.query("rollback");
    } finally {
      await three.end();
    }
    const pending = await one.query(`select count(*)::int n from payment_reference where invoice_id = $1 and status = 'SUBMITTED'`, [invoice.id]);
    assert.equal(pending.rows[0].n, 3);
  } finally {
    await one.end();
    await two.end();
  }
});

test("authorisation and academy isolation are unchanged", async () => {
  const green = await world("pa-green");
  const blue = await world("pa-blue");
  const invoice = await green.invoice();
  // Roles that cannot submit or decide.
  for (const role of ["HEAD_COACH", "COACH", "NUTRITION_PRO"])
    await refuses(submitPayment(actorOf(green.id, role), pay(invoice.id, `ROLE-${role}`)), 403);
  // Another family of the same academy cannot see the invoice.
  await refuses(submitPayment(green.otherGuardian, pay(invoice.id, "OTHER-FAMILY")), 404);
  const attempt = await submitPayment(green.guardian, pay(invoice.id, "SHARED-REF"));
  for (const role of ["HEAD_COACH", "COACH", "NUTRITION_PRO", "GUARDIAN", "ADULT_PLAYER"])
    await refuses(verifyPayment(actorOf(green.id, role), decide(attempt.id, "REJECTED", "CORRECTABLE")), 403);
  // Another academy can neither submit against nor decide on this invoice's attempts...
  await refuses(submitPayment(blue.finance, pay(invoice.id, "CROSS")), 404);
  await refuses(verifyPayment(blue.finance, decide(attempt.id, "REJECTED", "CORRECTABLE")), 404);
  assert.equal((await row(attempt.id)).status, "SUBMITTED");
  // ...and references are per academy: the same text is independent in another academy.
  const blueInvoice = await blue.invoice();
  assert.equal((await submitPayment(blue.guardian, pay(blueInvoice.id, "shared-ref"))).academyId, blue.id);
  // The family payload shows the attempt and the decision without internal columns.
  await verifyPayment(green.finance, decide(attempt.id, "REJECTED", "CORRECTABLE"));
  const family = await bootstrapAcademy(green.guardian);
  const shown = family.payments.find((p) => p.id === attempt.id)!;
  assert.equal(shown.data.rejectionKind, "CORRECTABLE");
  assert.ok(!("referenceKey" in shown) && !("rejectionKind" in shown), "internal columns are not sent");
  assert.ok(family.payments.every((p) => p.academyId === green.id));
  assert.equal((await bootstrapAcademy(green.otherGuardian)).payments.length, 0);
});

test("decision rule (pure): precedence of duplicate, blocked and invalid-resubmission", () => {
  const p = (id: string, invoiceId: string, status: string, rejectionKind: string | null = null, attemptNo?: number) => ({
    id, invoiceId, status, rejectionKind, data: attemptNo ? { attemptNo } : {},
  });
  assert.deepEqual(referenceDecision([], "i1"), { ok: true, previous: null });
  assert.equal(referenceDecision([p("a", "i2", "VERIFIED"), p("b", "i1", "REJECTED", "INVALID")], "i1").ok, false);
  assert.deepEqual(referenceDecision([p("a", "i2", "VERIFIED")], "i1"), { ok: false, code: "PAYMENT_REFERENCE_DUPLICATE" });
  assert.deepEqual(referenceDecision([p("a", "i1", "SUBMITTED")], "i1"), { ok: false, code: "PAYMENT_REFERENCE_DUPLICATE" });
  assert.deepEqual(referenceDecision([p("a", "i1", "REJECTED", null)], "i1"), { ok: false, code: "PAYMENT_REFERENCE_BLOCKED" });
  assert.deepEqual(referenceDecision([p("a", "i1", "REJECTED", "INVALID")], "i1"), { ok: false, code: "PAYMENT_REFERENCE_BLOCKED" });
  assert.deepEqual(referenceDecision([p("a", "i2", "REJECTED", "CORRECTABLE")], "i1"), { ok: false, code: "PAYMENT_RESUBMISSION_INVALID" });
  const chain = [p("a", "i1", "REJECTED", "CORRECTABLE"), p("c", "i1", "REJECTED", "CORRECTABLE", 3), p("b", "i1", "REJECTED", "CORRECTABLE", 2)];
  const allowed = referenceDecision(chain, "i1");
  assert.ok(allowed.ok && allowed.previous?.id === "c", "the newest correctable attempt is the one replaced");
});
