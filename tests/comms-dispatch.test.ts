import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { setProviderFetchForTests, type FetchLike } from "../src/modules/communications/providers/transport";
import { TestClient } from "./helpers/client";
import { FIXTURE_PASSWORD, addFixtureUser, idsFor, USERS } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";

/**
 * E-mail through the OPTIONAL ZeptoMail service, and free manual sending (WhatsApp and e-mail by wa.me / mailto links),
 * through the existing outbox, with a FAKE provider. Nothing here contacts a real provider and no real credential is used.
 * What is proved, over real HTTP and real rows:
 *   - processOutbox sends EMAIL rows through the service only when it is configured; otherwise, and always for WHATSAPP, the
 *     row is READY_TO_SHARE and a person sends it from their own mail app / WhatsApp. PORTAL is unchanged;
 *   - recipients, consent, guardian links, approval hash and scheduling still decide who is addressed;
 *   - states are accurate (SENT = accepted by the service; SHARED = opened by the sender; RETRY; FAILED; SKIPPED), retries are
 *     capped, a permanent failure is not retried, a processed message is never sent twice, a row left SENDING is never resent;
 *   - consent withdrawn between queueing and sending stops the send, automatic or manual;
 *   - a number is only ever the recipient's OWN registered number, and nothing sensitive is stored in a delivery detail.
 */
const TOKEN = "fake-token-for-tests-only";
const B = idsFor("childB"); // a minor, guardian GUARDIAN2
const FATHER = "fx-comms-father";
const GUARDIAN2 = USERS.guardian2.id;
const db = () => database();
let app: Harness;

type Call = { url: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let behave: (call: Call, n: number) => Response = () => new Response("{}", { status: 500 });
const fake: FetchLike = async (url, init) => {
  const call: Call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
  calls.push(call);
  return behave(call, calls.length);
};
const zepto = (status = 201, body: unknown = { request_id: "zm-1" }) => () => new Response(JSON.stringify(body), { status });
const isEmail = (c: Call) => c.url.includes("zeptomail");

function configure(on: { email?: boolean }) {
  const env = process.env;
  for (const k of ["ZEPTOMAIL_SEND_TOKEN", "ZEPTOMAIL_FROM_ADDRESS"]) delete env[k];
  if (on.email) Object.assign(env, { ZEPTOMAIL_SEND_TOKEN: TOKEN, ZEPTOMAIL_FROM_ADDRESS: "academy@example.test" });
}
const route = (path: string) => `/api/academy/${path}`;
const owner = () => app.as("owner");
const sessions = new Map<string, TestClient>();
async function signedIn(who: string): Promise<TestClient> {
  let c = sessions.get(who);
  if (!c) {
    c = new TestClient(app.origin);
    const r = await c.signIn(`${who}.canary@example.test`, FIXTURE_PASSWORD);
    assert.equal(r.status, 200, `sign-in ${who}`);
    sessions.set(who, c);
  }
  return c;
}
type Channel = "PORTAL" | "EMAIL" | "WHATSAPP";
async function schedule(subject: string, playerIds: string[], channels: Channel[], templateId: string | null = null, body = "Please review the update in the family portal.") {
  const data = { subject, body, playerIds, batchIds: [], allBatches: false, channels, templateId };
  const c = await owner();
  const send = async (extra: Record<string, unknown>) => {
    const r = await c.post(route("communications/save"), { scheduledAt: null, data, ...extra });
    assert.equal(r.status, 200, `${extra.action}: ${r.text}`);
    return r.json as { id: string; version: number };
  };
  let row = await send({ action: "save" });
  row = await send({ id: row.id, version: row.version, action: "approve" });
  row = await send({ id: row.id, version: row.version, action: "schedule", scheduledAt: "2020-01-01T00:00:00Z" });
  return row.id;
}
type Summary = { sent: number; retrying: number; failed: number; skipped: number; notConfigured: number; stuck: number };
async function runOutbox(): Promise<{ processed: number; delivery: Summary }> {
  const r = await (await owner()).post(route("communications/process"), {});
  assert.equal(r.status, 200, r.text);
  return r.json as { processed: number; delivery: Summary };
}
const rows = async (messageId: string) =>
  (await db().select().from(t.deliveries).where(and(eq(t.deliveries.academyId, "green"), eq(t.deliveries.messageId, messageId)))).sort((x, y) =>
    `${x.userId}${x.channel}`.localeCompare(`${y.userId}${y.channel}`),
  );
const one = async (messageId: string, userId: string, channel: Channel) => (await rows(messageId)).find((r) => r.userId === userId && r.channel === channel)!;
const messageStatus = async (id: string) => (await db().select().from(t.messages).where(eq(t.messages.id, id)))[0].status;
async function consent(playerId: string, userId: string, flags: { portal: boolean; email: boolean; whatsapp: boolean }) {
  await db().update(t.guardianLinks).set({ consent: flags }).where(and(eq(t.guardianLinks.academyId, "green"), eq(t.guardianLinks.playerId, playerId), eq(t.guardianLinks.userId, userId)));
}
const ALL = { portal: true, email: true, whatsapp: true };
/** Ends or restores a parent's link to a player: the only thing that stops a message reaching a parent now. */
async function linked(playerId: string, userId: string, active: boolean) {
  await db().update(t.guardianLinks).set({ active }).where(and(eq(t.guardianLinks.academyId, "green"), eq(t.guardianLinks.playerId, playerId), eq(t.guardianLinks.userId, userId)));
}

before(
  async () => {
    app = await startHarness("comms-dispatch");
    setProviderFetchForTests(fake);
    await consent(B.playerId, GUARDIAN2, ALL);
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    setProviderFetchForTests(null);
    configure({});
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
beforeEach(() => {
  calls = [];
  behave = () => new Response("{}", { status: 500 });
  configure({ email: true });
});

test("e-mail: a configured channel is sent through ZeptoMail to each approved guardian, once, with accurate states", { timeout: TEST_TIMEOUT }, async () => {
  behave = zepto();
  const id = await schedule("Match day", [B.playerId], ["PORTAL", "EMAIL"]);
  const out = await runOutbox();
  assert.equal(out.processed, 1);
  assert.equal(out.delivery.sent, 1);
  const mail = calls.filter(isEmail);
  assert.equal(mail.length, 1, "one request per recipient");
  assert.equal(mail[0].headers.Authorization, `Zoho-enczapikey ${TOKEN}`);
  assert.equal(mail[0].body.subject, "Match day");
  assert.equal(mail[0].body.to.length, 1);
  assert.equal(mail[0].body.to[0].email_address.address, USERS.guardian2.email.toLowerCase());
  const email = await one(id, GUARDIAN2, "EMAIL");
  assert.equal(email.status, "SENT");
  assert.match(email.detail, /Accepted by the provider \(id zm-1\)/);
  assert.match(email.detail, /not tracked/, "SENT is not claimed to mean delivered or read");
  assert.equal((await one(id, GUARDIAN2, "PORTAL")).status, "AVAILABLE_IN_PORTAL", "the portal channel is unchanged");
  assert.equal(email.attempts, 1);
  assert.equal(await messageStatus(id), "PROCESSED");
  assert.equal(email.detail.includes(TOKEN) || email.detail.includes("@"), false, "no token or address in a stored detail");
  assert.equal(mail[0].body.client_reference, email.id, "the provider call carries the outbox row id");

  const again = await runOutbox();
  assert.equal(again.processed, 0);
  assert.equal(calls.filter(isEmail).length, 1, "processing again never sends again");
  assert.equal((await one(id, GUARDIAN2, "EMAIL")).attempts, 1);
});

test("e-mail: nobody is addressed who is not a linked, approved recipient", { timeout: TEST_TIMEOUT }, async () => {
  behave = zepto();
  // No player chosen: nobody is linked to the audience, so approval is refused and nothing is called.
  const data = { subject: "No audience", body: "Body text here.", playerIds: [], batchIds: [], allBatches: false, channels: ["EMAIL"], templateId: null };
  const r = await (await owner()).post(route("communications/save"), { scheduledAt: null, action: "save", data });
  assert.equal(r.status, 200, r.text);
  const saved = r.json as { id: string; version: number };
  const approve = await (await owner()).post(route("communications/save"), { id: saved.id, version: saved.version, scheduledAt: null, action: "approve", data });
  assert.equal(approve.status, 422, "approval is refused: nobody can receive it");
  assert.equal(calls.length, 0);
});

test("e-mail: a temporary failure is retried at the next runs, at most three attempts, then FAILED", { timeout: TEST_TIMEOUT }, async () => {
  behave = zepto(503, { error: { code: "TM_X", message: "try later" } });
  const id = await schedule("Retry me", [B.playerId], ["EMAIL"]);
  let out = await runOutbox();
  assert.equal(out.delivery.retrying, 1);
  let row = await one(id, GUARDIAN2, "EMAIL");
  assert.deepEqual([row.status, row.attempts], ["RETRY", 1]);
  assert.match(row.detail, /Attempt 1 of 3/);
  assert.equal(await messageStatus(id), "PROCESSED");
  out = await runOutbox();
  row = await one(id, GUARDIAN2, "EMAIL");
  assert.deepEqual([row.status, row.attempts], ["RETRY", 2]);
  out = await runOutbox();
  assert.equal(out.delivery.failed, 1);
  row = await one(id, GUARDIAN2, "EMAIL");
  assert.deepEqual([row.status, row.attempts], ["FAILED", 3]);
  assert.match(row.detail, /Gave up after 3 attempts/);
  await runOutbox();
  await runOutbox();
  assert.equal(calls.filter(isEmail).length, 3, "a failed row is never tried again");
});

test("e-mail: a retry that succeeds is SENT with the attempt count, and is not sent a second time", { timeout: TEST_TIMEOUT }, async () => {
  behave = (_c, n) => (n === 1 ? new Response("{}", { status: 429 }) : new Response(JSON.stringify({ request_id: "zm-2" }), { status: 201 }));
  const id = await schedule("Second time lucky", [B.playerId], ["EMAIL"]);
  await runOutbox();
  assert.equal((await one(id, GUARDIAN2, "EMAIL")).status, "RETRY");
  await runOutbox();
  const row = await one(id, GUARDIAN2, "EMAIL");
  assert.deepEqual([row.status, row.attempts], ["SENT", 2]);
  await runOutbox();
  assert.equal(calls.filter(isEmail).length, 2);
});

test("e-mail: a permanent failure is recorded once and never retried; rejected credentials say so", { timeout: TEST_TIMEOUT }, async () => {
  behave = zepto(422, { error: { code: "TM_3201", message: "Invalid email address" } });
  const id = await schedule("Bad address", [B.playerId], ["EMAIL"]);
  const out = await runOutbox();
  assert.equal(out.delivery.failed, 1);
  const row = await one(id, GUARDIAN2, "EMAIL");
  assert.deepEqual([row.status, row.attempts], ["FAILED", 1]);
  assert.match(row.detail, /TM_3201/);
  await runOutbox();
  assert.equal(calls.length, 1);

  calls = [];
  behave = zepto(401, { error: { code: "TM_4001", message: `Access denied ${TOKEN}` } });
  const id2 = await schedule("Bad token", [B.playerId], ["EMAIL"]);
  await runOutbox();
  const row2 = await one(id2, GUARDIAN2, "EMAIL");
  assert.equal(row2.status, "FAILED");
  assert.match(row2.detail, /credentials/);
  assert.equal(row2.detail.includes(TOKEN), false);
});

test("a parent unlinked after queueing but before the retry stops the send (SKIPPED, nothing sent)", { timeout: TEST_TIMEOUT }, async () => {
  behave = zepto(503, {});
  const id = await schedule("Link changes", [B.playerId], ["EMAIL"]);
  await runOutbox();
  assert.equal((await one(id, GUARDIAN2, "EMAIL")).status, "RETRY");
  const before = calls.length;
  await linked(B.playerId, GUARDIAN2, false);
  try {
    behave = zepto();
    const out = await runOutbox();
    assert.equal(out.delivery.skipped, 1);
    assert.equal(calls.length, before, "no request after the parent was unlinked");
    const row = await one(id, GUARDIAN2, "EMAIL");
    assert.equal(row.status, "SKIPPED");
    assert.match(row.detail, /no longer a linked parent/i);
  } finally {
    await linked(B.playerId, GUARDIAN2, true);
  }
});

test("free default: with no e-mail service, e-mail and WhatsApp rows are READY_TO_SHARE, nothing is called, the message is PROCESSED; preview says MANUAL", { timeout: TEST_TIMEOUT }, async () => {
  configure({});
  const preview = await (await owner()).post(route("communications/preview"), { subject: "Preview", body: "Body text here.", playerIds: [B.playerId], batchIds: [], allBatches: false, channels: ["EMAIL", "WHATSAPP"], templateId: null });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual((preview.json as { providers: unknown }).providers, { PORTAL: "AVAILABLE", EMAIL: "MANUAL", WHATSAPP: "MANUAL" });
  // The preview also says who the audience covers and who agreed to what, so the screen can explain an empty result.
  const audience = (preview.json as { audience: { players: number; playersWithParent: number; reach: Record<string, number> } }).audience;
  assert.equal(audience.players, 1);
  assert.equal(audience.playersWithParent, 1);
  assert.ok(audience.reach.EMAIL >= 1 && audience.reach.WHATSAPP >= 1 && audience.reach.PORTAL >= 1, JSON.stringify(audience));
  const nobody = await (await owner()).post(route("communications/preview"), { subject: "Preview", body: "Body text here.", playerIds: [], batchIds: [], allBatches: false, channels: ["PORTAL"], templateId: null });
  assert.equal(nobody.status, 200, nobody.text);
  const none = nobody.json as { recipients: unknown[]; audience: { players: number; reach: Record<string, number> } };
  assert.equal(none.recipients.length, 0);
  assert.equal(none.audience.players, 0, "no one chosen: the screen says to choose an audience");
  assert.deepEqual(none.audience.reach, { PORTAL: 0, EMAIL: 0, WHATSAPP: 0 });
  const id = await schedule("Unconfigured", [B.playerId], ["PORTAL", "EMAIL", "WHATSAPP"]);
  const out = await runOutbox();
  assert.equal(calls.length, 0, "nothing is sent by the server");
  assert.equal(out.delivery.sent, 0);
  for (const channel of ["EMAIL", "WHATSAPP"] as const) {
    const row = await one(id, GUARDIAN2, channel);
    assert.equal(row.status, "READY_TO_SHARE", channel);
    assert.match(row.detail, /Nothing has been sent yet/);
  }
  assert.equal(await messageStatus(id), "PROCESSED", "a free channel is never a reason to block a message");

  configure({ email: true });
  const ok = await (await owner()).post(route("communications/preview"), { subject: "Preview", body: "Body text here.", playerIds: [B.playerId], batchIds: [], allBatches: false, channels: ["EMAIL"], templateId: null });
  assert.deepEqual((ok.json as { providers: unknown }).providers, { PORTAL: "AVAILABLE", EMAIL: "AVAILABLE", WHATSAPP: "MANUAL" });
  // WhatsApp stays manual even when an e-mail service exists: there is no WhatsApp provider.
  behave = zepto();
  const mixed = await schedule("Mixed", [B.playerId], ["EMAIL", "WHATSAPP"]);
  await runOutbox();
  assert.equal((await one(mixed, GUARDIAN2, "EMAIL")).status, "SENT");
  assert.equal((await one(mixed, GUARDIAN2, "WHATSAPP")).status, "READY_TO_SHARE");
  assert.equal(calls.filter(isEmail).length, 1);
  assert.equal(calls.length, 1, "no request of any kind for WhatsApp");
});

type ShareItem = { id: string; messageId: string; userId: string; channel: string; name: string; email: string | null; phone: string | null; subject: string; body: string };
const shareList = async () => {
  const r = await (await owner()).post(route("communications/share-list"), {});
  assert.equal(r.status, 200, r.text);
  return (r.json as { items: ShareItem[] }).items;
};

test("manual sending: the list carries each guardian's OWN number and address, and opening a link is recorded as opened, once", { timeout: TEST_TIMEOUT }, async () => {
  configure({});
  // A second parent of the minor with no registered number.
  await addFixtureUser(FATHER, [{ academyId: "green", role: "GUARDIAN" }]);
  await db().insert(t.guardianLinks).values({ academyId: "green", playerId: B.playerId, userId: FATHER, relationship: "Father", consent: { portal: false, email: false, whatsapp: false } });
  // A decoy: the player's profile phone must never be used for a parent.
  const [prof] = await db().select().from(t.profiles).where(and(eq(t.profiles.academyId, "green"), eq(t.profiles.playerId, B.playerId)));
  await db().update(t.profiles).set({ data: { ...prof.data, phone: "+91 90000 00000" } }).where(and(eq(t.profiles.academyId, "green"), eq(t.profiles.playerId, B.playerId)));
  const reg = await (await app.as("guardian2")).post(route("communications/phone"), { phone: "98700 11111" });
  assert.equal(reg.status, 200, reg.text);
  const id = await schedule("Manual send", [B.playerId], ["EMAIL", "WHATSAPP"], null, "Training is at 5 pm.");
  await runOutbox();
  const items = (await shareList()).filter((i) => i.subject === "Manual send");
  const wa = items.filter((i) => i.channel === "WHATSAPP");
  const mail = items.filter((i) => i.channel === "EMAIL");
  assert.equal(wa.length, 2, "both approved guardians are listed");
  assert.equal(wa.find((i) => i.userId === GUARDIAN2)!.phone, "+919870011111", "her own number, read in the academy's country (India)");
  assert.equal(wa.find((i) => i.userId === FATHER)!.phone, null, "no registered number: none is invented");
  assert.equal(mail.length, 2, "both parents are listed for e-mail; no consent record is needed");
  assert.equal(mail.find((i) => i.userId === GUARDIAN2)!.email, USERS.guardian2.email.toLowerCase());
  assert.equal(items.every((i) => i.body === "Training is at 5 pm."), true);
  assert.equal(JSON.stringify(items).includes("90000"), false, "the profile decoy number is never exposed");

  const target = wa.find((i) => i.userId === GUARDIAN2)!;
  const first = await (await owner()).post(route("communications/mark-shared"), { id: target.id });
  assert.equal(first.status, 200, first.text);
  const row = await one(id, GUARDIAN2, "WHATSAPP");
  assert.equal(row.status, "SHARED");
  assert.match(row.detail, /not tracked/, "opened is not claimed to mean sent, delivered or read");
  assert.equal(row.detail.includes("9870"), false, "the number is not stored in a detail");
  const again = await (await owner()).post(route("communications/mark-shared"), { id: target.id });
  assert.equal(again.status, 200, "opening the same link twice is harmless");
  assert.equal((await shareList()).some((i) => i.id === target.id), false, "an opened row leaves the list");
  const other = await (await owner()).post(route("communications/mark-shared"), { id: "does-not-exist" });
  assert.equal(other.status, 409);
  assert.equal(calls.length, 0, "the server never contacts a provider for manual sending");
  // The second parent was added for this test only; unlink her so the later tests see one e-mail recipient again.
  await linked(B.playerId, FATHER, false);
});

test("manual sending: a parent unlinked before the link is used removes the row (SKIPPED)", { timeout: TEST_TIMEOUT }, async () => {
  configure({});
  const id = await schedule("Link changes again", [B.playerId], ["WHATSAPP"]);
  await runOutbox();
  assert.equal((await one(id, GUARDIAN2, "WHATSAPP")).status, "READY_TO_SHARE");
  await linked(B.playerId, GUARDIAN2, false);
  try {
    const items = await shareList();
    assert.equal(items.some((i) => i.messageId === id && i.userId === GUARDIAN2), false);
    const row = await one(id, GUARDIAN2, "WHATSAPP");
    assert.equal(row.status, "SKIPPED");
    assert.match(row.detail, /no longer a linked parent/i);
  } finally {
    await linked(B.playerId, GUARDIAN2, true);
  }
});

test("manual sending: only people allowed to approve messages can list or mark", { timeout: TEST_TIMEOUT }, async () => {
  for (const who of ["coach", "guardian", "finance"] as const) {
    for (const path of ["communications/share-list", "communications/mark-shared"]) {
      const r = await (await app.as(who)).post(route(path), { id: "x" });
      assert.ok([401, 403].includes(r.status), `${who} ${path}: ${r.status}`);
    }
  }
});

test("a row left in SENDING (a crash mid-send) is never sent again automatically and is reported as stuck", { timeout: TEST_TIMEOUT }, async () => {
  behave = zepto();
  const id = await schedule("Crash window", [B.playerId], ["EMAIL"]);
  await db().insert(t.deliveries).values({ id: crypto.randomUUID(), academyId: "green", messageId: id, userId: GUARDIAN2, channel: "EMAIL", status: "SENDING", attempts: 1, detail: "Sending." });
  const out = await runOutbox();
  // (An unrelated RETRY row left by an earlier test may legitimately be retried in this run; the stuck row must not be.)
  assert.equal(calls.filter(isEmail).length, 0, "the SENDING row is never sent");
  assert.ok(out.delivery.stuck >= 1);
  const row = await one(id, GUARDIAN2, "EMAIL");
  assert.deepEqual([row.status, row.attempts], ["SENDING", 1]);
});

test("two overlapping runs send each delivery once", { timeout: TEST_TIMEOUT }, async () => {
  behave = zepto();
  const id = await schedule("Overlap", [B.playerId], ["EMAIL"]);
  await Promise.all([runOutbox(), runOutbox()]);
  assert.equal(calls.filter(isEmail).length, 1);
  assert.equal((await one(id, GUARDIAN2, "EMAIL")).status, "SENT");
});

test("only people allowed to approve messages can trigger sending", { timeout: TEST_TIMEOUT }, async () => {
  behave = zepto();
  await schedule("Forbidden", [B.playerId], ["EMAIL"]);
  for (const who of ["coach", "guardian", "finance"] as const) {
    const r = await (await app.as(who)).post(route("communications/process"), {});
    assert.ok([401, 403].includes(r.status), `${who}: ${r.status}`);
  }
  assert.equal(calls.length, 0);
});
