import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { DomainError } from "../src/modules/training/domain/rules";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { bootstrapAcademy } from "../src/modules/academy/application/bootstrap";
import {
  issueInvoice,
  saveFeePlan,
  submitPayment,
  verifyPayment,
  recordRefund,
  voidInvoice,
} from "../src/modules/fees/application/service";
import { saveSettings } from "../src/modules/settings/application/service";
import { receiptPdf } from "../src/modules/reports/application/pdf";
import {
  CURRENCIES,
  formatMoney,
  invoiceTotal,
  minorUnits,
  plainMoney,
} from "../src/modules/fees/domain/money";
import {
  currencyChangeBlockers,
  findCurrencyIssues,
  type MoneyRecords,
} from "../src/modules/fees/domain/currency";
import { checkTarget } from "../scripts/lib/currency-check-guard";
import { runMigrations } from "../src/infrastructure/database/migrations";
import { HOOK_TIMEOUT, REPO_ROOT } from "./helpers/paths";
import {
  provisionTestDatabase,
  type TestDatabase,
} from "./helpers/test-database";

/**
 * Stage 5B: one configured currency per academy. Runs on embedded PGlite and, under
 * `npm run test:pg`, on real PostgreSQL 17 and 18. Every test builds its own academy so tests do
 * not depend on each other's records.
 */
process.env.BETTER_AUTH_SECRET = "currency-test-secret-0123456789abcdef012345";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
let testDb: TestDatabase | undefined;
before(
  async () => {
    testDb = await provisionTestDatabase("currency");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await testDb?.cleanup();
  },
  { timeout: HOOK_TIMEOUT },
);

type Cur = "INR" | "USD";
const actorOf = (world: string, role: string): Actor => ({
  id: `${world}-${role.toLowerCase().replace("_", "-")}`,
  name: `Fixture ${role}`,
  role,
  academyId: world,
  timezone: "Asia/Kolkata",
  academyName: `Academy ${world}`,
});
const ROLES = [
  "OWNER",
  "ADMIN",
  "HEAD_COACH",
  "COACH",
  "FINANCE",
  "NUTRITION_PRO",
  "GUARDIAN",
  "ADULT_PLAYER",
];
/** A complete little academy billing in `currency`, with one child linked to the guardian. */
async function world(id: string, currency: Cur) {
  const db = database();
  await db
    .insert(t.academies)
    .values({ id, name: `Academy ${id}`, timezone: "Asia/Kolkata" });
  await db
    .insert(t.academySettings)
    .values({ academyId: id, data: { ...defaultSettings, currency } });
  await db.insert(t.entitlements).values({
    academyId: id,
    data: { reports: true, nutrition: true, communications: true, manualVideo: true },
  });
  await db
    .insert(t.branches)
    .values({ id: `${id}-branch`, academyId: id, name: "Branch" });
  for (const role of ROLES) {
    const a = actorOf(id, role);
    await db
      .insert(t.user)
      .values({ id: a.id, name: a.name, email: `${a.id}@example.test` });
    await db.insert(t.memberships).values({ academyId: id, userId: a.id, role });
  }
  const coach = actorOf(id, "COACH");
  await db.insert(t.batches).values({
    id: `${id}-batch`,
    academyId: id,
    name: "Batch",
    branchId: `${id}-branch`,
    coachId: coach.id,
  });
  await db
    .insert(t.players)
    .values({ id: `${id}-child`, academyId: id, batchId: `${id}-batch`, name: "Child" });
  await db
    .insert(t.profiles)
    .values({ academyId: id, playerId: `${id}-child`, data: defaultProfile });
  await db.insert(t.guardianLinks).values({
    academyId: id,
    playerId: `${id}-child`,
    userId: actorOf(id, "GUARDIAN").id,
    relationship: "Parent",
    consent: { portal: true, email: false, whatsapp: false },
  });
  return {
    id,
    owner: actorOf(id, "OWNER"),
    finance: actorOf(id, "FINANCE"),
    guardian: actorOf(id, "GUARDIAN"),
    player: `${id}-child`,
  };
}
type World = Awaited<ReturnType<typeof world>>;
const invoiceRequest = (w: World, currency: Cur, over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  playerIds: [w.player],
  familyUserId: null,
  planId: null,
  description: "Monthly academy fee",
  subtotal: 100000,
  discount: 0,
  currency,
  dueDate: "2030-01-31",
  ...over,
});
const paymentRequest = (invoiceId: string, amount = 100000) => ({
  invoiceId,
  idempotencyKey: crypto.randomUUID(),
  amount,
  reference: `REF-${crypto.randomUUID()}`,
  method: "BANK",
});
/** Settings as the form would send them: the stored values with some fields replaced. */
async function settingsRequest(w: World, patch: Record<string, unknown> = {}) {
  const db = database();
  const [row] = await db
    .select()
    .from(t.academySettings)
    .where(eq(t.academySettings.academyId, w.id));
  const [academy] = await db.select().from(t.academies).where(eq(t.academies.id, w.id));
  return {
    version: row.version,
    name: academy.name,
    timezone: academy.timezone,
    country: row.data.country,
    currency: row.data.currency,
    colour: row.data.colour,
    policy: row.data.policy,
    retentionDays: row.data.retentionDays,
    features: row.data.features,
    ...patch,
  };
}
const storedSettings = async (id: string) =>
  (
    await database()
      .select()
      .from(t.academySettings)
      .where(eq(t.academySettings.academyId, id))
  )[0];
async function refuses(
  work: Promise<unknown>,
  status: number,
  code: string | undefined,
  message?: RegExp,
) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}
const countInvoices = async (id: string) =>
  (await database().select().from(t.invoices).where(eq(t.invoices.academyId, id))).length;
/** The text drawn on a PDF: page streams are compressed and hold the text as hex strings. */
function pdfText(bytes: Uint8Array) {
  const raw = Buffer.from(bytes).toString("latin1");
  const lines: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const stop = raw.indexOf("endstream", start);
    try {
      const body = inflateSync(Buffer.from(raw.slice(start, stop), "latin1")).toString("latin1");
      for (const h of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g))
        lines.push(Buffer.from(h[1], "hex").toString("latin1"));
    } catch {
      /* not a compressed page stream */
    }
  }
  return lines.join("\n");
}
const pdfContains = (bytes: Uint8Array, phrase: string) => pdfText(bytes).includes(phrase);

// ---------------------------------------------------------------------------------------------
test("invoices are accepted only in the academy's configured currency", async () => {
  const inr = await world("cur-inr", "INR");
  const usd = await world("cur-usd", "USD");
  const issued = await issueInvoice(inr.owner, invoiceRequest(inr, "INR"));
  assert.equal(issued.data.currency, "INR");
  await refuses(
    issueInvoice(inr.owner, invoiceRequest(inr, "USD")),
    422,
    "CURRENCY_MISMATCH",
    /academy currency \(INR\).*USD.*no conversion/,
  );
  assert.equal(await countInvoices(inr.id), 1, "the refused invoice was not stored");
  assert.equal((await issueInvoice(usd.owner, invoiceRequest(usd, "USD"))).data.currency, "USD");
  await refuses(issueInvoice(usd.owner, invoiceRequest(usd, "INR")), 422, "CURRENCY_MISMATCH");
  // Finance staff are held to the same rule; another academy's currency changes nothing here.
  assert.equal((await issueInvoice(inr.finance, invoiceRequest(inr, "INR"))).data.currency, "INR");
  await refuses(issueInvoice(inr.finance, invoiceRequest(inr, "USD")), 422, "CURRENCY_MISMATCH");
  // An unsupported code never reaches the rule.
  await assert.rejects(() => issueInvoice(inr.owner, invoiceRequest(inr, "EUR" as Cur)));
});

test("an academy without a settings row bills in the application default", async () => {
  const w = await world("cur-default", "INR");
  await database().delete(t.academySettings).where(eq(t.academySettings.academyId, w.id));
  assert.equal(defaultSettings.currency, "INR");
  await issueInvoice(w.owner, invoiceRequest(w, "INR"));
  await refuses(issueInvoice(w.owner, invoiceRequest(w, "USD")), 422, "CURRENCY_MISMATCH");
});

test("fee plans must be priced in the academy currency and keep it", async () => {
  const w = await world("cur-plan", "INR");
  await refuses(
    saveFeePlan(w.owner, { name: "Dollar plan", amount: 50000, currency: "USD", archived: false }),
    422,
    "CURRENCY_MISMATCH",
    /academy currency \(INR\)/,
  );
  const plan = await saveFeePlan(w.owner, { name: "Monthly", amount: 300000, currency: "INR", archived: false });
  // Changing the amount is fine; changing the currency never is.
  await saveFeePlan(w.owner, { id: plan.id, name: "Monthly", amount: 310000, currency: "INR", archived: false });
  await refuses(
    saveFeePlan(w.owner, { id: plan.id, name: "Monthly", amount: 310000, currency: "USD", archived: false }),
    409,
    "PLAN_CURRENCY_LOCKED",
  );
  const [stored] = await database().select().from(t.feePlans).where(eq(t.feePlans.id, plan.id));
  assert.deepEqual([stored.currency, stored.amount], ["INR", 310000]);
  // An invoice that uses the plan must match both the plan and the academy.
  const ok = await issueInvoice(w.owner, invoiceRequest(w, "INR", { planId: plan.id, subtotal: 310000 }));
  assert.equal(ok.data.planId, plan.id);
  await refuses(issueInvoice(w.owner, invoiceRequest(w, "USD", { planId: plan.id, subtotal: 310000 })), 422, "CURRENCY_MISMATCH");
  await refuses(issueInvoice(w.owner, invoiceRequest(w, "INR", { planId: plan.id, subtotal: 1 })), 422, undefined, /Recheck the fee plan/);
  await refuses(
    saveFeePlan(w.owner, { id: crypto.randomUUID(), name: "Ghost", amount: 1000, currency: "INR", archived: false }),
    404,
    undefined,
  );
});

test("a plan left over in another currency can be retired, nothing else", async () => {
  const w = await world("cur-legacy-plan", "INR");
  const legacy = crypto.randomUUID();
  await database()
    .insert(t.feePlans)
    .values({ id: legacy, academyId: w.id, name: "Old dollar plan", amount: 4000, currency: "USD", archived: false });
  const same = { id: legacy, name: "Old dollar plan", amount: 4000, currency: "USD" as const };
  await refuses(saveFeePlan(w.owner, { ...same, amount: 4100, archived: false }), 422, "CURRENCY_MISMATCH");
  await refuses(saveFeePlan(w.owner, { ...same, name: "Renamed", archived: true }), 422, "CURRENCY_MISMATCH");
  await refuses(issueInvoice(w.owner, invoiceRequest(w, "INR", { planId: legacy, subtotal: 4000 })), 422, undefined, /Recheck the fee plan/);
  await saveFeePlan(w.owner, { ...same, archived: true });
  await refuses(saveFeePlan(w.owner, { ...same, archived: false }), 422, "CURRENCY_MISMATCH");
  const [row] = await database().select().from(t.feePlans).where(eq(t.feePlans.id, legacy));
  assert.deepEqual([row.currency, row.amount, row.archived], ["USD", 4000, true]);
});

test("only the roles allowed to manage finance and settings can try; every other role is refused", async () => {
  const w = await world("cur-roles", "INR");
  for (const role of ROLES.filter((r) => !["OWNER", "ADMIN", "FINANCE"].includes(r)))
    await refuses(
      issueInvoice(actorOf(w.id, role), invoiceRequest(w, "INR")),
      403,
      undefined,
    );
  for (const role of ROLES.filter((r) => !["OWNER", "ADMIN"].includes(r)))
    await refuses(
      saveSettings(actorOf(w.id, role), await settingsRequest(w, { currency: "USD" })),
      403,
      undefined,
    );
  assert.equal((await storedSettings(w.id)).data.currency, "INR", "refused roles changed nothing");
  await saveSettings(actorOf(w.id, "ADMIN"), await settingsRequest(w, { currency: "USD" }));
  assert.equal((await storedSettings(w.id)).data.currency, "USD", "an admin may change it when nothing is open");
});

test("the academy currency cannot change while an unsettled invoice or an active plan would be left behind", async () => {
  const w = await world("cur-guard", "INR");
  const invoice = await issueInvoice(w.owner, invoiceRequest(w, "INR"));
  const before = await storedSettings(w.id);
  await refuses(
    saveSettings(w.owner, await settingsRequest(w, { currency: "USD" })),
    409,
    "CURRENCY_CHANGE_BLOCKED",
    /1 issued invoice with an outstanding balance.*nothing is converted/,
  );
  const after = await storedSettings(w.id);
  assert.deepEqual([after.version, after.data.currency], [before.version, "INR"], "a refused change leaves settings untouched");
  // Saving other settings with the same currency is never blocked by open invoices.
  await saveSettings(w.owner, await settingsRequest(w, { policy: "Fees are due monthly.", country: "IN" }));
  assert.equal((await storedSettings(w.id)).data.currency, "INR");
  // Two payments are submitted against the same balance; only one can be verified.
  const first = await submitPayment(w.guardian, paymentRequest(invoice.id));
  const second = await submitPayment(w.guardian, paymentRequest(invoice.id));
  const done = await verifyPayment(w.owner, { id: first.id, version: 1, decision: "VERIFIED", reason: "Bank statement matched." });
  assert.equal(done.status, "VERIFIED");
  // The invoice is now settled, but a payment still waits for a decision: still blocked.
  await refuses(saveSettings(w.owner, await settingsRequest(w, { currency: "USD" })), 409, "CURRENCY_CHANGE_BLOCKED", /pending payment/);
  await verifyPayment(w.owner, { id: second.id, version: 1, decision: "REJECTED", reason: "Duplicate transfer." });
  await saveSettings(w.owner, await settingsRequest(w, { currency: "USD" }));
  assert.equal((await storedSettings(w.id)).data.currency, "USD");
  // An active plan in the academy's currency blocks a switch back; archiving it releases it.
  const plan = await saveFeePlan(w.owner, { name: "Dollar plan", amount: 1000, currency: "USD", archived: false });
  await refuses(saveSettings(w.owner, await settingsRequest(w, { currency: "INR" })), 409, "CURRENCY_CHANGE_BLOCKED", /fee plan/);
  await saveFeePlan(w.owner, { id: plan.id, name: "Dollar plan", amount: 1000, currency: "USD", archived: true });
  await saveSettings(w.owner, await settingsRequest(w, { currency: "INR" }));
  assert.equal((await storedSettings(w.id)).data.currency, "INR");
});

test("void invoices do not block a currency change, and issued history keeps its currency, payments, receipts and family view", async () => {
  const w = await world("cur-history", "INR");
  const voided = await issueInvoice(w.owner, invoiceRequest(w, "INR"));
  await voidInvoice(w.owner, { id: voided.id, version: 1, reason: "Issued by mistake." });
  const request = invoiceRequest(w, "INR", { subtotal: 250000, discount: 50000 });
  const invoice = await issueInvoice(w.owner, request);
  const payment = await submitPayment(w.guardian, paymentRequest(invoice.id, 200000));
  const verified = await verifyPayment(w.finance, { id: payment.id, version: 1, decision: "VERIFIED", reason: "Statement matched." });
  assert.equal(verified.data.currency, "INR");
  await saveSettings(w.owner, await settingsRequest(w, { currency: "USD", country: "US" }));
  assert.equal((await storedSettings(w.id)).data.currency, "USD");
  // Nothing about the existing records changed: no conversion, no new currency.
  const [stored] = await database().select().from(t.invoices).where(eq(t.invoices.id, invoice.id));
  assert.deepEqual([stored.data.currency, stored.data.total, stored.status], ["INR", 200000, "ISSUED"]);
  const [paid] = await database().select().from(t.payments).where(eq(t.payments.id, payment.id));
  assert.deepEqual([paid.data.currency, paid.data.amount], ["INR", 200000]);
  // The receipt PDF prints the stored currency, not the academy's current one.
  const receipt = await receiptPdf(w.guardian, payment.id);
  assert.equal((await PDFDocument.load(receipt.bytes)).getPageCount(), 1);
  assert.ok(pdfContains(receipt.bytes, "INR 2000.00"), "receipt shows INR 2000.00");
  assert.ok(!pdfContains(receipt.bytes, "USD 2000.00"));
  // The family portal shows the invoice in its own currency while the academy now bills in USD.
  const family = await bootstrapAcademy(w.guardian);
  assert.equal(family.settings.data.currency, "USD");
  const view = family.invoices.find((i) => i.id === invoice.id)!;
  assert.deepEqual([view.data.currency, view.data.total, view.verified, view.balance], ["INR", 200000, 200000, 0]);
  assert.equal(family.payments.find((p) => p.id === payment.id)?.data.currency, "INR");
  assert.equal(formatMoney(view.data.total, view.data.currency), "₹2,000.00");
  // A retry of the original request still returns the stored invoice; a changed currency is a conflict.
  assert.equal((await issueInvoice(w.owner, request)).id, invoice.id);
  await refuses(issueInvoice(w.owner, { ...request, currency: "USD" }), 409, undefined, /already used with different values/);
  // New invoices follow the new academy currency.
  await refuses(issueInvoice(w.owner, invoiceRequest(w, "INR")), 422, "CURRENCY_MISMATCH");
  assert.equal((await issueInvoice(w.owner, invoiceRequest(w, "USD"))).data.currency, "USD");
  // A refund of the old payment keeps working and stays in the payment's currency.
  const refund = await recordRefund(w.owner, {
    paymentId: payment.id,
    amount: 50000,
    reason: "Recorded external partial refund.",
    idempotencyKey: crypto.randomUUID(),
    confirmedExternalRefund: true,
  });
  assert.equal(refund.amount, 50000);
  const owner = await bootstrapAcademy(w.owner);
  const after = owner.invoices.find((i) => i.id === invoice.id)!;
  assert.deepEqual([after.data.currency, after.refunded, after.balance], ["INR", 50000, 50000]);
});

test("a historical invoice in another currency stays fully payable, verifiable and printable", async () => {
  const w = await world("cur-legacy-invoice", "INR");
  // Written directly: this is what a record from before the rule looks like.
  const id = crypto.randomUUID();
  await database().insert(t.invoices).values({
    id,
    academyId: w.id,
    data: {
      number: "INV-LEGACY01",
      playerIds: [w.player],
      familyUserId: null,
      planId: null,
      description: "Historical dollar invoice",
      currency: "USD",
      subtotal: 50000,
      discount: 0,
      total: 50000,
      dueDate: "2030-01-31",
      issuedAt: new Date().toISOString(),
      voidReason: "",
    },
  });
  const payment = await submitPayment(w.guardian, paymentRequest(id, 50000));
  assert.equal(payment.data.currency, "USD", "the payment takes its invoice's currency, not the academy's");
  const verified = await verifyPayment(w.finance, { id: payment.id, version: 1, decision: "VERIFIED", reason: "Statement matched." });
  assert.equal(verified.status, "VERIFIED");
  assert.ok(pdfContains((await receiptPdf(w.guardian, payment.id)).bytes, "USD 500.00"));
  // The academy may keep billing in INR; the report finds the off-currency invoice but changes nothing.
  const issues = findCurrencyIssues("INR", await recordsOf(w.id));
  assert.deepEqual(issues.map((i) => i.code), ["INVOICE_OFF_CURRENCY"]);
});

test("a payment whose currency disagrees with its invoice is never verified", async () => {
  const w = await world("cur-tamper", "INR");
  const invoice = await issueInvoice(w.owner, invoiceRequest(w, "INR"));
  const payment = await submitPayment(w.guardian, paymentRequest(invoice.id));
  const row = (await database().select().from(t.payments).where(eq(t.payments.id, payment.id)))[0];
  await database().update(t.payments).set({ data: { ...row.data, currency: "USD" } }).where(eq(t.payments.id, payment.id));
  await refuses(
    verifyPayment(w.owner, { id: payment.id, version: 1, decision: "VERIFIED", reason: "Statement matched." }),
    409,
    "CURRENCY_MISMATCH",
  );
  const [still] = await database().select().from(t.payments).where(eq(t.payments.id, payment.id));
  assert.equal(still.status, "SUBMITTED");
  // Rejecting it is still possible.
  const rejected = await verifyPayment(w.owner, { id: payment.id, version: 1, decision: "REJECTED", reason: "Currency does not match the invoice." });
  assert.equal(rejected.status, "REJECTED");
});

test("concurrent invoice issuing and a currency change never leave an unsettled invoice in the old currency", async () => {
  const w = await world("cur-race", "INR");
  const attempts = await Promise.allSettled([
    ...Array.from({ length: 6 }, () => issueInvoice(w.owner, invoiceRequest(w, "INR"))),
    saveSettings(w.owner, await settingsRequest(w, { currency: "USD" })),
    ...Array.from({ length: 6 }, () => issueInvoice(w.finance, invoiceRequest(w, "USD"))),
  ]);
  const currency = (await storedSettings(w.id)).data.currency;
  const rows = await database().select().from(t.invoices).where(and(eq(t.invoices.academyId, w.id), eq(t.invoices.status, "ISSUED")));
  // Whatever order the database chose, nothing unpaid exists in a currency other than the academy's.
  assert.ok(rows.every((r) => r.data.currency === currency), `all issued invoices are in ${currency}`);
  for (const result of attempts)
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof DomainError, `unexpected failure: ${String(result.reason)}`);
      assert.ok(["CURRENCY_MISMATCH", "CURRENCY_CHANGE_BLOCKED"].includes(result.reason.code ?? ""), String(result.reason));
    }
  assert.equal(rows.length, attempts.filter((a, i) => a.status === "fulfilled" && i !== 6).length);
});

async function recordsOf(academyId: string): Promise<MoneyRecords> {
  const db = database();
  const [invoices, payments, refunds, plans] = await Promise.all([
    db.select().from(t.invoices).where(eq(t.invoices.academyId, academyId)),
    db.select().from(t.payments).where(eq(t.payments.academyId, academyId)),
    db.select().from(t.refunds).where(eq(t.refunds.academyId, academyId)),
    db.select().from(t.feePlans).where(eq(t.feePlans.academyId, academyId)),
  ]);
  return {
    invoices,
    payments: payments.map((p) => ({ id: p.id, invoiceId: p.invoiceId, status: p.status, data: p.data })),
    refunds,
    plans,
  };
}

// ---------------------------------------------------------------------------------------------
test("amounts: minor units, totals and formatting stay exact and currency-specific", () => {
  assert.equal(minorUnits("10.05"), 1005);
  assert.equal(minorUnits("19.99"), 1999);
  assert.equal(minorUnits("0.1"), 10);
  assert.equal(minorUnits("1000"), 100000);
  for (const bad of ["10.005", "-1", "1,000", "", "1e3", "0x10", "1000000000"])
    assert.throws(() => minorUnits(bad), DomainError, bad);
  assert.equal(invoiceTotal(100000, 25000), 75000);
  assert.throws(() => invoiceTotal(100, 101), DomainError);
  assert.throws(() => invoiceTotal(0.5, 0), DomainError);
  assert.deepEqual(Object.keys(CURRENCIES), ["INR", "USD"]);
  assert.equal(plainMoney(100000, "INR"), "INR 1000.00");
  assert.equal(plainMoney(5, "USD"), "USD 0.05");
  assert.equal(formatMoney(10000000, "INR"), "₹1,00,000.00");
  assert.equal(formatMoney(10000000, "USD"), "$100,000.00", "dollars use dollar grouping, not lakh grouping");
  assert.equal(formatMoney(123456789, "USD"), "$1,234,567.89");
});

test("currency change blockers: only unsettled issued invoices and active plans count", () => {
  const invoice = (id: string, status: string, currency: string, total = 1000) => ({ id, status, data: { currency, total } });
  const pay = (id: string, invoiceId: string, status: string, amount: number) => ({ id, invoiceId, status, data: { amount, currency: "INR" } });
  const records: MoneyRecords = {
    invoices: [
      invoice("open", "ISSUED", "INR"),
      invoice("settled", "ISSUED", "INR"),
      invoice("void", "VOID", "INR"),
      invoice("refunded", "ISSUED", "INR"),
      invoice("pending", "ISSUED", "INR"),
      invoice("already-usd", "ISSUED", "USD"),
    ],
    payments: [
      pay("p1", "settled", "VERIFIED", 1000),
      pay("p2", "refunded", "VERIFIED", 1000),
      pay("p3", "pending", "VERIFIED", 1000),
      pay("p4", "pending", "SUBMITTED", 500),
      pay("p5", "open", "REJECTED", 1000),
    ],
    refunds: [{ paymentId: "p2", amount: 100 }],
    plans: [
      { id: "plan-active", currency: "INR", amount: 1, archived: false },
      { id: "plan-archived", currency: "INR", amount: 1, archived: true },
      { id: "plan-usd", currency: "USD", amount: 1, archived: false },
    ],
  };
  const blockers = currencyChangeBlockers(records, "USD");
  assert.deepEqual(blockers.openInvoices.sort(), ["open", "pending", "refunded"], "unpaid, refunded-back and awaiting-decision invoices");
  assert.deepEqual(blockers.activePlans, ["plan-active"]);
  assert.equal(blockers.blocked, true);
  assert.equal(currencyChangeBlockers(records, "INR").openInvoices.join(), "already-usd");
  assert.equal(currencyChangeBlockers({ invoices: [], payments: [], refunds: [], plans: [] }, "USD").blocked, false);
});

test("the integrity check reports every kind of inconsistency and nothing else", () => {
  const records: MoneyRecords = {
    invoices: [
      { id: "ok", status: "ISSUED", data: { currency: "INR", total: 900, subtotal: 1000, discount: 100 } },
      { id: "usd", status: "ISSUED", data: { currency: "USD", total: 100, subtotal: 100, discount: 0 } },
      { id: "euro", status: "ISSUED", data: { currency: "EUR", total: 100, subtotal: 100, discount: 0 } },
      { id: "float", status: "ISSUED", data: { currency: "INR", total: 10.5, subtotal: 10.5, discount: 0 } },
      { id: "sum", status: "ISSUED", data: { currency: "INR", total: 500, subtotal: 1000, discount: 100 } },
    ],
    payments: [
      { id: "p-ok", invoiceId: "ok", status: "VERIFIED", data: { amount: 900, currency: "INR" } },
      { id: "p-bad", invoiceId: "ok", status: "SUBMITTED", data: { amount: 900, currency: "USD" } },
    ],
    refunds: [],
    plans: [
      { id: "plan-off", currency: "USD", amount: 100, archived: false },
      { id: "plan-old", currency: "USD", amount: 100, archived: true },
    ],
  };
  assert.deepEqual(
    findCurrencyIssues("INR", records).map((i) => `${i.code}:${i.id}`).sort(),
    [
      "AMOUNT_NOT_INTEGER:float",
      "INVOICE_OFF_CURRENCY:usd",
      "INVOICE_TOTAL_MISMATCH:sum",
      "PAYMENT_CURRENCY_MISMATCH:p-bad",
      "PLAN_OFF_CURRENCY:plan-off",
      "UNSUPPORTED_CURRENCY:euro",
    ],
  );
});

// ---------------------------------------------------------------------------------------------
test("the read-only check refuses the live development database and anything unconfirmed", () => {
  const repo = join(tmpdir(), "repo-root");
  const refuse = (args: string[], env: Record<string, string> = {}) => {
    const r = checkTarget(args, env, repo);
    assert.equal(r.ok, false, args.join(" "));
    return r.ok ? "" : r.reason;
  };
  refuse([]);
  refuse(["--pglite"]);
  refuse(["--pglite", join(repo, ".data", "development")]);
  assert.match(refuse(["--pglite", join(repo, ".data", "development"), "--copy"]), /live development database/);
  assert.match(refuse(["--pglite", join(repo, ".data", "development", "base"), "--copy"]), /live development database/);
  assert.match(refuse(["--pglite", repo, "--copy"], {}), /live development database/, "a parent of the live database");
  assert.match(refuse(["--pglite", join(repo, "custom-live"), "--copy"], { LOCAL_DATABASE_PATH: "custom-live" }), /live development database/, "the configured live path");
  assert.match(refuse(["--pglite", join(tmpdir(), "does-not-exist-xyz"), "--copy"]), /does not exist/);
  assert.match(refuse(["--copy"]), /only valid with --pglite/);
  assert.deepEqual(checkTarget([], { DATABASE_URL: "postgres://u@127.0.0.1/db" }, repo), { ok: true, kind: "postgres", url: "postgres://u@127.0.0.1/db" });
});

test("the read-only check runs against a copy, reports findings and changes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sportozen-currency-"));
  try {
    const path = join(dir, "copy");
    await runMigrations({ target: { kind: "pglite", path } });
    const { PGlite } = await import("@electric-sql/pglite");
    const client = new PGlite(path);
    await client.exec(`
      insert into academy (id, name, timezone) values ('z1', 'Check Academy', 'UTC');
      insert into academy_settings (academy_id, data) values ('z1', '{"currency":"INR"}');
      insert into fee_plan (id, academy_id, name, amount, currency, archived) values ('plan-1', 'z1', 'Dollar plan', 100, 'USD', false);
    `);
    const fingerprint = async () =>
      JSON.stringify((await client.query("select (select count(*)::int from fee_plan) a, (select count(*)::int from invoice) b, (select data from academy_settings) c")).rows);
    const before = await fingerprint();
    await client.close();
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "scripts/check-currency-integrity.ts"), ...args], {
        cwd: REPO_ROOT,
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 180_000,
      });
    const refused = run(["--pglite", path]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /--copy/);
    const found = run(["--pglite", path, "--copy"]);
    assert.equal(found.status, 1, found.stderr);
    assert.match(found.stdout, /academy z1: currency INR; 0 invoices, 0 payments, 1 plans; 1 finding\(s\)/);
    assert.match(found.stdout, /PLAN_OFF_CURRENCY\s+fee_plan plan-1/);
    assert.match(found.stdout, /Nothing was changed/);
    const reopened = new PGlite(path);
    assert.equal(JSON.stringify((await reopened.query("select (select count(*)::int from fee_plan) a, (select count(*)::int from invoice) b, (select data from academy_settings) c")).rows), before);
    await reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
