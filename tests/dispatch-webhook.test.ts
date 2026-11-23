import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";
import * as t from "../src/infrastructure/database/schema";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";

process.env.BETTER_AUTH_SECRET = "isolated-webhook-test-secret-123456789012345678";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
/**
 * The WhatsApp webhook route. It is inert unless the "meta" provider is configured; when it is, nothing is accepted without a
 * valid signature over the raw body, a replay changes nothing, and a STOP reply suppresses the number. No network, no real account.
 */
const APP_SECRET = "webhook-app-secret";
const ENV = {
  DISPATCH_WHATSAPP_PROVIDER: "meta",
  WHATSAPP_META_PHONE_NUMBER_ID: "1234567890",
  WHATSAPP_META_ACCESS_TOKEN: "not-a-real-token",
  WHATSAPP_META_APP_SECRET: APP_SECRET,
  WHATSAPP_META_VERIFY_TOKEN: "verify-me",
  WHATSAPP_META_TEMPLATE: "report_ready",
};
let testDb: TestDatabase | undefined;
let route: typeof import("../src/app/api/webhooks/whatsapp/route");
const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const post = (body: string, headers: Record<string, string> = {}) =>
  route.POST(new Request("http://127.0.0.1:3100/api/webhooks/whatsapp", { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));
const statusBody = (id: string, status: string) => JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id, status, timestamp: "1800000000" }] } }] }] });
const item = async () => (await database().select().from(t.dispatchItems).where(eq(t.dispatchItems.providerMessageId, "wamid.hook")))[0];

before(async () => {
  testDb = await provisionTestDatabase("dispatch-webhook");
  route = await import("../src/app/api/webhooks/whatsapp/route");
  const db = database();
  await db.insert(t.academies).values({ id: "green", name: "Academy green", timezone: "Asia/Kolkata" });
  await db.insert(t.academySettings).values({ academyId: "green", data: defaultSettings });
  await db.insert(t.branches).values({ id: "b", academyId: "green", name: "B" });
  await db.insert(t.user).values([
    { id: "owner", name: "Owner", email: "owner@example.test" },
    { id: "parent", name: "Parent", email: "parent@example.test", phone: "+919800000001" },
  ]);
  await db.insert(t.memberships).values([
    { academyId: "green", userId: "owner", role: "OWNER" },
    { academyId: "green", userId: "parent", role: "GUARDIAN" },
  ]);
  await db.insert(t.batches).values({ id: "bt", academyId: "green", coachId: "owner", branchId: "b", name: "Batch" });
  await db.insert(t.players).values({ id: "p", academyId: "green", batchId: "bt", name: "Aadi Sharma" });
  await db.insert(t.profiles).values({ academyId: "green", playerId: "p", data: defaultProfile });
  const [batch] = await db
    .insert(t.dispatchBatches)
    .values({ academyId: "green", title: "March", recipientMode: "PARENTS", channels: ["WHATSAPP"], reportIds: [], status: "APPROVED", createdBy: "owner", approvedBy: "owner", approvedAt: new Date() })
    .returning({ id: t.dispatchBatches.id });
  await db.insert(t.dispatchItems).values({
    academyId: "green",
    batchId: batch.id,
    channel: "WHATSAPP",
    address: "+919800000001",
    addressHash: "h",
    recipientNames: ["Parent"],
    subjectRefs: [{ kind: "ACCOUNT", id: "parent" }],
    reportIds: [],
    status: "SENT",
    providerMessageId: "wamid.hook",
  });
  await db.insert(t.contactPoints).values({ academyId: "green", userId: "parent", channel: "WHATSAPP", address: "+919800000001", optedInAt: new Date(), optInSource: "OWNER_WRITTEN" });
});
after(async () => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  await testDb?.cleanup();
});

test("without the meta provider configured the route is inert: it answers 404 and touches nothing", async () => {
  const get = await route.GET(new Request("http://x/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc"));
  assert.equal(get.status, 404);
  const body = statusBody("wamid.hook", "delivered");
  assert.equal((await post(body, { "x-hub-signature-256": sign(body) })).status, 404);
  assert.equal((await item()).status, "SENT");
  Object.assign(process.env, ENV);
});

test("the handshake answers the challenge only for the right verify token", async () => {
  const url = (token: string, mode = "subscribe") => `http://x/api/webhooks/whatsapp?hub.mode=${mode}&hub.verify_token=${token}&hub.challenge=abc123`;
  const ok = await route.GET(new Request(url("verify-me")));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "abc123");
  assert.equal((await route.GET(new Request(url("wrong")))).status, 403);
  assert.equal((await route.GET(new Request(url("verify-me", "other")))).status, 403);
});

test("an unsigned or wrongly signed call is refused and changes nothing; a valid one is applied once and a replay changes nothing", async () => {
  const body = statusBody("wamid.hook", "delivered");
  assert.equal((await post(body)).status, 401, "no signature");
  assert.equal((await post(body, { "x-hub-signature-256": sign(body, "another-secret") })).status, 401, "signed with another secret");
  assert.equal((await post(body, { "x-hub-signature-256": sign(`${body} `) })).status, 401, "signature of a different body");
  assert.equal((await item()).status, "SENT", "nothing changed so far");
  const ok = await post(body, { "x-hub-signature-256": sign(body) });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "ok", "fixed words only, nothing echoed");
  const delivered = await item();
  assert.equal(delivered.status, "DELIVERED");
  assert.ok(delivered.deliveredAt);
  const events = () => database().select().from(t.dispatchEvents).where(eq(t.dispatchEvents.itemId, delivered.id));
  const count = (await events()).filter((e) => e.type === "DELIVERED").length;
  assert.equal((await post(body, { "x-hub-signature-256": sign(body) })).status, 200, "Meta may repeat itself");
  assert.equal((await events()).filter((e) => e.type === "DELIVERED").length, count, "a replay records nothing new");
  const read = statusBody("wamid.hook", "read");
  await post(read, { "x-hub-signature-256": sign(read) });
  assert.equal((await item()).status, "READ");
  const late = statusBody("wamid.hook", "sent");
  await post(late, { "x-hub-signature-256": sign(late) });
  assert.equal((await item()).status, "READ", "a late 'sent' does not move it back");
  const broken = "{not json";
  assert.equal((await post(broken, { "x-hub-signature-256": sign(broken) })).status, 400);
  assert.equal((await post("x".repeat(10), { "content-length": "9999999", "x-hub-signature-256": sign("x".repeat(10)) })).status, 413, "an oversized body is refused before it is read");
});

test("a STOP reply withdraws the opt-in and suppresses that number", async () => {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "in.stop", from: "919800000001", timestamp: "1800000500", type: "text", text: { body: "STOP" } }] } }] }] });
  assert.equal((await post(body, { "x-hub-signature-256": sign(body) })).status, 200);
  const [point] = await database().select().from(t.contactPoints).where(eq(t.contactPoints.userId, "parent"));
  assert.equal(point.suppressionReason, "STOP");
  assert.ok(point.optInRevokedAt, "the opt-in is revoked too");
});
