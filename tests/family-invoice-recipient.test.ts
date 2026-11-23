import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { CANARY, USERS, addFixtureUser, canaryValues, idsFor, type FixtureUserKey } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { newMember, signedIn } from "./helpers/accounts";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";
import { assertNoLeak, assertPresent } from "./helpers/payload";
import type { TestClient } from "./helpers/client";
/**
 * STAGE 5F CORRECTION, owner decision D-5b (approved), through the real HTTP routes and real sessions:
 *
 *  - an invoice listing NO child but explicitly addressed to a family account (data.familyUserId) is visible
 *    exclusively to that account: family bootstrap, payment submission, receipt PDF;
 *  - an invoice listing no child and addressed to nobody is visible to no family account, on any endpoint;
 *  - another guardian, an adult player, an account of another academy, an inactive account and an account with
 *    no membership never reach it; request values (ids, extra fields, query strings) cannot widen access;
 *  - invoices that list children keep their existing rules; staff visibility is unchanged.
 *
 * The application cannot issue an invoice without a child (zod .min(1)), so these rows are inserted directly,
 * as data written outside the application would be.
 */
let app: Harness;
const db = () => database();
const STAMP = "2027-01-02T10:00:00.000Z";
const invoice = (id: string, academyId: string, playerIds: unknown, familyUserId: unknown, description: string) => ({
  id,
  academyId,
  data: {
    number: `INV-${id}`,
    playerIds,
    familyUserId,
    planId: null,
    description,
    currency: "INR",
    subtotal: 1000,
    discount: 0,
    total: 1000,
    dueDate: "2027-02-01",
    issuedAt: STAMP,
    voidReason: "",
  },
});
const verifiedPayment = (id: string, invoiceId: string, reference: string) => ({
  id,
  academyId: "green",
  invoiceId,
  status: "VERIFIED",
  idempotencyKey: `idem-${id}`,
  reference,
  data: {
    invoiceId,
    amount: 100,
    currency: "INR",
    reference,
    method: "UPI",
    submittedBy: USERS.finance.id,
    verifiedBy: USERS.finance.id,
    reason: "Fixture",
    receiptNumber: `RCT-${id.slice(0, 8).toUpperCase()}`,
  },
});
const G1 = USERS.guardian.id;
const INV = {
  toG1: "inv-d5b-to-g1",
  toAdult: "inv-d5b-to-adult",
  unaddressed: "inv-d5b-unaddressed",
  emptyContact: "inv-d5b-empty-contact",
  objectContact: "inv-d5b-object-contact",
  malformedToG1: "inv-d5b-malformed-to-g1",
  blueToG1: "inv-d5b-blue-to-g1",
} as const;
const TEXT = {
  toG1: "CANARY-D5B-TO-G1",
  toAdult: "CANARY-D5B-TO-ADULT",
  unaddressed: "CANARY-D5B-UNADDRESSED",
  emptyContact: "CANARY-D5B-EMPTY-CONTACT",
  objectContact: "CANARY-D5B-OBJECT-CONTACT",
  malformedToG1: "CANARY-D5B-MALFORMED-TO-G1",
  blueToG1: "CANARY-D5B-BLUE-TO-G1",
  unaddressedPay: "CANARY-D5B-PAY-UNADDRESSED",
} as const;
const PAY_UNADDRESSED = "pay-d5b-unaddressed";
const D5B_IDS: string[] = Object.values(INV);
before(
  async () => {
    app = await startHarness("family-invoice-d5b");
    await db().insert(t.invoices).values([
      invoice(INV.toG1, "green", [], G1, TEXT.toG1),
      invoice(INV.toAdult, "green", [], USERS.adult.id, TEXT.toAdult),
      invoice(INV.unaddressed, "green", [], null, TEXT.unaddressed),
      invoice(INV.emptyContact, "green", [], "", TEXT.emptyContact),
      // Not a string address: never an address (fail closed), even though it holds the user id.
      invoice(INV.objectContact, "green", [], { id: G1 }, TEXT.objectContact),
      // Not an array of children: never matches, even when addressed.
      invoice(INV.malformedToG1, "green", { [idsFor("childA").playerId]: true }, G1, TEXT.malformedToG1),
      // Addressed to a green account, but stored in the other academy.
      invoice(INV.blueToG1, "blue", [], G1, TEXT.blueToG1),
    ] as never);
    await db().insert(t.payments).values(verifiedPayment(PAY_UNADDRESSED, INV.unaddressed, TEXT.unaddressedPay) as never);
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const as = (key: FixtureUserKey) => app.as(key);
type Payload = {
  invoices: { id: string; data: { description: string }; balance: number }[];
  payments: { id: string; invoiceId: string }[];
};
async function bootstrapOf(client: TestClient, query = "") {
  const r = await client.get(`/api/academy${query}`);
  assert.equal(r.status, 200, `bootstrap ${r.status} ${r.text.slice(0, 160)}`);
  return r.json as Payload;
}
const d5bIn = (p: Payload) => p.invoices.map((i) => i.id).filter((id) => D5B_IDS.includes(id)).sort();
const allText = Object.values(TEXT);
const paymentBody = (invoiceId: string, reference: string, extra: Record<string, unknown> = {}) => ({
  invoiceId,
  idempotencyKey: crypto.randomUUID(),
  amount: 400,
  reference,
  method: "UPI",
  ...extra,
});
test("D5B-E1 family bootstrap: an addressed zero-child invoice reaches its recipient only", { timeout: TEST_TIMEOUT }, async () => {
  const expected: [FixtureUserKey, (keyof typeof INV)[]][] = [
    ["guardian", ["toG1"]],
    ["guardian2", []],
    ["adult", ["toAdult"]],
    ["blueGuardian", []],
  ];
  for (const [key, own] of expected) {
    const payload = await bootstrapOf(await as(key));
    assert.deepEqual(d5bIn(payload), own.map((k) => INV[k]).sort(), `${key}: zero-child invoices`);
    assertNoLeak(payload, allText.filter((x) => !own.some((k) => TEXT[k] === x)), key);
    if (own.length) assertPresent(payload, own.map((k) => TEXT[k]), key);
  }
  // Regression: invoices listing children keep their rules (each guardian still sees its own child's invoice).
  assert.ok((await bootstrapOf(await as("guardian"))).invoices.some((i) => i.id === idsFor("childA").invoiceId));
  assert.ok((await bootstrapOf(await as("guardian2"))).invoices.some((i) => i.id === idsFor("childB").invoiceId));
  assert.ok(!(await bootstrapOf(await as("guardian2"))).invoices.some((i) => i.id === idsFor("childA").invoiceId));
  assert.ok((await bootstrapOf(await as("blueGuardian"))).invoices.some((i) => i.id === idsFor("blue").invoiceId));
});
test("D5B-E2 staff invoice visibility is unchanged: finance roles see every invoice of their own academy only", { timeout: TEST_TIMEOUT }, async () => {
  const green = D5B_IDS.filter((id) => id !== INV.blueToG1).sort();
  for (const key of ["owner", "finance"] as const)
    assert.deepEqual(d5bIn(await bootstrapOf(await as(key))), green, key);
  assert.deepEqual(d5bIn(await bootstrapOf(await as("blueOwner"))), [INV.blueToG1], "blueOwner");
});
test("D5B-E3 the recipient can pay and download the receipt; nobody else can reach either", { timeout: TEST_TIMEOUT }, async () => {
  const g1 = await as("guardian");
  const submitted = await g1.post("/api/academy/fees/payment", paymentBody(INV.toG1, "D5B-REF-G1-0001"));
  assert.equal(submitted.status, 200, `recipient submits: ${submitted.text.slice(0, 160)}`);
  const payment = submitted.json as { id: string; version: number };
  for (const key of ["guardian2", "adult", "blueGuardian"] as const) {
    const r = await (await as(key)).post("/api/academy/fees/payment", paymentBody(INV.toG1, `D5B-REF-${key}-X`));
    assert.equal(r.status, 404, `${key} cannot pay the invoice addressed to guardian one`);
  }
  const verified = await (await as("finance")).post("/api/academy/fees/verify", {
    id: payment.id,
    version: payment.version,
    decision: "VERIFIED",
    reason: "Matched statement",
  });
  assert.equal(verified.status, 200, `finance verifies: ${verified.text.slice(0, 160)}`);
  const receipt = await g1.get(`/api/academy/fees/${payment.id}/receipt`);
  assert.equal(receipt.status, 200, "recipient downloads the receipt");
  assert.match(receipt.headers.get("content-type") ?? "", /application\/pdf/);
  for (const key of ["guardian2", "adult", "blueGuardian"] as const) {
    const r = await (await as(key)).get(`/api/academy/fees/${payment.id}/receipt`);
    assert.equal(r.status, 404, `${key} cannot download the recipient's receipt`);
  }
  // The payment follows its invoice in the bootstrap: the recipient sees it and the balance; nobody else does.
  const mine = await bootstrapOf(g1);
  assert.ok(mine.payments.some((p) => p.id === payment.id && p.invoiceId === INV.toG1));
  assert.equal(mine.invoices.find((i) => i.id === INV.toG1)?.balance, 600);
  for (const key of ["guardian2", "adult", "blueGuardian"] as const)
    assert.ok(!(await bootstrapOf(await as(key))).payments.some((p) => p.id === payment.id), `${key}: no payment`);
});
test("D5B-E4 unaddressed, empty-address, non-string-address and malformed zero-child invoices reach no family on any endpoint", { timeout: TEST_TIMEOUT }, async () => {
  const hidden = [INV.unaddressed, INV.emptyContact, INV.objectContact, INV.malformedToG1];
  for (const key of ["guardian", "guardian2", "adult"] as const) {
    const client = await as(key);
    for (const id of hidden) {
      const r = await client.post("/api/academy/fees/payment", paymentBody(id, `D5B-REF-${key}-${id}`));
      assert.equal(r.status, 404, `${key} cannot pay ${id}`);
    }
    const receipt = await client.get(`/api/academy/fees/${PAY_UNADDRESSED}/receipt`);
    assert.equal(receipt.status, 404, `${key}: no receipt of an unaddressed zero-child invoice`);
  }
  // Staff control: the same receipt exists and opens for finance, so the 404s above are about the family.
  assert.equal((await (await as("finance")).get(`/api/academy/fees/${PAY_UNADDRESSED}/receipt`)).status, 200);
  // Cross-academy: the blue invoice addressed to guardian one never reaches it, nor the blue guardian.
  assert.equal((await (await as("guardian")).post("/api/academy/fees/payment", paymentBody(INV.blueToG1, "D5B-REF-X-BLUE"))).status, 404);
  assert.equal((await (await as("blueGuardian")).post("/api/academy/fees/payment", paymentBody(INV.blueToG1, "D5B-REF-B-BLUE"))).status, 404);
  // Nothing was written by any refused request.
  const attempts = await db().select({ invoiceId: t.payments.invoiceId }).from(t.payments);
  for (const id of [...hidden, INV.blueToG1])
    assert.equal(attempts.filter((p) => p.invoiceId === id).length, id === INV.unaddressed ? 1 : 0, `${id}: no new attempt`);
});
test("D5B-E5 request values cannot redirect the address", { timeout: TEST_TIMEOUT }, async () => {
  const g2 = await as("guardian2");
  // Query strings naming another account or academy are ignored by the family loader.
  const tampered = await bootstrapOf(g2, `?familyUserId=${G1}&userId=${G1}&academyId=blue`);
  assert.deepEqual(d5bIn(tampered), []);
  assertNoLeak(tampered, [TEXT.toG1], "guardian2 with tampered query");
  // Extra body fields naming the recipient do not change who is asking.
  const r = await g2.post("/api/academy/fees/payment", paymentBody(INV.toG1, "D5B-REF-TAMPER", { familyUserId: G1, userId: G1, academyId: "green" }));
  assert.equal(r.status, 404);
  // Re-addressing the invoice moves visibility with it on the very next request (the address is read per request).
  const where = and(eq(t.invoices.academyId, "green"), eq(t.invoices.id, INV.toAdult));
  const [row] = await db().select().from(t.invoices).where(where);
  await db().update(t.invoices).set({ data: { ...row.data, familyUserId: USERS.guardian2.id } }).where(where);
  try {
    assert.deepEqual(d5bIn(await bootstrapOf(g2)), [INV.toAdult]);
    assert.deepEqual(d5bIn(await bootstrapOf(await as("adult"))), []);
  } finally {
    await db().update(t.invoices).set({ data: row.data }).where(where);
  }
  assert.deepEqual(d5bIn(await bootstrapOf(await as("adult"))), [INV.toAdult]);
});
test("D5B-E6 an inactive membership or no membership reaches nothing; an active recipient without children does", { timeout: TEST_TIMEOUT }, async () => {
  const member = await newMember("GUARDIAN", "green", "d5b");
  await db().insert(t.invoices).values(invoice("inv-d5b-to-member", "green", [], member.id, "CANARY-D5B-TO-MEMBER") as never);
  await db().insert(t.payments).values(verifiedPayment("pay-d5b-to-member", "inv-d5b-to-member", "CANARY-D5B-PAY-MEMBER") as never);
  const client = await signedIn(app, member.email);
  // Positive control: an active GUARDIAN with no linked child is still the addressed account.
  const payload = await bootstrapOf(client);
  assert.deepEqual(payload.invoices.map((i) => i.id), ["inv-d5b-to-member"]);
  assert.equal((await client.get("/api/academy/fees/pay-d5b-to-member/receipt")).status, 200);
  // Deactivated: every endpoint refuses before any invoice is read.
  const membership = and(eq(t.memberships.academyId, "green"), eq(t.memberships.userId, member.id));
  await db().update(t.memberships).set({ active: false }).where(membership);
  try {
    for (const r of [
      await client.get("/api/academy"),
      await client.get("/api/academy/fees/pay-d5b-to-member/receipt"),
      await client.post("/api/academy/fees/payment", paymentBody("inv-d5b-to-member", "D5B-REF-INACTIVE")),
    ]) {
      assert.equal(r.status, 403, `inactive: ${r.status}`);
      assert.ok(!r.text.includes("CANARY-D5B"), "inactive: nothing disclosed");
    }
  } finally {
    await db().update(t.memberships).set({ active: true }).where(membership);
  }
  // An account with no membership at all, addressed by an invoice, is refused too.
  const orphan = await addFixtureUser("d5b-no-membership", []);
  await db().insert(t.invoices).values(invoice("inv-d5b-to-orphan", "green", [], orphan.id, "CANARY-D5B-TO-ORPHAN") as never);
  const refused = await (await signedIn(app, orphan.email)).get("/api/academy");
  assert.equal(refused.status, 403);
  assert.ok(!refused.text.includes("CANARY-D5B"));
  // Other families' data stays out of the recipient's payload throughout.
  assertNoLeak(payload, [...canaryValues(CANARY.childA), ...canaryValues(CANARY.childB), ...canaryValues(CANARY.blue), ...allText], "member");
});
